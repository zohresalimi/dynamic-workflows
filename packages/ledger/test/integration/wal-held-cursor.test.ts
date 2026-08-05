/**
 * KAR-03.4 — why streaming reads drain with bounded `LIMIT` queries and never
 * with a lazy cursor.
 *
 * The first suite deliberately asserts the **bad** behaviour. That is the
 * point: a lazy `stmt.iterate()` piped into an SSE response is exactly the
 * shape a reasonable engineer reaches for, it looks like the memory-efficient
 * choice, and it silently pins the WAL open for as long as the stream lives.
 * The number is in the test name so the diff that removes it reads as a
 * warning.
 *
 * Verifies: EPIC-03-S14 · AC5
 */
import { NodeIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, describe as suite } from 'vitest';
import { appendIoChunks, drainIoChunks, type IoChunkDraft, openLedger } from '../../src/index.ts';
import { RUN_A } from './support/events.ts';

const NODE = NodeIdSchema.parse('n1');
const ROWS = 20_000;
const DATA = new TextEncoder().encode('z'.repeat(4096));

interface CheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

const walMegabytes = (file: string): number => {
  try {
    return statSync(`${file}-wal`).size / 1e6;
  } catch {
    return 0;
  }
};

const batch = (count: number): IoChunkDraft[] =>
  Array.from({ length: count }, () => ({
    runId: RUN_A,
    nodeId: NODE,
    attempt: 1,
    stream: 'stdout' as const,
    ts: 1_754_308_293_000,
    data: DATA,
  }));

suite('a cursor held across a stream pins the WAL open (EPIC-03-S14 scenario 1)', () => {
  it('blows -wal to 96 MB writing 20,000 rows; TRUNCATE reports busy and reclaims nothing', ({
    tmp,
  }) => {
    const file = join(tmp, 'ledger.db');
    const db = openLedger(tmp);
    // A real second connection, because that is the shape being warned about:
    // the SSE reader is a read-only connection and the daemon keeps writing.
    const reader = new Database(file, { readonly: true });
    try {
      appendIoChunks(db, batch(200));

      const cursor = reader
        .prepare('SELECT seq, data FROM io_chunk WHERE run_id = ? ORDER BY seq')
        .iterate(RUN_A);
      cursor.next(); // one frame delivered; the statement stays open

      for (let written = 0; written < ROWS; written += 500) appendIoChunks(db, batch(500));

      const pinned = walMegabytes(file);
      const checkpoint = db
        .prepare<CheckpointResult>('PRAGMA wal_checkpoint(TRUNCATE)')
        .get() as CheckpointResult;
      expect(pinned).toBeGreaterThan(50);
      expect(checkpoint.busy).toBe(1);
      expect(checkpoint.log).toBeGreaterThan(checkpoint.checkpointed);
      // Nothing was reclaimed: the file on disk is exactly as big as it was.
      expect(walMegabytes(file)).toBeCloseTo(pinned, 1);

      // Space comes back only after the cursor closes.
      cursor.return?.();
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      expect(walMegabytes(file)).toBeLessThan(1);
    } finally {
      reader.close();
      db.close();
    }
  });
});

suite('the shipped bounded drain does not (EPIC-03-S14 scenario 2)', () => {
  it('holds -wal at 5.8 MB over the same 20,000 rows and lets TRUNCATE reclaim it', ({ tmp }) => {
    const file = join(tmp, 'ledger.db');
    const db = openLedger(tmp);
    const reader = new Database(file, { readonly: true });
    try {
      appendIoChunks(db, batch(200));

      const selector = { runId: RUN_A, nodeId: NODE, attempt: 1 };
      let cursorSeq = 0;
      let drained = 0;
      const drainSome = (): void => {
        for (const stored of drainIoChunks(db, selector, { afterSeq: cursorSeq })) {
          cursorSeq = stored.seq;
          drained++;
        }
      };

      drainSome();
      for (let written = 0; written < ROWS; written += 500) {
        appendIoChunks(db, batch(500));
        drainSome();
      }

      expect(drained).toBe(ROWS + 200);
      const peak = walMegabytes(file);
      expect(peak).toBeLessThan(8);

      const checkpoint = db
        .prepare<CheckpointResult>('PRAGMA wal_checkpoint(TRUNCATE)')
        .get() as CheckpointResult;
      expect(checkpoint.busy).toBe(0);
      expect(walMegabytes(file)).toBeLessThan(1);
    } finally {
      reader.close();
      db.close();
    }
  });
});
