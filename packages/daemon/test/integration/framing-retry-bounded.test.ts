/**
 * KAR-19.9 — a pre-execution turn that keeps failing is journalled, bounded by
 * EPIC-06's own retry policy, and ends the run when the attempts are spent.
 *
 * This is the regression suite for the second defect of the 2026-08-13 by-hand
 * run, and every assertion below is a sentence from that afternoon inverted.
 * `runOneFraming` caught the thrown `NodeFailureError`, wrote it to the daemon's
 * own log, and `settleFramingWake` pushed the wake forward by a flat 30 s — for
 * ever. The ledger of `run_20260813T110608Z_379fc8` therefore held
 * `provider.probed`, `provider.probed`, `task.submitted` and **nothing else**
 * after eight minutes of identical failing turns, so neither the UI nor
 * `DeFlow status` nor a `sqlite3` session six weeks later could have shown what
 * was wrong.
 *
 * The three properties under test are the three coats of that one defect:
 *
 * - **journalled** — one `node.failed` per attempt, carrying the typed failure
 *   from KAR-02.10's closed taxonomy, appended *before* the wake is settled;
 * - **bounded** — the ceiling, the jittered backoff and the classification are
 *   the node's own `RetryPolicy` through `planRetry`/`recordNodeFailure`, and
 *   the driver keeps no count of its own;
 * - **terminal** — exhaustion reaches `run.aborted { outcome: 'failed' }`,
 *   leaves no due wake behind, and dispatches nothing afterwards.
 *
 * The counterweight is here too, and it was written first: a turn that fails
 * twice and succeeds on the third attempt must still reach `run.created`.
 * **Giving up early is the same class of defect as never giving up**, and for
 * anyone on a rate-limited plan it is the worse one.
 *
 * A `TestClock` drives the backoff windows, and no fake timers are used
 * anywhere: nothing here spawns a child, and the rule stays the rule.
 *
 * Verifies: EPIC-19-S58, EPIC-19-S59, EPIC-19-S60, EPIC-19-S61, EPIC-19-S63 ·
 * KAR-19.9 AC1, AC2, AC3, AC7, AC8 · test plan #1, #2, #7, #8
 */
import type { Event, NodeFailure, Random, RunId, TaskSpec } from '@DeFlow/core';
import {
  DEFAULT_RETRY_POLICY,
  NodeFailureError,
  parseEvent,
  runStatusLabel,
  sealTaskSpec,
} from '@DeFlow/core';
import {
  appendEvents,
  openLedger,
  readRange,
  readWakes,
  replayRun,
  scheduleWake,
} from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { createRunDriver, type FramingRunner } from '../../src/drive.ts';
import { FRAMING_WAKE_REASON } from '../../src/intake/intake.ts';
import { FRAMING_NODE } from '../../src/spec/gate.ts';
import { framed } from './support/spec-gate-run.ts';

const T0 = 1_755_080_000_000;
const RUN = 'run_20260813T110608Z_379fc8' as RunId;

/** The vendor failure the reported run actually produced, typed. */
const vendorFailure = (): NodeFailureError =>
  new NodeFailureError('claude exited 1: Invalid session ID', {
    reason: 'agent.nonzero-exit',
    class: 'transient',
    detail: { exitCode: 1, stderr: 'Invalid session ID: run_20260813T110608Z_379fc8-framing' },
  });

/** A draw of exactly a half, so the jittered delay is deterministic and the
 * assertions are about the *window* rather than about a lucky number. */
const halfDraw: Random = { next: () => 0.5 };

/**
 * A run at exactly the state the reported one was in: submitted, with a framing
 * wake due, and no `run.created`.
 */
async function seedSubmittedRun(dataDir: string) {
  const db = openLedger(dataDir);
  appendEvents(db, [
    {
      runId: RUN,
      ts: T0,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        sha256: 'b'.repeat(64),
        raw: 'Add a health endpoint',
        provenance: { kind: 'text', by: 'cli', submittedAt: T0, cwd: '/repo' },
      },
    },
  ]);
  scheduleWake(db, {
    runId: RUN,
    nodeId: FRAMING_NODE,
    wakeAt: T0,
    reason: FRAMING_WAKE_REASON,
  });
  return db;
}

type Ledger = ReturnType<typeof openLedger>;

const eventsOf = (db: Ledger): readonly Event[] =>
  readRange(db, RUN, 0, 500).events.flatMap((stored) => {
    const parsed = parseEvent(stored);
    return parsed.status === 'ok' ? [parsed.event] : [];
  });

const kindsOf = (db: Ledger): readonly string[] => eventsOf(db).map((event) => event.kind);

/** Every journalled failure of the framing node, oldest first. */
function failuresOf(db: Ledger): readonly { seq: number; failure: NodeFailure }[] {
  return eventsOf(db).flatMap((event) =>
    event.kind === 'node.failed' ? [{ seq: event.seq, failure: event.payload.failure }] : [],
  );
}

/** A runner that always throws, and remembers when it was called. */
function alwaysThrows(clock: TestClock) {
  const at: number[] = [];
  const runner: FramingRunner = () => {
    at.push(clock.now());
    throw vendorFailure();
  };
  return { runner, at };
}

/** The driver under test, with the jitter draw pinned. */
function driverOn(db: Ledger, clock: TestClock, runFraming: FramingRunner, dataDir: string) {
  return createRunDriver({
    db,
    clock,
    epoch: 1,
    spillTo: dataDir,
    random: halfDraw,
    runFraming,
  });
}

/**
 * Drives the run to a standstill: ticks, then jumps the clock to whatever the
 * `node_wake` row says is next, up to `limit` times.
 *
 * The clock follows the row rather than a constant, which is EPIC-19-S61's
 * *"observed from real spawns rather than read off a constant"* at the level
 * this spec runs at: a spec that advanced by a hard-coded 30 s would pass
 * against the very bug it exists to catch.
 */
async function driveToStandstill(
  driver: ReturnType<typeof createRunDriver>,
  db: Ledger,
  clock: TestClock,
  limit = 12,
): Promise<void> {
  for (let round = 0; round < limit; round += 1) {
    await driver.tick(clock.now());
    const wake = readWakes(db, RUN).find((row) => row.nodeId === FRAMING_NODE);
    if (wake === undefined) return;
    if (wake.wakeAt <= clock.now()) continue;
    clock.jumpTo(wake.wakeAt);
  }
}

suite('EPIC-19-S59 — every failed attempt is in the ledger (AC1)', () => {
  it('journals one node.failed per attempt, in seq order, with the typed failure', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    const { runner, at } = alwaysThrows(clock);
    const driver = driverOn(db, clock, runner, dataDir);

    try {
      await driveToStandstill(driver, db, clock);

      const failures = failuresOf(db);
      expect(failures).toHaveLength(at.length);
      expect(failures.map((one) => one.failure.attempt)).toEqual([0, 1, 2]);
      for (const { failure } of failures) {
        expect(failure.reason).toBe('agent.nonzero-exit');
        expect(failure.class).toBe('transient');
        // The provider-level detail, including the child's own stderr — the
        // thing the daemon log had and the ledger did not.
        expect(failure.detail).toMatchObject({ exitCode: 1 });
        expect(String(failure.detail?.stderr)).toContain('Invalid session ID');
      }
      // Seq order, and strictly increasing: three attempts, three records.
      expect(failures.map((one) => one.seq)).toEqual(
        [...failures.map((one) => one.seq)].toSorted(),
      );
    } finally {
      db.close();
    }
  });

  it('appends the failure before the retry is scheduled, so a crash loses the retry not the record', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    const { runner } = alwaysThrows(clock);
    const driver = driverOn(db, clock, runner, dataDir);

    try {
      await driver.tick(clock.now());

      const kinds = kindsOf(db);
      const failed = kinds.indexOf('node.failed');
      const scheduled = kinds.indexOf('node.retry.scheduled');
      expect(failed).toBeGreaterThanOrEqual(0);
      expect(scheduled).toBeGreaterThan(failed);
    } finally {
      db.close();
    }
  });

  it("is no longer reachable in the reported run's shape", async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    const { runner } = alwaysThrows(clock);
    const driver = driverOn(db, clock, runner, dataDir);

    try {
      await driveToStandstill(driver, db, clock);
      // The reported ledger held task.submitted and nothing after it.
      expect(kindsOf(db).slice(1)).not.toEqual([]);
      expect(kindsOf(db)).toContain('node.failed');
    } finally {
      db.close();
    }
  });
});

suite('EPIC-19-S58, S60 — the ceiling is the policy, and exhaustion is terminal (AC2, AC3)', () => {
  it('makes exactly maxAttempts attempts and then aborts the run', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    const { runner, at } = alwaysThrows(clock);
    const driver = driverOn(db, clock, runner, dataDir);

    try {
      await driveToStandstill(driver, db, clock);

      expect(at).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts);
      const kinds = kindsOf(db);
      expect(kinds.filter((kind) => kind === 'node.failed')).toHaveLength(
        DEFAULT_RETRY_POLICY.maxAttempts,
      );
      expect(kinds.at(-1)).toBe('run.aborted');

      const state = replayRun(db, RUN).state;
      expect(state.status).toBe('aborted');
      // AC6 — the one sentence every surface prints, and no fourth spelling.
      expect(runStatusLabel(state)).toBe('aborted');
    } finally {
      db.close();
    }
  });

  it('leaves no wake due and spawns nothing further, over ten more windows', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    const { runner, at } = alwaysThrows(clock);
    const driver = driverOn(db, clock, runner, dataDir);

    try {
      await driveToStandstill(driver, db, clock);
      const spent = at.length;
      expect(readWakes(db, RUN)).toEqual([]);

      for (let window = 0; window < 10; window += 1) {
        clock.jumpTo(clock.now() + DEFAULT_RETRY_POLICY.backoff.cap);
        const report = await driver.tick(clock.now());
        expect(report.dispatched).toEqual([]);
      }
      expect(at).toHaveLength(spent);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-19-S61 — backoff is bounded above, and one turn at a time (AC8)', () => {
  it('separates observed attempts by the policy window, never above its cap', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    const { runner, at } = alwaysThrows(clock);
    const driver = driverOn(db, clock, runner, dataDir);

    try {
      await driveToStandstill(driver, db, clock);

      const gaps = at.slice(1).map((instant, index) => instant - (at[index] as number));
      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) {
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.backoff.cap);
      }
      // The observed gaps are the policy's, not a flat re-dispatch interval:
      // full jitter over a doubling window makes attempt 2's wait longer than
      // attempt 1's for any fixed draw, and 30 s forever cannot produce that.
      expect(gaps[1]).toBeGreaterThan(gaps[0] as number);
    } finally {
      db.close();
    }
  });

  it('never has two framing turns in flight for one run', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    let inside = 0;
    let concurrent = 0;
    let release: (() => void) | null = null;

    const slow: FramingRunner = async () => {
      inside += 1;
      concurrent = Math.max(concurrent, inside);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      inside -= 1;
      throw vendorFailure();
    };
    const driver = driverOn(db, clock, slow, dataDir);

    try {
      const first = driver.tick(clock.now());
      // A second tick while the first turn is still inside the runner.
      await driver.tick(clock.now());
      expect(driver.inFlight).toBe(1);
      release?.();
      await first;
      expect(concurrent).toBe(1);
    } finally {
      release?.();
      db.close();
    }
  });
});

suite('EPIC-19-S63 — two failures then a success is still a working run (AC7)', () => {
  it('reaches run.created on the third attempt with both failures journalled', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = await seedSubmittedRun(dataDir);
    const clock = new TestClock(T0);
    let attempts = 0;

    const flaky: FramingRunner = async ({ runId, now, db: writer, epoch }) => {
      attempts += 1;
      if (attempts <= 2) throw vendorFailure();
      const spec: TaskSpec = await sealTaskSpec(framed());
      appendEvents(writer, [
        {
          runId,
          ts: now,
          kind: 'run.created',
          v: 1,
          epoch,
          payload: { spec, cwd: '/repo', repo: { head: 'e83c516', branch: 'main' } },
        },
      ]);
    };
    const driver = driverOn(db, clock, flaky, dataDir);

    try {
      await driveToStandstill(driver, db, clock);

      const kinds = kindsOf(db);
      expect(attempts).toBe(3);
      expect(kinds).toContain('run.created');
      expect(kinds.filter((kind) => kind === 'node.failed')).toHaveLength(2);
      expect(kinds).not.toContain('run.aborted');
    } finally {
      db.close();
    }
  });
});
