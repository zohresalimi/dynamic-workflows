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
