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
