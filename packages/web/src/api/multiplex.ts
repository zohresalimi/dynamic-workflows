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
import { connectStream, type StreamConnection } from './stream.ts';

export interface StreamHubOptions {
  /** Defaults to the page's own origin plus `/api`, as `createClient` does. */
  readonly baseUrl?: string;
  /** The cursor to resume from. `0` means "everything", never "from now". */
  readonly since?: number;
  /** Read per request, so a token acquired later is still attached. */
  readonly token?: () => string | null | undefined;
  /**
   * A `fatal` frame, after the hub has decided whether it may reconnect.
   * `terminal` is true for exactly `bad_token` and `epoch_mismatch` (AC15).
   */
  readonly onFatal?: (code: string, terminal: boolean) => void;
  /** Every named frame, for a caller that wants the raw control channel. */
  readonly onControl?: (frame: ControlFrame) => void;
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
  let filter: string[] = [];
  let id: string | null = null;
  let connections = 0;

  const opened = deferred();
  /** One waiter per run asked for, settled by the `subscribed` frame. */
  const awaiting = new Map<string, Deferred>();

  const onControl = (frame: ControlFrame): void => {
    options.onControl?.(frame);
    if (frame.name === 'hello') {
      id = stringField(frame.payload, 'streamId');
      filter = runsField(frame.payload);
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
    applyEvent: fanOutByRun((runId) => panels.get(runId)),
    control: onControl,
  });

  connections += 1;
  const connection: StreamConnection = connectStream({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.token === undefined ? {} : { token: options.token }),
    runs: [],
    since: options.since ?? 0,
    onMessage: (message) => {
      dispatcher.onFrame({ event: message.event, id: message.id ?? undefined, data: message.data });
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
    },
    async watch(runId, apply) {
      panels.set(runId, apply);
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

function runsField(payload: unknown): string[] {
  const value = (payload as { runs?: unknown } | null)?.runs;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
