/**
 * KAR-00.5 — the bridge between the vitest specs and the two things that
 * actually do the work: probe.mjs (one environment, probed) and bench.mjs
 * (eight fsync configurations, measured).
 *
 * Everything here spawns. Nothing here is mocked, and nothing here interprets
 * — it starts a real process, waits for it, and hands back what the process
 * said. A local cell runs probe.mjs under a concrete `node` binary resolved
 * from the machine's nvm installs; a docker cell runs the same file, unchanged,
 * inside a container whose image supplies both the libc and the Node major.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNodeBinary } from '../../../test/support/node-majors.ts';
import { type BenchRow, cellById, parseBenchCsv } from './analysis.ts';

export const SPIKE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MEASUREMENTS_DIR = join(SPIKE_ROOT, 'measurements');

export const BETTER_SQLITE3_SPEC = 'better-sqlite3@13.0.2';
export const LYDELL_PTY_SPEC = '@lydell/node-pty@1.2.0-beta.14';
export const UPSTREAM_PTY_SPEC = 'node-pty@1.1.0';

const REPORT_MARKER = '---S5-PROBE-JSON---';

export interface InstallReport {
  readonly spec: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly log: string;
  readonly compilationMarkers: readonly string[];
  readonly installScripts: readonly string[];
  readonly installScript: string | null;
  readonly gypfile: boolean | null;
  readonly prebuilds: readonly string[];
}

export interface SqliteReport {
  /** False when the prebuild installed but would not dlopen here. */
  readonly loaded: boolean;
  readonly failure: string | null;
  readonly version: string;
  readonly binding: string | null;
  readonly loadExtension: boolean;
  readonly journalMode: string;
  readonly fullfsync: number;
  readonly defaultSynchronous: number;
  readonly fts5: {
    readonly created: boolean;
    readonly tokenizer: string;
    readonly wholeTermMatches: Record<string, number>;
    readonly fragmentMatches: Record<string, number>;
    readonly bm25Order: readonly number[];
    readonly bm25Ranked: boolean;
  };
}

export interface PtyReport {
  readonly allocated: boolean;
  readonly device: string | null;
  readonly echoed: boolean;
  readonly platformPackage: string | null;
  readonly failure: string | null;
  /** What the dynamic linker said, when the package's own loader was vague. */
  readonly dlopenFailure?: string | null;
}

export interface ProbeReport {
  readonly cell: string;
  readonly environment: {
    readonly platform: string;
    readonly arch: string;
    readonly libc: string;
    readonly glibcVersion: string | null;
    readonly nodeVersion: string;
    readonly path: string;
    readonly compilersOnPath: Record<string, string | null>;
  };
  readonly installs: readonly InstallReport[];
  readonly sqlite?: SqliteReport;
  readonly pty?: PtyReport;
  readonly upstreamPty?: UpstreamPtyReport;
}

export interface UpstreamPtyReport {
  readonly spec: string;
  readonly ok: boolean;
  readonly log: string;
  readonly installScript: string | null;
  readonly installScripts: readonly string[];
  /** The platform directories 1.1.0 actually ships in its npm tarball. */
  readonly prebuilds: readonly string[];
  readonly prebuildForThisPlatform: boolean;
  /** True only when the `||` fallback handed over to node-gyp for real. */
  readonly nodeGypRan: boolean;
}

/** Whether a docker daemon is actually reachable — installed is not running. */
export function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return result.status === 0;
}

export async function runProbe(cellId: string): Promise<ProbeReport> {
  const cell = cellById(cellId);
  const { command, args } =
    cell.runner === 'local'
      ? {
          command: resolveNodeBinary(cell.nodeMajor),
          args: [join(SPIKE_ROOT, 'probe.mjs'), '--cell', cell.id],
        }
      : {
          command: 'docker',
          args: [
            'run',
            '--rm',
            // Never during a test run. A pull here would make the spec's
            // duration a property of the network, and on a machine whose docker
            // credential helper blocks in a non-interactive shell it hangs
            // outright. `node matrix.mjs --pull` fetches the three images once.
            '--pull',
            'never',
            '-v',
            `${SPIKE_ROOT}:/spike:ro`,
            '-w',
            '/root',
            cell.image ?? '',
            'node',
            '/spike/probe.mjs',
            '--cell',
            cell.id,
          ],
        };

  const { stdout, stderr, code } = await run(command, args);
  const marker = stdout.indexOf(REPORT_MARKER);
  if (marker === -1) {
    const hint =
      cell.runner === 'docker' && stderr.includes('No such image')
        ? `\n\nThe image is not present locally. Run "node ${join(SPIKE_ROOT, 'matrix.mjs')} --pull" once.`
        : '';
    throw new Error(
      `probe for ${cell.id} produced no report (exit ${code}).${hint}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  return JSON.parse(stdout.slice(marker + REPORT_MARKER.length)) as ProbeReport;
}

/**
 * Runs the benchmark for real and returns what it wrote. `events` is a
 * parameter because the eight configurations include one that issues an
 * `F_FULLFSYNC` per commit, and a caller may legitimately want to know how long
 * that takes before committing to 10,000 of them.
 */
export async function runBench(events: number, outPath?: string): Promise<BenchRow[]> {
  // Default to a temp file, not the committed measurement: a spec that rewrote
  // a tracked file on every run would leave the tree dirty after `pnpm test`.
  // The committed CSV is produced by `node bench.mjs`, deliberately, by hand.
  const out =
    outPath ?? join(mkdtempSync(join(tmpdir(), 's5-bench-out-')), 'append-throughput.csv');
  const { stdout, stderr, code } = await run(process.execPath, [
    join(SPIKE_ROOT, 'bench.mjs'),
    '--events',
    String(events),
    '--out',
    out,
  ]);
  if (code !== 0) throw new Error(`bench.mjs exited ${code}\n${stdout}\n${stderr}`);
  return parseBenchCsv(readFileSync(out, 'utf8'));
}

/** The committed run, as it stands in the repository. */
export function committedBench(): BenchRow[] {
  return parseBenchCsv(readFileSync(join(MEASUREMENTS_DIR, 'append-throughput.csv'), 'utf8'));
}

interface Completed {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

function run(command: string, args: readonly string[]): Promise<Completed> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, npm_config_update_notifier: 'false' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}
