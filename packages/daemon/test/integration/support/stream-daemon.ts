/**
 * KAR-15.3 — a real DeFlowd on a real socket over a real file-backed ledger,
 * for the specs that read the multiplexed stream off the wire.
 *
 * Everything here is real on purpose. The claims under test are *"the filter is
 * applied by the server"*, *"the drain holds no cursor"* and *"the emitter
 * fires after the commit"*, and not one of them can be told apart from a lucky
 * in-memory implementation without a socket, a file and a second connection.
 *
 * The one seam is `viewOf`: a spec can wrap the real `LedgerView` to count the
 * queries the serving loop issues, or to make one of them fail. It wraps the
 * real view rather than replacing it, so what the loop reads is still SQLite.
 */
import type { Db, RunId } from '@DeFlow/core';
import { openLedger } from '@DeFlow/ledger';
import { authorizedFetch, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { clearIntakePorts, setIntakePorts } from '../../../src/http/intake-ports.ts';
import {
  clearLedgerView,
  type LedgerView,
  type OpenedLedgerView,
  openLedgerView,
  setLedgerView,
} from '../../../src/http/ledger-view.ts';
import { startHttp } from '../../../src/http/server.ts';
import { setDaemonEpoch } from '../../../src/runtime.ts';
import { type Frames, readFrames } from './sse.ts';

export const T0 = 1_754_308_400_000;
export const EPOCH = 5;

/** Every request these specs make carries the daemon's bearer token. */
export const fetch = authorizedFetch();

export interface Served {
  readonly origin: string;
  /** The **write** connection. The stream reads through its own, read-only one. */
  readonly db: Db;
  /** The read-only view the routes serve from, as the spec may have wrapped it. */
  readonly view: LedgerView;
  readonly dataDir: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  /** Wraps the real read-only view, for counting or for provoking a failure. */
  readonly viewOf?: (real: OpenedLedgerView) => LedgerView;
}

/** Boots a daemon over `dataDir`, with the ledger open and the routes served. */
export async function serve(dataDir: string, options: ServeOptions = {}): Promise<Served> {
  const db = openLedger(dataDir);
  const opened = openLedgerView(dataDir);
  const view = options.viewOf?.(opened) ?? opened;
  setLedgerView(view);
  setDaemonEpoch(EPOCH);
  setIntakePorts({
    db,
    epoch: EPOCH,
    clock: { now: () => T0, setTimer: () => ({ cancel: () => {} }) },
    dataDir,
    randomHex: () => 'aa0001',
  });

  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    view,
    dataDir,
    async close() {
      await started.close();
      clearLedgerView();
      clearIntakePorts();
      opened.close();
      db.close();
    },
  };
}

/** One open stream, with its frames and the abort that closes the socket. */
export interface OpenStream {
  readonly frames: Frames;
  readonly response: Response;
  close(): void;
}

/**
 * Opens `GET /api/stream?<query>`.
 *
 * The `AbortController` is the socket: a spec that does not close it leaves a
 * handler draining a ledger the `afterEach` has already closed, which fails as
 * a confusing SQLite error in the *next* spec rather than in this one.
 */
export async function openStream(
  origin: string,
  query: string,
  init: RequestInit = {},
): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/stream?${query}`, {
    ...init,
    signal: controller.signal,
  });
  return {
    response,
    frames: readFrames(response, controller.signal),
    close: () => {
      controller.abort();
    },
  };
}

/** `POST /api/stream/:id/subscribe` — the filter mutation, without a reconnect. */
export async function subscribe(
  origin: string,
  streamId: string,
  runs: readonly RunId[],
): Promise<Response> {
  return fetch(`${origin}/api/stream/${streamId}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs }),
  });
}

/** What the `hello` frame announced. */
export interface Hello {
  readonly streamId: string;
  readonly apiVersion: number;
  readonly build: string;
  readonly daemonEpoch: number | null;
  readonly headSeq: number;
  readonly runs: string[];
}

export async function helloOf(frames: Frames): Promise<Hello> {
  const frame = await frames.until((candidate) => candidate.event === 'hello');
  return JSON.parse(frame.data) as Hello;
}
