/**
 * A real daemon-shaped process that takes the repository write lock and then
 * dies without giving it back (EPIC-06-S6).
 *
 * A separate process rather than a `close()` in the spec, because the claim
 * under test is about `SIGKILL`: no handler, no flush, no release, no
 * `finally`. A simulated crash that runs any cleanup at all is testing the
 * cleanup, and the whole point of putting the lock in the ledger is that the
 * cleanup never runs.
 *
 *   argv[2]  the data directory
 *   argv[3]  a marker file, written once every event is committed
 *   argv[4]  'held' | 'failed' — whether the holder also recorded its death
 */
import { writeFileSync } from 'node:fs';
import { appendEvents, openLedger } from '../../../src/index.ts';
import { heldLockRun, holderFailed } from './repo-lock-run.ts';

const [, , dataDir, readyFile, mode] = process.argv;
if (dataDir === undefined || readyFile === undefined || mode === undefined) {
  throw new Error('usage: hold-repo-lock.ts <dataDir> <readyFile> <held|failed>');
}

const db = openLedger(dataDir);
appendEvents(db, mode === 'failed' ? [...heldLockRun(), holderFailed()] : heldLockRun());

// Only after the append has committed: the parent waits on this file, so a
// marker written early would let it SIGKILL a ledger that has nothing in it.
writeFileSync(readyFile, 'ready');

// Spin until the signal lands. No `close()`, ever.
for (;;) {
  // Busy-waiting would burn a core for the whole test; a real timer is fine
  // here because this process is not the one under test — it is the corpse.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}
