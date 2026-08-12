/**
 * KAR-19.1 AC7 — a run that cannot proceed says so, once.
 *
 * F4.7's `run.stalled` has existed since KAR-06.8, is specified as *"surfaced,
 * never auto-killed"*, and has never been appended by anything: the detector
 * required a node to be `running`, so the one run shape that actually stalls in
 * practice — nothing in flight, ledger stopped, nobody coming back — was
 * invisible to it by construction. This is the first path that appends it.
 *
 * The repeated-advance clause is the whole difference between a useful signal
 * and a log an operator learns to ignore. A detector that fires per tick
 * produces one line a second, which trains exactly the habit that lost the
 * afternoon of 2026-08-12.
 *
 * A `TestClock` drives the ten-minute window in microseconds, with no fake
 * timers: nothing here spawns a child, and the rule stays the rule.
 *
 * Verifies: EPIC-19-S4 · KAR-19.1 AC7 · test plan #7
 */
import type { RunId, StallReport, TaskSpec } from '@DeFlow/core';
import { sealTaskSpec } from '@DeFlow/core';
import { appendEvents, openLedger, readRange, readWakes } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { createRunDriver } from '../../src/drive.ts';
import { framed } from './support/spec-gate-run.ts';

const T0 = 1_754_470_000_000;
const MINUTE = 60_000;
const RUN = 'run_20260806T101500Z_19a107' as RunId;

/**
 * A run that reached `run.created` and then stopped: the exact state
 * EPIC-19-S4 opens on. No plan, no node, no wake — nothing is in flight, and
 * nothing is coming back for it.
 */
async function seedCreatedRun(dataDir: string) {
  const db = openLedger(dataDir);
  const spec: TaskSpec = await sealTaskSpec(framed());
  appendEvents(db, [
    {
      runId: RUN,
      ts: T0,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        sha256: 'a'.repeat(64),
        raw: 'Migrate the checkout module',
        provenance: { kind: 'text', by: 'cli', submittedAt: T0 },
      },
    },
    {
      runId: RUN,
      ts: T0,
      kind: 'run.created',
      v: 1,
      epoch: 1,
      payload: { spec, cwd: '/repo', repo: { head: 'e83c516', branch: 'main' } },
    },
  ]);
  return db;
}

const kinds = (db: ReturnType<typeof openLedger>): string[] =>
  readRange(db, RUN, 0, 100).events.map((event) => event.kind);

const stalls = (db: ReturnType<typeof openLedger>): number =>
  kinds(db).filter((kind) => kind === 'run.stalled').length;

suite('EPIC-19-S4 — an accepted run stops advancing (AC7)', () => {
  it('appends exactly one run.stalled past the window, and never a second', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedCreatedRun(dataDir);
    const clock = new TestClock(T0);
    const reported: { runId: RunId; report: StallReport }[] = [];
    const driver = createRunDriver({
      db,
      clock,
      epoch: 1,
      onStalled: (runId, report) => reported.push({ runId, report }),
    });

    try {
      // Nine minutes fifty-nine: still silent. A run that has been quiet for
      // less than its window is a run that is working.
      clock.jumpTo(T0 + 9 * MINUTE + 59_000);
      await driver.tick(clock.now());
      expect(stalls(db)).toBe(0);

      clock.jumpTo(T0 + 10 * MINUTE + 1_000);
      await driver.tick(clock.now());

      expect(stalls(db)).toBe(1);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.runId).toBe(RUN);
      expect(reported[0]?.report).toEqual({
        watermarkSeq: 2,
        idleMs: 10 * MINUTE + 1_000,
        // EPIC-19-S4's clause: the empty running-node list is the report, not
        // the absence of one.
        runningNodes: [],
      });

      // Ten further windows, and the operator still has one line rather than
      // six hundred. The episode is identified by the watermark, and
      // `run.stalled` is the one event reduced without advancing it.
      for (let window = 1; window <= 10; window += 1) {
        clock.jumpTo(T0 + (10 + window * 10) * MINUTE);
        await driver.tick(clock.now());
      }
      expect(stalls(db)).toBe(1);
      expect(reported).toHaveLength(1);

      // The run is not killed and nothing was signalled: the only thing that
      // happened to this ledger is one report.
      expect(kinds(db)).toEqual(['task.submitted', 'run.created', 'run.stalled']);
      expect(readWakes(db, RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('says nothing about a run whose framing wake is still outstanding', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    appendEvents(db, [
      {
        runId: RUN,
        ts: T0,
        kind: 'task.submitted',
        v: 1,
        epoch: 1,
        payload: {
          sha256: 'a'.repeat(64),
          raw: 'Migrate the checkout module',
          provenance: { kind: 'text', by: 'cli', submittedAt: T0 },
        },
      },
    ]);
    const clock = new TestClock(T0 + 60 * MINUTE);
    const driver = createRunDriver({ db, clock, epoch: 1 });

    try {
      await driver.tick(clock.now());
      // Waiting is not stalling: the run has a durable wait with an instant on
      // it, and something is expected to come back for it. The silence that is
      // a defect is the one where nothing is.
      expect(stalls(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});
