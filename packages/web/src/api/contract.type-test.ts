/**
 * KAR-15.1 AC2 — the typecheck-level half of the contract, for `packages/web`.
 *
 * Verifies: EPIC-15-S2 · AC1, AC2
 *
 * This file asserts nothing at runtime and is never executed. It is compiled by
 * `pnpm typecheck`, and that is the whole point: because `@DeFlow/daemon`'s
 * `exports` field points at `./src/index.ts` inside the workspace, the types
 * below are the daemon's **live source**. Rename a field on a daemon response
 * type and this file stops compiling in the same commit that renamed it,
 * naming the field and this call site — rather than a view failing at runtime
 * three weeks later.
 *
 * The `@ts-expect-error` lines are load-bearing in the other direction: if the
 * client ever degraded to `any` — which is exactly what happens if somebody
 * unchains the daemon's route definitions for readability — reading a field
 * that does not exist would *succeed*, and TypeScript would then report the
 * unused `@ts-expect-error` as an error of its own. So the fixture fails either
 * way round.
 */
import type { InferRequestType, InferResponseType } from 'hono/client';
import { createClient } from './client.ts';

const rpc = createClient({ baseUrl: 'http://127.0.0.1:7777/api' });

// --- GET /runs/:id ----------------------------------------------------------

type RunSummaryWire = InferResponseType<(typeof rpc.runs)[':id']['$get'], 200>;

declare const summary: RunSummaryWire;

/** Fields read by name off the daemon's own return type. */
export const planVersion: number = summary.planVersion;
export const headSeq: number = summary.headSeq;
export const runId: string = summary.runId;

// @ts-expect-error — a field the daemon does not define. If this line ever
// compiles, the response type has degraded to `any` and the contract is gone.
export const renamed: unknown = summary.planVersionNumber;

/** The path parameter is inferred too: `id` is required and is a string. */
export const params: InferRequestType<(typeof rpc.runs)[':id']['$get']> = {
  param: { id: 'run_20260802T141133Z_9f2a1c' },
};

export const wrongParam: InferRequestType<(typeof rpc.runs)[':id']['$get']> = {
  // @ts-expect-error — the daemon's route names its parameter `id`, so a
  // client that guessed `runId` must not compile.
  param: { runId: 'run_20260802T141133Z_9f2a1c' },
};

// --- GET /runs/:id/snapshot -------------------------------------------------

type SnapshotWire = InferResponseType<(typeof rpc.runs)[':id']['snapshot']['$get'], 200>;

declare const snapshot: SnapshotWire;

export const snapshotSeq: number = snapshot.seq;
export const snapshotPlanVersion: number = snapshot.planVersion;

/**
 * KAR-15.7 — `?seq=` belongs to the *type* of the route rather than being a
 * string the handler happens to read off `c.req.query()`. `createScrubber` in
 * ./scrub.ts is its only caller, and a scrubber naming a parameter this route
 * stopped accepting must be a compile error here rather than a silent 400 in
 * a tab — the same reason `/runs/:id/events` declares `since` and `limit`.
 */
export const snapshotRequest: InferRequestType<(typeof rpc.runs)[':id']['snapshot']['$get']> = {
  param: { id: 'run_20260802T141133Z_9f2a1c' },
  query: { seq: 'head' },
};

// --- GET /health ------------------------------------------------------------

type HealthWire = InferResponseType<typeof rpc.health.$get, 200>;

declare const health: HealthWire;

export const apiVersion: number = health.apiVersion;
export const build: string = health.build;
export const uptimeMs: number = health.uptimeMs;
export const daemonEpoch: number | null = health.daemonEpoch;

// --- the error envelope -----------------------------------------------------

type RunNotFound = InferResponseType<(typeof rpc.runs)[':id']['$get'], 404>;

declare const refusal: RunNotFound;

export const code: string = refusal.error.code;
export const retryable: boolean = refusal.error.retryable;
