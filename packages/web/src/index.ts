/**
 * @DeFlow/web — the Vue 3 + Vite SPA: the ledger-projection Pinia store and the
 * nine P0 views.
 *
 * It imports from @DeFlow/core for types only. vue, pinia, @vue-flow/core,
 * xterm.js and shiki arrive with EPIC-16.
 *
 * The one thing it exports today is the API client (KAR-15.1): `packages/cli`
 * imports this module rather than writing a second client, so `deflow run` and
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
// KAR-15.7 — the client half of the snapshot endpoint: the only way either
// client materialises the state at a `seq`, so scrubbing a multi-hour run is a
// request rather than a fold in the tab (docs/11 §7.3).
export type { Scrubber, ScrubberOptions, ScrubPosition } from './api/scrub.ts';
export { createScrubber } from './api/scrub.ts';
// KAR-15.2 — the two halves of "the token is a header, never a URL": the SSE
// connector that can actually send one, and the first-run fragment handoff
// that gets the token into the tab without it ever reaching the server.
export type { StreamConnection, StreamOptions } from './api/stream.ts';
export { connectStream, streamUrl } from './api/stream.ts';
export { acquireToken, clearToken, readToken, TOKEN_STORAGE_KEY } from './api/token.ts';
// KAR-16.2 — the tab's one connection to the ledger, and the two pieces under
// it: the persisted cursor that makes a reload and a reconnect resume the same
// way, and the dispatcher the seven projections of KAR-16.3 plug into.
export type { LedgerApply, LedgerApplyOptions, Projection, RunLedger } from './ledger/apply.ts';
export { createLedgerApply } from './ledger/apply.ts';
export type { Cursor, HydrateToCursorOptions } from './ledger/cursor.ts';
export { CURSOR_STORAGE_KEY, hydrateToCursor, openCursor } from './ledger/cursor.ts';
export type {
  ConnectionStatus,
  FatalState,
  LedgerStream,
  LedgerStreamOptions,
  LedgerStreamState,
} from './ledger/stream.ts';
export { openLedgerStream, RECONNECT_INTERVAL_MS } from './ledger/stream.ts';
// KAR-17.5 / KAR-19.4 — the `io_chunk` tail's client half: how a surface asks
// for the tail or for what has arrived since a cursor, and how it parses the
// answer. Exported for `deflow run`, which follows a live node's output over
// the same endpoint the panel does — `packages/cli/src/run/run.ts`'s rule is
// that there is **no second protocol implementation**, and the tail is a
// protocol like the stream is.
export type { IoChunkLine, IoStream, OutputRenderer } from './lib/node-output.ts';
export {
  ENDED_WITHOUT_RESULT,
  IO_TAIL_CHUNKS,
  ioFollowQuery,
  ioTailQuery,
  mergeIoChunks,
  NO_OUTPUT_AT_ALL,
  outputRendererFor,
  parseIoNdjson,
} from './lib/node-output.ts';
