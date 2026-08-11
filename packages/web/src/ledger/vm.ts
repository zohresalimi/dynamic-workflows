/**
 * KAR-16.4 AC6 — the view-model surface, and the whole of it
 * (docs/12-frontend-architecture.md §3.3).
 *
 * > Components receive `PlanNodeVM` / `PlanEdgeVM` / `TimelineSpanVM` and never
 * > a raw `Event` and never a projection internal.
 *
 * That is a claim about *this file*, which is why it exists as a file rather
 * than as a convention. `../stores/useRunStore.ts` types every selector against
 * these names, so a component's props can only be spelled in terms of what is
 * re-exported here — and what is deliberately **not** re-exported is the point:
 *
 * - **`Event`.** A component that takes an envelope has moved the fold into the
 *   template, where it is unreachable by the projection suite and re-runs on
 *   every render. The envelope's only legal destinations are a projection and
 *   the debug ring.
 * - **The projection states** — `PlanProjection`, `TimelineProjection` and the
 *   other five. They carry a projection's *bookkeeping*: `appliedSeq`, held
 *   patch proposals, orphaned reads waiting to be adopted. A component that
 *   read `plan.proposals` would be rendering the reducer's scratch space, and
 *   the day that scratch space changes shape the view breaks for a reason no
 *   test named.
 *
 * `./vm.type-test.ts` is the assertion. It is a type-level test — nothing to
 * run — because the claim is about what will not compile.
 */

/**
 * What a node **cost**, as the money projection reports it.
 *
 * Re-exported for KAR-17.1's node body, which shows "cost so far" on the graph.
 * `CostFigures` is a view model — four independent figures, one per measurement
 * path — and not the projection's bookkeeping; `CostProjection` itself stays
 * unexported here for the same reason `PlanProjection` does.
 */
export type { CostFigures, UsageSource } from './projections/cost.ts';
/**
 * What a **gate** said about a node, for the verdict chip on its body.
 *
 * `GateAttemptVM` is the compact form — gate, attempt, outcome, `seq` — which is
 * all a chip needs; the findings and the criteria behind it belong to the review
 * surface (KAR-17.6) and are reached through the same projection there.
 */
export type { GateAttemptVM, VerdictOutcome } from './projections/gates.ts';
export type {
  NodeBinaryVM,
  NodeBlockedVM,
  NodeFailureVM,
  NodeRetryVM,
  PlanEdgeVM,
  PlanNodeVM,
} from './projections/plan.ts';
/**
 * The timeline's span, under the name the acceptance criteria give it.
 *
 * `timeline.ts` calls it `SpanVM` because inside that module there is only one
 * kind of span. Out here there are node spans, gate attempts and suspensions in
 * the same sentence, so the view-model name carries the projection it came
 * from — and renaming it in place would have churned KAR-16.3's snapshots for a
 * word.
 */
export type {
  SpanOutcome,
  SpanVM as TimelineSpanVM,
  SuspensionVM,
} from './projections/timeline.ts';
