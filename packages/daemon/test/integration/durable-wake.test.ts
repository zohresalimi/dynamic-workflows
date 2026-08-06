/**
 * KAR-06.6 — a six-hour human gate across laptop sleep costs one row
 * (EPIC-06-S22, docs/05-durable-execution.md §10.1).
 *
 * The three moving parts meet here for the first time: `decide()` from
 * @DeFlow/core asks for the wait, `node_wake` in @DeFlow/ledger *is* the wait,
 * and this package's ~1 Hz ticker is what looks at it. A real ledger file, a
 * real reopen after a real `kill -9`, and a `TestClock` so six hours pass in
 * microseconds — with no fake timers anywhere near a child process.
 *
 * The payoff the architecture claims is worth stating in the suite, because it
 * is the reason the story exists: a six-hour human gate, laptop sleep across
 * that gate, crash-and-restart mid-wait, and retry backoff are **the same
 * mechanism** — one code path exercised constantly instead of four exercised
 * rarely.
 *
 * Verifies: EPIC-06-S22 (scenarios 1, 2, 3, 4 and 5) · AC2, AC3, AC6, AC7, AC8
 */
import { type Command, decide, initialRunState, type RunState } from '@DeFlow/core';
import {
  appendEventsConsumingWakes,
  type Db,
  dueWakes,
  nextWakeAt,
  openLedger,
  readWakes,
  replayAll,
  scheduleWakeIfChanged,
} from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, TestClock, waitFor } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { startTicker } from '../../src/ticker.ts';
import {
  GATE,
  GATE_AT,
  GATE_RUN,
  hours,
  respondedAt,
  SIDEKICK,
  seedGateRun,
  T0,
} from './support/gate-run.ts';
import { recordingDb } from './support/recording-db.ts';

const HANG_SCRIPT = fileURLToPath(new URL('./support/hang-on-due-wake.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

interface Tick {
  readonly now: number;
  readonly commands: readonly Command['kind'][];
  readonly fired: readonly string[];
}

/**
 * One tick of the real loop: consume what is due, `decide()` over the folded
 * state, perform the `ScheduleWake`s it returns and nothing else.
 *
 * Deliberately the honest minimum. It performs no `StartNode` — spawning is
 * KAR-06.3's — so nothing here can make the gate come back for any reason
 * other than its wake coming due, which is the only thing this file claims.
 */
function makeLoop(db: Db) {
  let state: RunState = replayAll(db).runs.get(GATE_RUN) ?? initialRunState();
  const ticks: Tick[] = [];
  const fired: string[] = [];

  function tick(now: number): void {
    const due = dueWakes(db, now);
    for (const row of due) {
      fired.push(row.nodeId);
      // The delete and the event are one transaction (AC3): a crash cannot
      // both fire the wake and lose it.
      appendEventsConsumingWakes(db, [respondedAt(now)], [row]);
    }
    if (due.length > 0) state = replayAll(db).runs.get(GATE_RUN) ?? state;

    const commands = decide(state, now);
    for (const command of commands) {
      if (command.kind !== 'ScheduleWake') continue;
      scheduleWakeIfChanged(db, {
        runId: command.runId,
        nodeId: command.node,
        wakeAt: command.wakeAt,
        reason: command.reason,
      });
    }

    ticks.push({
      now,
      commands: commands.map((command) => command.kind),
      fired: due.map((row) => row.nodeId),
    });
  }

  return { tick, ticks, fired, state: (): RunState => state };
}

suite('EPIC-06-S22 scenario 1 — four problems, one mechanism (AC7)', () => {
  it('a suspended gate is one row with reason human_gate, and it holds nothing', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedGateRun(db);
      const loop = makeLoop(db);

      loop.tick(T0);

      expect(readWakes(db, GATE_RUN)).toEqual([
        { runId: GATE_RUN, nodeId: GATE, wakeAt: GATE_AT, reason: 'human_gate' },
      ]);

      // No lock and no slot: the tick's only other command is the *unrelated*
      // node starting, which is the slot the gate would still be occupying had
      // suspension been a flag on a running node rather than a row.
      const starts = decide(loop.state(), T0).filter((command) => command.kind === 'StartNode');
      expect(starts.map((command) => command.node)).toEqual([SIDEKICK]);
      expect(loop.state().nodes[GATE]?.status).toBe('suspended');
      expect(loop.state().locks).toEqual({});
    } finally {
      db.close();
    }
  });
});

suite('EPIC-06-S22 scenario 2 — six hours pass in microseconds (AC2, AC6)', () => {
  it('fires the gate once, at hour six, having written nothing in between', async ({ tmp }) => {
    const inner = openLedger(tmp);
    const db = recordingDb(inner);
    try {
      seedGateRun(db);
      const loop = makeLoop(db);
      const clock = new TestClock(T0);

      // The first tick writes the row — that is the one write this spec
      // expects, and it is what everything after it must *not* repeat.
      const ticker = startTicker({
        clock,
        nextWakeAt: () => nextWakeAt(db),
        onTick: loop.tick,
      });
      expect(db.writes.length).toBeGreaterThan(0);
      db.forget();

      const wallBefore = Date.now();
      await clock.advance(hours(6));
      const wallElapsed = Date.now() - wallBefore;

      ticker.stop();

      // Six hours of ticks, one per second, at the ceiling AC2 sets.
      expect(loop.ticks.length).toBe(hours(6) / 1_000 + 1);
      // The gate fired exactly once, at the instant on the row and not before.
      expect(loop.fired).toEqual([GATE]);
      expect(loop.ticks.find((tick) => tick.fired.length > 0)?.now).toBe(GATE_AT);
      // And the wall clock did not move. (Generously bounded — the assertion
      // is "nothing really waited", not a benchmark.)
      expect(wallElapsed).toBeLessThan(20_000);

      // AC6: every write recorded after the first tick belongs to the *firing*
      // — the event that consumed the wake and the delete that went with it.
      // The 21,599 silent ticks in between wrote nothing at all.
      const silent = db.writes.filter((statement) => !/event|node_wake/i.test(statement.sql));
      expect(silent).toEqual([]);
      expect(db.writes.filter((statement) => /INSERT INTO node_wake/i.test(statement.sql))).toEqual(
        [],
      );
      expect(readWakes(db, GATE_RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-06-S22 scenario 4 — the wall clock is not monotonic (AC8)', () => {
  it('fires every wake exactly once across an hour of correction', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedGateRun(db);
      const loop = makeLoop(db);

      // Hour 0: the row is written. Hour 2: still asleep. Then `now` moves
      // BACKWARDS by an hour, as laptop sleep and an NTP step both do, and
      // then forward across the deadline.
      for (const now of [T0, T0 + hours(2), T0 + hours(1), T0 + hours(5), T0 + hours(7)]) {
        loop.tick(now);
      }

      expect(loop.fired).toEqual([GATE]);
      expect(loop.ticks.find((tick) => tick.fired.length > 0)?.now).toBe(T0 + hours(7));
      expect(readWakes(db, GATE_RUN)).toEqual([]);

      // Ticking on past it fires nothing a second time: the row is gone, and
      // nothing in the loop compared two timestamps to each other to decide.
      loop.tick(T0 + hours(9));
      expect(loop.fired).toEqual([GATE]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-06-S22 scenario 3 — the gate survives a restart and a sleep (AC3)', () => {
  it('keeps its original wake_at across a close and reopen, and fires at hour six', async ({
    tmp,
  }) => {
    const first = openLedger(tmp);
    seedGateRun(first);
    makeLoop(first).tick(T0);
    // Hour two: the daemon dies. No shutdown, no release, no flush of a timer
    // that never existed.
    first.close();

    // Hour five: a fresh engine over the same bytes.
    const restarted = openLedger(tmp);
    try {
      expect(readWakes(restarted, GATE_RUN)).toEqual([
        { runId: GATE_RUN, nodeId: GATE, wakeAt: GATE_AT, reason: 'human_gate' },
      ]);

      const loop = makeLoop(restarted);
      loop.tick(T0 + hours(5));
      expect(loop.fired).toEqual([]);

      loop.tick(GATE_AT);
      expect(loop.fired).toEqual([GATE]);
    } finally {
      restarted.close();
    }
  });
});

suite('EPIC-06-S22 scenario 5 — a crash between the SELECT and the append (AC3)', () => {
  it('leaves the row on disk, and the restarted daemon fires it normally', async ({ tmp }) => {
    const readyFile = join(tmp, 'selected.json');
    const child = startCrashable({
      script: HANG_SCRIPT,
      args: [tmp, readyFile, String(T0 + hours(6))],
    });
    alive.push(child);

    // It read the row as due …
    await waitFor(
      () => {
        try {
          return (JSON.parse(readFileSync(readyFile, 'utf8')) as string[]).length > 0;
        } catch {
          return false;
        }
      },
      { describe: 'the child to select a due wake', timeoutMs: 20_000 },
    );
    expect(JSON.parse(readFileSync(readyFile, 'utf8'))).toEqual([GATE]);

    // … and then died with the event it should have appended unwritten.
    await child.sigkill();
    alive.splice(alive.indexOf(child), 1);

    const restarted = openLedger(tmp);
    try {
      // Still there. A wake that fired into a crash is not a wake that fired.
      expect(readWakes(restarted, GATE_RUN)).toEqual([
        { runId: GATE_RUN, nodeId: GATE, wakeAt: T0 + hours(6), reason: 'human_gate' },
      ]);

      const loop = makeLoop(restarted);
      loop.tick(T0 + hours(6));

      expect(loop.fired).toEqual([GATE]);
      expect(readWakes(restarted, GATE_RUN)).toEqual([]);

      // Exactly once, not twice: the delete committed with the event.
      loop.tick(T0 + hours(7));
      expect(loop.fired).toEqual([GATE]);
    } finally {
      restarted.close();
    }
  });
});
