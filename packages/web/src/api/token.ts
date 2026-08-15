/**
 * KAR-15.2 AC8 — the browser end of the first-run handoff.
 *
 * `deflow up` prints `http://127.0.0.1:7777/#token=<token>`. Fragments are
 * **never sent to the server**, which is the entire reason the token travels
 * there rather than in a query string: it cannot land in the daemon's access
 * log, in a proxy's, in browser history, or in the `Referer` header of any
 * outbound link (docs/11-api-and-realtime.md §8.1).
 *
 * The tab's job is to take it out of the URL as fast as possible: read it once,
 * put it in `sessionStorage`, and rewrite the history entry with
 * `history.replaceState` so the address bar — and therefore anything the user
 * copies, bookmarks or pastes into a bug report — no longer carries it. From
 * then on it is an `Authorization` header, on every request including the SSE
 * connection (./stream.ts).
 *
 * `sessionStorage` rather than `localStorage`: the token belongs to this daemon
 * life and this tab, and a credential that outlives the tab that acquired it is
 * a credential nobody remembers is there.
 *
 * Every browser object is read structurally off `globalThis`, the same way
 * `./client.ts` reads `location.origin` and for the same reason: this module is
 * compiled in three places — the browser bundle, `packages/cli` with only
 * Node's types, and the daemon's own specs — and only one of them has a DOM
 * lib. Outside a browser every function here is a no-op that answers `null`.
 */

/** Where the token lives for the life of the tab. */
export const TOKEN_STORAGE_KEY = 'DeFlow.daemonToken';

/**
 * The handoff fragment, and only that shape.
 *
 * Anchored so the UI's own route fragments (`#/runs/r_01JXQ`) are left alone —
 * consuming one of those would both fail to find a token and break routing.
 * The character class is base64url's, which is what `mintDaemonToken()`
 * produces.
 */
const HANDOFF = /^#token=([A-Za-z0-9_-]+)$/;

interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface TokenLocation {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

interface TokenHistory {
  replaceState(data: unknown, unused: string, url?: string): void;
}

interface Browser {
  readonly sessionStorage?: TokenStorage;
  readonly location?: TokenLocation;
  readonly history?: TokenHistory;
}

const browser = (): Browser => globalThis as Browser;

/**
 * The token this tab already holds, without touching the URL.
 *
 * This is what `createClient({ token: readToken })` is given: a function rather
 * than a string, so a tab that acquires its token after the client was
 * constructed does not need a second client.
 */
export function readToken(): string | null {
  return browser().sessionStorage?.getItem(TOKEN_STORAGE_KEY) ?? null;
}

/** Forgets it. The tab is anonymous again until the next handoff. */
export function clearToken(): void {
  browser().sessionStorage?.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * Reads the handoff fragment **once**, stores it, and strips it from the
 * address bar. Idempotent: after the first call the fragment is gone and this
 * answers out of `sessionStorage`.
 *
 * Call it before the first request of the page's life.
 */
export function acquireToken(): string | null {
  const { location, history, sessionStorage } = browser();
  if (location === undefined || sessionStorage === undefined) return null;

  const handoff = HANDOFF.exec(location.hash);
  const token = handoff?.[1];
  if (token !== undefined) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    // `replaceState` rather than assigning `location.hash = ''`: assigning
    // leaves a bare `#` behind *and* pushes a history entry, so the token
    // stays one Back away.
    history?.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  return readToken();
}
