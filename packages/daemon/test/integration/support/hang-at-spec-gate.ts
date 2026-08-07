/**
 * A daemon that opens the F1.3 approval gate and then never returns
 * (EPIC-10-S16's second scenario).
 *
 *     node hang-at-spec-gate.ts <dataDir> <readyFile>
 *
 * Writes `readyFile` once the gate is open and the ledger is on disk, then
 * hangs forever. The parent `SIGKILL`s it — no cleanup, no flush, no handlers —
 * and reopens the same database file.
 *
 * It has to be a real process: there is no way to ask a process to be killed
 * that rudely from inside itself, and `SIGTERM` would test the shutdown handler
 * rather than durability, which is the only thing this is about
 * (docs/14-testing-strategy.md §8).
 */

import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import { seedSpecGateRun } from './spec-gate-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: hang-at-spec-gate.ts <dataDir> <readyFile>');
}

const db = openLedger(dataDir);
const spec = await seedSpecGateRun(db);

writeFileSync(readyFile, JSON.stringify({ specHash: spec.specHash }), 'utf8');

// And now: nothing. No close, no checkpoint, no flush. Whatever is on disk at
// this moment is what the parent gets back.
setInterval(() => {}, 1_000);
