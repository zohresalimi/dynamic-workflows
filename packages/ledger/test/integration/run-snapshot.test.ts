/**
 * KAR-15.7 — the server-side snapshot at an arbitrary `seq`
 * (docs/11-api-and-realtime.md §7.3), against a real file-backed ledger.
 *
 * Every claim here is about what `snapshotRunAt` composes over real rows: the
 * same reducer core's own `foldEvents` produces (AC4, AC6), the greatest
 * committed `seq` at or below a request that lands in a gap (AC3) or past the
 * run's own head (AC8), the `'head'` alias (AC2), that `io_chunk` is never
 * touched (AC7), and that reducing 10,000 events stays within the budget the
 * architecture measured at 29 ms, on a real ledger file rather than the toy
 * fold `control-plane-split.test.ts` times (AC5, test plan #4).
 *
 * Verifies: EPIC-15-S45, EPIC-15-S46 · AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8 ·
 * test plan #1, #2, #3, #4
 */
import { type Db, type DbStatement, type DbValue, foldEvents, NodeIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  appendIoChunks,
  drainEvents,
  openLedger,
  snapshotRunAt,
} from '../../src/index.ts';
import { draft, RUN_A, RUN_B } from './support/events.ts';

const NODE = NodeIdSchema.parse('n1');

/** A `Db` that remembers every statement prepared through it (AC7). */
function recording(db: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const wrapper: Db = {
    get open() {
      return db.open;
    },
    prepare<Row = Record<string, DbValue>>(source: string): DbStatement<Row> {
      sql.push(source);
      return db.prepare<Row>(source);
    },
    exec: (source: string) => {
      sql.push(source);
      db.exec(source);
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn),
    pragma: (source: string) => db.pragma(source),
    close: () => {
      db.close();
    },
  };
  return { db: wrapper, sql };
}

const progress = (phase: string): unknown => ({ node: NODE, attempt: 1, phase });

suite('the resolved seq and state (EPIC-15-S45, AC1, AC4, AC6, test plan #1)', () => {
  it('matches folding the same events directly through @DeFlow/core', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        draft({
          runId: RUN_A,
          kind: 'node.scheduled',
          payload: { node: NODE, provider: 'claude', permission: 'read' },
        }),
        draft({
          runId: RUN_A,
          kind: 'node.started',
          payload: { node: NODE, attempt: 1 },
          nodeId: NODE,
          attempt: 1,
        }),
        // Seq 3 moves run-level status, so a fold stopped at seq 2 is
        // observably different from one that ran to the end — the property
        // that makes the comparison below meaningful rather than vacuous.
        draft({ runId: RUN_A, kind: 'run.paused', payload: { by: 'user' } }),
      ]);

      const snapshot = snapshotRunAt(db, RUN_A, 2);

      // The independent path: fold the same rows directly, with no
      // `snapshotRunAt` in between — a second reducer here would be free to
      // disagree with the shipped one, and this is the assertion that would
      // catch it.
      const direct = foldEvents(drainEvents(db, RUN_A));
      const upToTwo = foldEvents(
        (function* () {
          for (const event of drainEvents(db, RUN_A)) {
            if (event.seq > 2) return;
            yield event;
          }
        })(),
      );

      expect(snapshot.seq).toBe(2);
      expect(snapshot.state).toEqual(upToTwo.state);
      // The independent fold of everything disagrees on status alone, which
      // is what proves the comparison above is not vacuous: the third event
      // really did change something the stopped-early fold never sees.
      expect(direct.state.status).toBe('paused');
      expect(snapshot.state.status).not.toBe('paused');
    } finally {
      db.close();
    }
  });

  it('answers a run with no events yet at seq 0, the initial state', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const snapshot = snapshotRunAt(db, RUN_A, 100);
      expect(snapshot.seq).toBe(0);
      expect(snapshot.state.status).toBe('created');
    } finally {
      db.close();
    }
  });
});

suite("the 'head' alias (AC2, test plan #2)", () => {
  it('resolves to the actual current head, echoed in the body', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        draft({
          runId: RUN_A,
          kind: 'node.progress',
          payload: progress('a'),
          nodeId: NODE,
          attempt: 1,
        }),
        draft({
          runId: RUN_A,
          kind: 'node.progress',
          payload: progress('b'),
          nodeId: NODE,
          attempt: 1,
        }),
        draft({
          runId: RUN_A,
          kind: 'node.progress',
          payload: progress('c'),
          nodeId: NODE,
          attempt: 1,
        }),
      ]);

      const byAlias = snapshotRunAt(db, RUN_A, 'head');
      const byNumber = snapshotRunAt(db, RUN_A, 3);

      expect(byAlias.seq).toBe(3);
      expect(byAlias).toEqual(byNumber);
    } finally {
      db.close();
    }
  });
});

suite(
  'a seq in a gap resolves down, and a seq past head resolves to head (AC3, AC8, test plan #3)',
  () => {
    it('a gap left by another run', ({ tmp }) => {
      const db = openLedger(tmp);
      try {
        // seq 1, 2 for RUN_A.
        appendEvents(db, [
          draft({
            runId: RUN_A,
            kind: 'node.progress',
            payload: progress('a'),
            nodeId: NODE,
            attempt: 1,
          }),
          draft({
            runId: RUN_A,
            kind: 'node.progress',
            payload: progress('b'),
            nodeId: NODE,
            attempt: 1,
          }),
        ]);
        // seq 3 belongs to a different run entirely.
        appendEvents(db, [draft({ runId: RUN_B, kind: 'run.created' })]);
        // seq 4, 5 for RUN_A again.
        appendEvents(db, [
          draft({
            runId: RUN_A,
            kind: 'node.progress',
            payload: progress('c'),
            nodeId: NODE,
            attempt: 1,
          }),
          draft({
            runId: RUN_A,
            kind: 'node.progress',
            payload: progress('d'),
            nodeId: NODE,
            attempt: 1,
          }),
        ]);

        // 3 is RUN_B's seq, never RUN_A's — asking RUN_A for it must not 404
        // and must not silently round up to 4.
        const snapshot = snapshotRunAt(db, RUN_A, 3);
        expect(snapshot.seq).toBe(2);
        expect(snapshot.state).toEqual(snapshotRunAt(db, RUN_A, 2).state);
      } finally {
        db.close();
      }
    });

    it('a seq past this run’s own head resolves to the head state, not an error', ({ tmp }) => {
      const db = openLedger(tmp);
      try {
        appendEvents(db, [
          draft({
            runId: RUN_A,
            kind: 'node.progress',
            payload: progress('a'),
            nodeId: NODE,
            attempt: 1,
          }),
          draft({
            runId: RUN_A,
            kind: 'node.progress',
            payload: progress('b'),
            nodeId: NODE,
            attempt: 1,
          }),
        ]);

        const snapshot = snapshotRunAt(db, RUN_A, 999_999);
        expect(snapshot.seq).toBe(2);
        expect(snapshot).toEqual(snapshotRunAt(db, RUN_A, 'head'));
      } finally {
        db.close();
      }
    });
  },
);

suite('io_chunk is never read (AC7)', () => {
  it('reads only event, even when the run has a data plane too', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        draft({
          runId: RUN_A,
          kind: 'node.progress',
          payload: progress('a'),
          nodeId: NODE,
          attempt: 1,
        }),
      ]);
      appendIoChunks(db, [
        {
          runId: RUN_A,
          nodeId: NODE,
          attempt: 1,
          stream: 'stdout',
          ts: 1_754_308_293_000,
          data: new TextEncoder().encode('agent output nobody asked the reducer to read'),
        },
      ]);

      const { db: watched, sql } = recording(db);
      snapshotRunAt(watched, RUN_A, 'head');

      expect(sql.length).toBeGreaterThan(0);
      expect(sql.filter((statement) => statement.includes('io_chunk'))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('10,000 control-plane events stay within budget (AC5, test plan #4)', () => {
  it('reduces linearly rather than quadratically, on a real ledger file', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const seed = (count: number): void => {
        for (let batch = 0; batch < count; batch += 1000) {
          appendEvents(
            db,
            Array.from({ length: Math.min(1000, count - batch) }, (_unused, index) =>
              draft({
                runId: RUN_A,
                kind: 'node.progress',
                payload: progress(`step-${batch + index}`),
                nodeId: NODE,
                attempt: 1,
              }),
            ),
          );
        }
      };

      seed(1_000);
      const smallStart = performance.now();
      const small = snapshotRunAt(db, RUN_A, 'head');
      const smallElapsed = performance.now() - smallStart;
      expect(small.seq).toBe(1_000);

      seed(9_000);
      const bigStart = performance.now();
      const big = snapshotRunAt(db, RUN_A, 'head');
      const bigElapsed = performance.now() - bigStart;
      expect(big.seq).toBe(10_000);

      // The measured budget is 29 ms for 10,000 events; this asserts an order
      // of magnitude of headroom above it rather than the raw number, because
      // this machine also runs the rest of the suite at the same time.
      expect(bigElapsed, `reducing 10,000 events took ${bigElapsed.toFixed(1)} ms`).toBeLessThan(
        1_000,
      );

      // 10x the events. A linear fold costs on the order of 10x; a quadratic
      // one costs on the order of 100x. The ceiling sits well below the
      // quadratic case and well above ordinary load-induced noise, so it is
      // this specific regression that fails it rather than a busy box.
      const ratio = bigElapsed / Math.max(smallElapsed, 0.1);
      expect(
        ratio,
        `1,000 events took ${smallElapsed.toFixed(1)} ms and 10,000 took ${bigElapsed.toFixed(1)} ms`,
      ).toBeLessThan(60);
    } finally {
      db.close();
    }
  }, 30_000);
});
