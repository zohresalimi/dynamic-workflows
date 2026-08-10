/**
 * The daemon's side of `PtyOutputSink`: a live terminal's bytes, appended to
 * `io_chunk` (KAR-15.8 AC4).
 *
 * It is the same shape as `sqliteLedgerSink`'s `appendIo` and exists for the
 * same reason — the module that owns a process must not also own a database
 * connection — with one difference worth naming: a pty has **one** stream. The
 * terminal driver interleaves the child's stdout and stderr onto a single
 * file descriptor before DeFlow ever sees them, so there is no honest way to
 * split them afterwards and pretending otherwise would file half a stack trace
 * under the wrong stream. Everything from a pty is recorded as `stdout`, which
 * is what the terminal itself calls it.
 *
 * `ts` comes from the injected Clock (R1, NF9): the ledger never reads a clock
 * of its own, and neither does this.
 */
import type { Clock, Db, NodeId, RunId } from '@DeFlow/core';
import { appendIoChunk } from '@DeFlow/ledger';
import type { Buffer } from 'node:buffer';
import type { PtyOutputSink } from './pty-session.ts';

export interface LedgerPtySinkOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 1-based, like every other `io_chunk` writer in the daemon. */
  readonly attempt: number;
  readonly clock: Clock;
}

export function ledgerPtySink(options: LedgerPtySinkOptions): PtyOutputSink {
  const { db, runId, nodeId, attempt, clock } = options;
  return {
    write(bytes: Buffer): void {
      // An empty read is not a row: a pty produces them on close, and a table
      // of zero-byte chunks is a table nobody can page through.
      if (bytes.byteLength === 0) return;
      appendIoChunk(db, {
        runId,
        nodeId,
        attempt,
        stream: 'stdout',
        ts: clock.now(),
        // A copy, because the Buffer a pty hands over is reused for the next
        // read: keeping the view would file the *next* chunk's bytes under
        // this chunk's seq, and only under load.
        data: Uint8Array.from(bytes),
      });
    },
  };
}
