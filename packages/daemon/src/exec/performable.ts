/**
 * KAR-23.9 — what this daemon can actually perform, as one constant a plan
 * validator can read.
 *
 * On 2026-08-24 a validated plan was admitted with sixteen nodes, seven of them
 * of a type nothing in the daemon composed a performer for. Every one of those
 * nodes passed the *cheapest correctness gate in the system* — because the gate
 * had never been told what the executor can run. That is the gap this leaf
 * module closes: the set lives here, `pipeline/live-nodes.ts` composes its
 * registry against it with `satisfies`, and `plan/validate.ts` hands it to
 * `validatePlan`.
 *
 * **A leaf, deliberately.** It imports nothing but types from `@DeFlow/core`.
 * Deriving the set *from* `live-nodes.ts` would be the obvious move and would
 * cycle: `live-nodes.ts` already imports `live-chain.ts`, and `plan/validate.ts`
 * has no business reaching into the pipeline at all. Deriving `live-nodes`'
 * registry from *this* is the direction that works, and `satisfies
 * Record<PerformableNodeType, NodePerformer>` on an object literal errors on a
 * missing key *and* on an extra one — so the constant and the registry are
 * compiler-identical rather than two lists that agree today.
 */
import type { NodeType, ToolKind } from '@DeFlow/core';

/**
 * The node types `byNodeType` routes to a performer.
 *
 * `human` is **not** here and is not a gap: `decide()` admits a `human` node by
 * `SuspendNode` and never by `StartNode` (`admitHumanGates`), so it is answered
 * by a person rather than performed by anything. `SCHEDULER_HANDLED_NODE_TYPES`
 * in `@DeFlow/core` is the other half of that sentence, and the plan-time check
 * reads both — diagnosing `human` as unperformable would break KAR-13.1.
 *
 * `map`, `loop` and `subgraph` are absent because EPIC-15's fan-out and
 * EPIC-07's subgraphs have not shipped. Saying so at compile time, once, is
 * strictly better than fifteen `dependency.failed` events at node 27.
 */
export const PERFORMABLE_NODE_TYPES = [
  'agent',
  'gate',
  'tool',
] as const satisfies readonly NodeType[];

export type PerformableNodeType = (typeof PERFORMABLE_NODE_TYPES)[number];

/**
 * The `tool` kinds `toolNodePerformer` can run.
 *
 * One today. The performer's own `switch` is exhaustive over `ToolKind`, so
 * implementing `mcp` later is a compile error until it is registered here.
 */
export const PERFORMABLE_TOOL_KINDS = ['script'] as const satisfies readonly ToolKind[];

export type PerformableToolKind = (typeof PERFORMABLE_TOOL_KINDS)[number];
