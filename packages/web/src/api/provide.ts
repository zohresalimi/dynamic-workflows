/**
 * KAR-16.1 — how a view gets hold of the typed client.
 *
 * One client per application, provided at the root and injected where it is
 * needed, rather than a module-level singleton. Three reasons, in order of how
 * much each one costs when it is got wrong:
 *
 * 1. A singleton fixes the base URL at import time, and `packages/cli` imports
 *    this same `../api/` directory against whatever `--daemon` names.
 * 2. A spec that wants to assert *which request a view made* has to be able to
 *    hand the view a client with its own `fetch`. Monkey-patching
 *    `globalThis.fetch` would work once and then leak across files.
 * 3. The token is read per request through a function, so a tab that acquires
 *    its token after the client was built — the fragment handoff, or the paste
 *    path in `../views/TokenRequired.vue` — does not need a second client.
 */
import { type App, type InjectionKey, inject } from 'vue';
import { type ApiClient, createClient } from './client.ts';
import { readToken } from './token.ts';

export const API_CLIENT: InjectionKey<ApiClient> = Symbol('DeFlow.apiClient');

export function provideApiClient(app: App<unknown>, client: ApiClient): void {
  app.provide(API_CLIENT, client);
}

/**
 * The application's client.
 *
 * Falls back to a real one against the page's own origin, which is what the
 * shipped app uses: it is served by the daemon, on one port and one origin, so
 * there is no base URL to configure (D10, ADR 0011).
 */
export function useApiClient(): ApiClient {
  return inject(API_CLIENT, null) ?? createClient({ token: readToken });
}
