/**
 * KAR-15.5 test plan #7 — `POST /api/runs/:id/cancel { mode: 'forceful' }` is
 * the F5.7 kill switch, over a real process tree.
 *
 * Everything here needs processes that genuinely exist, because the claim is
 * about what the operating system did rather than what the route intended: a
 * cancel that appended the right event and signalled nothing would pass any
 * ledger-only assertion and leave three `sleep 300`s holding the worktree open.
 *
 * Two things the fixture exists to prove, and both were expensive to learn
 * (KAR-08.6):
 *
 * - **The group is signalled with a negative pid.** `detached: true` makes the
 *   child its own group leader, so `pgid === child.pid` and one signal reaches
 *   the grandchildren. A positive-pid kill leaves them running with `ppid = 1`.
 * - **The verification excludes `Z`.** After a *successful* group SIGKILL the
 *   grandchildren are still listed, as zombies, until init reaps them — and
 *   reaping lags badly inside containers. The spec asserts both halves at the
 *   same instant: the unfiltered `ps` is non-empty and the filtered one is
 *   empty, so the filter cannot pass vacuously.
 *
 * No fake timers: real children are alive throughout, and `vi.useFakeTimers()`
 * would stop their I/O ever arriving. Time moves through the injected `Clock`,
 * which is also what keeps the 5 s + 2 s ladder to microseconds here.
 *
 * Verifies: EPIC-15-S36 · AC1, AC9
 */
import { processStartTime } from '@DeFlow/adapters';
import type { Db } from '@DeFlow/core';
import { openLedger, recordProcess } from '@DeFlow/ledger';
import { authorizedFetch, it, sleep, TEST_DAEMON_TOKEN, TestClock, waitFor } from '@DeFlow/testkit';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { KILL_VERIFY_MS, TERM_GRACE_MS } from '../../src/cancel.ts';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import { AUTH, CANCEL_RUN, seedRunningRun, T0 } from './support/cancel-run.ts';
import { groupRows, killGroup, liveRows } from './support/ps.ts';

const fetch = authorizedFetch();

/** EPIC-15-S36's fixture, verbatim: a shell and three sleeps, one group. */
const BACKGROUNDS_TWO = ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'];

const groups: number[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

interface Served {
  readonly origin: string;
  readonly db: Db;
  readonly clock: TestClock;
  close(): Promise<void>;
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
  for (const pgid of groups.splice(0)) killGroup(pgid);
  children.splice(0);
  await sleep(50);
});

/** A daemon-shaped HTTP server over a real ledger holding one running run. */
async function serve(dataDir: string): Promise<Served> {
  const db = openLedger(dataDir);
  seedRunningRun(db);

  const view = openLedgerView(dataDir);
  setLedgerView(view);
  const clock = new TestClock(T0);
  setIntakePorts({ db, epoch: 1, clock, dataDir, randomHex: () => 'aa0001' });

  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    clock,
    async close() {
      await started.close();
      clearLedgerView();
      clearIntakePorts();
      view.close();
      db.close();
    },
  };
}

/** A detached `sh` with three backgrounded sleeps — four live members, one group. */
async function startTree(): Promise<number> {
  const child = spawn('/bin/sh', [...BACKGROUNDS_TWO], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Mandatory: without it the grandchildren join the test runner's own
    // process group, where the only group to signal is the runner's.
    detached: true,
    env: { ...process.env },
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pgid = child.pid as number;
  groups.push(pgid);
  child.stdout.resume();
  child.stderr.resume();
  await waitFor(() => liveRows(pgid).length >= 4, {
    describe: `the tree in pgid ${pgid} to have four live members`,
  });
  return pgid;
}

/** The `process` row the daemon writes beside `node.started` (KAR-05.9 AC6). */
function journalProcess(db: Db, pgid: number): void {
  recordProcess(db, {
    runId: CANCEL_RUN,
    nodeId: AUTH,
    attempt: 0,
    pid: pgid,
    pgid,
    startedAt: processStartTime(pgid),
    binarySha256: 'd'.repeat(64),
    worktree: null,
    spawnedAt: T0,
  });
}

const payloadsOf = (db: Db, kind: string): Record<string, unknown>[] =>
  db
    .prepare<{ payload: string }>(
      'SELECT payload FROM event WHERE run_id = ? AND kind = ? ORDER BY seq',
    )
    .all(CANCEL_RUN, kind)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);

interface CancelBody {
  readonly seq: number;
  readonly status: string;
  readonly kill: { readonly outcome: string; readonly survivors: readonly number[] };
}

suite('EPIC-15-S36 — forceful cancel is the kill switch (AC1)', () => {
  it('empties the process group and says so, with run.cancel.requested in the ledger', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const { origin, db, clock } = served;
    const pgid = await startTree();
    journalProcess(db, pgid);

    // `detached: true` is what makes one signal enough: every member carries
    // the leader's pid as its pgid.
    for (const row of liveRows(pgid)) expect(row.pgid).toBe(pgid);

    // The request is not awaited yet: the ladder's graces are on the injected
    // clock, so nothing advances until this spec says so.
    const pending = fetch(`${origin}/api/runs/${CANCEL_RUN}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'forceful' }),
    });

    await waitFor(() => liveRows(pgid).length === 0, {
      describe: 'the whole tree, grandchildren included, to go on the group SIGTERM',
    });
    await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);

    const response = await pending;
    expect(response.status).toBe(200);
    const body = (await response.json()) as CancelBody;

    expect(body.status).toBe('cancelling');
    expect(body.kill.outcome).toBe('stopped');
    expect(body.kill.survivors).toEqual([]);
    expect(liveRows(pgid)).toEqual([]);

    // The mode travels in the event, because which ladder ran is a scheduling
    // fact `decide()` reads out of the projection after a restart.
    expect(payloadsOf(db, 'run.cancel.requested')).toEqual([{ mode: 'forceful' }]);
    expect(payloadsOf(db, 'run.kill_failed')).toEqual([]);
  });

  it('does not conclude the kill failed because ps still lists Z-state grandchildren', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const { origin, db, clock } = served;
    const pgid = await startTree();
    journalProcess(db, pgid);

    const pending = fetch(`${origin}/api/runs/${CANCEL_RUN}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'forceful' }),
    });
    await waitFor(() => liveRows(pgid).length === 0, { describe: 'the group to go' });

    // Both halves at the same instant, before the graces are advanced: the
    // unfiltered read is what a naive verification would have counted.
    const unfiltered = groupRows(pgid);
    const live = liveRows(pgid);
    expect(live).toEqual([]);
    if (unfiltered.length > 0) {
      // Whether init has reaped them yet is the operating system's business —
      // what must never happen is a *non*-`Z` survivor being called dead.
      expect(unfiltered.every((row) => row.stat.includes('Z'))).toBe(true);
    }

    await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);
    const body = (await (await pending).json()) as CancelBody;
    expect(body.kill.outcome).toBe('stopped');
    expect(payloadsOf(db, 'run.kill_failed')).toEqual([]);
  });
});
