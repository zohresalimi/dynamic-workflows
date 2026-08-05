/**
 * KAR-03.4 — the data plane. Agent stdout, stderr and raw ACP frames land in
 * `io_chunk` and never in `event`.
 *
 * File-backed, because the megabyte written here is the thing being measured:
 * the whole claim of the split is that a chatty agent grows a table the reducer
 * never opens, and an in-memory database would not show the file at all.
 *
 * Verifies: EPIC-03-S11 (scenarios 1 and 2) · AC1
 */
import { NodeIdSchema, NodeProgressSchema, type RunId, RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  appendIoChunk,
  appendIoChunks,
  InvalidIoChunk,
  type IoChunkDraft,
  openLedger,
  readIoChunks,
} from '../../src/index.ts';
import { draft, RUN_A } from './support/events.ts';

const NODE = NodeIdSchema.parse('n7');
const OTHER_NODE = NodeIdSchema.parse('n8');
const RUN_C: RunId = RunIdSchema.parse('run_20260805T090000Z_1a2b3c');

/** One `agent_message_chunk` frame's worth of bytes: 5 KiB, 200 of them is 1 MB. */
const FRAME_BYTES = 5 * 1024;

const frame = (ordinal: number): Uint8Array =>
  new TextEncoder().encode(`${String(ordinal).padStart(4, '0')}`.padEnd(FRAME_BYTES, 'x'));

const chunk = (overrides: Partial<IoChunkDraft> = {}): IoChunkDraft => ({
  runId: RUN_A,
  nodeId: NODE,
  attempt: 1,
  stream: 'stdout',
  ts: 1_754_308_293_000,
  data: frame(0),
  ...overrides,
});

const countOf = (db: Parameters<typeof appendIoChunk>[0], sql: string, runId: string): number =>
  db.prepare<{ n: number }>(sql).get(runId)?.n ?? -1;

const EVENT_COUNT = 'SELECT count(*) AS n FROM event WHERE run_id = ?';
const IO_COUNT = 'SELECT count(*) AS n FROM io_chunk WHERE run_id = ?';
const IO_BYTES = 'SELECT coalesce(sum(length(data)), 0) AS n FROM io_chunk WHERE run_id = ?';

suite('a chatty agent does not grow the control plane (EPIC-03-S11 scenario 1)', () => {
  it('routes 1 MB over 200 frames into io_chunk and adds fewer than 10 event rows', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // The run already has its 40 control-plane events before the node starts.
      appendEvents(
        db,
        Array.from({ length: 40 }, (_unused, index) => draft({ payload: { ordinal: index } })),
      );
      expect(countOf(db, EVENT_COUNT, RUN_A)).toBe(40);

      appendEvents(db, [draft({ kind: 'node.started', nodeId: NODE, attempt: 1 })]);
      const seqs = appendIoChunks(
        db,
        Array.from({ length: 200 }, (_unused, index) => chunk({ data: frame(index) })),
      );
      appendEvents(db, [
        draft({
          kind: 'node.progress',
          nodeId: NODE,
          attempt: 1,
          payload: { node: NODE, attempt: 1, phase: 'streaming', ioChunkSeq: seqs.at(-1) },
        }),
        draft({ kind: 'node.completed', nodeId: NODE, attempt: 1 }),
      ]);

      expect(countOf(db, IO_COUNT, RUN_A)).toBe(200);
      expect(countOf(db, IO_BYTES, RUN_A)).toBe(200 * FRAME_BYTES);
      expect(countOf(db, EVENT_COUNT, RUN_A) - 40).toBeLessThan(10);
    } finally {
      db.close();
    }
  });

  it('leaves no event payload carrying more than a bounded excerpt', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendIoChunks(
        db,
        Array.from({ length: 200 }, (_unused, index) => chunk({ data: frame(index) })),
      );
      appendEvents(db, [
        draft({
          kind: 'node.progress',
          nodeId: NODE,
          attempt: 1,
          payload: { node: NODE, attempt: 1, phase: 'streaming', ioChunkSeq: 200 },
        }),
      ]);

      const payloads = db
        .prepare<{ payload: string }>('SELECT payload FROM event WHERE run_id = ? LIMIT 1000')
        .all(RUN_A)
        .map((row) => row.payload);
      expect(payloads.length).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(payload.length).toBeLessThan(1024);
        expect(payload).not.toContain('xxxxxxxx');
      }
    } finally {
      db.close();
    }
  });
});

suite('node.progress points at the stream rather than carrying it (scenario 2)', () => {
  it('accepts an ioChunkSeq pointer', () => {
    expect(
      NodeProgressSchema.safeParse({ node: NODE, attempt: 1, phase: 'streaming', ioChunkSeq: 12 })
        .success,
    ).toBe(true);
  });

  it('refuses a payload that carries the chunk bytes', () => {
    expect(
      NodeProgressSchema.safeParse({
        node: NODE,
        attempt: 1,
        phase: 'streaming',
        data: 'x'.repeat(5000),
      }).success,
    ).toBe(false);
  });
});

suite('readIoChunks is a per-node, per-attempt, strictly-greater-than cursor', () => {
  it('round-trips the bytes and the stream exactly', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const seq = appendIoChunk(db, chunk({ stream: 'agent_json', data: frame(3), ts: 17 }));
      const [stored] = readIoChunks(db, { runId: RUN_A, nodeId: NODE, attempt: 1 }, 0, 10).chunks;
      expect(stored).toEqual({
        seq,
        runId: RUN_A,
        nodeId: NODE,
        attempt: 1,
        stream: 'agent_json',
        ts: 17,
        data: frame(3),
      });
    } finally {
      db.close();
    }
  });

  it('isolates one node and attempt from another', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendIoChunks(db, [
        chunk({ data: frame(1) }),
        chunk({ nodeId: OTHER_NODE, data: frame(2) }),
        chunk({ attempt: 2, data: frame(3) }),
        chunk({ runId: RUN_C, data: frame(4) }),
        chunk({ data: frame(5) }),
      ]);

      const page = readIoChunks(db, { runId: RUN_A, nodeId: NODE, attempt: 1 }, 0, 10);
      expect(page.chunks.map((row) => row.data)).toEqual([frame(1), frame(5)]);
      expect(page.hasMore).toBe(false);
    } finally {
      db.close();
    }
  });

  it('pages with a strictly-greater-than cursor and reports that more remain', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const seqs = appendIoChunks(
        db,
        Array.from({ length: 5 }, (_unused, index) => chunk({ data: frame(index) })),
      );
      const first = readIoChunks(db, { runId: RUN_A, nodeId: NODE, attempt: 1 }, 0, 2);
      expect(first.chunks.map((row) => row.seq)).toEqual(seqs.slice(0, 2));
      expect(first.hasMore).toBe(true);

      const last = readIoChunks(
        db,
        { runId: RUN_A, nodeId: NODE, attempt: 1 },
        first.chunks.at(-1)?.seq ?? 0,
        10,
      );
      expect(last.chunks.map((row) => row.seq)).toEqual(seqs.slice(2));
      expect(last.hasMore).toBe(false);
    } finally {
      db.close();
    }
  });

  it('refuses a limit or cursor that is not a usable index', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const selector = { runId: RUN_A, nodeId: NODE, attempt: 1 };
      expect(() => readIoChunks(db, selector, 0, 0)).toThrow(RangeError);
      expect(() => readIoChunks(db, selector, -1, 10)).toThrow(RangeError);
    } finally {
      db.close();
    }
  });
});

suite('the append boundary refuses a chunk that cannot be written twice', () => {
  it('rejects an unknown stream', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => appendIoChunk(db, chunk({ stream: 'pty' as IoChunkDraft['stream'] }))).toThrow(
        InvalidIoChunk,
      );
      expect(countOf(db, IO_COUNT, RUN_A)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects an attempt that is not positive and writes none of the batch', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => appendIoChunks(db, [chunk(), chunk({ attempt: 0 })])).toThrow(InvalidIoChunk);
      expect(countOf(db, IO_COUNT, RUN_A)).toBe(0);
    } finally {
      db.close();
    }
  });
});
