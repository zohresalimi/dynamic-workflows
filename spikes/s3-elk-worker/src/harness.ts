/**
 * Running the real `vite build`, and looking at what it wrote.
 *
 * Node built-ins only, so the repository's own test slices can import this
 * without depending on the throwaway workspace's node_modules — and so
 * `check.mjs` can import it too, under Node's own type stripping.
 *
 * Nothing here asks the app under test how it went: the build is a subprocess,
 * the chunk sizes come from `statSync`, and the served `dist/` goes out over a
 * plain `node:http` server with no Vite anywhere in the loop. A spike that
 * proved "the worker chunk is emitted" by asking Vite whether it emitted one
 * would prove nothing.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The committed measurements: the numbers `docs/spikes/S3-elk-worker.md`
 * quotes, and the evidence the spike leaves behind. They are goldens, so a test
 * run writes what it just measured somewhere else and compares — see
 * `measurementsOutDir` below.
 */
export const MEASUREMENTS_DIR = fileURLToPath(new URL('../measurements/', import.meta.url));

/**
 * The opt-in that rewrites the committed measurements, spelled the way the rest
 * of the repository spells "this run rewrites something a human has to look at
 * and commit" (`pnpm test:record`, `DeFlow_MANUAL_VENDOR_CLI`).
 *
 *   pnpm spike:s3:record
 *
 * Without it the browser measurement is fresh on every run — it has to be, it
 * is the measurement — but it lands in a temporary directory instead of
 * restamping a tracked file with a new duration, a new tick count and a new
 * ephemeral port.
 */
export const RECORD_MEASUREMENTS_ENV = 'DeFlow_RECORD_MEASUREMENTS';

let scratchMeasurements: string | undefined;

/** Where this process's measurements are written. */
export function measurementsOutDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env[RECORD_MEASUREMENTS_ENV] === '1') return MEASUREMENTS_DIR;
  scratchMeasurements ??= mkdtempSync(join(tmpdir(), 'deflow-s3-measurements-'));
  return scratchMeasurements;
}

/** Writes one measurement as JSON and returns the path it landed on. */
export function writeMeasurement(
  name: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const directory = measurementsOutDir(env);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** The committed golden for `name`, whatever this run happens to write. */
export function readMeasurement<T>(name: string): T {
  return JSON.parse(readFileSync(join(MEASUREMENTS_DIR, name), 'utf8')) as T;
}

/**
 * `elk` is the app as it is meant to be shipped. `no-elk` is the same app with
 * the engine module aliased to a stub that throws — same routes, same fixtures,
 * same dagre, same everything else — which is what makes AC2's entry-chunk
 * comparison a comparison of one variable.
 *
 * `main-thread` is KAR-00.10's sabotage: the same app again, with the engine
 * aliased to one that imports `elkjs/lib/elk.bundled.js` as a plain module. It
 * is never shipped and never served; it exists so the budget below can be shown
 * going red against the exact regression it claims to catch.
 */
export type Variant = 'elk' | 'no-elk' | 'main-thread';

export interface ChunkInfo {
  readonly file: string;
  readonly bytes: number;
}

export interface BuildResult {
  readonly variant: Variant;
  readonly outDir: string;
  readonly exitCode: number;
  readonly output: string;
  readonly durationMs: number;
  readonly entry: ChunkInfo;
  /** Worker chunks, recognised by name: only elkjs's worker is ever built here. */
  readonly workers: ChunkInfo[];
  readonly assets: string[];
}

export interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

const OUT_DIR: Record<Variant, string> = {
  elk: 'dist',
  'no-elk': 'dist-no-elk',
  'main-thread': 'dist-main-thread',
};

// --- the instrument ----------------------------------------------------------

/**
 * Strings only a real GWT-transpiled ELK bundle contains. Deliberately *not*
 * the bare "org.eclipse.elk" prefix: the app's own constraint probe writes
 * option ids like "org.eclipse.elk.layered.layering.layerChoiceConstraint" into
 * the entry chunk, and a fingerprint a caller can trip is not a fingerprint.
 */
export const ELK_FINGERPRINTS = ['org.eclipse.elk.alg', 'elk.alg.layered', 'ELK Layered'] as const;

/**
 * What KAR-00.4 actually protects, expressed so that a toolchain bump cannot
 * pretend to be a regression and a regression cannot pretend to be a toolchain
 * bump.
 *
 * The story this replaces asserted `workerChunkBytes === 1425139`, recorded on
 * one machine on 2026-08-04. It went red for 51 bytes and a different content
 * hash under an unchanged elkjs, vite and rollup — and re-recording the number
 * would only have bought a green until the next minifier release. Meanwhile it
 * could not have told that apart from ELK sliding into the first paint's
 * critical path, which is the only thing anybody cares about here.
 *
 * So:
 *
 * - `entryBytes` is an **absolute** budget, in NF3 territory ("UI interactive
 *   < 1 s"). 64 KB is roughly five times the 13 KB this app actually emits, so
 *   ordinary drift never reaches it and 1.4 MB cannot avoid it.
 * - `entryCostBytes` is AC2's own cap, unchanged: what ELK adds to the entry
 *   against the identical build without it.
 * - `workerShare` is the relationship that carries the real claim. Of the ELK
 *   weight this app ships, the fraction that sits in the worker chunk rather
 *   than in the entry. Bytes moving *within* the worker chunk cannot move it;
 *   bytes moving *between* chunks are the only thing that can.
 */
export const BUDGET = {
  entryBytes: 64 * 1024,
  entryCostBytes: 100 * 1024,
  workerShare: 0.99,
} as const;

export interface ElkWeight {
  /** The whole entry chunk, which is what the browser parses before first paint. */
  readonly entryBytes: number;
  /** What ELK adds to it, against the identical build with ELK aliased away. */
  readonly entryCostBytes: number;
  /** Every worker chunk emitted, added up. */
  readonly workerBytes: number;
  /** Of ELK's shipped weight, the share that is in a worker chunk. */
  readonly workerShare: number;
  /** Whether a real ELK bundle's fingerprints appear in the entry chunk. */
  readonly elkInEntry: boolean;
}

/** The measurement, taken off the bytes two real builds wrote. */
export function elkWeight(withElk: BuildResult, baseline: BuildResult): ElkWeight {
  const workerBytes = withElk.workers.reduce((total, chunk) => total + chunk.bytes, 0);
  const entryCostBytes = withElk.entry.bytes - baseline.entry.bytes;
  const shipped = workerBytes + Math.max(entryCostBytes, 0);
  const entryText = readAsset(withElk, withElk.entry.file);
  return {
    entryBytes: withElk.entry.bytes,
    entryCostBytes,
    workerBytes,
    // An app that ships no ELK at all has no share to speak of; calling that 0
    // is what makes the `main-thread` sabotage trip this dimension rather than
    // divide by zero and be quietly excused.
    workerShare: shipped === 0 ? 0 : workerBytes / shipped,
    elkInEntry: ELK_FINGERPRINTS.some((fingerprint) => entryText.includes(fingerprint)),
  };
}

/**
 * The budget, as names rather than as a boolean, so a failing run says which
 * dimension moved — and so the sabotage build can assert that *every* dimension
 * is alive rather than that "something failed".
 */
export function budgetViolations(weight: ElkWeight): string[] {
  const violations: string[] = [];
  if (weight.elkInEntry) violations.push('elk-in-entry');
  if (weight.entryBytes >= BUDGET.entryBytes) violations.push('entry-bytes');
  if (Math.abs(weight.entryCostBytes) >= BUDGET.entryCostBytes) violations.push('entry-cost-bytes');
  if (weight.workerShare <= BUDGET.workerShare) violations.push('worker-share');
  return violations;
}

/**
 * The committed `measurements/build-sizes.json`.
 *
 * It is a **record**: what one build on one stated toolchain weighed, kept
 * because "1.4 MB of ELK against 5.5 KB of entry cost" is the finding and
 * because the note quotes it. Nothing asserts equality against `measured` —
 * that is the loop KAR-00.10 broke.
 */
export interface BuildSizesRecord {
  readonly $comment: string;
  readonly recordedOn: {
    readonly date: string;
    readonly os: string;
    readonly node: string;
    readonly vite: string;
    readonly elkjs: string;
  };
  readonly budgets: typeof BUDGET;
  readonly measured: {
    readonly entryChunk: string;
    readonly entryWithElkBytes: number;
    readonly entryWithoutElkBytes: number;
    readonly entryDeltaBytes: number;
    readonly workerChunk: string;
    readonly workerChunkBytes: number;
    readonly assets: string[];
  };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join(posix.sep));
    }
  };
  walk(root);
  return out.sort();
}

interface ManifestEntry {
  readonly file: string;
  readonly isEntry?: boolean;
}

function entryChunk(outDir: string): ChunkInfo {
  const manifest = JSON.parse(readFileSync(join(outDir, '.vite/manifest.json'), 'utf8')) as Record<
    string,
    ManifestEntry
  >;
  const entries = Object.values(manifest).filter((candidate) => candidate.isEntry === true);
  if (entries.length !== 1) {
    throw new Error(`expected exactly one entry chunk, got ${JSON.stringify(entries)}`);
  }
  const file = entries[0]?.file ?? '';
  return { file, bytes: statSync(join(outDir, file)).size };
}

const builds = new Map<Variant, BuildResult>();

/** A real `vite build`, once per variant per process. */
export async function build(variant: Variant): Promise<BuildResult> {
  const cached = builds.get(variant);
  if (cached !== undefined) return cached;

  const outDir = join(SPIKE_ROOT, OUT_DIR[variant]);
  const startedAt = Date.now();
  const vite = join(SPIKE_ROOT, 'node_modules/vite/bin/vite.js');
  const run = spawnSync(
    process.execPath,
    [vite, 'build', '--outDir', OUT_DIR[variant], '--emptyOutDir'],
    {
      cwd: SPIKE_ROOT,
      env: { ...process.env, S3_VARIANT: variant },
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const exitCode = run.status ?? -1;
  const durationMs = Date.now() - startedAt;

  if (exitCode !== 0) {
    const failed: BuildResult = {
      variant,
      outDir,
      exitCode,
      output,
      durationMs,
      entry: { file: '', bytes: 0 },
      workers: [],
      assets: [],
    };
    builds.set(variant, failed);
    return failed;
  }

  const assets = listFiles(outDir);
  const result: BuildResult = {
    variant,
    outDir,
    exitCode,
    output,
    durationMs,
    entry: entryChunk(outDir),
    workers: assets
      .filter((file) => file.endsWith('.js') && /worker/i.test(file))
      .map((file) => ({ file, bytes: statSync(join(outDir, file)).size })),
    assets,
  };
  builds.set(variant, result);
  return result;
}

export function readAsset(result: BuildResult, file: string): string {
  return readFileSync(join(result.outDir, file), 'utf8');
}

/**
 * The `check.mjs` the epic asks this spike to leave behind, run as a subprocess.
 *
 * `DeFlow_RECORD_MEASUREMENTS` is cleared rather than inherited: a spec that
 * asserts what the script does by default must not have that answer changed by
 * whichever environment happened to invoke `vitest`.
 */
export function runCheckScript(env: NodeJS.ProcessEnv = {}): CommandResult {
  const run = spawnSync(process.execPath, ['check.mjs'], {
    cwd: SPIKE_ROOT,
    env: { ...process.env, [RECORD_MEASUREMENTS_ENV]: '', ...env },
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { exitCode: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

export interface StaticServer {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * The plainest possible static server: this is standing in for "the daemon
 * serves the built assets", and the point of AC1 is that nothing clever is
 * needed for the hashed worker URL to resolve.
 */
export async function serveDist(outDir: string): Promise<StaticServer> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const relativePath = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = join(outDir, relativePath);
    if (!file.startsWith(outDir)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the static server port'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
