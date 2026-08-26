/**
 * KAR-19.9 AC2 / EPIC-19-S60 — *"the attempt ceiling, the backoff and the
 * classification all come from `planRetry` and `recordNodeFailure`"*, asserted
 * over the shipped source rather than remembered.
 *
 * `FRAMING_RETRY_MS = 30_000` was the whole of the 2026-08-13 defect in one
 * constant: a **re-dispatch interval** doing duty as a retry policy, with no
 * ceiling behind it, in a file whose own header says it owns no policy. EPIC-06
 * had already built the answer — `planRetry` bounds attempts at `maxAttempts`
 * and returns `{ action: 'fail', exhausted: true }` after them, and
 * `recordNodeFailure` writes the events and the wake row in one transaction —
 * and the drive loop was bypassing it.
 *
 * The shortcut this guard exists to refuse is a counter in `drive.ts`: three
 * lines, correct-looking, and a second retry policy that nothing reconciles
 * with the node's own `RetryPolicy` the first time somebody sets
 * `maxAttempts: 5` in a plan. Two policies that disagree are worse than the bug
 * they replaced, because the disagreement is silent.
 *
 * Scanned files are the *dispatch* — the driver and the chain it dispatches to.
 * `packages/daemon/src/retry.ts` is deliberately **not** scanned: it is the one
 * module that may talk about retries, and it reads the policy off the node
 * rather than declaring one.
 *
 * Verifies: EPIC-19-S60 · KAR-19.9 AC2
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from './support/workspace.ts';

/** The dispatch: the driver, and the chain it hands a due turn to. */
const DISPATCH = [
  'packages/daemon/src/drive.ts',
  'packages/daemon/src/pipeline/run-chain.ts',
] as const;

/** The module the dispatch must route a failed turn through. */
const RECORDER = 'packages/daemon/src/pipeline/turn-failure.ts';

/** Comments are prose about the policy, not the policy; the guard reads code. */
function code(path: string): string {
  return readText(path)
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A duration the dispatch declares for itself — `FRAMING_RETRY_MS`,
 * `retryDelayMs`, `const BACKOFF_MS`.
 *
 * The *name* rather than the number, because that is what a second policy
 * always has: `EVENT_PAGE = 5_000` is a page size and no amount of grepping for
 * four-digit literals can tell the two apart, while a constant with `retry`,
 * `backoff` or `_MS` in its name is a wait this file decided on.
 */
const OWN_DURATION = /\b(?:[A-Z][A-Z0-9_]*_MS|[A-Za-z_]*(?:RETRY|BACKOFF|DELAY)[A-Za-z0-9_]*)\b/gi;

/**
 * Durations the dispatch may *name* because they are provably not an attempt
 * policy — declared in `@DeFlow/core`, imported here, and about something other
 * than when to try again.
 *
 * A named exemption rather than a weakened pattern, in the same spirit as
 * `packages/daemon/src/retry.ts` being excluded from `DISPATCH` above: the rule
 * is worth nothing if it can be routed around by renaming, so what is allowed is
 * written down one constant at a time.
 *
 * `COOPERATIVE_CANCEL_UNANSWERED_MS` (KAR-27.6) is how long a cooperative cancel
 * may go unanswered before the run *says so*. It schedules nothing and retries
 * nothing — cooperative is never promoted (EPIC-19-S38) — and the drive's only
 * use of it is a comparison before appending a `run.cancel.unanswered`.
 *
 * `STOP_ASK_SETTLE_MS` (KAR-27.9) is how long `settle()` will wait, **once, at
 * shutdown**, for a protocol cancel that has already been sent to be answered.
 * A bound on a wait rather than a policy about attempts: when it elapses nothing
 * is re-sent and nothing is signalled — the daemon stops waiting on an agent
 * that is not answering, which is the opposite of trying again.
 */
const NOT_A_RETRY_POLICY: ReadonlySet<string> = new Set([
  'COOPERATIVE_CANCEL_UNANSWERED_MS',
  'STOP_ASK_SETTLE_MS',
]);

/** A ceiling of its own: a comparison against a count of attempts or tries. */
const OWN_CEILING = /\b(?:max|MAX)[_A-Za-z]*(?:Attempts|ATTEMPTS|Retries|RETRIES|Tries|TRIES)\b/;

/**
 * The closed taxonomy itself, so the guard cannot drift from it and cannot
 * mistake an event kind for a failure reason — `'provider.probed'` is a kind,
 * `'provider.unavailable'` is a classification, and only one of them is a
 * decision this file is forbidden to make.
 */
function failureReasons(): readonly string[] {
  const vocabulary = readText('packages/core/src/node-failure.ts');
  const block = /export const NODE_FAILURE_REASONS = \[([\s\S]*?)\] as const;/.exec(vocabulary);
  if (block === null) throw new Error('NODE_FAILURE_REASONS has moved; this guard reads it');
  return [...(block[1] as string).matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

const namesAReason = (source: string): string | null =>
  failureReasons().find((reason) => source.includes(`'${reason}'`)) ?? null;

suite('AC2 — one retry policy, and it is the node’s own', () => {
  it('scans files that actually exist, so an empty result means something', () => {
    for (const path of DISPATCH) expect(code(path).length).toBeGreaterThan(500);
    expect(code(RECORDER).length).toBeGreaterThan(200);
  });

  it('has no attempt ceiling of its own in the dispatch', () => {
    for (const path of DISPATCH) {
      expect(OWN_CEILING.test(code(path)), `${path} declares an attempt ceiling`).toBe(false);
    }
  });

  it('has no backoff constant used as an attempt policy in the dispatch', () => {
    for (const path of DISPATCH) {
      const found = [...code(path).matchAll(OWN_DURATION)]
        .map((match) => match[0])
        .filter((name) => !NOT_A_RETRY_POLICY.has(name));
      expect(found[0] ?? null, `${path} spells a duration constant`).toBeNull();
    }
  });

  it('names no NodeFailureReason in the dispatch', () => {
    for (const path of DISPATCH) {
      expect(namesAReason(code(path)), `${path} classifies a failure itself`).toBeNull();
    }
  });

  it('has FRAMING_RETRY_MS gone rather than renamed', () => {
    // Code, not prose: the constant may — and should — still be *named* in the
    // comment that explains why it is gone, because the next person to reach
    // for a re-dispatch interval needs to find that paragraph.
    for (const path of DISPATCH) expect(code(path)).not.toContain('FRAMING_RETRY_MS');
  });

  it('routes the dispatch’s failures through the shipped policy', () => {
    const driver = code('packages/daemon/src/drive.ts');
    expect(driver).toContain('recordTurnFailure');
    const recorder = code(RECORDER);
    // The ceiling, the backoff and the classification are all one call away,
    // in EPIC-06's module rather than in a second one.
    expect(recorder).toContain('recordNodeFailure');
    expect(recorder).toContain('DEFAULT_RETRY_POLICY');
    // Exhaustion is the shipped `fail` action with `exhausted` true, never a
    // count the driver kept.
    expect(recorder).toContain('exhausted');
  });

  it('and that guard is not vacuous: an invented second ceiling is refused', () => {
    const invented = 'if (attempts >= maxAttempts) return;\nconst BACKOFF_MS = 30_000;\n';
    expect(OWN_CEILING.test(invented)).toBe(true);
    expect(OWN_DURATION.test(invented)).toBe(true);
    expect(namesAReason("const r = 'agent.nonzero-exit';")).toBe('agent.nonzero-exit');
    expect(namesAReason("kind: 'provider.probed'")).toBeNull();
  });
});
