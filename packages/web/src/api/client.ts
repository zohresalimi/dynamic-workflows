/**
 * The typed client — one module, two consumers (docs/11-api-and-realtime.md §9).
 *
 * `hc<ApiType>` derives the whole client from the daemon's own chained route
 * definitions. There is no codegen step, no OpenAPI document and no generated
 * client anywhere in this repository, and that is the point: because
 * `@DeFlow/daemon`'s `exports` field points at `./src/index.ts` inside the
 * workspace, this file typechecks against **live daemon source**, so renaming a
 * field on a daemon response type breaks the UI *and* the CLI build in the same
 * commit that renamed it.
 *
 * The import of `ApiType` is `import type`, and with `verbatimModuleSyntax` on
 * that is erased entirely: no daemon code reaches the browser bundle. `hono/client`
 * is the only runtime dependency this module adds, and it runs in both a
 * browser and Node — which is what lets `DeFlow run` be a caller of this exact
 * module rather than a second implementation of the same protocol.
 *
 * **The token is never in the URL.** It is attached as an `Authorization`
 * header, on every request, because a token in a query string lands in shell
 * history, terminal scrollback, browser history, `Referer` headers and any
 * access log anyone ever adds (docs/15-security-model.md §3). The `token`
 * option is a *function* rather than a string so a tab that acquires its token
 * after the client was constructed — the fragment handoff of KAR-15.2 — does
 * not need a second client.
 */
import type { ApiType } from '@DeFlow/daemon';
import type { ClientRequestOptions } from 'hono/client';
import { hc } from 'hono/client';

/** Where the API is mounted. One origin, no CORS, no proxy (D10, ADR 0011). */
export const API_BASE_PATH = '/api';

/** The daemon's own default port, for a caller with no origin of its own. */
export const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:7777';

export interface ApiClientOptions {
  /**
   * The API's base URL, `/api` included. Defaults to the page's own origin in a
   * browser and to the daemon's default port outside one — so a tab needs no
   * configuration at all, and `DeFlow run` needs only `--daemon` when the port
   * is not the default.
   */
  readonly baseUrl?: string;
  /** Read on every request, so a token acquired later still gets attached. */
  readonly token?: () => string | null | undefined;
  /** Injected in tests, and by nothing else. */
  readonly fetch?: ClientRequestOptions['fetch'];
}

export type ApiClient = ReturnType<typeof hc<ApiType>>;

/**
 * The page's own origin where there is one.
 *
 * Read off `globalThis` rather than `window` and typed structurally, because
 * this module is compiled in three places — the browser bundle, `packages/cli`
 * with only Node's types, and the daemon's own specs — and only one of them has
 * a DOM lib.
 */
function pageOrigin(): string | null {
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  return typeof location?.origin === 'string' ? location.origin : null;
}

export function defaultBaseUrl(): string {
  return `${pageOrigin() ?? DEFAULT_DAEMON_ORIGIN}${API_BASE_PATH}`;
}

/**
 * A client for the daemon at `baseUrl`.
 *
 * Constructed rather than exported as a singleton: the UI has one per tab, the
 * CLI makes one per command against whatever `--daemon` names, and a test makes
 * one per case with its own `fetch`. A module-level `rpc` would force all three
 * to share one base URL, which the CLI in particular cannot.
 */
export function createClient(options: ApiClientOptions = {}): ApiClient {
  const token = options.token;

  return hc<ApiType>(options.baseUrl ?? defaultBaseUrl(), {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    headers: () => {
      const value = token?.();
      return value === null || value === undefined || value === ''
        ? {}
        : { Authorization: `Bearer ${value}` };
    },
  });
}
