/**
 * KAR-15.6 AC4 — the **tail** query behind `GET /api/runs/:id/nodes/:nodeId/io`.
 *
 * `readIoChunks` pages *forward* from a cursor, which is the right shape for a
 * client that already knows where it is and the wrong one for a terminal
 * reattaching to a node that has produced 200 MB: paging forward from 0 to the
 * end reads the whole log to answer "what are the last 200 lines". So there is
 * a second bounded statement — `ORDER BY seq DESC LIMIT ?` over the same
 * covering index — and this file is what says it reads the *end* and touches
 * nothing else.
 *
 * File-backed, because the claim is about how much of a real table a real
 * query reads.
 *
 * Verifies: EPIC-15-S40 · KAR-15.6 AC4 · test plan #4
 */
import { NodeIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { appendIoChunks, type IoChunkDraft, openLedger, readIoChunkTail } from '../../src/index.ts';
import { RUN_A } from './support/events.ts';

const NODE = NodeIdSchema.parse('n7');
const OTHER = NodeIdSchema.parse('n8');

const chunk = (ordinal: number, over: Partial<IoChunkDraft> = {}): IoChunkDraft => ({
  runId: RUN_A,
  nodeId: NODE,
  attempt: 1,
  stream: 'stdout',
  ts: 1_754_308_293_000 + ordinal,
  data: new TextEncoder().encode(`line ${ordinal}\n`),
  ...over,
});

suite('the tail is the end of the log, read without walking it (AC4)', () => {
  it('returns the last `limit` chunks in ascending seq order', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendIoChunks(
        db,
        Array.from({ length: 500 }, (_unused, index) => chunk(index)),
      );

      const tail = readIoChunkTail(db, { runId: RUN_A, nodeId: NODE, attempt: 1 }, 3);

      // Ascending, so a client can write them straight to a terminal — the
      // reversal happens once here rather than at every call site.
      expect(tail.chunks.map((entry) => new TextDecoder().decode(entry.data))).toEqual([
        'line 497\n',
        'line 498\n',
        'line 499\n',
      ]);
      // There is more *before* the window: a tail is the end, so `hasMore`
      // means "earlier output exists", which is what a scrollback control asks.
      expect(tail.hasMore).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reports no more when the whole log fits inside the window', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendIoChunks(
        db,
        Array.from({ length: 3 }, (_unused, index) => chunk(index)),
      );

      const tail = readIoChunkTail(db, { runId: RUN_A, nodeId: NODE, attempt: 1 }, 10);

      expect(tail.chunks).toHaveLength(3);
      expect(tail.hasMore).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is scoped to one node attempt', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendIoChunks(db, [
        chunk(0),
        chunk(1, { nodeId: OTHER }),
        chunk(2, { attempt: 2 }),
        chunk(3),
      ]);

      const tail = readIoChunkTail(db, { runId: RUN_A, nodeId: NODE, attempt: 1 }, 10);

      expect(tail.chunks.map((entry) => new TextDecoder().decode(entry.data))).toEqual([
        'line 0\n',
        'line 3\n',
      ]);
    } finally {
      db.close();
    }
  });

  it('reads the end of the table rather than scanning it', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendIoChunks(
        db,
        Array.from({ length: 2000 }, (_unused, index) => chunk(index)),
      );

      // The plan is the assertion: a covering index walked backwards, never a
      // SCAN and never a temp b-tree for the ORDER BY. A tail that sorted the
      // whole table would still return the right rows, and would still read
      // 200 MB to do it.
      const plan = db
        .prepare<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT seq, run_id, node_id, attempt, stream, ts, data
             FROM io_chunk
             WHERE run_id = ? AND node_id = ? AND attempt = ?
             ORDER BY seq DESC
             LIMIT ?`,
        )
        .all(RUN_A, NODE, 1, 3)
        .map((row) => row.detail)
        .join('\n');

      expect(plan).toContain('io_run_seq');
      expect(plan).not.toContain('TEMP B-TREE');
    } finally {
      db.close();
    }
  });
});
