/**
 * One daemon life that drives a run into a blocking `human` node, publishing
 * where it is so the harness can put the knife inside the admission window
 * (KAR-13.1 AC1).
 *
 *     node fuzz-human-gate.ts <dataDir> <phaseFile>
 *
 * The phase goes to a **file** rather than to stdout for the reason
 * ./daemon-life.ts gives: the reader is a parent polling a process it is about
 * to `SIGKILL`, and a line still sitting in a pipe buffer when the signal lands
 * is a line that never existed.
 *
 * Then it hangs. No close, no checkpoint, no flush — whatever is on disk at the
 * instant the signal arrives is what the harness gets back.
 */
import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
// From the module rather than from the package index: `@DeFlow/testkit`'s
// barrel re-exports the vitest `it` fixture, and importing that outside a
// vitest worker throws before this script reaches its first line.
import { TestClock } from '../../../../testkit/src/clock.ts';
import { driveToTheGate, seedHumanRun, T0 } from '../../integration/support/human-gate-run.ts';

const [dataDir, phaseFile] = process.argv.slice(2);
if (dataDir === undefined || phaseFile === undefined) {
  throw new Error('usage: fuzz-human-gate.ts <dataDir> <phaseFile>');
}

const publish = (marker: string): void => {
  writeFileSync(phaseFile, marker, 'utf8');
};

const db = openLedger(dataDir);
publish('seeding');
seedHumanRun(db);
publish('admitting');

await driveToTheGate(db, new TestClock(T0), undefined, publish);

publish('suspended');
setInterval(() => {}, 1_000);
