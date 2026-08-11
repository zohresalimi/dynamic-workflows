/**
 * The recorded ledgers, for the specs that run in a **browser**.
 *
 * `./run-fixtures.ts` next door does the same job for the projection suite, and
 * it does it with `node:fs` — which a page cannot do. So the same `events.jsonl`
 * arrives here through Vite's `?raw` import instead, and is parsed through the
 * production `parseEvent` for exactly the reason that file gives: a spec that
 * fed a projection raw JSON would be testing it against a shape nothing on the
 * wire produces, and would keep passing after a payload schema changed
 * underneath it.
 *
 * Two of the six fixtures are exported rather than all of them, and each earns
 * its place:
 *
 * - **`happy-path-12`** is the one KAR-17.1's test plan names, and it is the one
 *   that happens to contain **all seven display states at once** — pending,
 *   running, blocked, passed, failed, abandoned and awaiting-human — which is
 *   what lets EPIC-17-S2's state matrix be asserted against a real recording
 *   rather than against seven hand-built nodes. It is also the only fixture with
 *   facts that are read, invalidated and taint their readers, which is
 *   KAR-17.3's provenance table.
 * - **`repair-attempts`** is the only fixture with **more than one context
 *   packet for the same node**. EPIC-17-S13's side-by-side of attempt 1 and
 *   attempt 3 has nothing to compare without it.
 * - **`compaction`** is the only fixture holding **one `context.compacted` of
 *   each fidelity** — an `exact` one DeFlow measured both ends of, and a
 *   `partial` one the vendor reported a `pre_tokens` for and nothing else. It
 *   is exported from a real `ledger.db` rather than assembled, and KAR-17.4's
 *   *"render the gap as a gap"* has nothing to render without it.
 *
 * Add another here when a spec needs one; do not hand-write events.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import compactionRaw from '../../../test/fixtures/runs/compaction/events.jsonl?raw';
import gateRepairRaw from '../../../test/fixtures/runs/gate-failure-repair/events.jsonl?raw';
import happyRaw from '../../../test/fixtures/runs/happy-path-12/events.jsonl?raw';
import repairRaw from '../../../test/fixtures/runs/repair-attempts/events.jsonl?raw';

/** The run the `happy-path-12` recording belongs to. */
export const HAPPY_PATH_RUN = 'run_20260811T090000Z_a1b2c3';

/** The run the `gate-failure-repair` recording belongs to. */
export const GATE_REPAIR_RUN = 'run_20260810T090000Z_9f31ab';

/** The run the `repair-attempts` recording belongs to. */
export const REPAIR_ATTEMPTS_RUN = 'run_20260811T140000Z_c4d5e6';

/** The run the `compaction` recording belongs to. */
export const COMPACTION_RUN = 'run_20260806T120000Z_c0ffee';

const cache = new Map<string, readonly Event[]>();

function parse(name: string, raw: string): readonly Event[] {
  const held = cache.get(name);
  if (held !== undefined) return held;

  const events = raw
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const result = parseEvent(JSON.parse(line));
      if (result.status !== 'ok') {
        throw new Error(
          `${name}/events.jsonl line ${index + 1} is not readable by this build: ` +
            `${JSON.stringify(result)} — rebuild the fixture from its own script`,
        );
      }
      return result.event;
    });

  cache.set(name, events);
  return events;
}

/** Every event of `happy-path-12`, in `seq` order, parsed. */
export const happyPath12 = (): readonly Event[] => parse('happy-path-12', happyRaw);

/** Every event of `repair-attempts`, in `seq` order, parsed. */
export const repairAttempts = (): readonly Event[] => parse('repair-attempts', repairRaw);

/** Every event of `compaction`, in `seq` order, parsed. */
export const compactionRun = (): readonly Event[] => parse('compaction', compactionRaw);

/**
 * Every event of `gate-failure-repair`, in `seq` order, parsed.
 *
 * KAR-17.6's fixture: a real `tsc` behind a real gate definition failed with a
 * `blocker` finding at `src/date-picker.ts:2`, a surgical fix node wrote the
 * regression test and then the fix, and the gate set re-ran and passed. It is
 * the only recording holding a whole repair loop, which is what F7.5's
 * before → after has to animate.
 */
export const gateFailureRepair = (): readonly Event[] =>
  parse('gate-failure-repair', gateRepairRaw);

/**
 * A `gate.evaluated` envelope, built here and read back through `parseEvent`.
 *
 * The rule at the top of this file — *"do not hand-write events"* — is about
 * **recordings**, and it stands: every assertion that can be made against a
 * real ledger is. Two cells of KAR-17.6's matrix have no recording to be made
 * against, because nothing DeFlow has run has yet produced either, and both are
 * legal shapes the surface must handle:
 *
 * - a finding with severity `info` (the recordings hold `blocker`, `major` and
 *   `minor`), and
 * - a finding with **no `location` at all** — a judgement about the change as a
 *   whole, which `FindingV2Schema` explicitly permits and which AC3 says must
 *   render at file level rather than be dropped or guessed onto line 1.
 *
 * Writing them as envelopes and parsing them through the production
 * `parseEvent` is what keeps them honest: the same zod schema the wire is
 * validated against rejects a shape the daemon could not emit, so this cannot
 * drift into testing a payload nothing produces.
 */
export function gateEvaluated(spec: {
  readonly seq: number;
  readonly runId?: string;
  readonly gate: string;
  readonly gateNode: string;
  readonly evaluatedNode: string;
  readonly outcome: 'pass' | 'fail' | 'needs-human';
  readonly summary: string;
  readonly attempt?: number;
  readonly criteria?: readonly { readonly id: string; readonly status: string }[];
  readonly findings: readonly Record<string, unknown>[];
}): Event {
  const result = parseEvent({
    seq: spec.seq,
    runId: spec.runId ?? HAPPY_PATH_RUN,
    ts: 1_786_402_564_331 + spec.seq,
    kind: 'gate.evaluated',
    v: 4,
    epoch: 0,
    nodeId: spec.gateNode,
    attempt: spec.attempt ?? 0,
    payload: {
      gate: spec.gate,
      node: spec.evaluatedNode,
      verdict: {
        schemaId: 'DeFlow.verdict.v4',
        outcome: spec.outcome,
        gate: spec.gate,
        evaluatedNode: spec.evaluatedNode,
        by: { node: spec.gateNode, provider: 'deflow', model: 'deterministic-gate' },
        criteria: spec.criteria ?? [],
        findings: spec.findings,
        summary: spec.summary,
      },
    },
  });

  if (result.status !== 'ok') {
    throw new Error(`the built gate.evaluated is not a legal event: ${JSON.stringify(result)}`);
  }
  return result.event;
}
