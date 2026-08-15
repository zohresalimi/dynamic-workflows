/**
 * The artefact EPIC-00 asks this spike to leave behind: a script that builds
 * every variant and asserts on the built `dist/`, so the answer can be
 * re-derived in one command a year from now without reading any test file.
 *
 *   node check.mjs
 *
 * What it asserts is the same `budgetViolations` the integration slice asserts
 * — one instrument, in `src/harness.ts`, used by both — rather than a second
 * hand-rolled copy of the same arithmetic that can drift from it.
 *
 * KAR-00.10: this script used to *rewrite* `measurements/build-sizes.json` on
 * every run, including every run made by `pnpm test`. That is why the recorded
 * numbers could never disagree with the measured ones (the comparison ran after
 * the overwrite), why the note's numbers could and did, and why a plain test
 * run left the working tree dirty. The write is now opt-in, spelled the way the
 * rest of the repository spells it:
 *
 *   pnpm spike:s3:record
 *
 * Without it, the fresh measurement lands in a temporary directory and the
 * committed record is left exactly as it was found.
 */
import {
  BUDGET,
  budgetViolations,
  build,
  elkWeight,
  measurementsOutDir,
  RECORD_MEASUREMENTS_ENV,
  readAsset,
  writeMeasurement,
} from './src/harness.ts';

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`);
    return;
  }
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  failures.push(label);
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const percent = (share) => `${(share * 100).toFixed(3)}%`;

console.log('building spikes/s3-elk-worker with ELK …');
const withElk = await build('elk');
check('vite build succeeds', withElk.exitCode === 0, `${withElk.durationMs} ms`);
if (withElk.exitCode !== 0) {
  console.log(withElk.output);
  process.exit(1);
}

console.log('building the same app without ELK …');
const withoutElk = await build('no-elk');
check('vite build succeeds without ELK', withoutElk.exitCode === 0, `${withoutElk.durationMs} ms`);
if (withoutElk.exitCode !== 0) {
  console.log(withoutElk.output);
  process.exit(1);
}

const worker = withElk.workers[0];
check('exactly one worker chunk is emitted', withElk.workers.length === 1, worker?.file);
check(
  'the worker chunk name is hashed',
  worker !== undefined && /^assets\/.*worker.*-[A-Za-z0-9_-]{8}\.js$/.test(worker.file),
  worker?.file,
);

const entryText = readAsset(withElk, withElk.entry.file);
check(
  'the entry chunk references the hashed worker',
  entryText.includes((worker?.file ?? '').replace('assets/', '')),
);
check('no worker chunk in the ELK-free build', withoutElk.workers.length === 0);

const weight = elkWeight(withElk, withoutElk);
check('the entry chunk carries no ELK', !weight.elkInEntry, withElk.entry.file);
check(
  `the entry chunk is under ${kb(BUDGET.entryBytes)}`,
  weight.entryBytes < BUDGET.entryBytes,
  kb(weight.entryBytes),
);
check(
  `ELK costs the entry chunk under ${kb(BUDGET.entryCostBytes)}`,
  Math.abs(weight.entryCostBytes) < BUDGET.entryCostBytes,
  `${kb(withElk.entry.bytes)} with ELK, ${kb(withoutElk.entry.bytes)} without, delta ${weight.entryCostBytes} B`,
);
check(
  `the worker chunk carries over ${percent(BUDGET.workerShare)} of ELK's shipped weight`,
  weight.workerShare > BUDGET.workerShare,
  `${percent(weight.workerShare)} — ${kb(weight.workerBytes)} in the worker against ${weight.entryCostBytes} B in the entry`,
);
check('no budget dimension is in violation', budgetViolations(weight).length === 0, 'all four');

/**
 * KAR-00.10 AC4. The same instrument, pointed at the regression it claims to
 * catch: ELK imported as a plain module instead of as a `?worker` entry. If
 * this build does *not* violate the budget, the budget above is decoration and
 * this script says so in the same breath as it says everything passed.
 */
console.log('building the sabotage variant, with ELK back in the entry chunk …');
const mainThread = await build('main-thread');
check('vite build succeeds with ELK on the main thread', mainThread.exitCode === 0);
const sabotaged =
  mainThread.exitCode === 0 ? budgetViolations(elkWeight(mainThread, withoutElk)) : [];
check(
  'the budget goes red when ELK is bundled back into the entry',
  ['elk-in-entry', 'entry-bytes', 'entry-cost-bytes', 'worker-share'].every((dimension) =>
    sabotaged.includes(dimension),
  ),
  sabotaged.join(', '),
);

const measured = {
  $comment:
    'A record of one build on one toolchain, written by check.mjs. Not asserted for equality — see docs/spikes/S3-elk-worker.md and KAR-00.10.',
  recordedOn: {
    date: new Date().toISOString().slice(0, 10),
    os: `${process.platform}/${process.arch}`,
    node: process.version,
    vite: '8.2.0',
    elkjs: '0.12.0',
  },
  budgets: BUDGET,
  measured: {
    entryChunk: withElk.entry.file,
    entryWithElkBytes: withElk.entry.bytes,
    entryWithoutElkBytes: withoutElk.entry.bytes,
    entryDeltaBytes: weight.entryCostBytes,
    workerChunk: worker?.file ?? null,
    workerChunkBytes: worker?.bytes ?? null,
    assets: withElk.assets,
  },
};
const written = writeMeasurement('build-sizes.json', measured);
console.log(
  process.env[RECORD_MEASUREMENTS_ENV] === '1'
    ? `\nrecorded ${written}`
    : `\nmeasured into ${measurementsOutDir()} — set ${RECORD_MEASUREMENTS_ENV}=1 (pnpm spike:s3:record) to rewrite the committed record`,
);

console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
