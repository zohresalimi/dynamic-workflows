/**
 * KAR-25.7 — the tab's one ledger connection, shared by every consumer.
 *
 * docs/11 §2/§3 and `./stream.ts`'s own module comment are one sentence:
 * **one SSE connection per tab, opened once, never a second.** Before this
 * story that was true by accident of routing — `../app/useRunFeed.ts` and
 * `../app/useRunList.ts` each opened their own `openLedgerStream`, and the
 * property held only because a run screen and the run list are never mounted
 * at the same time, so the previous view's `close()` always ran before the
 * next view's `open()`.
 *
 * KAR-25.7 breaks that accident on purpose. The approvals control lives in
 * the topbar, which is mounted for the whole life of the tab, and it has to
 * hear a `human.responded` frame for *any* run — so something has to hold a
 * global (`?runs=*`) subscription for the tab's whole life, at the same time
 * a run screen holds its own per-run one. Two `openLedgerStream` instances
 * doing that is not just a second socket: `./cursor.ts`'s persisted cursor is
 * keyed **per tab, not per stream** (`DeFlow.cursor`, one `sessionStorage`
 * key), so two live instances would each overwrite the other's progress in
 * it, and a reload could resume either one from a `seq` it never actually
 * applied — a silent gap, not a crash.
 *
 * So there is exactly one `LedgerStream`, created lazily on whichever call
 * arrives first and kept for the tab's life. It is never `close()`d by a
 * consumer giving up its own watch — `./stream.ts`'s own doc comment is
 * "opened once at app start", and nothing in this application closes the
 * app — only `resetSharedHub()` closes it, and that is for a spec's teardown,
 * never for production code.
 *
 * Every consumer multiplexes onto the one hub:
 *
 * - `watchRun` — `./feed.ts`'s job, now against the shared instance: hydrate
 *   the run, subscribe it, pour its events into a sink keyed by `runId`.
 *   `close()` unwatches the run and leaves the connection running for
 *   everyone else.
 * - `watchLifecycle` — `./runs-feed.ts`'s job, now against the shared
 *   instance: every frame on `?runs=*`, fanned out to as many listeners as
 *   ask, because the run list and the approvals store both need it and
 *   opening it twice is exactly the bug this module exists to prevent.
 *
 * `projections: []` throughout, for `./feed.ts`'s own reason: the fold
 * belongs to whichever sink is watching, never to the stream.
 *
 * This module is deliberately not the *only* way to reach `openLedgerStream`.
 * `./feed.ts`'s `openRunFeed` is unchanged and still opens its own, private
 * connection — `test/integration/gate-answer-fanout.test.ts` uses it to model
 * *two separate browser tabs*, which is precisely the one case where two
 * connections is the correct number.
 */
import type { Event } from '@DeFlow/core';
import type { EventSink } from './feed.ts';
import { type LedgerStream, type LedgerStreamState, openLedgerStream } from './stream.ts';

export interface SharedHubOptions {
  /** Defaults to the page's own origin plus `/api`, as `createClient` does. */
  readonly baseUrl?: string;
  /** Read per request, so a token acquired later is still attached. */
  readonly token?: () => string | null | undefined;
  /** The build this tab was served with, for the skew check. */
  readonly build?: string;
  /** Defaults to `sessionStorage`. Overridden in specs, and by nothing else —
   * see `./stream.ts`'s own `LedgerStreamOptions.storage`. */
  readonly storage?: Storage;
}

export interface SharedRunWatch {
  readonly runId: string;
  /** Resolves once the run is hydrated to its head and caught up. */
  readonly ready: Promise<void>;
  /** Unwatches this run. The hub itself stays open for every other consumer. */
  close(): void;
}

export interface SharedLifecycleWatch {
  /** Resolves once the hub's `hello` has arrived. */
  readonly ready: Promise<void>;
  /** Stops delivering to this listener. The hub itself stays open. */
  close(): void;
}

let hub: LedgerStream | null = null;
/** `runId` → the one sink watching it. `../stores/useRunStore.ts` is the only
 * production caller with a run open at a time, but this is a map rather than
 * a single slot so a second, independent watcher — a spec, an inspector that
 * grows its own watch later — is not a redesign away. */
const runSinks = new Map<string, EventSink>();
const lifecycleListeners = new Set<(event: Event) => void>();
const statusListeners = new Set<(state: LedgerStreamState) => void>();

function ensureHub(options: SharedHubOptions): LedgerStream {
  if (hub !== null) return hub;
  hub = openLedgerStream({
    global: true,
    projections: [],
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    onApplied: (event) => {
      runSinks.get(event.runId)?.applyEvent(event);
    },
    onLifecycle: (event) => {
      for (const listener of lifecycleListeners) listener(event);
    },
    onStateChange: (state) => {
      for (const listener of statusListeners) listener(state);
    },
  });
  return hub;
}

/**
 * Watches one run against the shared hub: hydrate, subscribe, pour events
 * into `sink`. Mirrors `./feed.ts`'s `openRunFeed` in everything but where the
 * connection comes from — see the module header for why that difference
 * matters.
 */
export function watchRun(
  runId: string,
  sink: EventSink,
  options: SharedHubOptions & { readonly onStatus?: (state: LedgerStreamState) => void } = {},
): SharedRunWatch {
  const stream = ensureHub(options);
  runSinks.set(runId, sink);
  if (options.onStatus !== undefined) statusListeners.add(options.onStatus);
  const ready = stream.watch(runId).then(() => undefined);
  return {
    runId,
    ready,
    close(): void {
      stream.unwatch(runId);
      // Only if this call is still the run's own sink: a route that closed
      // and reopened on the same run before this `close()` ran must not
      // evict the newer watch's sink out from under it.
      if (runSinks.get(runId) === sink) runSinks.delete(runId);
      if (options.onStatus !== undefined) statusListeners.delete(options.onStatus);
    },
  };
}

/**
 * Every frame on `?runs=*`, against the shared hub. Mirrors `./runs-feed.ts`'s
 * `openRunsFeed` in everything but where the connection comes from.
 */
export function watchLifecycle(
  onLifecycle: (event: Event) => void,
  options: SharedHubOptions & { readonly onStatus?: (state: LedgerStreamState) => void } = {},
): SharedLifecycleWatch {
  const stream = ensureHub(options);
  lifecycleListeners.add(onLifecycle);
  if (options.onStatus !== undefined) statusListeners.add(options.onStatus);
  return {
    ready: stream.opened(),
    close(): void {
      lifecycleListeners.delete(onLifecycle);
      if (options.onStatus !== undefined) statusListeners.delete(options.onStatus);
    },
  };
}

/**
 * Closes the shared hub and forgets every registered consumer.
 *
 * Test-only. Production code never calls this — see the header comment on
 * why the hub outlives every individual `close()` — but a spec file has to
 * start the next case from zero connections, and vitest's browser project
 * reuses one page across a whole file's tests.
 */
export function resetSharedHub(): void {
  hub?.close();
  hub = null;
  runSinks.clear();
  lifecycleListeners.clear();
  statusListeners.clear();
}
