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
 * Verifies: EPIC-10-S22, EPIC-10-S29 (third scenario), EPIC-12-S27 · AC5,
 * KAR-12.4 AC6, AC9
 */
import { expect, it, describe as suite } from 'vitest';
import { verdictCriteriaProjection } from './acceptance-board.ts';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';
import type { VerdictV2 } from './verdict.ts';

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

/**
 * KAR-12.4 AC9 — "run.completed carries criteriaSatisfied … computed from the
 * same projection, so the run summary and the board can never disagree."
 *
 * The two are computed by different code (`reduce`'s `withCriteria`, folding
 * `gate.evaluated` one event at a time, versus `verdictCriteriaProjection`,
 * a pure function over the whole verdict list at once) — so "can never
 * disagree" is only true if both are built on the same rule, `isVerdictVoid`.
 * This proves the two independent code paths, fed the identical verdicts,
 * produce the identical satisfied set — across the same scenarios AC5's
 * suite above already exercises one at a time.
 */
suite('criteriaSatisfied agrees with the criteria projection (KAR-12.4 AC9)', () => {
  function projectedSatisfied(events: readonly Event[], currentSpecHash: string): string[] {
    const verdicts = events
      .filter((one) => one.kind === 'gate.evaluated')
      .map((one) => (one.payload as { verdict: VerdictV2 }).verdict);
    return verdictCriteriaProjection(verdicts, currentSpecHash)
      .filter((row) => row.status === 'satisfied')
      .map((row) => row.criterion as string)
      .toSorted();
  }

  it('agrees on a verdict at the current hash', () => {
    const events = [approvedAt(HASH_A, 1), event('gate.evaluated', gateEvaluated(HASH_A), 2)];
    const state = fold(events);
    expect([...state.criteriaSatisfied].toSorted()).toEqual(projectedSatisfied(events, HASH_A));
  });

  it('agrees that a verdict voided by a spec edit satisfies neither', () => {
    const events = [
      approvedAt(HASH_A, 1),
      event('gate.evaluated', gateEvaluated(HASH_A), 2),
      event('spec.amended', amendment(), 3),
      approvedAt(HASH_B, 4),
    ];
    const state = fold(events);
    expect(state.criteriaSatisfied).toEqual([]);
    expect(projectedSatisfied(events, HASH_B)).toEqual([]);
  });

  it('agrees across two gates, one live and one voided', () => {
    const events = [
      approvedAt(HASH_A, 1),
      event('gate.evaluated', gateEvaluated(HASH_A, 'ac-3'), 2),
      event('gate.evaluated', gateEvaluated(HASH_B, 'ac-7'), 3),
    ];
    const state = fold(events);
    expect([...state.criteriaSatisfied].toSorted()).toEqual(['ac-3']);
    expect(projectedSatisfied(events, HASH_A)).toEqual(['ac-3']);
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
