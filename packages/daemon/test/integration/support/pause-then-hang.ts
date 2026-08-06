/**
 * A daemon that pauses a run and then dies without shutting down
 * (EPIC-06-S23 scenario 2).
 *
 *     node pause-then-hang.ts <dataDir> <readyFile>
 *
 * Seeds the run, ticks the loop once so the pause is observed by a real
 * scheduler, appends `run.paused`, writes `readyFile`, and then hangs forever.
 * The parent SIGKILLs it — SIGTERM would test the shutdown handler, and there
 * is no shutdown handler in the claim under test — and reopens the same file.
 *
 * The pause has to be written by a process that then *dies*, because the thing
 * being proved is that nothing in memory carried it: a `paused` boolean on an
 * object in this process would produce exactly the same ledger and exactly the
 * same assertions up to the kill, and then differ afterwards.
 */
import { appendEvents, openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import { makeLoop, pause, seedRunningRun, T0 } from './cancel-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: pause-then-hang.ts <dataDir> <readyFile>');
}

const db = openLedger(dataDir);
seedRunningRun(db);

const loop = makeLoop(db);
loop.tick(T0);

// The status *before* the pause, so the parent can tell a run that was really
// admitting work from one that never started.
const before = loop.state().status;

appendEvents(db, [pause()]);

writeFileSync(
  readyFile,
  JSON.stringify({ before, after: loop.state().status, started: loop.started() }),
  'utf8',
);

// And now: nothing. No flush, no close, no release of the repo lock the
// in-flight node is holding.
setInterval(() => {}, 1_000);
