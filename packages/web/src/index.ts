/**
 * @DeFlow/web — the Vue 3 + Vite SPA: the ledger-projection Pinia store and the
 * nine P0 views.
 *
 * It imports from @DeFlow/core for types only. vue, pinia, @vue-flow/core,
 * xterm.js and shiki arrive with EPIC-16.
 *
 * The one thing it exports today is the API client (KAR-15.1): `packages/cli`
 * imports this module rather than writing a second client, so `DeFlow run` and
 * the browser reach the daemon through the identical typed surface
 * (docs/11-api-and-realtime.md §9). The daemon is imported **type-only** there,
 * so nothing of it enters either bundle.
 */
export type { ApiClient, ApiClientOptions } from './api/client.ts';
export {
  API_BASE_PATH,
  createClient,
  DEFAULT_DAEMON_ORIGIN,
  defaultBaseUrl,
} from './api/client.ts';
// KAR-15.3 — the client half of the frame contract: one dispatcher, named
// frames to control, everything else to the reducer.
export type { ControlFrame, Dispatcher, DispatcherOptions, StreamFrame } from './api/dispatch.ts';
export { createDispatcher, fanOutByRun, stopsRetrying } from './api/dispatch.ts';
// KAR-15.4 — the explicit hydrate path, which is mandatory rather than an
// optimisation: it is how a reloaded tab, a cold start and `DeFlow` itself all
// reach a cursor they can open the stream at (docs/11 §4.1).
export type { HydrateOptions, HydratePage, HydrateResult } from './api/hydrate.ts';
export { hydrateRun } from './api/hydrate.ts';
export type { HelloSkew, StreamHub, StreamHubOptions } from './api/multiplex.ts';
export { openStreamHub } from './api/multiplex.ts';
// KAR-15.2 — the two halves of "the token is a header, never a URL": the SSE
// connector that can actually send one, and the first-run fragment handoff
// that gets the token into the tab without it ever reaching the server.
export type { StreamConnection, StreamOptions } from './api/stream.ts';
export { connectStream, streamUrl } from './api/stream.ts';
export { acquireToken, clearToken, readToken, TOKEN_STORAGE_KEY } from './api/token.ts';
