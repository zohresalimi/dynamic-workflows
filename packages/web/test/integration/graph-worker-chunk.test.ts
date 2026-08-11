/**
 * KAR-16.6 AC5 — ELK runs in a Web Worker **in the built output**, not only in
 * the dev server.
 *
 * Verifies: EPIC-16-S37 · AC5
 *
 * A real `vite build` into a temporary directory, asserted against the files it
 * produced. That is the whole point of the spec: the failure mode this rules
 * out is specifically an *asset-path* one. elkjs is GWT-transpiled Java whose
 * own README acknowledges bundler friction, and the option its documentation
 * offers — `workerUrl` — wants a path served publicly under a name known at
 * authoring time, which is exactly what `vite build` destroys when it renames
 * the file to `elk-worker.min-<hash>.js`. A dev-server pass would prove nothing
 * about any of that (docs/spikes/S3-elk-worker.md, EPIC-00 KAR-00.4).
 *
 * Three claims, in the order they can fail:
 *
 * 1. the worker chunk exists, is hashed, and carries the layout algorithm;
 * 2. the ~1.4 MB of engine is **absent** from everything the first paint loads;
 * 3. nothing in the built output asks for elkjs by a public path — no
 *    `workerUrl`, and no `?worker&inline` that would put the megabyte back.
 *
 * The module list of each chunk is read out of its **sourcemap**, which is the
 * only honest way to ask "is this module in this chunk" — a substring search of
 * minified code answers questions about variable names. The byte-level
 * fingerprint check beside it is the one exception, and it is deliberate: it
 * asks whether the *algorithm itself* is in the initial payload, which is a
 * question about bytes rather than about module names (S3 row 6).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';

const webRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Strings that only appear if ELK's layered algorithm itself is present. */
const ELK_FINGERPRINTS = ['elk.alg.layered', 'org.eclipse.elk.alg', 'ELK Layered'] as const;

interface BuiltChunk {
  readonly file: string;
  readonly text: string;
  readonly bytes: number;
  readonly modules: readonly string[];
}

let outDir: string;
let initial: BuiltChunk[];
let all: BuiltChunk[];

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
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}\n${output}`)),
    );
  });
}

async function chunkAt(dir: string, file: string): Promise<BuiltChunk> {
  const text = await readFile(join(dir, file), 'utf8');
  let modules: string[] = [];
  try {
    const map = JSON.parse(await readFile(join(dir, `${file}.map`), 'utf8')) as {
      sources?: string[];
    };
    modules = map.sources ?? [];
  } catch {
    modules = [];
  }
  return { file, text, bytes: Buffer.byteLength(text), modules };
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'DeFlow-graph-worker-'));
  await run(
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
  const entry = /<script[^>]+src="\/?([^"]+\.js)"/.exec(html)?.[1];
  if (entry === undefined) throw new Error(`no entry script in the built index.html:\n${html}`);
  const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+)"/g)].map(
    (match) => match[1] as string,
  );

  initial = await Promise.all([entry, ...preloaded].map((file) => chunkAt(outDir, file)));
  const assets = await readdir(join(outDir, 'assets'));
  all = await Promise.all(
    assets
      .filter((file) => file.endsWith('.js'))
      .map((file) => chunkAt(outDir, join('assets', file))),
  );
}, 240_000);

afterAll(async () => {
  if (outDir !== undefined && process.env['DeFlow_KEEP_TMP'] === undefined) {
    await rm(outDir, { recursive: true, force: true });
  }
});

const holds = (chunks: readonly BuiltChunk[], module: string): boolean =>
  chunks.some((chunk) => chunk.modules.some((source) => source.includes(module)));

suite('EPIC-16-S37 — the built artefact, not just the dev server', () => {
  it('built something with sourcemaps to read', () => {
    expect(all.length).toBeGreaterThan(2);
    expect(initial.reduce((total, chunk) => total + chunk.modules.length, 0)).toBeGreaterThan(20);
  });

  it('emits exactly one ELK worker chunk, hashed, carrying the layered algorithm', () => {
    const workers = all.filter((chunk) => holds([chunk], 'elk-worker'));

    expect(workers.map((chunk) => chunk.file)).toHaveLength(1);
    const worker = workers[0] as BuiltChunk;
    // Hashed: a worker served under a stable name is one a browser caches
    // across a deploy, which for a 1.4 MB engine is the wrong one for a week.
    expect(worker.file).toMatch(/assets\/[^/]*-[A-Za-z0-9_-]{8}\.js$/);
    expect(worker.bytes).toBeGreaterThan(1_000_000);
    expect(worker.text).toContain('elk.alg.layered');
  });

  it('keeps all of that out of what the first paint loads', () => {
    // The module-name half…
    expect(holds(initial, 'elk-worker')).toBe(false);
    expect(holds(initial, 'elkjs')).toBe(false);
    // …and the byte half, which is the one that would catch an inlined worker
    // hiding under a name the sourcemap does not mention.
    for (const fingerprint of ELK_FINGERPRINTS) {
      for (const chunk of initial) {
        expect(chunk.text.includes(fingerprint), `${fingerprint} is in ${chunk.file}`).toBe(false);
      }
    }
  });

  it('does not inline the worker, which would put the megabyte back', () => {
    // The import statements only. The module's prose explains at length why
    // `?worker&inline` is wrong, and a plain substring search over the file
    // would be matching the explanation.
    const imports = readFileSync(
      fileURLToPath(new URL('../../src/components/graph/layout.ts', import.meta.url)),
      'utf8',
    )
      .split('\n')
      .filter((line) => /^import\s/.test(line));

    expect(imports.some((line) => /['"][^'"]+\?worker['"]/.test(line))).toBe(true);
    expect(imports.some((line) => line.includes('?worker&inline'))).toBe(false);
  });

  it('reaches the worker by the hashed URL the bundler chose, not by a public path', () => {
    // `workerUrl` is elkjs's own documented option and it is the trap: it wants
    // a URL known at authoring time, and a hashed build has none. What the
    // built output must contain instead is a `Worker` constructed against the
    // asset name Vite emitted — the positive form of the same claim, and the
    // one that cannot pass vacuously.
    //
    // (The *word* `workerUrl` is in the bundle regardless: it is a parameter
    // name inside elkjs's own `elk-api.js`. Asserting on its absence would be
    // asserting about a dependency's source.)
    const layoutChunk = all.find((chunk) => holds([chunk], 'src/components/graph/layout.ts'));

    expect(layoutChunk, 'no chunk was built from layout.ts').toBeDefined();
    expect(layoutChunk?.text).toMatch(/new Worker\(`\/assets\/[^`]*-[A-Za-z0-9_-]{8}\.js`/);
    expect(layoutChunk?.text).toContain('workerFactory');
  });
});
