/**
 * A daemon that is `SIGKILL`ed between `run.cancel.requested` and the ladder
 * (EPIC-19-S43).
 *
 *     node hang-mid-cancel.ts <dataDir> <readyFile>
 *
 * Seeds the running run of `./cancel-run.ts`, spawns a **detached** process
 * tree as that run's agent, journals the `process` row the daemon writes beside
 * `node.started`, appends the operator's `run.cancel.requested` — and then
 * hangs, having done nothing about it. The parent `SIGKILL`s this process group
 * and reopens the same database.
 *
 * The agent tree is spawned detached on purpose: it is the daemon's *child* in
 * production and its own process group there too, so it has to outlive the
 * SIGKILL exactly as a real agent outlives the daemon that spawned it. A tree
 * that died with this process would make the recovery trivially green.
 */

import { processStartTime } from '@DeFlow/adapters';
import { appendEvents, openLedger, recordProcess } from '@DeFlow/ledger';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { AUTH, CANCEL_RUN, seedRunningRun, T0 } from './cancel-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: hang-mid-cancel.ts <dataDir> <readyFile>');
}

const mode = process.argv[4] ?? 'forceful';

const db = openLedger(dataDir);
seedRunningRun(db);

const child = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise<void>((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
child.stdout?.resume();
child.stderr?.resume();
const pgid = child.pid as number;
child.unref();

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

appendEvents(db, [
  {
    runId: CANCEL_RUN,
    ts: T0 + 1_000,
    kind: 'run.cancel.requested',
    v: 1,
    epoch: 1,
    payload: { mode },
  },
]);

writeFileSync(readyFile, JSON.stringify({ pgid }), 'utf8');

// And now: nothing. The operator's request is on disk and not one rung of the
// ladder has been walked.
setInterval(() => {}, 1_000);
