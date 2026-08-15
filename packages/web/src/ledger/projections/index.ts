/**
 * KAR-16.3 — the projections, as the seam `../apply.ts` plugs into.
 *
 * KAR-16.2 built the dispatcher against a `Projection<S>` interface and shipped
 * with nothing implementing it. This is what implements it, and the list is
 * deliberately the whole registration surface: the run store (KAR-16.4) hands
 * `PROJECTIONS` to `createLedgerApply` and holds one state object per entry, so
 * adding an eighth view is a line here rather than an edit in the store, the
 * dispatcher and every panel.
 *
 * Order matters only for reading a failure — `RunLedger.projections()` reports
 * in registration order — because the seven are independent by construction.
 * None reads another's state; each folds the same event and answers a different
 * question about it. That is what makes the whole set safe to apply in any
 * order and safe to test one at a time.
 */
import type { Projection } from '../apply.ts';
import { applyBlackboard, type BlackboardProjection, emptyBlackboard } from './blackboard.ts';
import { applyContext, type ContextProjection, emptyContext } from './context.ts';
import { applyCost, type CostProjection, emptyCost } from './cost.ts';
import { applyGates, emptyGates, type GatesProjection } from './gates.ts';
import type { ProjectionName } from './kinds.ts';
import { applyPlan, emptyPlan, type PlanProjection } from './plan.ts';
import { applyPlanHistory, emptyPlanHistory, type PlanHistoryProjection } from './planHistory.ts';
import { applyProvider, emptyProvider, type ProviderProjection } from './provider.ts';
import { applySubmission, emptySubmission, type SubmissionProjection } from './submission.ts';
import { applyTimeline, emptyTimeline, type TimelineProjection } from './timeline.ts';

/** A `Projection` whose `name` is one of the seven, rather than any string. */
export interface ProjectionModule<S> extends Projection<S> {
  readonly name: ProjectionName;
}

const projection = <S>(
  name: ProjectionName,
  create: () => S,
  apply: (state: S, event: Parameters<Projection<S>['apply']>[1]) => void,
): ProjectionModule<S> => ({ name, create, apply });

export const planProjection: ProjectionModule<PlanProjection> = projection(
  'plan',
  emptyPlan,
  applyPlan,
);
export const planHistoryProjection: ProjectionModule<PlanHistoryProjection> = projection(
  'planHistory',
  emptyPlanHistory,
  applyPlanHistory,
);
export const blackboardProjection: ProjectionModule<BlackboardProjection> = projection(
  'blackboard',
  emptyBlackboard,
  applyBlackboard,
);
export const contextProjection: ProjectionModule<ContextProjection> = projection(
  'context',
  emptyContext,
  applyContext,
);
export const gatesProjection: ProjectionModule<GatesProjection> = projection(
  'gates',
  emptyGates,
  applyGates,
);
export const costProjection: ProjectionModule<CostProjection> = projection(
  'cost',
  emptyCost,
  applyCost,
);
export const timelineProjection: ProjectionModule<TimelineProjection> = projection(
  'timeline',
  emptyTimeline,
  applyTimeline,
);
export const providerProjection: ProjectionModule<ProviderProjection> = projection(
  'provider',
  emptyProvider,
  applyProvider,
);

/**
 * Every projection, in the order docs/12-frontend-architecture.md §3.2 lists
 * them.
 *
 * The element type is `ProjectionModule<never>` for the same reason
 * `LedgerApplyOptions.projections` is a `Projection<unknown>[]`: the set is
 * heterogeneous by construction — nine reducers over nine unrelated state
 * types — and the concrete type is recovered through the module object's own
 * identity by `RunLedger.state()`.
 */
export const submissionProjection: ProjectionModule<SubmissionProjection> = projection(
  'submission',
  emptySubmission,
  applySubmission,
);

export const PROJECTIONS = [
  planProjection,
  planHistoryProjection,
  blackboardProjection,
  contextProjection,
  gatesProjection,
  costProjection,
  timelineProjection,
  providerProjection,
  submissionProjection,
  // eslint-disable-next-line — the cast is the heterogeneity note above.
] as unknown as readonly ProjectionModule<never>[];

export type { BlackboardProjection } from './blackboard.ts';
export type { ContextProjection } from './context.ts';
export type { CostProjection } from './cost.ts';
export type { EscalationVM, GatesProjection } from './gates.ts';
export type { PlanProjection } from './plan.ts';
export type { PlanHistoryProjection } from './planHistory.ts';
export type { ProviderChoiceState, ProviderProjection } from './provider.ts';
export type { SubmissionProjection, SubmittedTask } from './submission.ts';
export type { TimelineProjection } from './timeline.ts';
