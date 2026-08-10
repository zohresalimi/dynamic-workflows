/**
 * A daemon that drives a run to its blocking `human` node and then never
 * returns (EPIC-13-S3).
 *
 *     node hang-at-human-gate.ts <dataDir> <readyFile>
 *
 * Writes `readyFile` once the gate is open and the ledger is on disk, then
 * hangs forever. The parent `SIGKILL`s it — no cleanup, no flush, no handlers —
 * and constructs a fresh engine over the same `.DeFlow/` directory.
 *
 * It has to be a real process: there is no way to ask a process to be killed
 * that rudely from inside itself, and `SIGTERM` would test the shutdown handler
 * rather than durability, which is the only thing this is about
 * (docs/14-testing-strategy.md §11).
 */
import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
// From the module rather than from the package index: `@DeFlow/testkit`'s
// barrel re-exports the vitest `it` fixture, and importing that outside a
// vitest worker throws before this script reaches its first line.
import { TestClock } from '../../../../testkit/src/clock.ts';
import { driveToTheGate, seedHumanRun, T0 } from './human-gate-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: hang-at-human-gate.ts <dataDir> <readyFile>');
}

const db = openLedger(dataDir);
seedHumanRun(db);
const { state } = await driveToTheGate(db, new TestClock(T0));

writeFileSync(readyFile, JSON.stringify({ status: state.status }), 'utf8');

// And now: nothing. No close, no checkpoint, no flush. Whatever is on disk at
// this moment is what the parent gets back.
setInterval(() => {}, 1_000);
