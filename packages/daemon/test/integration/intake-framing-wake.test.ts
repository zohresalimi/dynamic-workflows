/**
 * KAR-19.1 AC1, AC8 — intake hands off to framing, durably.
 *
 * On 2026-08-12 `POST /api/runs` appended `task.submitted`, returned 201 and
 * scheduled nothing. The run had one event in its ledger for the rest of the
 * afternoon. The fix is one row, and *where* it is written is the whole design:
 * [05 §10](../../../../docs/05-durable-execution.md) argues that a durable row
 * is the wait and a promise is not, so the `node_wake` for the framing step goes
 * in the **same transaction** as the event. Split the pair and a crash in the
 * window loses the half nobody notices — the run that simply never comes back,
 * which looks exactly like a run that has not got there yet.
 *
 * Real file-backed SQLite, never `:memory:`: every claim here is about what
 * survives a process, and a database that dies with the process cannot make one.
 *
 * Verifies: EPIC-19-S5, EPIC-19-S6 · KAR-19.1 AC1, AC8 · test plan #1, #8
 */
import type { Db } from '@DeFlow/core';
import { openLedger, readRange, readWakes } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { FRAMING_WAKE_REASON, submitTask } from '../../src/intake/intake.ts';
import { FRAMING_NODE } from '../../src/spec/gate.ts';

const T0 = 1_754_470_000_000;

let hexCalls = 0;
const randomHex = (): string => {
  hexCalls += 1;
  return hexCalls.toString(16).padStart(6, '0');
};

async function ports(tmp: string) {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const db = openLedger(dataDir);
  const clock = new TestClock(T0);
  return { db, clock, dataDir, epoch: 1, randomHex };
}

const body = (tmp: string, text: string) => ({
  input: { kind: 'text' as const, text },
  cwd: tmp,
  permission: 'worktree' as const,
});

/** The `seq` of the run's `task.submitted`. */
function submittedSeq(db: Db, runId: string): number {
  const seq = readRange(db, runId, 0, 10).events[0]?.seq;
  if (seq === undefined) throw new Error(`no task.submitted for ${runId}`);
  return seq;
}

suite('intake schedules the framing step (AC1)', () => {
  it('writes a due node_wake for the framing node beside task.submitted', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask({ body: body(tmp, 'Migrate the UI'), by: 'cli' }, p);
      if (result.outcome !== 'created') throw new Error('expected the submission to be accepted');

      const wakes = readWakes(p.db, result.runId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.nodeId).toBe(FRAMING_NODE);
      expect(wakes[0]?.reason).toBe(FRAMING_WAKE_REASON);
      // Due *now*, not in a second's time: the operator is watching the prompt,
      // and the whole of AC3's two-second budget is the first tick after this.
      expect(wakes[0]?.wakeAt).toBe(T0);
      // And still exactly the one event KAR-10.1 permits: scheduling framing is
      // a row, not an interpretation of the task (06 §1.1).
      expect(readRange(p.db, result.runId, 0, 10).events.map((event) => event.kind)).toEqual([
        'task.submitted',
      ]);
    } finally {
      p.db.close();
    }
  });

  it('leaves neither half behind when the ledger is reopened — the row outlives the process', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    let runId: string;
    try {
      const result = await submitTask({ body: body(tmp, 'Migrate the UI'), by: 'cli' }, p);
      if (result.outcome !== 'created') throw new Error('expected the submission to be accepted');
      runId = result.runId;
    } finally {
      p.db.close();
    }

    // A new connection over the same file is the closest a test gets to the
    // SIGKILL in EPIC-19-S5 without one; the crash itself is asserted by the
    // daemon-level spec that boots twice over one data directory.
    const reopened = openLedger(join(tmp, 'data'));
    try {
      expect(readWakes(reopened, runId).map((wake) => wake.nodeId)).toEqual([FRAMING_NODE]);
      expect(submittedSeq(reopened, runId)).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
  });

  it('writes neither the event nor the row when the submission is rejected', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        { body: { input: { kind: 'text', text: '' }, cwd: tmp, permission: 'worktree' }, by: 'ui' },
        p,
      );

      expect(result.outcome).toBe('rejected');
      expect(readWakes(p.db)).toEqual([]);
    } finally {
      p.db.close();
    }
  });
});

suite('EPIC-19-S6 — two submissions in the same millisecond (AC8)', () => {
  it('mints two runs, two wakes, and coalesces neither into the other', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      // No await between them, and one pinned clock: both carry the same `ts`,
      // which is the condition a wake key that is unique on the *reason* or on
      // the timestamp silently fails under.
      const [first, second] = await Promise.all([
        submitTask({ body: body(tmp, 'Migrate the design system'), by: 'cli' }, p),
        submitTask({ body: body(tmp, 'Upgrade the router'), by: 'ui' }, p),
      ]);
      if (first.outcome !== 'created' || second.outcome !== 'created') {
        throw new Error('expected both submissions to be accepted');
      }

      expect(first.runId).not.toBe(second.runId);

      const wakes = readWakes(p.db);
      expect(wakes).toHaveLength(2);
      expect(wakes.map((wake) => wake.runId).toSorted()).toEqual(
        [first.runId, second.runId].toSorted(),
      );
      for (const wake of wakes) {
        expect(wake.nodeId).toBe(FRAMING_NODE);
        expect(wake.wakeAt).toBe(T0);
      }

      // Neither run's submitted text leaked into the other's.
      const textOf = (runId: string): string => {
        const event = readRange(p.db, runId, 0, 10).events[0];
        return JSON.stringify(event?.payload ?? {});
      };
      expect(textOf(first.runId)).toContain('Migrate the design system');
      expect(textOf(first.runId)).not.toContain('Upgrade the router');
      expect(textOf(second.runId)).toContain('Upgrade the router');
      expect(textOf(second.runId)).not.toContain('Migrate the design system');
    } finally {
      p.db.close();
    }
  });
});
