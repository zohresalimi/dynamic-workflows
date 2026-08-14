/**
 * KAR-19.1 AC2, AC3 — `boot()` performs `start-ticker`, and the wake intake
 * wrote is consumed.
 *
 * `recovery.ts` has declared eight steps since KAR-06.9 and its only caller
 * performed five of them: the ledger had a `node_wake` writer and no reader, so
 * the durable wait at the centre of the whole design was a table nothing looked
 * at. Every assertion here is about that gap being closed — the eighth step
 * performed, the row consumed, and `run.created` reached inside the budget an
 * operator will actually wait through.
 *
 * The framing runner is a **port**, and this spec supplies one that seals the
 * committed framed fixture. What it stands in for is a live ACP session on a
 * probed provider, which is KAR-19.3's; what it does *not* stand in for is any
 * part of the machinery under test — the wake, the tick, the dispatch and the
 * ledger are all real, and the row it consumes was written by the real
 * `submitTask`.
 *
 * Verifies: EPIC-19-S1, EPIC-19-S5, EPIC-19-S8 · KAR-19.1 AC2, AC3 ·
 * test plan #2, #3
 */
import type { RunId, TaskSpec } from '@DeFlow/core';
import { sealTaskSpec } from '@DeFlow/core';
import { appendEvents, openLedger, readRange, readWakes, scheduleWake } from '@DeFlow/ledger';
import { it, makeRepo, TEST_DAEMON_TOKEN, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { systemClock } from '../../src/clock.ts';
import type { FramingRunner } from '../../src/drive.ts';
import { FRAMING_WAKE_REASON, submitTask } from '../../src/intake/intake.ts';
import { RECOVERY_STEPS, type RecoveryStep } from '../../src/recovery.ts';
import { FRAMING_NODE } from '../../src/spec/gate.ts';
import { framed } from './support/spec-gate-run.ts';

const T0 = 1_754_470_000_000;

/**
 * A framing runner that does the one thing the interview's success arm does:
 * appends `run.created` carrying a sealed `TaskSpec`.
 *
 * Deliberately not a second interview — no packet, no session, no schema
 * enforcement — because those belong to the function this port will be bound to
 * (`runFramingInterview`) and re-implementing them here would be the second
 * planner KAR-19.3 AC7's guard exists to refuse.
 */
function framingRunner(repoDir: string) {
  const calls: RunId[] = [];

  const runner: FramingRunner = async ({ runId, now, db, epoch }) => {
    calls.push(runId);
    const spec: TaskSpec = await sealTaskSpec(framed());
    appendEvents(db, [
      {
        runId,
        ts: now,
        kind: 'run.created',
        v: 1,
        epoch,
        payload: { spec, cwd: repoDir, repo: { head: 'e83c516', branch: 'main' } },
      },
    ]);
  };

  return { runner, calls };
}

/** The intake ports a spec drives `submitTask` through directly, on the booted
 * daemon's own writer — the same connection `POST /api/runs` uses. */
const intakePortsOf = (booted: Booted, hex: string) => ({
  db: booted.db,
  epoch: booted.epoch,
  clock: systemClock,
  dataDir: booted.dataDir,
  randomHex: () => hex,
});

const kindsOf = (booted: Booted, runId: string): string[] =>
  readRange(booted.db, runId as RunId, 0, 50).events.map((event) => event.kind);

const tsOf = (booted: Booted, runId: string, kind: string): number | undefined =>
  readRange(booted.db, runId as RunId, 0, 50).events.find((event) => event.kind === kind)?.ts;

/** Real milliseconds, never a fake timer: the ticker is alive. */
const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

suite('boot performs RECOVERY_STEPS in full (AC2)', () => {
  it('performs all eight steps, in order, start-ticker included', async ({ tmp }) => {
    const steps: RecoveryStep[] = [];
    const booted = await boot({
      dataDir: join(tmp, 'data'),
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      onRecoveryStep: (step) => steps.push(step),
    });
    try {
      expect(steps).toEqual([...RECOVERY_STEPS]);
      expect(booted.ticker.running).toBe(true);
    } finally {
      await booted.shutdown();
      expect(booted.ticker.running).toBe(false);
    }
  });

  it('records the ticker interval in daemon.json, so deflow status can report it', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    const booted = await boot({
      dataDir,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      tickIntervalMs: 250,
    });
    try {
      const file = JSON.parse(
        await import('node:fs/promises').then((fs) =>
          fs.readFile(join(dataDir, 'daemon.json'), 'utf8'),
        ),
      ) as { tickIntervalMs: number };
      expect(file.tickIntervalMs).toBe(250);
    } finally {
      await booted.shutdown();
    }
  });
});

suite('the ticker consumes the framing wake (AC2, AC3)', () => {
  it('reaches run.created within 2 s of task.submitted, and clears the wake', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const framing = framingRunner(repo.dir);
    const booted = await boot({
      dataDir: join(tmp, 'data'),
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      tickIntervalMs: 25,
      runFraming: framing.runner,
    });
    try {
      const submitted = await submitTask(
        {
          body: {
            input: { kind: 'text', text: 'Migrate the checkout module' },
            cwd: repo.dir,
            permission: 'worktree',
          },
          by: 'cli',
        },
        intakePortsOf(booted, '0a0a0a'),
      );
      if (submitted.outcome !== 'created')
        throw new Error('expected the submission to be accepted');

      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && !kindsOf(booted, submitted.runId).includes('run.created')) {
        await settle();
      }

      expect(kindsOf(booted, submitted.runId)).toEqual(['task.submitted', 'run.created']);
      expect(framing.calls).toEqual([submitted.runId]);

      // AC3 — the elapsed milliseconds are derivable from the two events' own
      // timestamps, which is what makes the budget checkable six weeks later
      // from the ledger alone rather than from a stopwatch in this file.
      const from = tsOf(booted, submitted.runId, 'task.submitted');
      const to = tsOf(booted, submitted.runId, 'run.created');
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect((to ?? 0) - (from ?? 0)).toBeLessThan(2_000);

      // The wake was the reminder, and the event is the record: once framing has
      // happened the row is gone, so no later daemon frames this run twice.
      expect(readWakes(booted.db, submitted.runId)).toEqual([]);
    } finally {
      await booted.shutdown();
    }
  });

  it('consumes a pre-seeded due wake within two tick intervals of a TestClock', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });

    // EPIC-19-S8 — a submission the daemon was not around to drive: the ledger
    // and the row are on disk, and nothing is running.
    const seeded = openLedger(dataDir);
    const runId = 'run_20260806T101500Z_19a101' as RunId;
    appendEvents(seeded, [
      {
        runId,
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
    scheduleWake(seeded, {
      runId,
      nodeId: FRAMING_NODE,
      wakeAt: T0 + 1,
      reason: FRAMING_WAKE_REASON,
    });
    seeded.close();

    const clock = new TestClock(T0);
    const framing = framingRunner(repo.dir);
    const booted = await boot({
      dataDir,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      clock,
      tickIntervalMs: 1_000,
      runFraming: framing.runner,
    });
    try {
      // The wake was one millisecond in the future at boot, so the immediate
      // first tick may not take it. Two intervals is the ceiling AC2 states.
      for (let tick = 0; tick < 2; tick += 1) {
        await clock.advance(1_000);
        await settle(5);
      }

      expect(kindsOf(booted, runId)).toEqual(['task.submitted', 'run.created']);
      // And the operator never resubmitted anything: the provenance is still
      // the original submission's (EPIC-19-S8).
      const submitted = readRange(booted.db, runId, 0, 10).events[0];
      expect((submitted?.payload as { provenance: { by: string } }).provenance.by).toBe('cli');
      expect(readWakes(booted.db, runId)).toEqual([]);
    } finally {
      await booted.shutdown();
    }
  });
});

suite('EPIC-19-S5 — the wake survives the daemon that wrote it', () => {
  it('is still there after a daemon that could not frame it, and the next one frames it', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const dataDir = join(tmp, 'data');

    // A daemon with no framing runner: it ticks, it reads the row, and it
    // consumes nothing — the state a crash between the 201 and the next tick
    // leaves behind.
    const first = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
    let runId: string;
    try {
      const submitted = await submitTask(
        {
          body: {
            input: { kind: 'text', text: 'Migrate the checkout module' },
            cwd: repo.dir,
            permission: 'worktree',
          },
          by: 'cli',
        },
        intakePortsOf(first, '0b0b0b'),
      );
      if (submitted.outcome !== 'created')
        throw new Error('expected the submission to be accepted');
      runId = submitted.runId;
      await settle(30);
      expect(readWakes(first.db, runId)).toHaveLength(1);
      expect(kindsOf(first, runId)).toEqual(['task.submitted']);
    } finally {
      await first.shutdown();
    }

    const framing = framingRunner(repo.dir);
    const second = await boot({
      dataDir,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      tickIntervalMs: 25,
      runFraming: framing.runner,
    });
    try {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && !kindsOf(second, runId).includes('run.created')) {
        await settle();
      }
      expect(kindsOf(second, runId)).toEqual(['task.submitted', 'run.created']);
      // No second row was created for the same framing step: the key is
      // `(runId, framing)`, and the wait was already there.
      expect(readWakes(second.db, runId)).toEqual([]);
    } finally {
      await second.shutdown();
    }
  });
});
