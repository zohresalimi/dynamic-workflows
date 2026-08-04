/**
 * @DeFlow/core — the pure domain and engine logic. Zero I/O.
 *
 * This file is the package's whole contract: re-exports only, no logic
 * (docs/16-repo-layout.md §8). Deep imports across packages are banned, so
 * anything meant to be shared is exported here or it is internal.
 *
 * R1: this package depends on nothing in the workspace and on nothing that can
 * perform I/O — zod and nothing else. Time, randomness and ids arrive through
 * ports declared here and implemented in @DeFlow/daemon or @DeFlow/testkit.
 *
 * EPIC-02 fills this in: TaskSpec, PlanGraph, PlanPatch, Fact, ContextPacket,
 * the Event union, reduce, decide, the patch policy and the permission ladder.
 */
export type { Clock, TimerHandle } from './clock.ts';

// KAR-02.1 — identifier types and the stable-NodeId invariant.
export type {
  Brand,
  CriterionId,
  EventSeq,
  FactId,
  GateId,
  Handle,
  IdempotencyKey,
  NodeId,
  NodeLifecycle,
  PlanHash,
  ProviderId,
  RunId,
  SchemaId,
  SegmentId,
} from './ids.ts';
export {
  CriterionIdSchema,
  EventSeqSchema,
  FactIdSchema,
  GateIdSchema,
  HandleSchema,
  NodeIdSchema,
  NodeLifecycleSchema,
  PlanHashSchema,
  ProviderIdSchema,
  RunIdSchema,
  SchemaIdSchema,
  SegmentIdSchema,
} from './ids.ts';
export type { ParsedIkey } from './ikey.ts';
// IdempotencyKeySchema is deliberately not exported (AC4) — ikey() below is
// the only legal constructor.
export { ikey, parseIkey } from './ikey.ts';
export type { ItemIdFrom } from './map-child-id.ts';
export { mapChildId } from './map-child-id.ts';
export { NodeIdRegistry, NodeIdReused } from './node-id-registry.ts';
export { mintRunId } from './run-id.ts';
