/**
 * KAR-10.4 AC5 — the run-level half of "void": what `RunState.criteriaSatisfied`
 * is allowed to count.
 *
 * `criteriaSatisfied` is not a display concern. It is what `run.completed`'s
 * `partial` outcome is measured against, so a criterion left in it after the
 * spec it was judged under was superseded is a run that reports success against
 * a contract nobody currently holds it to. The board (./acceptance-board.ts)
 * makes the void *visible*; this makes it *count for nothing*, and the two have
 * to agree or F7.4's board and the run's own outcome tell different stories.
 *
 * Verifies: EPIC-10-S22, EPIC-10-S29 (third scenario) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const HASH_A = `sha256-${'a'.repeat(64)}`;
const HASH_B = `sha256-${'b'.repeat(64)}`;
const TS = 1_754_313_093_000;

function event(kind: EventKind, payload: unknown, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

const gateEvaluated = (specHash: string | undefined, criterion = 'ac-3'): unknown => ({
  gate: 'review',
  node: 'implement',
  verdict: {
    schemaId: 'DeFlow.verdict.v2',
    outcome: 'pass',
    gate: 'review',
    evaluatedNode: 'implement',
    by: { node: 'gate-review', provider: 'codex', model: 'gpt-5-codex' },
    criteria: [{ id: criterion, status: 'satisfied' }],
    findings: [],
    summary: 'The criterion holds.',
    ...(specHash === undefined ? {} : { specHash }),
  },
});

/** `reduce` is total, so the fold is a plain left-fold — see ./reduce.ts. */
const fold = (events: readonly Event[]): RunState => events.reduce(reduce, initialRunState());

const approvedAt = (specHash: string, seq: number): Event =>
  event('run.spec.approved', { specHash, by: 'ui' }, seq);

suite('criteriaSatisfied counts only verdicts judged against the current spec (AC5)', () => {
  it('counts a verdict that names the run’s current specHash', () => {
    const state = fold([approvedAt(HASH_A, 1), event('gate.evaluated', gateEvaluated(HASH_A), 2)]);
    expect(state.criteriaSatisfied).toEqual(['ac-3']);
  });

  it('does not count a verdict judged against a superseded spec', () => {
    const state = fold([
      approvedAt(HASH_A, 1),
      // The operator amends; the daemon re-approves at B in the same commit.
      approvedAt(HASH_B, 2),
      event('gate.evaluated', gateEvaluated(HASH_A), 3),
    ]);
    expect(state.criteriaSatisfied).toEqual([]);
  });

  /**
   * The expensive half of the rule, and the one the epic's notes insist stays
   * expensive: an edit invalidates gate work that already ran. Softening this
   * to "keep what still looks right" would keep a judgement formed against a
   * different contract.
   */
  it('un-counts a criterion when the spec moves under it', () => {
    const state = fold([
      approvedAt(HASH_A, 1),
      event('gate.evaluated', gateEvaluated(HASH_A), 2),
      event('spec.amended', amendment(), 3),
      approvedAt(HASH_B, 4),
    ]);
    expect(state.criteriaSatisfied).toEqual([]);
  });

  it('re-approving the same spec un-counts nothing', () => {
    const state = fold([
      approvedAt(HASH_A, 1),
      event('gate.evaluated', gateEvaluated(HASH_A), 2),
      approvedAt(HASH_A, 3),
    ]);
    expect(state.criteriaSatisfied).toEqual(['ac-3']);
  });

  /** A `.v1` verdict, upcast: it names no contract, so it is not evidence
   * about this one. Void rather than trusted — see `VerdictV2Schema`. */
  it('does not count a verdict that names no specHash', () => {
    const state = fold([
      approvedAt(HASH_A, 1),
      event('gate.evaluated', gateEvaluated(undefined), 2),
    ]);
    expect(state.criteriaSatisfied).toEqual([]);
  });
});

/** The minimum `spec.amended` payload the schema accepts. The document itself
 * is irrelevant here — what the reducer reads is the pair of hashes. */
function amendment(): unknown {
  return {
    from: HASH_A,
    to: HASH_B,
    patch: [{ op: 'replace', path: '/goal', value: 'Migrate checkout to Vue 3, carefully.' }],
    document: DOCUMENT,
    by: 'ui',
  };
}

const DOCUMENT = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Migrate checkout to Vue 3, carefully.',
  scope: { included: ['packages/ui'] },
  nonGoals: ['Rewriting the payment gateway'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [{ id: 'ac-3', statement: 'It compiles.', verifiedBy: ['typecheck'] }],
  knownFailureModes: [],
};
