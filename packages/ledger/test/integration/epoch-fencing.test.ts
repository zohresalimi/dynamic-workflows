/**
 * KAR-03.7 — the belt to `flock`'s braces: a daemon that bypassed the lease is
 * fenced by `daemon_epoch` anyway (docs/05-durable-execution.md §12).
 *
 * Two real processes over one ledger file, neither of them holding the lease.
 * `flock` semantics on network mounts are the documented case where the lock
 * is not enough, so this spec deliberately does not take one — assuming the
 * lock is unbreachable is precisely the assumption the epoch exists to
 * survive.
 *
 * Verifies: EPIC-03-S22 (scenario 3), EPIC-03-S23 (scenario 3) · AC6, AC7
 */
import { foldEvents, RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import {
  appendEvents,
  bumpEpoch,
  drainEvents,
  openLedger,
  RunCheckpointer,
  readRange,
} from '../../src/index.ts';
import { draft, RUN_A } from './support/events.ts';

const STALE_DAEMON = fileURLToPath(new URL('./support/stale-daemon.ts', import.meta.url));

let olderDaemon: ChildProcess | undefined;

afterEach(() => {
  olderDaemon?.kill('SIGKILL');
  olderDaemon = undefined;
});

interface AppendReport {
  readonly ok: boolean;
  readonly attempts: number;
  readonly stale?: boolean;
  readonly epoch?: number | null;
  readonly currentEpoch?: number | null;
}

/** Boots daemon A in a real process and waits for the epoch it took. */
async function bootOlderDaemon(
  dataDir: string,
): Promise<{ epoch: number; ask: (n: number) => Promise<AppendReport> }> {
  const child = fork(STALE_DAEMON, [dataDir], { execArgv: [], stdio: 'pipe' });
  olderDaemon = child;

  const epoch = await new Promise<number>((resolve, reject) => {
    child.once('message', (message) => resolve((message as { epoch: number }).epoch));
    child.once('exit', (code) => reject(new Error(`daemon A exited early with code ${code}`)));
  });

  const ask = (ordinal: number): Promise<AppendReport> =>
    new Promise<AppendReport>((resolve, reject) => {
      const onExit = (code: number | null) =>
        reject(new Error(`daemon A exited with code ${code} mid-append`));
      child.once('message', (message) => {
        child.off('exit', onExit);
        resolve(message as AppendReport);
      });
      child.once('exit', onExit);
      child.send({ append: ordinal });
    });

  return { epoch, ask };
}

suite('the older daemon is fenced out of a ledger it can still open (AC6)', () => {
  it("rejects all of its appends and keeps only the newer daemon's rows", async ({ tmp }) => {
    // Daemon A boots first and takes epoch 1.
    const older = await bootOlderDaemon(tmp);
    expect(older.epoch).toBe(1);

    // Daemon B boots afterwards over the same file and advances the persisted
    // epoch to 2. Nothing stopped A: no lease was ever taken.
    const db = openLedger(tmp);
    try {
      const newer = bumpEpoch(db);
      expect(newer).toBe(older.epoch + 1);

      const reports: AppendReport[] = [];
      for (let ordinal = 0; ordinal < 50; ordinal += 1) {
        // Interleaved: B writes, then A tries, 50 times each.
        appendEvents(db, [{ ...draft({ epoch: newer }), payload: { from: 'B', ordinal } }]);
        reports.push(await older.ask(ordinal));
      }

      // Every one of A's 50 attempts was refused, and it made exactly one
      // attempt per request — a writer that retried would report more.
      expect(reports.filter((report) => report.ok)).toHaveLength(0);
      expect(reports.every((report) => report.stale === true)).toBe(true);
      expect(reports.at(-1)?.attempts).toBe(50);
      expect(reports[0]?.epoch).toBe(older.epoch);
      expect(reports[0]?.currentEpoch).toBe(newer);

      // The ledger is exactly what B alone would have written.
      const stored = [...drainEvents(db, RUN_A)];
      expect(stored).toHaveLength(50);
      expect(stored.every((event) => event.epoch === newer)).toBe(true);
      expect(stored.map((event) => (event.payload as { from: string }).from)).toEqual(
        Array.from({ length: 50 }, () => 'B'),
      );
    } finally {
      db.close();
    }
  });
});

suite('the run projection records who advanced it (EPIC-03-S23 scenario 3, AC7)', () => {
  it('carries the epoch of the daemon that last advanced the run', async ({ tmp }) => {
    const RUN = RunIdSchema.parse('run_20260805T101500Z_ab12cd');
    const PLAN_HASH = `sha256-${'a'.repeat(64)}`;

    // Daemon life 1 — the run is started and parked under epoch 1.
    const first = openLedger(tmp);
    try {
      bumpEpoch(first);
      const checkpointer = new RunCheckpointer(first, RUN);
      checkpointer.append([
        draft({ runId: RUN, epoch: 1, kind: 'run.started', payload: { planHash: PLAN_HASH } }),
      ]);
      checkpointer.append([
        draft({
          runId: RUN,
          epoch: 1,
          kind: 'run.paused',
          payload: { by: 'user', reason: 'stepping away' },
        }),
      ]);
      checkpointer.quiesce();
      expect(runEpoch(first, RUN)).toBe(1);
    } finally {
      first.close();
    }

    // Daemon life 2 — a later daemon resumes the same run and advances it.
    const second = openLedger(tmp);
    try {
      const epoch = bumpEpoch(second);
      expect(epoch).toBe(2);
      const checkpointer = RunCheckpointer.resume(second, RUN);
      checkpointer.append([
        draft({ runId: RUN, epoch, kind: 'run.resumed', payload: { by: 'user' } }),
      ]);
      checkpointer.quiesce();

      // The field the UI renders "resumed by a later daemon" from, alone.
      expect(runEpoch(second, RUN)).toBe(2);
      // And it is the fold of the ledger, not a number the checkpointer made
      // up: replaying from zero produces the same epoch.
      const replayed = foldEvents(readRange(second, RUN, 0, 100).events);
      expect(replayed.state.epoch).toBe(2);
    } finally {
      second.close();
    }
  });
});

function runEpoch(db: ReturnType<typeof openLedger>, runId: string): number | undefined {
  return db
    .prepare<{ daemon_epoch: number }>('SELECT daemon_epoch FROM run WHERE run_id = ?')
    .get(runId)?.daemon_epoch;
}
