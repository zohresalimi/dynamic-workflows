/**
 * KAR-15.1 AC2 — the typecheck-level half of the contract, for `packages/cli`.
 *
 * Verifies: EPIC-15-S1 (the CLI half), EPIC-15-S2 · AC1, AC2
 *
 * The same fixture as `packages/web/src/api/contract.type-test.ts`, in the
 * second consumer, because AC2 asks for the build to break in **both**. It
 * imports the identical client module the UI imports — there is one client, and
 * `DeFlow run` is a caller of it rather than a second implementation of it.
 *
 * Nothing here runs. `pnpm typecheck` is the assertion.
 */
import { type ApiClient, createClient } from '@DeFlow/web';
import type { InferResponseType } from 'hono/client';

const rpc: ApiClient = createClient({ baseUrl: 'http://127.0.0.1:7777/api' });

type RunSummaryWire = InferResponseType<(typeof rpc.runs)[':id']['$get'], 200>;

declare const summary: RunSummaryWire;

export const planVersion: number = summary.planVersion;
export const runId: string = summary.runId;

// @ts-expect-error — a field the daemon does not define. A client that had
// degraded to `any` would accept this, and TypeScript would then flag this very
// line as an unused expectation.
export const renamed: unknown = summary.planVersionNumber;

type Created = InferResponseType<typeof rpc.runs.$post, 201>;

declare const created: Created;

export const createdRunId: string = created.runId;
export const createdSeq: number = created.seq;
