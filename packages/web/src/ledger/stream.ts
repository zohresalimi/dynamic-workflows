/**
 * KAR-16.2 — the tab's one connection to the ledger
 * (docs/12-frontend-architecture.md §3.2, docs/11-api-and-realtime.md §2, §4, §5).
 *
 * One SSE connection per tab, opened once, and never a second. That is an
 * architecture constraint rather than a tuning knob: `DeFlowd` is HTTP/1.1,
 * browsers cap concurrent connections per origin at about six, and an SSE
 * connection never closes. A tab that opened one per run panel reaches the cap,
 * and what happens next is **not an error** — every subsequent `fetch` queues
 * behind the streams forever, which reads as *"the daemon hung"* against a
 * perfectly healthy daemon.
 *
 * This module is the assembly. The pieces below it each own one thing and are
 * shared with `DeFlow run` (docs/11 §7.2), which is why they live in `../api/`:
 *
 * - `../api/hydrate.ts` — the cold-start loop, paged on the server's cursor.
 * - `../api/multiplex.ts` — the connection, the filter mutation, the fan-out.
 * - `../api/dispatch.ts` — named frame or ledger event, known kind or not.
 * - `./cursor.ts` — the persisted `seq`, and why the client keeps its own.
 * - `./apply.ts` — the per-run projection sets and the idempotency guard.
 *
 * ## The order is the correctness requirement
 *
 * **Hydrate, then stream.** A panel calls `GET /api/runs/:id/events?since=<cursor>`
 * until `more` is false and only then is the socket opened, at the cursor that
 * loop ended on. Not an optimisation (§4.1): a tab that opened the stream first
 * and hydrated alongside it has no defined seam between the two, and the events
 * that land in the overlap are the ones nobody notices are missing.
 *
 * That is why no connection exists until the first `watch()`. A hub opened at
 * construction would be opened at `since=0` on a cold tab, and would then
 * re-deliver the four thousand events the hydrate had just applied.
 *
 * ## What this surfaces, and why each one is a different state
 *
 * `hello.daemonEpoch` moving means the daemon was **replaced** under an open
 * tab: the ledger is still the truth, this tab's cursor is still valid, and
 * nothing is reset — a restart is not a new run. `hello.build` differing means
 * this tab is running JavaScript from another release, and the only complete
 * answer is a reload. And a `fatal` frame carrying `bad_token` or
 * `epoch_mismatch` means retrying can only ever be refused, so it stops; every
 * other code, `internal` included, is worth reconnecting for.
 */
import type { Event } from '@DeFlow/core';
import { createClient } from '../api/client.ts';
import type { ControlFrame } from '../api/dispatch.ts';
import type { HydratePage } from '../api/hydrate.ts';
import { openStreamHub, type StreamHub } from '../api/multiplex.ts';
import { createLedgerApply, type Projection, type RunLedger } from './apply.ts';
import { type Cursor, hydrateToCursor, openCursor } from './cursor.ts';

/**
 * §3.2 rule 2 — the interval the daemon writes as `retry: 2000`, once,
 * immediately after the headers.
 *
 * Stated here as well so the two can be *asserted* equal rather than assumed
 * so: `eventsource-client` starts at this value and replaces it with whatever
 * the server's `retry:` line says, which means a client whose policy disagreed
 * would silently adopt the server's and the disagreement would never surface.
 */
export const RECONNECT_INTERVAL_MS = 2000;

export type ConnectionStatus =
  /** No connection yet, because no panel has asked for one. */
  | 'idle'
  /** Folding a run through the REST endpoint, before any socket. */
  | 'hydrating'
  /** The socket is open, or opening, and every watched run is caught up. */
  | 'live'
  /** Broken, and the client's own reconnection policy is running. */
  | 'reconnecting'
  /** Terminally stopped: a `fatal` this client must not retry, or `close()`. */
  | 'stopped';

export interface FatalState {
  readonly code: string;
  /** `bad_token` and `epoch_mismatch`, and nothing else (§10). */
  readonly terminal: boolean;
}

export interface LedgerStreamState {
  readonly status: ConnectionStatus;
  /** The daemon epoch moved between two hellos: it restarted under this tab. */
  readonly restarted: boolean;
  /** This tab's build and the daemon's disagree, or the epoch was rejected. */
  readonly reloadRequired: boolean;
  /** The last `fatal` frame, kept rather than cleared so a view can explain. */
  readonly fatal: FatalState | null;
  readonly cursor: number;
  /** Per run, how far the cold hydrate has got. `headSeq` is the denominator. */
  readonly hydrating: ReadonlyMap<string, HydratePage>;
  /** The runs the daemon has said `caught_up` for. */
  readonly live: readonly string[];
  /** Connections established over this tab's life. One, unless it dropped. */
  readonly connects: number;
  /** Every reconnect interval the library scheduled, as it scheduled it. */
  readonly reconnectDelays: readonly number[];
  /** `: keepalive` comments consumed. They reach no reducer and no timer. */
  readonly keepalives: number;
}

export interface LedgerStreamOptions {
  /** Defaults to the page's own origin plus `/api`. */
  readonly baseUrl?: string;
  /** Read per request, so a token acquired later is still attached. */
  readonly token?: () => string | null | undefined;
  /** The build this tab was served with. Compared against `hello.build`. */
  readonly build?: string;
  /** Defaults to `sessionStorage`: the cursor is per tab, never per browser. */
  readonly storage?: Storage;
  /** The seven pure reducers of KAR-16.3. Each run gets its own instances. */
  readonly projections: readonly Projection<unknown>[];
  /** Open on `runs=*` as well — the four lifecycle kinds, not every run. */
  readonly global?: boolean;
  /** Every event actually applied, once. The debug ring's feed (KAR-16.4). */
  readonly onApplied?: (event: Event) => void;
  /** A `runs=*` frame: it belongs to a run this tab has no panel for. */
  readonly onLifecycle?: (event: Event) => void;
  /** One call per hydrate page, so a view can render an honest denominator. */
  readonly onHydrateProgress?: (page: HydratePage & { readonly runId: string }) => void;
  /** Called whenever any field of `state()` changes. */
  readonly onStateChange?: (state: LedgerStreamState) => void;
}

export interface LedgerStream {
  /** Ensures the connection and resolves on its `hello`. */
  opened(): Promise<void>;
  /**
   * Opens a run panel: hydrate to the head, then subscribe, then wait for the
   * daemon's `caught_up` for this run. Resolves with the run's projections.
   */
  watch(runId: string): Promise<RunLedger>;
  /** Closes a panel. The server-side filter is left alone. */
  unwatch(runId: string): void;
  ledger(runId: string): RunLedger | undefined;
  runs(): readonly string[];
  state(): LedgerStreamState;
  cursor(): number;
  streamId(): string | null;
  /** Connections this tab has *opened*. The property is that it is one. */
  connections(): number;
  close(): void;
}

export function openLedgerStream(options: LedgerStreamOptions): LedgerStream {
  const cursor: Cursor = openCursor(options.storage ?? sessionStorage);
  const client = createClient({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.token === undefined ? {} : { token: options.token }),
  });

  const ledgers = createLedgerApply({
    projections: options.projections,
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
  });

  const hydrating = new Map<string, HydratePage>();
  const live = new Set<string>();
  /** One waiter per run, settled by that run's `caught_up` frame. */
  const awaiting = new Map<string, () => void>();
  const reconnectDelays: number[] = [];

  let hub: StreamHub | null = null;
  let connected = false;
  let connects = 0;
  let keepalives = 0;
  let restarted = false;
  let reloadRequired = false;
  let fatal: FatalState | null = null;
  let closed = false;

  const status = (): ConnectionStatus => {
    if (closed || fatal?.terminal === true) return 'stopped';
    if (hydrating.size > 0) return 'hydrating';
    if (hub === null) return 'idle';
    return connected ? 'live' : 'reconnecting';
  };

  const state = (): LedgerStreamState => ({
    status: status(),
    restarted,
    reloadRequired,
    fatal,
    cursor: cursor.read(),
    hydrating: new Map(hydrating),
    live: [...live],
    connects,
    reconnectDelays: [...reconnectDelays],
    keepalives,
  });

  const changed = (): void => options.onStateChange?.(state());

  const onControl = (frame: ControlFrame): void => {
    if (frame.name !== 'caught_up') return;
    const runId = (frame.payload as { runId?: unknown } | null)?.runId;
    if (typeof runId !== 'string') return;
    live.add(runId);
    awaiting.get(runId)?.();
    changed();
  };

  const ensureHub = (): StreamHub => {
    if (hub !== null) return hub;
    hub = openStreamHub({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.build === undefined ? {} : { build: options.build }),
      // Opened at what this tab has already applied, which after the first
      // hydrate is the head of the run rather than zero.
      since: cursor.read(),
      ...(options.global === true ? { runs: ['*'] } : {}),
      onControl,
      onCursor: (seq) => {
        cursor.advance(seq);
      },
      onUnrouted: (event) => options.onLifecycle?.(event),
      onConnect: () => {
        connected = true;
        connects += 1;
        changed();
      },
      onDisconnect: () => {
        connected = false;
        // The runs are re-backfilled from the cursor on the way back in, so
        // none of them is "caught up" until the daemon says so again.
        live.clear();
        changed();
      },
      onComment: () => {
        // A comment carries no field: it reaches no reducer, resets no timer of
        // this client's — it has none — and exists so that nothing else in the
        // path sees a silent socket.
        keepalives += 1;
        changed();
      },
      onScheduleReconnect: ({ delay }) => {
        reconnectDelays.push(delay);
        changed();
      },
      onSkew: (skew) => {
        restarted = restarted || skew.restarted;
        reloadRequired = reloadRequired || skew.buildChanged;
        changed();
      },
      onFatal: (code, terminal) => {
        fatal = { code, terminal };
        // A superseded epoch is the one fatal a reload actually fixes: the tab
        // is talking to a daemon that has been replaced, and its next write
        // would be refused for the same reason.
        if (code === 'epoch_mismatch') reloadRequired = true;
        changed();
      },
    });
    changed();
    return hub;
  };

  const caughtUp = (runId: string): Promise<void> =>
    live.has(runId)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          awaiting.set(runId, resolve);
        });

  return {
    state,
    cursor: () => cursor.read(),
    runs: () => ledgers.runs(),
    ledger: (runId) => ledgers.ledger(runId),
    streamId: () => hub?.streamId() ?? null,
    connections: () => (hub === null ? 0 : hub.connections()),
    async opened() {
      refuseWhenClosed(closed);
      await ensureHub().opened();
    },
    unwatch(runId) {
      hub?.unwatch(runId);
      ledgers.unwatch(runId);
      live.delete(runId);
      changed();
    },
    async watch(runId) {
      refuseWhenClosed(closed);
      const run = ledgers.watch(runId);

      // Phase 1 — the REST hydrate, to the head of this run's log. Nothing is
      // open yet on a cold tab, which is the whole point of the ordering.
      hydrating.set(runId, { cursor: cursor.read(), headSeq: 0, more: true, applied: 0 });
      changed();
      try {
        await hydrateToCursor(client, runId, cursor, {
          // From what *this* panel holds, not from what the tab last streamed.
          // A tab that reloaded has a persisted cursor and no projections, and
          // resuming the fold from that cursor would render the tail of a run
          // as if it were the whole of it — a plausible, wrong picture, which
          // is the one failure NF10 exists to prevent.
          from: run.appliedSeq(),
          apply: (event) => {
            ledgers.apply(event);
          },
          onProgress: (page) => {
            hydrating.set(runId, page);
            options.onHydrateProgress?.({ ...page, runId });
            changed();
          },
        });
      } finally {
        hydrating.delete(runId);
        changed();
      }

      // Phase 2 — the connection, at the cursor phase 1 ended on, and then one
      // filter mutation rather than a second socket.
      const opening = caughtUp(runId);
      await ensureHub().watch(runId, (event) => {
        ledgers.apply(event);
      });
      // `subscribed` says the daemon accepted the filter; `caught_up` says it
      // has finished backfilling this run. A panel that rendered on the first
      // would claim to be showing a run whose events were still on the wire.
      await opening;
      awaiting.delete(runId);
      return run;
    },
    close() {
      closed = true;
      hub?.close();
      hub = null;
      connected = false;
      changed();
    },
  };
}

/**
 * A closed stream stays closed.
 *
 * Without this, a `watch()` after `close()` would quietly open a *second*
 * connection for the tab — the one thing this module exists to prevent — while
 * `state().status` went on reporting `stopped`.
 */
function refuseWhenClosed(closed: boolean): void {
  if (closed) throw new Error('this ledger stream was closed; open a new one');
}
