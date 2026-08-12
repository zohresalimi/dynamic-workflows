/**
 * A real DeFlowd on a real socket, for the CLI specs that resume from one.
 *
 * The CLI is *"a client of the HTTP API, not a second implementation"*, so its
 * specs go over a socket to a daemon serving a real file-backed ledger. What is
 * assembled here is only what a read path needs — the read-only ledger view,
 * this daemon life's epoch and the HTTP server — because a CLI resuming a run
 * writes nothing.
 */
import type { Db } from '@DeFlow/core';
import {
  clearLedgerView,
  type OpenedLedgerView,
  openLedgerView,
  setDaemonEpoch,
  setLedgerView,
  startHttp,
} from '@DeFlow/daemon';
import { openLedger } from '@DeFlow/ledger';
import { TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const EPOCH = 5;
export const T0 = 1_754_308_400_000;

export interface ServedDaemon {
  /** `http://127.0.0.1:<port>` — what a CLI command is pointed at. */
  readonly baseUrl: string;
  /** The write connection, for a spec that appends while the CLI watches. */
  readonly db: Db;
  /**
   * The node `http.Server` itself, for the one spec that has to be rude to it:
   * KAR-18.3 AC5 drops the SSE socket mid-run and watches the client come back
   * with `?since=`, and `closeAllConnections()` is the only honest way to
   * produce that — a client-side `close()` would be the client deciding.
   */
  readonly http: Server;
  close(): Promise<void>;
}

export async function serveDaemon(dataDir: string): Promise<ServedDaemon> {
  const db = openLedger(dataDir);
  const view: OpenedLedgerView = openLedgerView(dataDir);
  setLedgerView(view);
  setDaemonEpoch(EPOCH);

  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    http: started.server,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}
