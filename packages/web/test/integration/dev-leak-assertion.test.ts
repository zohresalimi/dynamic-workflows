/**
 * KAR-16.4 AC9 — the leak assertion fires in dev and is **absent** from the
 * production bundle.
 *
 * Verifies: EPIC-16-S30 (scenario 2) · AC9
 *
 * Two halves, and only one of them can be checked from inside a page.
 * `../../src/app/leak-assert.test.ts` proves the counter fires and what it
 * prints; this file proves the string is not in what ships. A real `vite build`
 * in a real subprocess, into a temporary directory — the thing under test is
 * the bundler's output, and no mock can answer it.
 *
 * The grep is over **every** emitted asset, not the entry chunk: the failure
 * being guarded is a dev assertion that survived into a lazily-loaded route
 * chunk, which is invisible to a check that only reads the entry. A sourcemap
 * is not enough either — the tag is a string literal, and a minifier keeps
 * string literals.
 *
 * The positive half is asserted against the source rather than the build,
 * because "the wiring is behind `import.meta.env.DEV`" is a claim about how it
 * is written: a static import with a guarded call site would depend on
 * tree-shaking noticing that the only use had gone, and a build where it *did*
 * survive would fail this file with no explanation of why.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';

const webRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The tag `../../src/app/leak-assert.ts` exports. Spelled out on purpose. */
const TAG = '[proj]';

let outDir: string;
/** Every emitted file, as text. Sourcemaps included; they are shipped too. */
let assets: { file: string; text: string }[];

/**
 * A real `vite build`, **with `NODE_ENV` set to production explicitly**.
 *
 * Not a detail. Vitest exports `NODE_ENV=test` to everything it spawns, and
 * Vite derives `isProduction` — and therefore the value it substitutes for
 * `import.meta.env.DEV` — from `process.env.NODE_ENV` before it looks at the
 * build mode. A child that inherited the runner's environment would build a
 * bundle with `DEV === true` in it: the dev branch survives, the chunk is
 * emitted, and this file fails while reporting what looks like a source bug.
 * The artifact under test is the one an operator receives, so it is built the
 * way an operator's is.
 */
function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
    });
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

async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(join(dir, entry.name), `${path}/`)));
    else found.push(path);
  }
  return found;
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'DeFlow-leak-assert-'));
  await run('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], webRoot);

  const files = await filesUnder(outDir);
  assets = await Promise.all(
    files.map(async (file) => ({ file, text: await readFile(join(outDir, file), 'utf8') })),
  );
}, 180_000);

afterAll(async () => {
  if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
});

suite('AC9 — the dev counter is wired, behind import.meta.env.DEV', () => {
  it('loads the module from a dynamic import inside the DEV branch', async () => {
    const source = await readFile(join(webRoot, 'src/app/create-app.ts'), 'utf8');

    expect(source).toContain('import.meta.env.DEV');
    expect(source).toMatch(/import\(\s*'\.\/leak-assert\.ts'\s*\)/);
    // Static, and the branch is dead code in production, so the module never
    // enters the graph. A top-level `import … from './leak-assert.ts'` here
    // would put it in the graph and leave the tag's absence up to the
    // bundler noticing the only use had gone.
    expect(source).not.toMatch(/^import .*leak-assert/m);
  });

  it('starts the counter with the run store’s own counts', async () => {
    const source = await readFile(join(webRoot, 'src/app/create-app.ts'), 'utf8');

    expect(source).toContain('startLeakAssertion');
    expect(source).toContain('counts');
  });
});

suite('AC9 — and it is absent from what ships', () => {
  it('built something, so the grep is not over an empty directory', () => {
    expect(assets.length).toBeGreaterThan(2);
    expect(assets.some((asset) => asset.file.endsWith('.js'))).toBe(true);
    expect(assets.some((asset) => asset.file === 'index.html')).toBe(true);
  });

  it('contains the "[proj]" tag in no emitted asset', () => {
    const offending = assets.filter((asset) => asset.text.includes(TAG));

    expect(offending.map((asset) => asset.file)).toEqual([]);
  });

  it('does not ship the module itself under any name', () => {
    const offending = assets.filter((asset) => asset.text.includes('startLeakAssertion'));

    expect(offending.map((asset) => asset.file)).toEqual([]);
  });

  /**
   * *"And no 60-second interval is registered in production"* (EPIC-16-S30).
   *
   * Asserted as "the only module that registers one was not emitted" rather
   * than as "the word `setInterval` appears nowhere". The latter would be a
   * false rule: the SSE client's keepalive is a real interval that a shipped
   * tab genuinely needs, so a blanket ban would fail on correct code and teach
   * the next reader to weaken the whole file.
   */
  it('emits no chunk for the module that registers the interval', () => {
    const chunks = assets.filter((asset) => /leak-assert/i.test(asset.file));

    expect(chunks.map((asset) => asset.file)).toEqual([]);
    expect(assets.some((asset) => asset.text.includes('LEAK_ASSERTION_INTERVAL_MS'))).toBe(false);
  });
});
