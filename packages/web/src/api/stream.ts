/**
 * KAR-15.2 AC8/AC9 — the SSE connection, with the bearer token as a **header**.
 *
 * This module is the reason `eventsource-client` is a dependency at all.
 * Native `EventSource` cannot send custom headers — the API has no mechanism
 * for it — so a design built on it forces the token into the query string,
 * where it lands in shell history, terminal scrollback, browser history, the
 * `Referer` header of any outbound link, and any access log anyone ever adds
 * (docs/11-api-and-realtime.md §8.1). For a long-lived token that authorises
 * spawning processes on the user's machine, that is unacceptable.
 *
 * Two libraries were considered and rejected in docs/02 §4:
 * `@microsoft/fetch-event-source` is abandoned (2.0.1, 2021-04-25), and
 * `eventsource` is a spec-faithful polyfill that therefore *inherits* the
 * no-headers limitation — its own README points at this one.
 *
 * What this file owns is the **transport**: the URL, the header and the
 * lifecycle. The reconnection policy, the cursor persistence and the projection
 * store are EPIC-16's (KAR-16.2, KAR-16.4). `?since=` is here, and it is the
 * *only* cursor this client has — see `connectStream` for why the header path
 * is the browser's alone and why the query parameter is re-stamped on every
 * attempt (KAR-15.4).
 */
import {
  createEventSource,
  type EventSourceClient,
  type EventSourceMessage,
  type FetchLike,
} from 'eventsource-client';
import { defaultBaseUrl } from './client.ts';

export interface StreamOptions {
  /** Defaults to the page's own origin plus `/api`, as `createClient` does. */
  readonly baseUrl?: string;
  /** The runs this connection multiplexes. Empty is a valid subscription. */
  readonly runs: readonly string[];
  /**
   * The cursor to resume from. `0` means "everything", never "from now".
   *
   * A **function** where the cursor moves, which is every case but a one-shot
   * connection: it is read again on every attempt, so a reconnect resumes from
   * what this tab has actually applied rather than from where it first opened
   * (KAR-15.4 AC1/AC2). See `connectStream` for why a fixed URL is a bug here.
   */
  readonly since: number | (() => number);
  /** Read per connection attempt, so a token acquired later is still attached. */
  readonly token?: () => string | null | undefined;
  /**
   * The library's own message type rather than a structural copy of it: under
   * `exactOptionalPropertyTypes`, `event?: string` and `event?: string |
   * undefined` are different types, and a hand-written copy silently stops
   * matching the callback `createEventSource` actually calls.
   */
  readonly onMessage?: (event: EventSourceMessage) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: () => void;
  /** Injected in tests, and by nothing else. */
  readonly fetch?: FetchLike;
}

export interface StreamConnection {
  close(): void;
}

/**
 * `"<base>/stream?runs=<ids>&since=<seq>"` — two parameters, and never a third.
 *
 * The `runs` parameter is always present even when nothing is subscribed, so
 * the request line has one shape: a connection with no runs is the dev loop's
 * hello-and-keepalive stream, not a different endpoint.
 */
export function streamUrl(baseUrl: string, runs: readonly string[], since: number): string {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/stream`);
  url.searchParams.set('runs', runs.join(','));
  url.searchParams.set('since', String(since));
  return url.toString();
}

/**
 * Opens the multiplexed stream.
 *
 * The `Authorization` header is built per attempt from `options.token()`, and
 * omitted entirely when there is no token — an empty `Bearer ` reads as a
 * malformed credential rather than as an anonymous request, and the daemon
 * would answer `bad_token` where `missing_token` is the truth.
 *
 * ## Why `?since=` is rewritten on every attempt (KAR-15.4)
 *
 * `createEventSource` takes a URL **once** and reuses it for every reconnect.
 * That is fine for a client whose cursor is the browser's `Last-Event-ID`, and
 * wrong for this one, whose cursor is its own: a URL built at open time carries
 * the cursor the tab had *then*, and the server's precedence is `since` >
 * `Last-Event-ID` (docs/11 §4.1) — so on a reconnect the stale query parameter
 * beats the fresher header the library would have sent, and everything between
 * the two arrives a second time.
 *
 * So the URL is stamped per attempt, through the `fetch` the library calls.
 * Wrapping `fetch` rather than reconnecting by hand keeps the retry policy
 * where it belongs — the library owns backoff, and EPIC-16 owns the policy over
 * it — while making every request carry the cursor as of the moment it is sent.
 *
 * `initialLastEventId` is deliberately **not** set. The header is the browser's
 * mechanism, and this client's cursor lives in `?since=` exclusively, which is
 * what makes the UI and `DeFlow`'s CLI — which has no `Last-Event-ID`
 * mechanism at all — resume through one code path rather than two (AC9).
 */
export function connectStream(options: StreamOptions): StreamConnection {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const token = options.token?.();
  const cursor =
    typeof options.since === 'function' ? options.since : () => options.since as number;
  const fetching: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  const client: EventSourceClient = createEventSource({
    url: streamUrl(baseUrl, options.runs, cursor()),
    ...(token === null || token === undefined || token === ''
      ? {}
      : { headers: { Authorization: `Bearer ${token}` } }),
    fetch: (url, init) => fetching(withCursor(url, cursor()), init),
    ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
    ...(options.onConnect === undefined ? {} : { onConnect: options.onConnect }),
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
  });

  return { close: () => client.close() };
}

/** `url` with `since` set to `cursor` — the one parameter an attempt rewrites. */
function withCursor(url: string | URL, cursor: number): string {
  const stamped = new URL(url.toString());
  stamped.searchParams.set('since', String(cursor));
  return stamped.toString();
}
