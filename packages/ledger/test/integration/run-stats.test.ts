/**
 * KAR-03.4 — the assumption that removed snapshotting, instrumented.
 *
 * "A 40-node multi-hour run produces on the order of 2,000 control-plane
 * events" is the whole reason `reduce` over a full ledger is cheap enough that
 * no snapshot table exists. Roadmap A1-3 is the risk that it is 10-100x off
 * because someone started emitting an event per tool call. This spec is how
 * that gets discovered by measurement rather than by a nine-hour run being slow
 * to open.
 *
 * Verifies: EPIC-03-S30 · AC6
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  appendIoChunks,
  CONTROL_EVENT_BUDGET,
  openLedger,
  readRunStats,
  SNAPSHOT_REVISIT_THRESHOLD,
} from '../../src/index.ts';
import { draft, RUN_A, RUN_B } from './support/events.ts';
import { fortyNodeRun, NODE_COUNT } from './support/forty-node-run.ts';

suite('the counter exists from M1 (EPIC-03-S30 scenario 1)', () => {
  it('reports a control-plane event count for a scripted 40-node run', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const run = fortyNodeRun(RUN_A);
      for (let batch = 0; batch < run.events.length; batch += 500) {
        appendEvents(db, run.events.slice(batch, batch + 500));
      }
      for (let batch = 0; batch < run.chunks.length; batch += 500) {
        appendIoChunks(db, run.chunks.slice(batch, batch + 500));
      }

      const stats = readRunStats(db, RUN_A);
      expect(stats.runId).toBe(RUN_A);
      expect(stats.controlEventCount).toBe(run.events.length);
      expect(stats.ioChunkCount).toBe(run.chunks.length);
      expect(stats.lastSeq).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('lands in the low thousands, consistent with the ~2,000 the design assumes', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const run = fortyNodeRun(RUN_A);
      for (let batch = 0; batch < run.events.length; batch += 500) {
        appendEvents(db, run.events.slice(batch, batch + 500));
      }
      const { controlEventCount } = readRunStats(db, RUN_A);

      expect(NODE_COUNT).toBe(40);
      expect(controlEventCount).toBeGreaterThan(1000);
      expect(controlEventCount).toBeLessThan(3000);
    } finally {
      db.close();
    }
  });

  it('counts only this run, so two interleaved runs do not inflate each other', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      for (let index = 0; index < 20; index++) {
        appendEvents(db, [draft({ runId: RUN_A }), draft({ runId: RUN_B })]);
      }
      appendEvents(db, [draft({ runId: RUN_A })]);

      expect(readRunStats(db, RUN_A).controlEventCount).toBe(21);
      expect(readRunStats(db, RUN_B).controlEventCount).toBe(20);
    } finally {
      db.close();
    }
  });

  it('reports zeroes for a run that has never been written', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(readRunStats(db, RUN_A)).toEqual({
        runId: RUN_A,
        controlEventCount: 0,
        ioChunkCount: 0,
        ioBytes: 0,
        lastSeq: 0,
      });
    } finally {
      db.close();
    }
  });
});

suite('a regression is visible (EPIC-03-S30 scenario 2)', () => {
  it('holds the standard fixture under the 20,000-event budget', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const run = fortyNodeRun(RUN_A);
      for (let batch = 0; batch < run.events.length; batch += 500) {
        appendEvents(db, run.events.slice(batch, batch + 500));
      }

      // If this fails, the "~2,000 control-plane events per 40-node run"
      // assumption behind "do not build snapshotting"
      // (docs/05-durable-execution.md §5.1) has moved. Find what started
      // emitting per tool call. Real snapshots are only warranted past
      // SNAPSHOT_REVISIT_THRESHOLD control events in a single run; below it the
      // cheaper move for file size is io_chunk in a second file via ATTACH.
      expect(readRunStats(db, RUN_A).controlEventCount).toBeLessThan(CONTROL_EVENT_BUDGET);
    } finally {
      db.close();
    }
  });

  it('sets the budget an order of magnitude above the fixture and below the revisit line', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const run = fortyNodeRun(RUN_A);
      for (let batch = 0; batch < run.events.length; batch += 500) {
        appendEvents(db, run.events.slice(batch, batch + 500));
      }
      const { controlEventCount } = readRunStats(db, RUN_A);

      // An event per tool call is the 10x this budget is set to catch.
      expect(CONTROL_EVENT_BUDGET).toBeGreaterThan(controlEventCount * 5);
      expect(CONTROL_EVENT_BUDGET).toBeLessThan(SNAPSHOT_REVISIT_THRESHOLD);
      expect(SNAPSHOT_REVISIT_THRESHOLD).toBe(100_000);
    } finally {
      db.close();
    }
  });
});
