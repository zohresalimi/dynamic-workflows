/**
 * KAR-00.5 / EPIC-00-S18 — what does an append cost on APFS?
 *
 * Every fsync-sensitive number in docs/05-durable-execution.md — 979 ev/s at
 * `synchronous = FULL` against 22,982 ev/s at `NORMAL` — was measured in a
 * Linux container, likely over overlayfs. This re-measures the same shape on
 * the filesystem the daemon will actually run on, against a real file, in WAL,
 * with real commits.
 *
 * It measures **eight** configurations rather than the four the story asks for,
 * because four would have been misleading. macOS's `fsync(2)` does not flush
 * the drive's write cache; only `fcntl(F_FULLFSYNC)` does, and SQLite issues
 * that only under `PRAGMA fullfsync = 1`, which is **off** by default on
 * darwin. So `synchronous = FULL` at the darwin default is cheap precisely
 * because it is weaker than the Linux `FULL` the baseline was measured under,
 * and comparing the two without saying so would flatter the platform. Both
 * halves are measured and both are recorded.
 *
 * Usage:  node bench.mjs [--events 10000] [--batch 100] [--out <csv>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, 'measurements/append-throughput.csv');
const BETTER_SQLITE3_SPEC = 'better-sqlite3@13.0.2';

const CSV_HEADER =
  'machine,filesystem,synchronous,fullfsync,mode,batch_size,events,elapsed_ms,events_per_second';

/** A payload the size of a plausible control-plane event, so the fsync dominates rather than the row. */
const PAYLOAD = JSON.stringify({ kind: 'step.finished', stepId: 'x'.repeat(140) });

/**
 * The marker `--shape` writes its rounds behind, so a caller can find the JSON
 * in stdout the same way `probe.mjs`'s report is found.
 */
const SHAPE_MARKER = '---S5-SHAPE-JSON---';

const argv = process.argv.slice(2);
const events = Number(valueOf('--events') ?? 10_000);
const batchSize = Number(valueOf('--batch') ?? 100);
const out = valueOf('--out') ?? DEFAULT_OUT;
const rounds = Number(valueOf('--rounds') ?? 0);
const fullfsyncOnly = valueOf('--fullfsync');

const Database = await load();
const machine = describeMachine();
const filesystem = filesystemOf(tmpdir());

if (rounds > 0) {
  /**
   * `--rounds N` measures the four configurations **interleaved**: all four,
   * then all four again, N times over, rather than each one to completion in
   * turn.
   *
   * That is not a refinement, it is what makes the comparisons mean anything.
   * Every claim this benchmark supports is a *ratio* between two of these
   * configurations, and the recorded run measures them one after another, each
   * once — so the two halves of a ratio are taken minutes apart at whatever the
   * machine happened to be doing at each moment. On an idle laptop that is
   * invisible. Beside a saturated test suite it is not: at the default 10,000
   * events the batched configurations finish in nine to thirteen milliseconds,
   * and nine milliseconds on a box running a hundred forked workers measures
   * the scheduler. `batchingGainNormal` has been observed at 0.82 that way —
   * batching reported as a *loss* — with nothing wrong with the machine except
   * that it was busy.
   *
   * Interleaved, the two halves of each ratio are adjacent, so the load either
   * one meets is the load the other meets and it cancels. Repeated, a round
   * that met a spike anyway is outvoted: the caller takes the median of the
   * per-round ratios, never a ratio of aggregates.
   *
   * `--fullfsync 0` restricts the sweep to one setting, because the two are not
   * comparable in cost: at `fullfsync = 1` a single-commit run issues one
   * `F_FULLFSYNC` per event and takes about three seconds per thousand, so the
   * event count that gives the ff0 quartet honest windows would make an ff1
   * round take minutes.
   */
  const settings = fullfsyncOnly === undefined ? [0, 1] : [Number(fullfsyncOnly)];
  const measured = [];
  for (let round = 0; round < rounds; round += 1) {
    const inThisRound = [];
    for (const fullfsync of settings) {
      for (const synchronous of ['FULL', 'NORMAL']) {
        for (const mode of ['single', 'batched']) {
          inThisRound.push(measure({ synchronous, fullfsync, mode }));
        }
      }
    }
    measured.push(inThisRound);
  }
  process.stdout.write(`${SHAPE_MARKER}${JSON.stringify(measured)}\n`);
} else {
  const rows = [];
  for (const fullfsync of [0, 1]) {
    for (const synchronous of ['FULL', 'NORMAL']) {
      for (const mode of ['single', 'batched']) {
        rows.push(measure({ synchronous, fullfsync, mode }));
      }
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${CSV_HEADER}\n${rows.map(toCsvLine).join('\n')}\n`);
  process.stdout.write(`${CSV_HEADER}\n${rows.map(toCsvLine).join('\n')}\n`);
}

function measure({ synchronous, fullfsync, mode }) {
  const dir = mkdtempSync(join(tmpdir(), 's5-bench-'));
  const db = new Database(join(dir, 'events.db'));
  db.pragma('journal_mode = WAL');
  db.pragma(`fullfsync = ${fullfsync}`);
  db.pragma(`synchronous = ${synchronous}`);
  db.exec('create table event(seq integer primary key, payload text not null)');

  const insert = db.prepare('insert into event(payload) values (?)');
  const commitBatch = db.transaction((payloads) => {
    for (const payload of payloads) insert.run(payload);
  });
  const batch = Array.from({ length: batchSize }, () => PAYLOAD);

  // A short warm-up so page allocation and WAL creation are not inside the
  // measured window; it is discarded, not reported.
  for (let i = 0; i < 50; i += 1) insert.run(PAYLOAD);

  const started = process.hrtime.bigint();
  if (mode === 'single') {
    for (let i = 0; i < events; i += 1) insert.run(PAYLOAD);
  } else {
    for (let i = 0; i < events; i += batchSize) commitBatch(batch);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const [{ fullfsync: observedFullfsync }] = db.pragma('fullfsync');
  if (observedFullfsync !== fullfsync) {
    throw new Error(`asked for fullfsync=${fullfsync}, got ${observedFullfsync}`);
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    machine,
    filesystem,
    synchronous,
    fullfsync,
    mode,
    batchSize: mode === 'single' ? 1 : batchSize,
    events,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    eventsPerSecond: Number((events / (elapsedMs / 1000)).toFixed(1)),
  };
}

function toCsvLine(row) {
  return [
    row.machine,
    row.filesystem,
    row.synchronous,
    row.fullfsync,
    row.mode,
    row.batchSize,
    row.events,
    row.elapsedMs,
    row.eventsPerSecond,
  ].join(',');
}

/**
 * The benchmark needs the driver it is benchmarking. It installs into its own
 * directory rather than borrowing the repository's node_modules, so the number
 * is attributable to 13.0.2 and to nothing the workspace happens to hoist.
 */
async function load() {
  const dir = join(HERE, 'node_modules');
  if (!existsSync(join(dir, 'better-sqlite3'))) {
    const result = spawnSync('npm', ['install', BETTER_SQLITE3_SPEC, '--no-audit', '--no-fund'], {
      cwd: HERE,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`could not install ${BETTER_SQLITE3_SPEC}`);
  }
  return createRequire(join(HERE, 'bench.cjs'))('better-sqlite3');
}

function describeMachine() {
  const model = run('sysctl', ['-n', 'hw.model']) ?? run('uname', ['-m']) ?? 'unknown';
  return `${process.platform}-${process.arch}-${model}`.replaceAll(',', '-');
}

/**
 * The filesystem the temp directory actually lives on. The whole point of this
 * benchmark is that "APFS" is a claim about the disk, not about the operating
 * system, so it is read off `mount` rather than assumed from `process.platform`.
 */
function filesystemOf(path) {
  const output = run('df', ['-P', path]);
  const device = output?.split('\n')[1]?.split(/\s+/)[0];
  if (device === undefined) return 'unknown';
  const mounts = run('mount') ?? '';
  const line = mounts.split('\n').find((entry) => entry.startsWith(`${device} `));
  const type = /\(([a-z0-9]+)[,)]/.exec(line ?? '');
  return type?.[1] ?? 'unknown';
}

function run(command, args = []) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '').trim() : null;
}

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}
