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
  /**
   * The runs this connection multiplexes. Empty is a valid subscription.
   *
   * A **function** where the filter moves, which is every case but a one-shot
   * connection. `POST …/subscribe` mutates the filter of one *connection*, and
   * a reconnect is a new connection: it is served from its query string alone,
   * so a client that opened with `runs=` and subscribed afterwards would come
   * back from a blip subscribed to nothing at all — and the symptom is silence,
   * not an error (KAR-16.2 AC5).
   */
  readonly runs: readonly string[] | (() => readonly string[]);
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
  /**
   * An SSE comment line — `: keepalive` and nothing else, in this protocol.
   *
   * A comment carries no field, so every client ignores it and no reducer ever
   * sees one; it is here so a tab can *count* them, which is how KAR-16.2
   * asserts that fifteen idle minutes produce no reconnect rather than
   * asserting it about the absence of a timer nobody wrote.
   */
  readonly onComment?: (comment: string) => void;
  /**
   * KAR-16.2 AC10 — the reconnection policy, observed.
   *
   * `delay` is the library's current interval, which starts at 2,000 ms and is
   * replaced by whatever the server's `retry:` line last said. Exposing it is
   * what lets a spec assert the two agree instead of assuming they do.
   */
  readonly onScheduleReconnect?: (info: { delay: number }) => void;
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
 *
 * ## Why `onDisconnect` is derived rather than forwarded
 *
 * **Verified 2026-08-11 against eventsource-client@1.2.0's shipped code.** The
 * library calls `onDisconnect` from exactly one branch: the one where
 * `reader.read()` resolves `done: true`, i.e. a response body the server ended
 * *cleanly*. A **destroyed** socket does not end a body — it rejects the read,
 * and that lands in the library's `.catch`, which calls `scheduleReconnect()`
 * and nothing else.
 *
 * So on every failure that is not a polite `res.end()` — a lid closing, Wi-Fi
 * going, a daemon restarting, `closeAllConnections()` — a forwarded
 * `onDisconnect` never fires, and a client built on it reports a healthy
 * connection for the whole outage. That is the plausible-but-wrong picture NF10
 * exists to prevent, and it is the *common* case rather than the exotic one.
 *
 * `scheduleReconnect` is the one signal the library raises on **both** paths, so
 * the disconnect is derived from whichever arrives first and de-duplicated
 * against the other. `connected` is reset by `onConnect`, which the library
 * calls on every response, so the pair stays balanced across any number of
 * reconnects.
 */
export function connectStream(options: StreamOptions): StreamConnection {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const token = options.token?.();
  const cursor =
    typeof options.since === 'function' ? options.since : () => options.since as number;
  const filter =
    typeof options.runs === 'function' ? options.runs : () => options.runs as readonly string[];
  const fetching: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  /** Whether a response is currently open, as the two callbacks below see it. */
  let connected = false;
  const disconnected = (): void => {
    if (!connected) return;
    connected = false;
    options.onDisconnect?.();
  };

  const client: EventSourceClient = createEventSource({
    url: streamUrl(baseUrl, filter(), cursor()),
    ...(token === null || token === undefined || token === ''
      ? {}
      : { headers: { Authorization: `Bearer ${token}` } }),
    fetch: (url, init) => fetching(stamped(url, filter(), cursor()), init),
    ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
    onConnect: () => {
      connected = true;
      options.onConnect?.();
    },
    onDisconnect: disconnected,
    ...(options.onComment === undefined ? {} : { onComment: options.onComment }),
    onScheduleReconnect: (info) => {
      // Ordered so a listener never sees a reconnect scheduled for a connection
      // it still believes is up.
      disconnected();
      options.onScheduleReconnect?.(info);
    },
  });

  return { close: () => client.close() };
}

/** `url` with both parameters as of the moment the request is actually sent. */
function stamped(url: string | URL, runs: readonly string[], cursor: number): string {
  const next = new URL(url.toString());
  next.searchParams.set('runs', runs.join(','));
  next.searchParams.set('since', String(cursor));
  return next.toString();
}
