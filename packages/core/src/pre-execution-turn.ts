/**
 * KAR-27.3 AC1 — whether a pre-execution turn is *in flight*, derived from the
 * ledger and from nothing else.
 *
 * **The defect this closes.** On 2026-08-23 a framing turn spent minutes making
 * five Linear queries and reading the repository. `provider.session_opened` was
 * in the ledger the whole time, and every surface still said *submitted —
 * waiting to be framed*, because that is the `created` label and nothing
 * consulted the session row. The operator's words were *"the user is unsure if
 * anything is going on."*
 *
 * `reduce.ts` folded `provider.session_opened` to `null` for a stated reason —
 * *"a running node here would be a framing node nothing ever completes"* — and
 * that reason was correct: there was no completion vocabulary. This module is
 * that vocabulary, written down once.
 *
 * ## Two numbers, deliberately kept apart
 *
 * - `sessions` counts `provider.session_opened` rows for the node. It is the
 *   **io address**: `openPreExecutionSession` numbers them from 0 and the io
 *   store counts attempts from 1, so the latest child's io lives at
 *   `sessions`. A `repair` opens a second session inside one retry attempt, so
 *   this is *not* the retry count.
 * - `failures` counts `node.failed` since the last `run.created`, which is
 *   exactly what `packages/daemon/src/pipeline/turn-failure.ts`'s
 *   `attemptsSpent` counts. It is the **display** number: "attempt 2 of 3".
 *
 * Conflating them is how a repaired framing turn would report itself as being
 * on its last attempt when it has spent none.
 *
 * ## Why one shared function
 *
 * The web folds the same events into its own per-view projections
 * (`packages/web/src/ledger/projections/`). A second spelling of "what counts
 * as this turn concluding" is a second answer, and the whole of this story is
 * that two surfaces disagreed about one run. So the table below is imported by
 * both the reducer and the web projection.
 *
 * Verifies: EPIC-27-S15, EPIC-27-S16 · KAR-27.3 AC1
 */
import type { Event } from './events.ts';
import { DEFAULT_RETRY_POLICY } from './plan-graph.ts';

/**
 * The three turns that run *before* a plan exists, by the node id their events
 * are recorded under — the same three
 * `packages/daemon/src/pipeline/pre-execution-session.ts` opens sessions for.
 *
 * A plan node is deliberately not one of them: it has `node.started`,
 * `node.completed` and a `NodeState` of its own, and this record exists only
 * for the turns that have none of that.
 */
export const PRE_EXECUTION_NODE_IDS = ['framing', 'recon', 'planner'] as const;

export type PreExecutionNodeId = (typeof PRE_EXECUTION_NODE_IDS)[number];

const isPreExecutionNode = (node: string): node is PreExecutionNodeId =>
  (PRE_EXECUTION_NODE_IDS as readonly string[]).includes(node);

/** What the ledger says about one pre-execution node's turns. */
export interface PreExecutionTurnState {
  /** A session was opened and nothing has concluded it yet. */
  readonly running: boolean;
  /** `provider.session_opened` rows for this node. The io attempt is this. */
  readonly sessions: number;
  /** `node.failed` rows since the last `run.created`. The display is this + 1. */
  readonly failures: number;
  /** The envelope `ts` of the last `provider.session_opened` — AC1's since-instant. */
  readonly sinceTs: number;
  /**
   * The ceiling the retry ladder is applying, as the last `node.failed`
   * declared it.
   *
   * Read off the event rather than re-derived, for the reason
   * `NodeFailedSchema.maxAttempts` exists at all: the alternative is a copy of
   * `maxAttempts` in every surface, one process away from the scheduler that
   * applies it. Before any failure there is nothing to read, and the floor is
   * the policy `recordTurnFailure` bounds these turns by.
   */
  readonly maxAttempts: number;
}

/** One entry per pre-execution node the ledger has said anything about. */
export type PreExecutionTurns = Readonly<Record<string, PreExecutionTurnState>>;

const fresh = (sinceTs: number): PreExecutionTurnState => ({
  running: false,
  sessions: 0,
  failures: 0,
  sinceTs,
  maxAttempts: DEFAULT_RETRY_POLICY.maxAttempts,
});

const sameTurn = (left: PreExecutionTurnState, right: PreExecutionTurnState): boolean =>
  left.running === right.running &&
  left.sessions === right.sessions &&
  left.failures === right.failures &&
  left.sinceTs === right.sinceTs &&
  left.maxAttempts === right.maxAttempts;

/**
 * `next`, or `null` when it says exactly what `prev` already said.
 *
 * `null` is the reducer's "this event changed nothing", and it is what keeps
 * the progress watermark honest: an event that moved no field must not be able
 * to end a stall episode.
 */
function changed(prev: PreExecutionTurns, next: PreExecutionTurns): PreExecutionTurns | null {
  const before = Object.keys(prev);
  const after = Object.keys(next);
  if (before.length !== after.length) return next;
  for (const key of after) {
    const was = prev[key];
    const now = next[key];
    if (was === undefined || now === undefined || !sameTurn(was, now)) return next;
  }
  return null;
}

/** Every node's turn marked not-running. The record's keys are untouched. */
function quiesce(prev: PreExecutionTurns): Record<string, PreExecutionTurnState> {
  const next: Record<string, PreExecutionTurnState> = {};
  for (const [node, turn] of Object.entries(prev)) next[node] = { ...turn, running: false };
  return next;
}

/** One node's turn concluded, with the fields the concluding event carries. */
function conclude(
  prev: PreExecutionTurns,
  node: string,
  ts: number,
  extra: Partial<PreExecutionTurnState> = {},
): PreExecutionTurns | null {
  if (!isPreExecutionNode(node)) return null;
  const before = prev[node] ?? fresh(ts);
  return changed(prev, { ...prev, [node]: { ...before, running: false, ...extra } });
}

/**
 * Folds one event into the pre-execution record, or answers `null` when the
 * event does not touch it.
 *
 * **The completion vocabulary is this switch and nothing else.** Every arm is a
 * point at which the child of that node has certainly exited — either because
 * the event is only ever appended after the process is gone (`run.created`,
 * `fact.written`, `plan.proposed`), or because the turn's own failure path
 * appended it (`node.failed`), or because a later session for the same node
 * displaced it. A turn that concludes in a way nobody wrote down here would
 * show as running for ever, which is exactly the bug the old `return null`
 * avoided by never showing anything.
 */
export function foldPreExecutionTurns(
  prev: PreExecutionTurns,
  event: Event,
): PreExecutionTurns | null {
  switch (event.kind) {
    /**
     * A turn is starting. The row is appended *before* the spawn
     * (`openPreExecutionSession`), so this is the earliest honest instant to
     * say the node is running, and its `ts` is the since-instant every surface
     * renders.
     *
     * It also quiesces the other two: the chain runs framing → recon →
     * planner in one process, so the next node opening a session is proof the
     * previous one's child is gone even when its own completion event is a
     * kind this build has never heard of.
     */
    case 'provider.session_opened': {
      const node = event.payload.node;
      if (!isPreExecutionNode(node)) return null;
      const before = prev[node];
      return changed(prev, {
        ...quiesce(prev),
        [node]: {
          running: true,
          // The envelope counts sessions from 0 and this counts them, so the
          // row that says `attempt: 0` is the first session.
          sessions: event.payload.attempt + 1,
          failures: before?.failures ?? 0,
          sinceTs: event.ts,
          maxAttempts: before?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        },
      });
    }

    /**
     * The turn failed. `failures` is what the display counts, and it is bumped
     * even when no session was ever opened — a framing turn refused before it
     * spawned (`unframeableRunFailure`, `noProviderFailure`) has still spent
     * an attempt, and `attemptsSpent` counts it.
     */
    case 'node.failed':
      return conclude(prev, event.payload.node, event.ts, {
        failures: (prev[event.payload.node]?.failures ?? 0) + 1,
        ...(event.payload.maxAttempts === undefined
          ? {}
          : { maxAttempts: event.payload.maxAttempts }),
      });

    /** Cancelled rather than failed: the child is gone, no attempt was spent. */
    case 'node.cancelled':
      return conclude(prev, event.payload.node, event.ts);

    /**
     * Framing succeeded. The spec exists, so the interview's child has exited.
     *
     * And the attempt counters reset — on all three, mirroring `attemptsSpent`,
     * which counts `node.failed` *since the last `run.created`*. A re-framed
     * spec is a new turn and is not charged for the attempts the previous one
     * spent.
     */
    case 'run.created': {
      const next = Object.fromEntries(
        Object.entries(prev).map(([node, turn]) => [
          node,
          { ...turn, failures: 0, ...(node === 'framing' ? { running: false } : {}) },
        ]),
      );
      return changed(prev, next);
    }

    /**
     * A clarifying question. The interview asks it *after* the child returned
     * it, so framing is not running while the operator reads it — which is the
     * whole of S16's "or whose last attempt concluded".
     */
    case 'human.requested':
      return conclude(prev, event.payload.node, event.ts);

    /**
     * A recon fact. `runReconNode` derives its facts from the survey the child
     * returned, so a fact written *by recon* is proof recon's child has exited.
     */
    case 'fact.written':
      return event.payload.fact.provenance.byNode === 'recon'
        ? conclude(prev, 'recon', event.ts)
        : null;

    /** The three ways a planner turn ends: a plan, a rejected plan, or a stop. */
    case 'plan.proposed':
    case 'plan.validation_failed':
      return conclude(prev, 'planner', event.ts);

    /**
     * The run stopped for a person. Which node was in flight is not carried, so
     * every one of them is quiesced: the drive is not advancing anything while
     * a human is being waited on, and a turn shown as running here would be a
     * turn nothing will ever conclude.
     */
    case 'run.needs_human':
    case 'run.aborted':
    case 'run.completed':
      return changed(prev, quiesce(prev));

    default:
      return null;
  }
}

/**
 * The one pre-execution turn in flight, or `null`.
 *
 * At most one is running by construction — the chain is sequential and every
 * `provider.session_opened` quiesces the others — but the record is data read
 * back from a ledger a newer daemon may have written, so "the latest one" is
 * the answer rather than a throw. Iterated in the fixed order the constant
 * declares, so two surfaces folding the same events pick the same node.
 */
export function inFlightPreExecution(
  turns: PreExecutionTurns,
): { readonly node: PreExecutionNodeId; readonly turn: PreExecutionTurnState } | null {
  let found: { node: PreExecutionNodeId; turn: PreExecutionTurnState } | null = null;
  for (const node of PRE_EXECUTION_NODE_IDS) {
    const turn = turns[node];
    if (turn === undefined || !turn.running) continue;
    if (found === null || turn.sinceTs >= found.turn.sinceTs) found = { node, turn };
  }
  return found;
}
