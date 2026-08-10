/**
 * Talking to a DeFlowd that authenticates (KAR-15.2).
 *
 * Every route but `GET /api/health` needs `Authorization: Bearer <token>`, so
 * every spec that drives the HTTP surface needs a token — and a spec that
 * forgot one would fail with a 401 that reads like a routing bug. This is the
 * one place that knows how the header is spelled.
 *
 * `authorizedFetch` returns a `fetch`-shaped function deliberately: a spec
 * assigns it to a local `fetch` and its call sites read exactly as they did
 * before the daemon had auth at all, so the diff that introduced the token is
 * two lines per file rather than one per request.
 *
 * The token is a fixed, obviously-synthetic string. It is **not** a token any
 * daemon ever mints — `mintDaemonToken()` is 32 random bytes — so it cannot be
 * confused for a real credential if it ever turns up in a log.
 */

/** The bearer token the specs boot their daemons with. */
export const TEST_DAEMON_TOKEN = 'test-daemon-token-not-a-real-credential';

/**
 * `fetch`'s own parameter types, read off the global rather than named.
 *
 * `RequestInfo` and `HeadersInit` are DOM globals, and this workspace compiles
 * with `lib: ["es2024"]` and `types: ["node"]` — no DOM. Deriving them from
 * `globalThis.fetch` keeps the signature exactly as wide as the function being
 * wrapped, and it cannot drift from it.
 */
type FetchParams = Parameters<typeof globalThis.fetch>;
type FetchHeaders = NonNullable<FetchParams[1]>['headers'];

/** A `fetch` that attaches the daemon's bearer token to every request. */
export function authorizedFetch(token: string = TEST_DAEMON_TOKEN): typeof globalThis.fetch {
  return (input: FetchParams[0], init?: FetchParams[1]) =>
    globalThis.fetch(input, {
      ...init,
      headers: { ...headersOf(init?.headers), Authorization: `Bearer ${token}` },
    });
}

/** `HeadersInit` in its three shapes, as a plain record. */
function headersOf(headers: FetchHeaders): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  // The record form permits `undefined` values — `{ 'If-None-Match': undefined }`
  // is a legal way to say "no header" — and those are dropped rather than
  // stringified into the literal text "undefined".
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
