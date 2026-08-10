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
import type { AddressInfo } from 'node:net';

export const EPOCH = 5;
export const T0 = 1_754_308_400_000;

export interface ServedDaemon {
  /** `http://127.0.0.1:<port>` — what a CLI command is pointed at. */
  readonly baseUrl: string;
  /** The write connection, for a spec that appends while the CLI watches. */
  readonly db: Db;
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
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}
