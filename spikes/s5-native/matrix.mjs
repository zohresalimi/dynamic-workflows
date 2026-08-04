/**
 * KAR-00.5 / EPIC-00-S19 — the five-cell install matrix, in one command.
 *
 * Two cells are the author's own laptop under two Node majors; three are
 * containers, because Linux glibc and Linux musl are not opinions the laptop
 * can hold. Every cell runs the same probe.mjs, and the file it writes —
 * measurements/pty-matrix.json — is the record the decision note quotes and the
 * unit spec checks for completeness.
 *
 * A cell that fails is written down as a failure with a fallback beside it.
 * That is the whole point of AC6: the outcome this spike must never produce is
 * "probably fine".
 *
 * Usage:
 *   node matrix.mjs           run every cell and write the JSON
 *   node matrix.mjs --pull    fetch the three container images first
 *   node matrix.mjs --only linux-musl-node24
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CELLS } from './src/analysis.ts';
import { runProbe } from './src/harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'measurements/pty-matrix.json');

const argv = process.argv.slice(2);
const only = valueOf('--only');
const cells = only === undefined ? ALL_CELLS : ALL_CELLS.filter((c) => c.id === only);

if (argv.includes('--pull')) pullImages();

const outcomes = [];
for (const cell of cells) {
  process.stderr.write(`\n=== ${cell.id} (${cell.platform}, Node ${cell.nodeMajor}) ===\n`);
  outcomes.push(await runCell(cell));
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify({ recordedAt: new Date().toISOString(), cells: outcomes }, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);

async function runCell(cell) {
  let report;
  try {
    report = await runProbe(cell.id);
  } catch (error) {
    return {
      id: cell.id,
      status: 'fail',
      fallback:
        'the cell could not be executed on this machine; it is a documented prerequisite, ' +
        'not a passed cell',
      detail: String(error).slice(0, 800),
    };
  }

  const sqlite = report.installs.find((i) => i.spec.startsWith('better-sqlite3'));
  const pty = report.installs.find((i) => i.spec.startsWith('@lydell/node-pty'));
  const ledgerWorks = report.sqlite?.loaded === true;
  const allocated = report.pty?.allocated === true && report.pty?.echoed === true;

  return {
    id: cell.id,
    status: allocated && ledgerWorks ? 'pass' : 'fail',
    fallback: fallbackFor({ ledgerWorks, allocated }),
    nodeVersion: report.environment.nodeVersion,
    arch: report.environment.arch,
    libc: report.environment.libc,
    glibcVersion: report.environment.glibcVersion ?? null,
    compilersOnPath: Object.entries(report.environment.compilersOnPath)
      .filter(([, found]) => found !== null)
      .map(([name]) => name),
    betterSqlite3: {
      installed: sqlite?.ok ?? false,
      loaded: ledgerWorks,
      durationMs: Math.round(sqlite?.durationMs ?? 0),
      compilationMarkers: sqlite?.compilationMarkers ?? [],
      sqliteVersion: report.sqlite?.version ?? null,
      binding: report.sqlite?.binding?.replace(/^.*node_modules\//, '') ?? null,
      failure: report.sqlite?.failure ?? null,
    },
    lydellPty: {
      installed: pty?.ok ?? false,
      durationMs: Math.round(pty?.durationMs ?? 0),
      compilationMarkers: pty?.compilationMarkers ?? [],
      platformPackage: report.pty?.platformPackage ?? null,
      device: report.pty?.device ?? null,
      echoed: report.pty?.echoed ?? false,
      failure: report.pty?.failure ?? null,
      dlopenFailure: report.pty?.dlopenFailure ?? null,
    },
    upstreamPty: {
      ok: report.upstreamPty?.ok ?? null,
      prebuildForThisPlatform: report.upstreamPty?.prebuildForThisPlatform ?? null,
      nodeGypRan: report.upstreamPty?.nodeGypRan ?? null,
    },
  };
}

/**
 * AC6 — what a failing cell becomes. The two halves fail differently and their
 * fallbacks are different: a ledger that will not load is a **prerequisite**
 * (there is no DeFlow without a ledger), while a pty that will not allocate is
 * a **capability** DeFlow can decline to advertise, because no agent process
 * needs a TTY — ACP and every headless mode are pure pipe protocols.
 */
function fallbackFor({ ledgerWorks, allocated }) {
  const reasons = [];
  if (!ledgerWorks) {
    reasons.push(
      'documented prerequisite: better-sqlite3@13.0.2 installs here but its prebuild will not ' +
        'load, so this platform is not a supported target for the ledger as pinned',
    );
  }
  if (!allocated) {
    reasons.push(
      'no-TTY: @lydell/node-pty stays an optionalDependency and DeFlow does not advertise the ' +
        'ACP terminal/* client capability on this platform',
    );
  }
  return reasons.length === 0 ? null : reasons.join('; ');
}

/**
 * A one-off, kept out of the test path deliberately. It also routes around a
 * docker credential helper that blocks when there is no terminal to prompt at,
 * by pointing DOCKER_CONFIG at an empty directory — these are public images and
 * need no credentials at all.
 */
function pullImages() {
  const config = mkdtempSync(join(tmpdir(), 's5-dockercfg-'));
  for (const cell of ALL_CELLS.filter((c) => c.runner === 'docker')) {
    process.stderr.write(`pulling ${cell.image}\n`);
    const result = spawnSync('docker', ['pull', cell.image], {
      stdio: 'inherit',
      env: { ...process.env, DOCKER_CONFIG: config },
    });
    if (result.status !== 0) throw new Error(`could not pull ${cell.image}`);
  }
}

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}
