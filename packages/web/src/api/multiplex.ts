/**
 * KAR-15.3 AC1 — the tab's **one** stream connection (docs/11-api-and-realtime.md §2).
 *
 * > This is an architecture constraint, not a tuning knob. It must be designed
 * > in from day one.
 *
 * It has to be, and the reason is unpleasantly concrete. DeFlowd runs on Node's
 * `http` server, which is HTTP/1.1: browsers refuse h2c, so HTTP/2 on localhost
 * would need TLS, and shipping a certificate for `127.0.0.1` is a worse problem
 * than the one it solves. Browsers cap concurrent connections per origin at
 * about six. An SSE connection never closes. A tab that opens one per run panel
 * therefore reaches the cap at the sixth panel, and what happens next is **not
 * an error**: every subsequent `fetch` to that origin queues behind the streams
 * forever, with nothing logged anywhere. The symptom presents as *"the daemon
 * hung"* against a perfectly healthy daemon.
 *
 * So there is one connection per tab, opened at app start, and opening a run
 * panel is a **filter mutation** on it — `POST /api/stream/:streamId/subscribe`
 * — rather than a second socket. The daemon answers on the connection that is
 * already open: `subscribed`, then the backfill from this client's cursor, then
 * `caught_up`, then live frames (§5).
 *
 * This module owns exactly that: the connection, the filter, and the fan-out.
 * It owns neither the frame contract (`./dispatch.ts`) nor the transport
 * (`./stream.ts`), and it deliberately does not own the reconnection policy or
 * the projection store — those are EPIC-16's KAR-16.2 and KAR-16.4.
 *
 * `watch()` resolves on the **`subscribed` frame**, not on the `202`. The
 * daemon returns `202` before it has written a single backfilled event
 * precisely so the acknowledgement a client renders on is the one that arrives
 * in order with the backfill; resolving on the response instead would tell a
 * panel it was subscribed while the events it exists to show were still on the
 * wire.
 */
import type { Event } from '@DeFlow/core';
import { createClient } from './client.ts';
import {
  type ControlFrame,
  createDispatcher,
  type Dispatcher,
  fanOutByRun,
  stopsRetrying,
} from './dispatch.ts';
import { connectStream, type StreamConnection, type StreamOptions } from './stream.ts';

/**
 * KAR-15.4 AC7 — what a `hello` frame says has changed since the last one.
 *
 * Two different facts with two different remedies, which is why they are two
 * fields rather than one "reconnected" flag. A changed `daemonEpoch` means the
 * daemon was replaced under an open tab: the projections are still valid and
 * the client resumes from its own cursor. A changed `build` means this tab is
 * running JavaScript from a different release than the daemon it is talking to,
 * and the only complete answer is a reload — daemon and UI ship in the same npm
 * tarball, so skew only ever means "stale tab", never "stale deployment".
 */
export interface HelloSkew {
  /** The daemon epoch moved between two hellos on this hub. */
  readonly restarted: boolean;
  /** `hello.build` differs from the build this tab was loaded with. */
  readonly buildChanged: boolean;
  readonly daemonEpoch: number | null;
  readonly previousEpoch: number | null;
  readonly build: string | null;
}

export interface StreamHubOptions {
  /** Defaults to the page's own origin plus `/api`, as `createClient` does. */
  readonly baseUrl?: string;
  /**
   * The cursor to open at. `0` means "everything", never "from now".
   *
   * Only the *opening* cursor: every reconnect after it resumes from the
   * highest `seq` this hub has applied, which is what stops a reconnect from
   * re-delivering everything between the two (KAR-15.4 AC1).
   */
  readonly since?: number;
  /** Read per request, so a token acquired later is still attached. */
  readonly token?: () => string | null | undefined;
  /**
   * The build this tab was served with, when the caller knows it. Compared
   * against `hello.build` to detect a stale tab (AC7).
   */
  readonly build?: string;
  /**
   * The filter to **open** with. Empty — the default — is the hello-and-
   * keepalive stream a tab holds before its first panel.
   *
   * The one value that cannot be added later is `'*'`: the global lifecycle
   * topic is resolved from the query string when the connection is served, so
   * a tab that wants it has to ask at open (docs/11 §5).
   */
  readonly runs?: readonly string[];
  /**
   * An event for a run no panel is watching — which is what every frame on the
   * `runs=*` topic is, since a lifecycle event carries the id of the run it
   * happened to. Dropped when this is absent, as a stale subscription's tail
   * should be.
   */
  readonly onUnrouted?: (event: Event) => void;
  /** The connection was established. Fires again on every reconnect. */
  readonly onConnect?: () => void;
  /** The connection was broken. The library will reconnect unless closed. */
  readonly onDisconnect?: () => void;
  /** A `: keepalive` comment. Counted by KAR-16.2, ignored by everything else. */
  readonly onComment?: (comment: string) => void;
  /** A reconnect was scheduled, with the interval the server last named. */
  readonly onScheduleReconnect?: (info: { delay: number }) => void;
  /** The highest `seq` this hub has seen moved. The tab's cursor hangs off it. */
  readonly onCursor?: (cursor: number) => void;
  /**
   * A `fatal` frame, after the hub has decided whether it may reconnect.
   * `terminal` is true for exactly `bad_token` and `epoch_mismatch` (AC15).
   */
  readonly onFatal?: (code: string, terminal: boolean) => void;
  /** A `hello` that disagrees with the last one, or with this tab's build. */
  readonly onSkew?: (skew: HelloSkew) => void;
  /** Every named frame, for a caller that wants the raw control channel. */
  readonly onControl?: (frame: ControlFrame) => void;
  /** Injected in tests, and by nothing else. */
  readonly fetch?: StreamOptions['fetch'];
}

export interface StreamHub {
  /** Resolves once the connection's `hello` frame has arrived. */
  opened(): Promise<void>;
  /**
   * Adds a run panel: one filter mutation, no reconnect, no second socket.
   * Resolves when the daemon acknowledges it *on the stream*.
   */
  watch(runId: string, apply: (event: Event) => void): Promise<void>;
  /** Removes a panel's fan-out target. The server-side filter is unchanged. */
  unwatch(runId: string): void;
  /** The runs this connection's filter carries, as the daemon last stated it. */
  runs(): readonly string[];
  /** The id `POST …/subscribe` addresses, or `null` before `hello`. */
  streamId(): string | null;
  /** The highest `seq` this tab has seen, unknown kinds included. */
  cursor(): number;
  /**
   * Connections this hub has opened over its whole life.
   *
   * Exposed because *"the tab holds exactly one"* is the property, and a
   * property nothing can read is a property nothing can defend.
   */
  connections(): number;
  close(): void;
}

export function openStreamHub(options: StreamHubOptions = {}): StreamHub {
  const client = createClient({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.token === undefined ? {} : { token: options.token }),
  });

  const panels = new Map<string, (event: Event) => void>();
  /**
   * The filter this hub *wants*, as opposed to the one the daemon last stated.
   *
   * They differ for exactly as long as a `subscribe` is in flight, and they
   * differ again the instant a connection drops: the daemon resolves a
   * connection's filter from its query string, so the runs this tab subscribed
   * to have to be re-stamped on every attempt or the reconnect comes back
   * watching nothing. That failure is silent — the stream is open, `hello`
   * arrives, and no event ever does.
   */
  const desired = new Set<string>(options.runs ?? []);
  let filter: string[] = [];
  let id: string | null = null;
  let connections = 0;
  /** The epoch the previous `hello` carried; `undefined` before the first. */
  let epoch: number | null | undefined;

  const opened = deferred();
  /** One waiter per run asked for, settled by the `subscribed` frame. */
  const awaiting = new Map<string, Deferred>();

  /**
   * AC7 — the two ways a `hello` can say the world changed under this tab.
   *
   * Compared against the *previous* hello rather than against a value fetched
   * from anywhere else: a restart is only observable as a difference between
   * two frames on the same hub, and the first hello of a session has nothing to
   * disagree with. The build does — the tab knows which build it loaded — so a
   * skew there is reportable on the very first frame.
   */
  const reportSkew = (payload: unknown): void => {
    const daemonEpoch = numberField(payload, 'daemonEpoch');
    const build = stringField(payload, 'build');
    const restarted = epoch !== undefined && epoch !== daemonEpoch;
    const buildChanged = options.build !== undefined && build !== null && build !== options.build;
    const previousEpoch = epoch ?? null;
    epoch = daemonEpoch;

    if (restarted || buildChanged) {
      options.onSkew?.({ restarted, buildChanged, daemonEpoch, previousEpoch, build });
    }
  };

  const onControl = (frame: ControlFrame): void => {
    options.onControl?.(frame);
    if (frame.name === 'hello') {
      id = stringField(frame.payload, 'streamId');
      filter = runsField(frame.payload);
      reportSkew(frame.payload);
      opened.resolve();
      return;
    }
    if (frame.name === 'subscribed') {
      filter = runsField(frame.payload);
      for (const runId of filter) awaiting.get(runId)?.resolve();
      return;
    }
    if (frame.name === 'fatal') {
      const code = stringField((frame.payload as { error?: unknown } | null)?.error, 'code') ?? '';
      const terminal = stopsRetrying(code);
      // A terminal code is the one case a client must stop reconnecting on: a
      // rotated token and a superseded daemon epoch both need a human or a
      // reload, and retrying would hammer a socket that can only refuse it.
      if (terminal) connection.close();
      options.onFatal?.(code, terminal);
    }
  };

  const dispatcher: Dispatcher = createDispatcher({
    applyEvent: fanOutByRun((runId) => panels.get(runId) ?? options.onUnrouted),
    control: onControl,
  });

  connections += 1;
  const openedAt = options.since ?? 0;
  const connection: StreamConnection = connectStream({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onConnect === undefined ? {} : { onConnect: options.onConnect }),
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
    ...(options.onComment === undefined ? {} : { onComment: options.onComment }),
    ...(options.onScheduleReconnect === undefined
      ? {}
      : { onScheduleReconnect: options.onScheduleReconnect }),
    // Read per attempt, exactly as `since` is, and for the same reason.
    runs: () => [...desired],
    // Read per attempt: a reconnect resumes from what this tab has applied, and
    // falls back to where it opened only while it has applied nothing. `max`
    // rather than the dispatcher's cursor alone, because a hub that opened at
    // 10,432 and has seen nothing since must not resume from 0 (KAR-15.4 AC1).
    since: () => Math.max(openedAt, dispatcher.cursor()),
    onMessage: (message) => {
      const before = dispatcher.cursor();
      dispatcher.onFrame({ event: message.event, id: message.id ?? undefined, data: message.data });
      // Reported off the dispatcher rather than off the applied event, because
      // the cursor advances past a kind this build cannot read too — and a tab
      // that persisted only what it understood would re-request that frame on
      // every reconnect for the life of the run.
      const after = dispatcher.cursor();
      if (after > before) options.onCursor?.(after);
    },
  });

  return {
    opened: () => opened.promise,
    runs: () => [...filter],
    streamId: () => id,
    cursor: () => dispatcher.cursor(),
    connections: () => connections,
    unwatch(runId) {
      panels.delete(runId);
      desired.delete(runId);
    },
    async watch(runId, apply) {
      panels.set(runId, apply);
      desired.add(runId);
      if (filter.includes(runId)) return;
      await opened.promise;
      if (id === null) throw new Error('the stream announced no streamId to subscribe against');

      const waiter = awaiting.get(runId) ?? deferred();
      awaiting.set(runId, waiter);
      // The URL comes from the typed client and the body does not, because the
      // route reads its body with `c.req.json()` rather than through a
      // validator, so `hc<ApiType>` knows the path and the param but has no
      // type for the payload. Taking the path from the client anyway is what
      // keeps this coupled: renaming the daemon's route breaks this build in
      // the same commit, which is the whole point of §9's typed client.
      const token = options.token?.();
      const response = await fetch(
        client.stream[':streamId'].subscribe.$url({ param: { streamId: id } }),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token === null || token === undefined || token === ''
              ? {}
              : { Authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify({ runs: [runId] }),
        },
      );
      if (!response.ok) {
        awaiting.delete(runId);
        throw new Error(`the daemon refused a filter mutation for ${runId}: ${response.status}`);
      }
      await waiter.promise;
      awaiting.delete(runId);
    },
    close() {
      panels.clear();
      connection.close();
    },
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

function stringField(payload: unknown, field: string): string | null {
  const value = (payload as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' ? value : null;
}

function numberField(payload: unknown, field: string): number | null {
  const value = (payload as Record<string, unknown> | null)?.[field];
  return typeof value === 'number' ? value : null;
}

function runsField(payload: unknown): string[] {
  const value = (payload as { runs?: unknown } | null)?.runs;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
