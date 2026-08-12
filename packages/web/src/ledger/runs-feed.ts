/**
 * KAR-19.1 AC5 — the `?runs=*` subscription the root route lives on.
 *
 * `../api/multiplex.ts` has carried the global topic since KAR-15.3 and
 * `./stream.ts` has been able to open on it since KAR-16.2 — with `global:
 * true` and `onLifecycle` — and nothing has ever asked for one. This module is
 * that caller, and it is a module for the reason `./feed.ts` is one: the join
 * between a socket and a projection is the thing that keeps going missing, so it
 * is somewhere a reader can find it.
 *
 * It watches **no run**. `openLedgerStream`'s per-run machinery — hydrate,
 * `caught_up`, the per-run projections — is untouched: a lifecycle frame carries
 * the id of the run it happened to, no panel is watching that run, so it arrives
 * as `onUnrouted` and comes out here. That is exactly the design §3 describes,
 * and it is why a tab showing forty runs costs one connection.
 */
import type { Event } from '@DeFlow/core';
import { type LedgerStreamState, openLedgerStream } from './stream.ts';

export interface RunsFeedOptions {
  /** Every frame on the global topic, already parsed. */
  readonly onLifecycle: (event: Event) => void;
  /** Defaults to the page's own origin plus `/api`, as the daemon serves it. */
  readonly baseUrl?: string;
  /** Read per request, so a token acquired after this opened still attaches. */
  readonly token?: () => string | null | undefined;
  readonly build?: string;
  readonly onStatus?: (state: LedgerStreamState) => void;
}

export interface RunsFeed {
  /** Resolves once the connection's `hello` has arrived. */
  readonly ready: Promise<void>;
  close(): void;
}

export type RunsFeedFactory = (options: RunsFeedOptions) => RunsFeed;

export function openRunsFeed(options: RunsFeedOptions): RunsFeed {
  const stream = openLedgerStream({
    global: true,
    projections: [],
    onLifecycle: options.onLifecycle,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.onStatus === undefined ? {} : { onStateChange: options.onStatus }),
  });

  return {
    ready: stream.opened(),
    close: () => {
      stream.close();
    },
  };
}
