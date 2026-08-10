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
 * lifecycle. The reconnection policy, the cursor persistence and the
 * projection store are EPIC-16's (KAR-16.2, KAR-16.4); `initialLastEventId`
 * and `?since=` are here because the resume contract is the server's, and both
 * halves of it have to be reachable from the client the daemon ships with.
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
  /** The cursor to resume from. `0` means "everything", never "from now". */
  readonly since: number;
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
 */
export function connectStream(options: StreamOptions): StreamConnection {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const token = options.token?.();

  const client: EventSourceClient = createEventSource({
    url: streamUrl(baseUrl, options.runs, options.since),
    ...(token === null || token === undefined || token === ''
      ? {}
      : { headers: { Authorization: `Bearer ${token}` } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
    ...(options.onConnect === undefined ? {} : { onConnect: options.onConnect }),
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
    ...(options.since > 0 ? { initialLastEventId: String(options.since) } : {}),
  });

  return { close: () => client.close() };
}
