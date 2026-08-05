/**
 * A process that spawns another process and then does nothing useful — the
 * shape `startCrashable` has to be able to kill in one signal.
 *
 * The grandchild rewrites its marker file every 20 ms for as long as it lives,
 * so "was it killed with its parent?" is answered by whether the file stays
 * where the test put it rather than by a pid lookup that races with reaping.
 *
 *   argv[2]  the parent's marker file
 *   argv[3]  the grandchild's marker file
 *   argv[4]  --exit to finish immediately, --boom to fail on stderr
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const [, , parentMarker, childMarker, mode] = process.argv;
if (parentMarker === undefined || childMarker === undefined) {
  throw new Error('usage: spawns-a-child.ts <parentMarker> <childMarker> [--exit|--boom]');
}

if (mode === '--boom') {
  process.stderr.write('the scripted run refused to start\n');
  process.exit(1);
}

if (mode === '--exit') {
  writeFileSync(parentMarker, 'up');
  process.exit(0);
}

const grandchild = `
  const { writeFileSync } = require('node:fs');
  setInterval(() => writeFileSync(process.argv[1], 'up'), 20);
`;
spawn(process.execPath, ['-e', grandchild, childMarker], { stdio: 'ignore' });

writeFileSync(parentMarker, 'up');

// Never reached in a passing test — the parent kills the group. The interval
// is a backstop so an abandoned child cannot outlive the suite.
setTimeout(() => process.exit(0), 60_000);
