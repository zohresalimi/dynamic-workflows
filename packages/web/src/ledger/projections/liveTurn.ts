/**
 * KAR-27.3 AC3 — `liveTurn.ts`: which pre-execution turn this run has in flight.
 *
 * The tenth projection, and the one that answers the question an operator asks
 * out loud. On 2026-08-23 a framing turn ran for minutes and the workflow view
 * showed a strip that said nothing was happening; the run's own
 * `provider.session_opened` was on the feed the whole time, claimed by no
 * projection at all.
 *
 * ## Why it folds nothing of its own
 *
 * The fold is `foldPreExecutionTurns` from `@DeFlow/core` — the same function
 * the reducer uses to build `RunState.preExecution`. That is not shared code
 * for tidiness: "what counts as a framing turn concluding" is a vocabulary, and
 * a browser copy of it would be a second answer to a question two surfaces
 * already disagreed about once. This module is the projection *shell* — the
 * cursor, the container, the registration — and the domain decision lives in
 * one file that neither surface owns.
 *
 * ## What it does not hold
 *
 * The turn's **output**. That is `io_chunk`, the data plane, polled by the
 * component that renders it and never folded into a store
 * (`../../api/io-tail.ts`, KAR-17.5 AC8). This projection holds five integers
 * and a boolean per node.
 *
 * Verifies: EPIC-27-S18 · AC3
 */
import type { Event, PreExecutionNodeId, PreExecutionTurns } from '@DeFlow/core';
import { foldPreExecutionTurns, inFlightPreExecution } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

export interface LiveTurnProjection {
  /** One entry per pre-execution node the feed has said anything about. */
  turns: PreExecutionTurns;
  /** The highest `seq` folded. The cursor moves for **every** event, including
   * kinds this build cannot read: a frame that was seen has been seen, and a
   * client that forgot would re-request it on every reconnect for the life of
   * the run (EPIC-16-S11). */
  appliedSeq: number;
}

export const emptyLiveTurn = (): LiveTurnProjection => ({ turns: {}, appliedSeq: 0 });

/** The at-most-one turn in flight, or `null`. Re-exported so a renderer reads
 * the same answer the run list's label does. */
export function liveTurnOf(
  state: LiveTurnProjection,
): { readonly node: PreExecutionNodeId; readonly turn: PreExecutionTurns[string] } | null {
  return inFlightPreExecution(state.turns);
}

export function applyLiveTurn(state: LiveTurnProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'provider.session_opened':
    case 'node.failed':
    case 'node.cancelled':
    case 'run.created':
    case 'human.requested':
    case 'fact.written':
    case 'plan.proposed':
    case 'plan.validation_failed':
    case 'run.needs_human':
    case 'run.aborted':
    case 'run.completed': {
      // `null` is "this event moved nothing", and keeping the same object is
      // what makes the projection idempotent under a re-delivered frame.
      state.turns = foldPreExecutionTurns(state.turns, event) ?? state.turns;
      return;
    }
    default:
      ignored<'liveTurn'>(event as Ignorable<'liveTurn'>);
  }
}
