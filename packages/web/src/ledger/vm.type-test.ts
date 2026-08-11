/**
 * KAR-16.4 AC6 — components receive view models, never an envelope and never a
 * projection internal.
 *
 * Verifies: EPIC-16-S28 (the shape half) · AC6
 *
 * Nothing here runs. It is compiled by `pnpm typecheck`, and every
 * `@ts-expect-error` is load-bearing in both directions: if the construct it
 * guards ever *does* compile, TypeScript reports the unused directive as an
 * error of its own, so the fixture fails either way round.
 *
 * The claim being defended is a boundary, and boundaries are only real if
 * crossing them fails a build. A component that took an `Event` would move the
 * fold into a template — unreachable by the projection suite, re-run on every
 * render — and a component that took a `PlanProjection` would render the
 * reducer's scratch space: `appliedSeq`, held patch proposals, orphan reads
 * waiting to be adopted. Both look completely ordinary in a review.
 */
import type { Event } from '@DeFlow/core';
import type { PlanProjection } from './projections/plan.ts';
import type { TimelineProjection } from './projections/timeline.ts';
import type { PlanEdgeVM, PlanNodeVM, TimelineSpanVM } from './vm.ts';

// ── what a component may declare ─────────────────────────────────────────────

/** The three names AC6 lists, as a component's props would spell them. */
export interface GraphCanvasProps {
  readonly nodes: readonly PlanNodeVM[];
  readonly edges: readonly PlanEdgeVM[];
  readonly spans: readonly TimelineSpanVM[];
}

/** A view model is a rendering surface: ids, titles, states, no bookkeeping. */
export function label(node: PlanNodeVM): string {
  return `${node.id} ${node.state} ${node.title}`;
}

export function span(one: TimelineSpanVM): number {
  return (one.endTs ?? one.startTs) - one.startTs;
}

// ── what it may not ──────────────────────────────────────────────────────────

/**
 * The envelope is not a view model, and no widening makes it one.
 *
 * `Event` carries `kind` and `payload` — the two things a component may never
 * branch on, because branching on them *is* the fold.
 */
export function envelopeIsNotANode(event: Event): PlanNodeVM {
  // @ts-expect-error — an `Event` is not a `PlanNodeVM`.
  return event;
}

/** A projection's state is not a view model either. */
export function projectionIsNotAProp(state: PlanProjection): GraphCanvasProps['nodes'] {
  // @ts-expect-error — `PlanProjection` is the reducer's own state, not an
  // array of view models. Handing it to a component exports `appliedSeq` and
  // `proposals` to a template.
  return state;
}

export function timelineProjectionIsNotASpanList(state: TimelineProjection): TimelineSpanVM[] {
  // @ts-expect-error — same rule for the timeline: `spans` is a `Map` keyed by
  // `${nodeId}#${attempt}`, and a component that knew that key format would be
  // holding the projection's private index.
  return state;
}

/**
 * The bookkeeping fields are not reachable *through* a view model.
 *
 * This is the assertion that keeps `vm.ts` honest as it grows: re-exporting a
 * projection state under a friendlier name would leave every test above
 * passing and this one failing.
 */
export function nodeHasNoBookkeeping(node: PlanNodeVM): number {
  // @ts-expect-error — `appliedSeq` belongs to the projection, not to a node.
  return node.appliedSeq;
}
