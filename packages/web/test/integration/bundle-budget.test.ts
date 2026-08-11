/**
 * KAR-16.1 AC9 — the initial chunk stays under budget.
 *
 * Verifies: EPIC-16-S5 · AC9, AC10
 *
 * NF3 is *"UI interactive < 1s on localhost"*, and it is **contingent on what
 * lands in the initial chunk** (docs/12-frontend-architecture.md §10). Serving
 * is local, so transfer time is near zero and the budget is really about parse
 * and execute time — which is why the number is asserted against the built
 * bytes and not against a lighthouse score.
 *
 * A real `vite build` in a real subprocess, into a temporary directory: the
 * thing under test is the bundler's output, and there is no version of this
 * that a mock can answer. The module list of each chunk is read out of its
 * **sourcemap**, which is the only honest way to ask "is this module in this
 * chunk" — a substring search of the minified code answers questions about
 * variable names.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';

const webRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The budget, in bytes of gzip. docs/12 §10: ~200 KB for the initial shell. */
const INITIAL_CHUNK_BUDGET = 200 * 1024;

/**
 * Modules that must never reach the initial chunk (AC9).
 *
 * Some of them are not dependencies yet — the terminal, diff and dashboard
 * views arrive with EPIC-17 — and the assertion is written to be true now and
 * load-bearing the moment they land, rather than to be added later by somebody
 * who remembers. `@vue-flow/core` is deliberately **not** on this list: the
 * plan graph is the landing view, so its 345 KB raw is in the initial chunk on
 * purpose.
 */
const BANNED_FROM_INITIAL = ['elkjs', 'shiki', '@xterm/', '@git-diff-view/', 'echarts'] as const;

interface BuiltChunk {
  readonly file: string;
  readonly bytes: Buffer;
  /** Every module the chunk was built from, as its sourcemap reports it. */
  readonly modules: readonly string[];
}

let outDir: string;
/**
 * The initial payload: the entry chunk **plus every chunk the built
 * `index.html` preloads**, plus the stylesheet it links.
 *
 * Not the entry file alone. Rolldown splits shared vendor code out of the
 * entry and lists it as `modulepreload`, so the browser fetches, parses and
 * executes all of it before the first paint — a budget measured against the
 * entry file alone would fall every time the bundler moved a megabyte one
 * chunk to the left.
 */
let initial: BuiltChunk[];
let lazy: BuiltChunk[];
let buildOutput: string;

function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}\n${output}`));
    });
  });
}

async function chunkAt(dir: string, file: string): Promise<BuiltChunk> {
  const bytes = await readFile(join(dir, file));
  let modules: string[] = [];
  try {
    const map = JSON.parse(await readFile(join(dir, `${file}.map`), 'utf8')) as {
      sources?: string[];
    };
    modules = map.sources ?? [];
  } catch {
    modules = [];
  }
  return { file, bytes, modules };
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'DeFlow-bundle-'));

  buildOutput = await run(
    process.execPath,
    [
      join(webRoot, 'node_modules/vite/bin/vite.js'),
      'build',
      '--outDir',
      outDir,
      '--emptyOutDir',
      '--sourcemap',
    ],
    webRoot,
  );

  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const entryFile = /<script[^>]+src="\/?([^"]+\.js)"/.exec(html)?.[1];
  if (entryFile === undefined) throw new Error(`no entry script in the built index.html:\n${html}`);

  const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  const stylesheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/?([^"]+)"/g)].map(
    (match) => match[1] as string,
  );

  initial = await Promise.all(
    [entryFile, ...preloaded, ...stylesheets].map((file) => chunkAt(outDir, file)),
  );

  const assets = await readdir(join(outDir, 'assets'));
  const inInitial = new Set(initial.map((chunk) => chunk.file));
  lazy = await Promise.all(
    assets
      .filter((file) => file.endsWith('.js') && !inInitial.has(join('assets', file)))
      .map((file) => chunkAt(outDir, join('assets', file))),
  );
}, 240_000);

afterAll(async () => {
  if (outDir !== undefined && process.env['DeFlow_KEEP_TMP'] === undefined) {
    await rm(outDir, { recursive: true, force: true });
  }
});

const gzippedTotal = (chunks: readonly BuiltChunk[]): number =>
  chunks.reduce((total, chunk) => total + gzipSync(chunk.bytes).byteLength, 0);

const holds = (chunks: readonly BuiltChunk[], module: string): boolean =>
  chunks.some((chunk) => chunk.modules.some((source) => source.includes(module)));

suite('EPIC-16-S5 — what is allowed in the first chunk (AC9)', () => {
  it('built something with sourcemaps to read', () => {
    expect(initial.length).toBeGreaterThan(1);
    expect(gzippedTotal(initial)).toBeGreaterThan(1000);
    // Without this the module assertions below all pass vacuously against an
    // empty list, which is the worst kind of green.
    expect(initial.reduce((n, chunk) => n + chunk.modules.length, 0)).toBeGreaterThan(20);
  });

  it(`keeps the initial payload at or under ${INITIAL_CHUNK_BUDGET / 1024} KB gzip`, () => {
    const size = gzippedTotal(initial);
    const breakdown = initial
      .map((chunk) => `${chunk.file} ${(gzipSync(chunk.bytes).byteLength / 1024).toFixed(1)}`)
      .join(', ');

    // Reported in the message rather than only on failure, because the number
    // moving is the interesting part and a boolean does not say which way.
    expect(
      size,
      `initial payload is ${(size / 1024).toFixed(1)} KB gzip — ${breakdown}`,
    ).toBeLessThanOrEqual(INITIAL_CHUNK_BUDGET);
  });

  it('has @vue-flow/core in it, because the plan graph is the landing view', () => {
    expect(holds(initial, '@vue-flow/core')).toBe(true);
  });

  it.each(BANNED_FROM_INITIAL)('does not have %s in it', (module) => {
    expect(holds(initial, module)).toBe(false);
  });

  it('splits the lazy routes into chunks of their own', () => {
    // The mechanism AC9 depends on, asserted where it can be asserted today:
    // if the route table's dynamic imports were not splitting, the four
    // assertions above would stay green right up until the first heavy view
    // landed and then all fail at once.
    const names = lazy.flatMap((chunk) => chunk.modules);

    expect(names.some((module) => module.includes('PlanEvolutionView'))).toBe(true);
    expect(holds(initial, 'PlanEvolutionView')).toBe(false);
    // `@DeFlow/core`'s reducer and its zod schemas arrive with `scrub.ts`, and
    // they are three times the size of the view that pulls them in. Behind the
    // lazy route they cost nothing at boot; in the initial payload they would
    // be most of the budget on their own.
    expect(holds(initial, 'zod')).toBe(false);
  });
});

suite('EPIC-16-S5 — the build is Rolldown’s, and quiet (AC10)', () => {
  it('emits no circular-import warning', () => {
    // Rolldown reports cycles Rollup was silent about, and they are usually
    // pre-existing and real. Fixed, never silenced (docs/12 §2.2).
    expect(buildOutput.toLowerCase()).not.toContain('circular');
  });

  it('emits no warning at all about the chunking it just did', () => {
    expect(buildOutput.toLowerCase()).not.toContain('some chunks are larger');
  });
});
