/**
 * KAR-03.4 — the split is what removes snapshotting, so the two numbers it
 * rests on are asserted rather than believed: the fold ignores a data plane
 * fifty times its size, and the tail query is served by the index.
 *
 * Verifies: EPIC-03-S12, EPIC-03-S13 (scenarios 1 and 2) · AC3, AC4
 */
import { type Db, type DbStatement, type DbValue, NodeIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  appendIoChunks,
  drainEvents,
  drainIoChunks,
  EVENT_TAIL_SQL,
  IO_CHUNK_TAIL_SQL,
  openLedger,
  type StoredEvent,
} from '../../src/index.ts';
import { draft, RUN_A } from './support/events.ts';

const NODE = NodeIdSchema.parse('n1');

/** A `Db` that remembers every statement prepared through it. */
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

/**
 * A stand-in for KAR-03.5's `reduce`: enough per-event work — a branch on
 * `kind` and a touch of the parsed payload — that the measured time is the
 * fold's and not an empty loop's.
 */
interface Tally {
  seen: number;
  completed: number;
  watermark: number;
}

const fold = (state: Tally, event: StoredEvent): Tally => {
  const { ordinal } = event.payload as { ordinal: number };
  if (event.kind !== 'node.completed') {
    // Progress does not advance the watermark — the F4.7 property the split
    // gives away for free, spelled out here so the fold is not an empty loop.
    return { ...state, seen: Math.max(state.seen, ordinal + 1) };
  }
  return {
    seen: Math.max(state.seen, ordinal + 1),
    completed: state.completed + 1,
    watermark: event.seq,
  };
};

/** 10,000 control-plane events, one in ten of them a `node.completed`. */
function seedControlPlane(db: Db, count: number): void {
  for (let batch = 0; batch < count; batch += 1000) {
    appendEvents(
      db,
      Array.from({ length: Math.min(1000, count - batch) }, (_unused, index) => {
        const ordinal = batch + index;
        return draft({
          kind: ordinal % 10 === 0 ? 'node.completed' : 'node.progress',
          nodeId: NODE,
          attempt: 1,
          payload: { ordinal, phase: 'streaming' },
        });
      }),
    );
  }
}

/** Bytes per `io_chunk` row, so the control below can prove it read them all. */
const CHUNK_BYTES = 256;

/** 500,000 data-plane rows for the same run. */
function seedDataPlane(db: Db, count: number): void {
  const data = new TextEncoder().encode('y'.repeat(CHUNK_BYTES));
  for (let batch = 0; batch < count; batch += 10_000) {
    appendIoChunks(
      db,
      Array.from({ length: Math.min(10_000, count - batch) }, () => ({
        runId: RUN_A,
        nodeId: NODE,
        attempt: 1,
        stream: 'stdout' as const,
        ts: 1_754_308_293_000,
        data,
      })),
    );
  }
}

suite('500k data-plane rows do not slow the fold (EPIC-03-S12, AC3)', () => {
  it('folds 10,000 control-plane events beside 500,000 io_chunk rows for a fraction of what reading that data plane costs', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedControlPlane(db, 10_000);
      seedDataPlane(db, 500_000);

      const { db: watched, sql } = recording(db);
      const started = performance.now();
      let state: Tally = { seen: 0, completed: 0, watermark: 0 };
      for (const event of drainEvents(watched, RUN_A)) state = fold(state, event);
      const elapsed = performance.now() - started;

      expect(state.seen).toBe(10_000);
      expect(state.completed).toBe(1000);

      // The control, on the same machine seconds later: the data plane this
      // fold refused to look at, drained through the same bounded reader. It is
      // this spec's own regression measured directly — a reducer that started
      // reading io_chunk would pay exactly this — so the two halves are the
      // honest fold and the dishonest one, side by side.
      //
      // It runs through `db` rather than `watched` on purpose: the control must
      // not appear in `sql`, which the statement assertions below read.
      const controlStarted = performance.now();
      let controlBytes = 0;
      for (const chunk of drainIoChunks(db, { runId: RUN_A, nodeId: NODE, attempt: 1 })) {
        controlBytes += chunk.data.byteLength;
      }
      const control = performance.now() - controlStarted;
      // A control that read nothing would make the ceiling below meaningless,
      // so it has to prove it read all 128 MB of it.
      expect(controlBytes, 'the control must actually read the data plane').toBe(
        500_000 * CHUNK_BYTES,
      );

      // The scenario's "under 100 ms on CI hardware", kept as the floor and
      // expressed against that control above it. The flat number was measuring
      // the box: this spec runs in the integration slice beside a hundred
      // forked workers, several of them driving real subprocesses, and the same
      // fold costs 6.8-8.3 ms idle but 24.8 ms beside a live full suite — and
      // on the EPIC-07 gate run, 110.04 ms against the 100 ms ceiling. Nothing
      // had touched the reducer; the box was busy. (S13 below went the same way
      // and was fixed the same way.)
      //
      // The ratio is what is stable, because load moves both halves together
      // and cancels. Measured 2026-08-06, 8 cores, better-sqlite3 in WAL:
      // 0.0172, 0.0182, 0.0206 and 0.0220 idle, 0.0220 beside a live full suite
      // and 0.0231 beside twelve CPU hogs — six samples inside a 1.34x spread
      // while the absolute fold moved by 3.6x.
      //
      // A quarter is calibrated against the regression, not guessed. A fold
      // that reaches into the data plane pays what the control pays, so its
      // ratio is about 1: forced to drain io_chunk inside the timed region it
      // measured 1.0534 idle and 1.0205 under twelve CPU hogs, and went red
      // both times — by 4.0x and 4.1x — and green again on removal. So the
      // ceiling sits ~11x above the worst honest sample and ~4x below a
      // regressed one.
      //
      // The 100 ms floor is the scenario's own budget, kept intact: idle, a
      // quarter of the control is ~95 ms, so a quiet machine is held to exactly
      // the number EPIC-03 wrote down.
      expect(
        elapsed,
        `draining the 500,000 io_chunk rows beside it took ${control.toFixed(0)} ms on this machine`,
      ).toBeLessThan(Math.max(100, control / 4));

      // The stronger half of the same claim: it is not that the fold is fast
      // despite the data plane, it is that it never looks at it. The first
      // assertion is what stops the second from passing on an empty log.
      expect(sql.length).toBeGreaterThan(0);
      expect(sql.filter((statement) => statement.includes('io_chunk'))).toEqual([]);
    } finally {
      db.close();
    }
    // The slice's 30 s default would be the old flat budget by the back door:
    // this spec seeds 510,000 rows and then reads 128 MB of them back, and the
    // point of it is that both halves are slow when the box is loaded. Measured
    // end to end at 2.3 s idle and 6.4 s beside twelve CPU hogs, so 60 s is 9x
    // the worst honest run where the default was 4.7x.
  }, 60_000);

  it('folds a realistic ~2,000-event run in single-digit milliseconds', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedControlPlane(db, 2000);
      const started = performance.now();
      let seen = 0;
      for (const _event of drainEvents(db, RUN_A)) seen++;
      expect(seen).toBe(2000);
      expect(performance.now() - started).toBeLessThan(30);

      // "No snapshot table is consulted, because none exists."
      const tables = db
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT 100",
        )
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain('snapshot');
    } finally {
      db.close();
    }
  });
});

suite('the tail query is served by the index (EPIC-03-S13, AC4)', () => {
  /**
   * The shipped query with the index taken away from it, derived from the
   * shipped constant so the two cannot drift into different queries. `+ 0`
   * makes `seq` an expression rather than a column, which SQLite cannot answer
   * from `event_run_seq` — the regression the plan assertions forbid, kept here
   * as a live control to time against. If `EVENT_TAIL_SQL` is ever reworded so
   * these substitutions miss, the control stops being slow and the ratio
   * assertion fails, which is the direction a broken fixture should fail in.
   */
  const SCAN_CONTROL_SQL = EVENT_TAIL_SQL.replace('AND seq > ?', 'AND seq + 0 > ?').replace(
    'ORDER BY seq',
    'ORDER BY seq + 0',
  );

  const plan = (db: Db, sql: string, parameters: DbValue[]): string =>
    db
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters)
      .map((row) => row.detail)
      .join(' | ');

  it('plans the shipped event tail query as a SEARCH on event_run_seq, never a SCAN', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const detail = plan(db, EVENT_TAIL_SQL, [RUN_A, 0, 500]);
      expect(detail).toContain('SEARCH event USING');
      expect(detail).toContain('event_run_seq');
      expect(detail).not.toContain('SCAN event');
      expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    } finally {
      db.close();
    }
  });

  it('plans the seq-only cursor probe as a COVERING INDEX read of event_run_seq', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // The architecture's recorded string. It is only *covering* when the
      // query asks for nothing outside (run_id, seq) — see README, "the tail
      // query is served by the index".
      const detail = plan(
        db,
        'SELECT seq FROM event WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        [RUN_A, 0, 500],
      );
      expect(detail).toContain('SEARCH event USING COVERING INDEX event_run_seq');
    } finally {
      db.close();
    }
  });

  it('plans the io_chunk tail query on io_run_seq rather than scanning the data plane', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const detail = plan(db, IO_CHUNK_TAIL_SQL, [RUN_A, NODE, 1, 0, 500]);
      expect(detail).toContain('io_run_seq');
      expect(detail).not.toContain('SCAN io_chunk');
    } finally {
      db.close();
    }
  });

  it('serves 1,000 advancing tail queries over 500,000 events, 25x cheaper than the plan it forbids', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedControlPlane(db, 500_000);
      const statement = db.prepare<{ seq: number }>(EVENT_TAIL_SQL);

      /**
       * The box's own tail, sampled inside the same loop as the queries.
       *
       * A recursive CTE counting to 5,000 is pure arithmetic inside SQLite: it
       * reads no table, so no index and no query plan can change what it costs,
       * and 5,000 makes one of them about half a millisecond against a tail
       * query's fifth of one. Being the same order of magnitude is the whole
       * requirement — what it measures is how often the scheduler takes the CPU
       * away *during a sub-millisecond window*, and a probe a hundred times
       * shorter than the subject would be hit a hundred times less often and
       * would report a tail that is not the subject's.
       */
      const noise = db.prepare<{ counted: number }>(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) ' +
          'SELECT count(*) AS counted FROM c',
      );

      let cursor = 0;
      const each: number[] = [];
      const scheduler: number[] = [];
      for (let query = 0; query < 1000; query++) {
        const before = performance.now();
        const rows = statement.all(RUN_A, cursor, 500);
        each.push(performance.now() - before);
        cursor = rows.at(-1)?.seq ?? 0;

        const noiseBefore = performance.now();
        noise.all();
        scheduler.push(performance.now() - noiseBefore);
      }
      /** The middle sample, which is what "what a query costs" means here. */
      const middle = (samples: readonly number[]): number => {
        const sorted = [...samples].sort((left, right) => left - right);
        return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
      };
      // The median, not the mean, and not the wall clock either — the wall clock
      // now spans the interleaved probe as well. A mean of a thousand
      // fifth-of-a-millisecond samples is whatever the worst stall in the window
      // was, divided by a thousand: this spec has been measured with one query
      // at 3,014.7 ms beside a live slice, which on its own adds 3 ms to a mean
      // whose honest value is 0.2. The ratio below went red at 1.36x that way on
      // a full-suite run with the plan untouched.
      const perQuery = middle(each);

      expect(cursor).toBe(500_000);
      // A probe that never ran would make the two ceilings below meaningless.
      expect(scheduler, 'the scheduler probe must have been sampled too').toHaveLength(1000);

      // The control: the same query over the same 500,000 rows on the same
      // machine seconds later, with only the property under test taken away —
      // `seq + 0` is opaque to the index, so the ordering goes through the temp
      // b-tree the spec above forbids. Asserting the *ratio* rather than an
      // absolute budget is what makes this survive its neighbours: the
      // integration slice runs a hundred forked specs, several of them driving
      // real agent subprocesses, and the same thousand queries that take 196 ms
      // on an idle box took 770 ms beside a full slice — a number that measures
      // the scheduler, not the query plan. Load moves both halves together, so
      // it cancels; a plan regression moves only one.
      expect(plan(db, SCAN_CONTROL_SQL, [RUN_A, 0, 500])).toContain('USE TEMP B-TREE FOR ORDER BY');
      const control = db.prepare<{ seq: number }>(SCAN_CONTROL_SQL);
      // Five samples reduced by median rather than three reduced by mean, so
      // that both sides of the ratio are the same kind of number. One stall on
      // one of three samples moves a mean by a third; it cannot move a median.
      const controlEach: number[] = [];
      for (let query = 0; query < 5; query++) {
        const before = performance.now();
        control.all(RUN_A, query * 1000, 500);
        controlEach.push(performance.now() - before);
      }
      const controlPerQuery = middle(controlEach);

      // Measured 2026-08-02: 0.2 ms indexed against 28.7 ms through the b-tree,
      // a factor of ~135. 25 is the floor, not the expectation.
      //
      // Measured 2026-08-06 as median against median, seven honest samples:
      // 5.5x and 5.5x of headroom idle, 7.9x and 7.0x under twelve CPU hogs,
      // and 5.4x, 6.4x and 15.4x beside a live integration slice, while the mean
      // form of the same ratio failed at 1.36x. Forced onto the forbidden plan
      // the medians are 22.8 ms against a 30.1 ms control idle and 52.4 against
      // 77.6 under hogs, which fails by 19x and 17x.
      expect(
        perQuery * 25,
        `median query ${perQuery.toFixed(3)} ms against a median control query of ` +
          `${controlPerQuery.toFixed(1)} ms on this machine`,
      ).toBeLessThan(controlPerQuery);
      // The scenario's "no single query exceeds 5 ms", asserted at p99 rather
      // than at the maximum. The integration slice runs several heavy specs in
      // parallel forks, so a query here and there meets a GC pause or the OS
      // descheduling the worker — an outlier that measures the scheduler, not
      // the query plan.
      //
      // Both of these were flat millisecond ceilings until 2026-08-06 and were
      // demonstrably measuring the box: beside a live integration slice the p99
      // ran 2.7, 3.5, 5.8 and 8.5 ms against a 5 ms ceiling, and the worst
      // single query 21.6, 54.6, 67.2 and 76.4 ms against a 100 ms one, where
      // idle the same spec measures 0.23 ms and 1.9 ms.
      //
      // Expressing them against `controlPerQuery` was the first fix and it was
      // not enough: the p99 went red again at 0.348 of the control where the
      // worst sample behind that ceiling had been 0.108. The reason is that the
      // two halves are not the same kind of number. The subject is the *tail* of
      // a thousand fifth-of-a-millisecond samples; the control is the *mean* of
      // three 28 ms ones. Scheduler noise is additive — a 10 ms stall lands
      // whole on whichever sample it hits — so it moves a tail of tiny samples
      // enormously and a mean of large ones barely at all, and no constant makes
      // that a ratio.
      //
      // So the tail is measured against a tail, sampled in the same loop: the
      // scheduler probe above, which is the same order of duration, is sampled
      // the same thousand times, and cannot be touched by a query plan. What it
      // reports is exactly the term that was inflating the p99, and it is added
      // to the ceiling rather than divided into it, because that is how the
      // noise enters.
      //
      // Measured 2026-08-06, 8 cores, better-sqlite3 in WAL, thirteen honest
      // samples. Idle, a p99 of 0.216-0.266 ms against a probe p99 of 0.50-0.53
      // and a ceiling of ~7.5 — 29x of headroom. Under twelve CPU hogs, a p99 of
      // 1.34, 6.53, 8.66 and 9.98 against probe p99s of 12.4-14.9, ceilings of
      // 25-34, closest margin 3.2x. Beside a live integration slice, 4.69, 7.33,
      // 8.35, 17.04 and 22.37 against probe p99s of 3.0-37.2, ceilings of 23-84,
      // closest margin 3.7x. The probe's own p99 reaching 37 ms while the median
      // query stayed at 0.6 ms is the finding: the tail was the box.
      //
      // Calibrated against the regression, not guessed. The tail query forced
      // onto the plan the specs above forbid — the same `seq + 0` the control
      // uses — measured a p99 of 26.86 ms against a 7.10 ceiling idle and 80.07
      // against a 34.21 ceiling under twelve hogs, failing by 3.8x and 2.3x. So
      // the ceiling sits at worst 3.2x above an honest sample and 2.3x below a
      // regressed one.
      //
      // Both floors are the scenario's own numbers, kept intact: idle the probe
      // contributes half a millisecond and a quarter of the control is ~7 ms, so
      // a quiet machine is held to what it always was.
      const budget = Math.max(5, controlPerQuery / 4);
      const sorted = [...each].sort((left, right) => left - right);
      const p99 = sorted[989] ?? Infinity;
      const schedulerSorted = [...scheduler].sort((left, right) => left - right);
      const schedulerP99 = schedulerSorted[989] ?? 0;
      const over = (samples: readonly number[]): number =>
        samples.filter((sample) => sample > budget).length;
      const note =
        `one control query cost ${controlPerQuery.toFixed(1)} ms on this machine; the budget is ` +
        `${budget.toFixed(1)} ms; the scheduler probe beside these queries ran to ` +
        `${schedulerP99.toFixed(1)} ms at p99 and ${Math.max(...scheduler).toFixed(1)} ms at ` +
        `worst, and ${over(scheduler)} of its 1,000 samples were over the budget`;
      expect(p99, note).toBeLessThan(budget + schedulerP99);

      // The other half of "no single query exceeds 5 ms": how *many* exceeded
      // it, against how many probe samples exceeded it in the same window.
      //
      // This was a ceiling on the single worst query until 2026-08-06, and a
      // maximum is not a measurable quantity here. It is the worst scheduling
      // event in the whole window and it belongs to whichever of the 2,000
      // samples it happened to land on, so the subject's maximum and the
      // probe's maximum are two *different* events and cannot be paired.
      // Measured beside a live integration slice: one query at 3,014.7 ms with a
      // median of 0.56 ms and the probe's own worst at 59.5 ms — the worker was
      // descheduled for three seconds, and nothing about that is a fact about a
      // query plan. On the run that produced this fix, that ceiling failed at
      // 511 ms with the probe's worst at 16.6 ms.
      //
      // A count over a threshold is attributable where an extremum is not: both
      // sides are counts of 1,000 interleaved samples over the same threshold in
      // the same window, so a busy box raises both. Measured over seven honest
      // samples at each run's own budget: 0 and 0 idle, and 2-4 queries against
      // 1-6 probe samples under twelve CPU hogs and beside a live slice. The
      // forbidden plan puts *every* query over the budget — 1,000 against the
      // probe's 0 — because that is what losing the index means, so the
      // separation here is a hundredfold rather than the twofold an extremum
      // gave. The allowance of 10 is 1% of the samples, the same 1% the p99
      // above already tolerates.
      expect(over(each), note).toBeLessThanOrEqual(over(scheduler) + 10);
    } finally {
      db.close();
    }
    // Every budget in this spec is already relative to a control measured on
    // the same box seconds later, so that load cancels. The slice's 30 s
    // default was the one number left that was not: building 500,000 events and
    // serving 1,000 interleaved tail queries costs 9.8 s beside a live
    // integration slice (measured 2026-08-07), which leaves it about 3x from
    // becoming a flat wall-clock budget by the back door — the exact failure
    // the ratios above exist to avoid. 60 s matches the sibling spec at the top
    // of this file, which does the same work for the same reason.
  }, 60_000);
});
