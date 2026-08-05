/**
 * KAR-05.9 AC6/AC7 — the `process` table: what makes orphan reaping possible.
 *
 * `detached: true` means the agent survives DeFlowd's death. The row written
 * here is the only handle a *later* daemon has on a process an earlier one
 * spawned, which puts two properties under test that nothing else can hold:
 *
 * 1. **The row is written in the same transaction as `node.started`.** A row
 *    written after the spawn can be lost to a crash in between — and the window
 *    in between is exactly when the daemon is at its most likely to die, since
 *    it has just started a child. `appendEventsWithProcess` exists so the pair
 *    is atomic, and the rollback spec below is what proves it.
 * 2. **The row survives close and reopen.** File-backed, never `:memory:`: the
 *    claim is that a *dead* daemon left it behind (docs/14-testing-strategy.md
 *    §7).
 *
 * `started_at` is stored verbatim as the OS printed it and is never parsed. It
 * is only ever compared for equality against the same source on the same
 * machine, and normalising it would invent precision `ps -o lstart=` does not
 * have — a comparison that is nearly right is what kills an unrelated user
 * process.
 *
 * Verifies: EPIC-05-S30 (scenario 4), EPIC-05-S32 · AC6, AC7
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEventsWithProcess,
  clearProcess,
  type EventDraft,
  markProcess,
  openLedger,
  type ProcessRowDraft,
  readLiveProcesses,
  readRange,
  recordProcess,
} from '../../src/index.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';
const SHA = 'a'.repeat(64);

const row = (over: Partial<ProcessRowDraft> = {}): ProcessRowDraft => ({
  runId: RUN,
  nodeId: 'n1',
  attempt: 0,
  pid: 4242,
  pgid: 4242,
  startedAt: 'Wed Aug  5 10:15:00 2026',
  binarySha256: SHA,
  worktree: '/tmp/wt/n1',
  spawnedAt: 1_754_313_093_000,
  ...over,
});

const started = (): EventDraft => ({
  runId: RUN,
  ts: 1_754_313_093_000,
  kind: 'node.started',
  v: 1,
  epoch: 1,
  nodeId: 'n1',
  attempt: 0,
  payload: { node: 'n1', attempt: 0, ikey: 'run_20260805T090000Z_5c1d2e:n1:0:0' },
});

suite('a process row accompanies node.started (EPIC-05-S30 scenario 4, AC6)', () => {
  it('writes the row and the event in one transaction and returns the assigned seq', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const [seq] = appendEventsWithProcess(db, [started()], row());
      expect(seq).toBeGreaterThan(0);

      const live = readLiveProcesses(db);
      expect(live).toEqual([{ ...row(), state: 'live' }]);
      expect(readRange(db, RUN, 0, 10).events.map((event) => event.kind)).toEqual(['node.started']);
    } finally {
      db.close();
    }
  });

  it('writes neither when the batch is refused, so no row describes a spawn that was never recorded', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      // A malformed envelope: the append boundary refuses it, and the process
      // row must go with it rather than outliving the event it belongs to.
      expect(() =>
        appendEventsWithProcess(db, [{ ...started(), kind: '' } as EventDraft], row()),
      ).toThrow();

      expect(readLiveProcesses(db)).toEqual([]);
      expect(readRange(db, RUN, 0, 10).events).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('outlives the daemon that wrote it', async ({ tmp }) => {
    const first = openLedger(tmp);
    appendEventsWithProcess(first, [started()], row());
    first.close();

    const second = openLedger(tmp);
    try {
      expect(readLiveProcesses(second)).toEqual([{ ...row(), state: 'live' }]);
    } finally {
      second.close();
    }
  });
});

suite('the row is cleared on clean exit (AC6)', () => {
  it('stops being live once the node exits', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordProcess(db, row());
      expect(readLiveProcesses(db)).toHaveLength(1);

      clearProcess(db, { runId: RUN, nodeId: 'n1', attempt: 0 });
      expect(readLiveProcesses(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('is a no-op for a node that never had a row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => clearProcess(db, { runId: RUN, nodeId: 'nope', attempt: 0 })).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('keeps one row per attempt, so a retry does not overwrite its predecessor', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      recordProcess(db, row({ attempt: 0, pid: 100, pgid: 100 }));
      recordProcess(db, row({ attempt: 1, pid: 200, pgid: 200 }));
      expect(readLiveProcesses(db).map((live) => live.pid)).toEqual([100, 200]);

      clearProcess(db, { runId: RUN, nodeId: 'n1', attempt: 0 });
      expect(readLiveProcesses(db).map((live) => live.pid)).toEqual([200]);
    } finally {
      db.close();
    }
  });
});

suite('the reaper marks what it decided (AC7)', () => {
  it('records reaped and discarded rows terminally, and never returns them again', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      recordProcess(db, row({ nodeId: 'n1', pid: 100, pgid: 100 }));
      recordProcess(db, row({ nodeId: 'n2', pid: 200, pgid: 200 }));

      markProcess(db, { runId: RUN, nodeId: 'n1', attempt: 0 }, 'reaped');
      markProcess(db, { runId: RUN, nodeId: 'n2', attempt: 0 }, 'discarded');

      expect(readLiveProcesses(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses a state outside the closed set rather than writing a row nobody can interpret', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      recordProcess(db, row());
      expect(() =>
        markProcess(db, { runId: RUN, nodeId: 'n1', attempt: 0 }, 'nonsense' as never),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
