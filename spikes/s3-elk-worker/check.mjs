/**
 * The artefact EPIC-00 asks this spike to leave behind: a script that builds
 * both variants and asserts on the built `dist/`, so the answer can be
 * re-derived in one command a year from now without reading any test file.
 *
 * It also writes `measurements/build-sizes.json`, which is where the byte
 * counts quoted in `docs/spikes/S3-elk-worker.md` come from.
 *
 *   node check.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, MEASUREMENTS_DIR, readAsset } from './src/harness.ts';

/**
 * Strings only a real GWT-transpiled ELK bundle contains. Deliberately *not*
 * the bare "org.eclipse.elk" prefix: the app itself writes option ids like
 * "org.eclipse.elk.layered.layering.layerChoiceConstraint" into the entry
 * chunk, and a fingerprint that a caller can trip is not a fingerprint.
 */
const ELK_FINGERPRINTS = ['org.eclipse.elk.alg', 'elk.alg.layered', 'ELK Layered'];

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
check(
  'the worker chunk carries ELK',
  ELK_FINGERPRINTS.every((mark) => readAsset(withElk, worker?.file ?? '').includes(mark)),
  kb(worker?.bytes ?? 0),
);

const entryText = readAsset(withElk, withElk.entry.file);
check(
  'the entry chunk carries no ELK',
  ELK_FINGERPRINTS.every((mark) => !entryText.includes(mark)),
  withElk.entry.file,
);
check(
  'the entry chunk references the hashed worker',
  entryText.includes((worker?.file ?? '').replace('assets/', '')),
);

const delta = withElk.entry.bytes - withoutElk.entry.bytes;
check(
  'ELK costs the entry chunk under 100 KB',
  Math.abs(delta) < 100 * 1024,
  `${kb(withElk.entry.bytes)} with ELK, ${kb(withoutElk.entry.bytes)} without, delta ${delta} B`,
);
check('no worker chunk in the ELK-free build', withoutElk.workers.length === 0);

mkdirSync(MEASUREMENTS_DIR, { recursive: true });
writeFileSync(
  join(MEASUREMENTS_DIR, 'build-sizes.json'),
  `${JSON.stringify(
    {
      elkjs: '0.12.0',
      vite: '8.2.0',
      entryChunk: withElk.entry.file,
      entryWithElkBytes: withElk.entry.bytes,
      entryWithoutElkBytes: withoutElk.entry.bytes,
      entryDeltaBytes: delta,
      workerChunk: worker?.file ?? null,
      workerChunkBytes: worker?.bytes ?? null,
      assets: withElk.assets,
    },
    null,
    2,
  )}\n`,
);

console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
