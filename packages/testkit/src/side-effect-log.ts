/**
 * KAR-03.8 — the fake agents' own record of what they were asked to do, and
 * the duplicate check that turns it into an assertion (EPIC-03-S26).
 *
 * The crash-fuzz suite's first invariant is "no effect executed twice", and it
 * is deliberately **not** checked against the effect journal alone. The journal
 * is the mechanism that is supposed to prevent the second execution; reading it
 * back to ask whether a second execution happened proves only that it agrees
 * with itself. So every fake binary appends one line per invocation to a text
 * file, and the invariant becomes a duplicate-key check on that file — an
 * observation of the world, not an inference from the thing under test.
 *
 * `readInvocation` and `recordInvocation` are the writing half, called by
 * `bin/fake-agent.ts` from inside the child process where the invocation
 * actually happens. Everything else here reads.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/** One invocation, as the fake binary recorded it. */
export interface SideEffect {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

export interface SideEffectLog {
  readonly entries: readonly SideEffect[];
  /**
   * Lines that were not a complete record.
   *
   * Reported rather than dropped. The log is written by a process that gets
   * `SIGKILL`ed on purpose, so a torn final line is a thing that can genuinely
   * happen — but a suite that silently ignores unreadable output cannot tell a
   * crash from a bug, and the count is what lets a spec say which it expects.
   */
  readonly malformed: number;
}

function toSideEffect(value: unknown): SideEffect | null {
  if (value === null || typeof value !== 'object') return null;
  const { runId, nodeId, attempt, idempotencyKey } = value as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof nodeId !== 'string') return null;
  if (typeof attempt !== 'number' || typeof idempotencyKey !== 'string') return null;
  return { runId, nodeId, attempt, idempotencyKey };
}

/** Reads the NDJSON log at `path`. A file that does not exist is an empty log. */
export function readSideEffectLog(path: string): SideEffectLog {
  if (!existsSync(path)) return { entries: [], malformed: 0 };

  const entries: SideEffect[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const effect = toSideEffect(parsed);
    if (effect === null) malformed += 1;
    else entries.push(effect);
  }
  return { entries, malformed };
}

// ---------------------------------------------------------------------------
// The writing half (KAR-04.6 AC8)
// ---------------------------------------------------------------------------

/** Where the log goes. Unset means no log, and the invocation is unaffected. */
export const SIDE_EFFECT_LOG_ENV = 'DeFlow_SIDE_EFFECT_LOG';
/** What EPIC-01 and EPIC-03 already set. Still honoured, and still an alias. */
export const LEGACY_SIDE_EFFECT_LOG_ENV = 'DeFlow_FAKE_SIDE_EFFECT_LOG';

/**
 * The four fields, in each of the three spellings a caller may use.
 *
 * All three, because DeFlowd passes them one way or the other depending on how
 * the adapter builds its argv, and a fixture that only worked one way would
 * look green right up until the adapter changed. argv wins over the environment:
 * it is the more specific of the two. `DeFlow_FAKE_*` is the spelling the
 * pre-KAR-04.6 fixtures use and it stays supported, last.
 */
export const IDEMPOTENCY_FIELDS = [
  { flag: '--run-id', env: 'DeFlow_RUN_ID', legacyEnv: 'DeFlow_FAKE_RUN_ID', key: 'runId' },
  { flag: '--node-id', env: 'DeFlow_NODE_ID', legacyEnv: 'DeFlow_FAKE_NODE_ID', key: 'nodeId' },
  { flag: '--attempt', env: 'DeFlow_ATTEMPT', legacyEnv: 'DeFlow_FAKE_ATTEMPT', key: 'attempt' },
  { flag: '--ikey', env: 'DeFlow_IKEY', legacyEnv: 'DeFlow_FAKE_IKEY', key: 'idempotencyKey' },
] as const;

export const IDEMPOTENCY_FLAGS = IDEMPOTENCY_FIELDS.map((field) => field.flag);

export type InvocationEnv = Readonly<Record<string, string | undefined>>;

/**
 * Scans argv directly rather than through any parser.
 *
 * Deliberate: "every invocation appends exactly one line" has to hold for an
 * invocation whose argv turned out to be unusable, and the invocation whose
 * absence from the log would be hardest to explain later is exactly that one.
 */
export function readInvocation(argv: readonly string[], env: InvocationEnv): SideEffect {
  const value = (flag: string, name: string, legacy: string): string => {
    const at = argv.lastIndexOf(flag);
    if (at >= 0 && argv[at + 1] !== undefined) return argv[at + 1] as string;
    return env[name] ?? env[legacy] ?? '';
  };

  const attempt = Number.parseInt(value('--attempt', 'DeFlow_ATTEMPT', 'DeFlow_FAKE_ATTEMPT'), 10);
  return {
    runId: value('--run-id', 'DeFlow_RUN_ID', 'DeFlow_FAKE_RUN_ID'),
    nodeId: value('--node-id', 'DeFlow_NODE_ID', 'DeFlow_FAKE_NODE_ID'),
    // Verbatim, except that an absent or unreadable attempt is 0 rather than
    // NaN — NaN does not survive JSON.stringify.
    attempt: Number.isFinite(attempt) ? attempt : 0,
    idempotencyKey: value('--ikey', 'DeFlow_IKEY', 'DeFlow_FAKE_IKEY'),
  };
}

/**
 * Appends one line, or does nothing at all when no log is configured.
 *
 * Synchronous on purpose: the process this exists to observe is one that gets
 * `SIGKILL`ed, and a line sitting in a stream buffer when the signal lands is a
 * line that never existed.
 */
export function recordInvocation(argv: readonly string[], env: InvocationEnv): void {
  const path = env[SIDE_EFFECT_LOG_ENV] ?? env[LEGACY_SIDE_EFFECT_LOG_ENV];
  if (path === undefined || path === '') return;
  appendFileSync(path, `${JSON.stringify(readInvocation(argv, env))}\n`);
}

/** An idempotency key that was performed more than once. */
export interface DuplicateEffect {
  readonly idempotencyKey: string;
  readonly invocations: number;
}

/**
 * The keys that appear more than once, in the order they were first performed.
 *
 * An empty array is F4.2 holding: "completed nodes are never re-executed", at
 * effect granularity, observed from outside.
 */
export function duplicateIdempotencyKeys(
  entries: readonly SideEffect[],
): readonly DuplicateEffect[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.idempotencyKey, (counts.get(entry.idempotencyKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, invocations]) => invocations > 1)
    .map(([idempotencyKey, invocations]) => ({ idempotencyKey, invocations }));
}
