/**
 * KAR-16.6 AC10 — swapping the renderer is provably a one-file change.
 *
 * Verifies: EPIC-16-S35 (scenario 2) · AC1, AC10
 *
 * > A spike branch replaces `GraphCanvas`'s internals with a stub renderer and
 * > every consuming view still compiles and renders.
 *
 * The spike branch is committed rather than imagined
 * (`packages/web/src/components/graph/GraphCanvas.stub.vue`), and
 * `DeFlow_GRAPH_RENDERER=stub` is what selects it — one alias, in one place, for
 * both builds. This spec runs the swap end to end:
 *
 * 1. **Compiles.** A real `vite build` of the whole SPA with the stub selected.
 *    Every view, the router, the shell — if anything reached past the facade for
 *    a Vue Flow type, a `useVueFlow()` composable or a `.vue-flow__*` behaviour,
 *    it either fails here or shows up in (2).
 * 2. **Nothing else reached past it.** `@vue-flow/core` is absent from every
 *    chunk of that build — 345 KB of renderer, gone, because one file stopped
 *    importing it. That is the assertion the facade exists for, and the lint
 *    rule's runtime counterpart.
 * 3. **Renders.** The measurement harness, built the same way, serving a real
 *    400-node plan folded from a real recording, in a real Chromium: every node
 *    is drawn, through the caller's `#node` slot, with the accessible name the
 *    view-model prescribes.
 *
 * The third step is what stops this being a compile check. A stub that rendered
 * nothing would satisfy (1) and (2) perfectly.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import type { DrawnGraph, MeasureGlobal, MemoryRenderResult } from '../packages/web/measure/api.ts';
import { RENDERER_ENV } from '../packages/web/scripts/renderer-alias.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(repoRoot, 'packages/web');

let appDir: string;
let harnessDir: string;
let appChunks: { file: string; text: string; modules: readonly string[] }[];
let browser: Browser | undefined;
let site: { origin: string; close: () => Promise<void> };
/** How many nodes the stub drew, and what the first one is called. */
let drawn: DrawnGraph;
/** KAR-17.9 row 7 — the same, for the *memory* graph. */
let memory: MemoryRenderResult;

/*
 * Every `page.evaluate` body below spells out
 * `(globalThis as unknown as MeasureGlobal).__deflowMeasure` in place: the body
 * is serialised into the browser, so a helper defined here would not exist
 * there, and `globalThis` rather than `window` because this slice compiles
 * without the DOM lib.
 */

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: webRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

const vite = (args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> =>
  run(process.execPath, [join(webRoot, 'node_modules/vite/bin/vite.js'), ...args], env);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocketServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function serve(dir: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const port = await freePort();
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const file = join(dir, path === '/' ? 'index.html' : decodeURIComponent(path));
    stat(file)
      .then(() => {
        response.writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        createReadStream(file).pipe(response);
      })
      .catch(() => response.writeHead(404).end('not found'));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), 'DeFlow-swap-app-'));
  harnessDir = await mkdtemp(join(tmpdir(), 'DeFlow-swap-harness-'));

  // (1) the application, with the renderer swapped out from under every view.
  await vite(['build', '--outDir', appDir, '--emptyOutDir', '--sourcemap'], {
    [RENDERER_ENV]: 'stub',
  });
  const assets = await readdir(join(appDir, 'assets'));
  appChunks = await Promise.all(
    assets
      .filter((file) => file.endsWith('.js'))
      .map(async (file) => {
        const text = await readFile(join(appDir, 'assets', file), 'utf8');
        let modules: string[] = [];
        try {
          const map = JSON.parse(await readFile(join(appDir, 'assets', `${file}.map`), 'utf8')) as {
            sources?: string[];
          };
          modules = map.sources ?? [];
        } catch {
          modules = [];
        }
        return { file, text, modules };
      }),
  );

  // (3) the harness, so a real plan can be rendered through the stub.
  await vite(
    [
      'build',
      '--config',
      join(webRoot, 'measure/vite.config.ts'),
      '--outDir',
      harnessDir,
      '--emptyOutDir',
    ],
    { [RENDERER_ENV]: 'stub' },
  );

  const events = (
    await readFile(join(repoRoot, 'test/fixtures/runs/stress-400/events.jsonl'), 'utf8')
  )
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  site = await serve(harnessDir);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(site.origin);
  await page.waitForFunction(
    () => (globalThis as unknown as Partial<MeasureGlobal>).__deflowMeasure !== undefined,
  );
  await page.evaluate(
    (payload) =>
      (globalThis as unknown as MeasureGlobal).__deflowMeasure.render({
        events: payload as unknown[],
        onlyRenderVisibleElements: false,
      }),
    events,
  );

  drawn = await page.evaluate(() =>
    (globalThis as unknown as MeasureGlobal).__deflowMeasure.drawn(),
  );

  // KAR-17.9 test plan row 7 — the *second* graph surface, through the same
  // stub. `happy-path-12` rather than `stress-400` because it is the recording
  // with a blackboard: three facts, three writers, three readers and an
  // invalidation, which is a memory graph with something in it.
  const happy = (
    await readFile(join(repoRoot, 'test/fixtures/runs/happy-path-12/events.jsonl'), 'utf8')
  )
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  memory = await page.evaluate(
    (payload) =>
      (globalThis as unknown as MeasureGlobal).__deflowMeasure.renderMemory({
        events: payload as unknown[],
        expand: 'plan-migration',
      }),
    happy,
  );
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (process.env['DeFlow_KEEP_TMP'] === undefined) {
    await rm(appDir, { recursive: true, force: true });
    await rm(harnessDir, { recursive: true, force: true });
  }
});

suite('EPIC-16-S35 — the swap is provably one file', () => {
  it('builds the whole application against the stub renderer', () => {
    // `vite build` resolving and compiling every route, view and component is
    // the "still compiles" half. It threw in beforeAll if it did not.
    expect(appChunks.length).toBeGreaterThan(2);
    expect(
      appChunks.some((chunk) =>
        chunk.modules.some((module) => module.includes('GraphCanvas.stub.vue')),
      ),
      'the stub was not the renderer that got built — the alias did not apply',
    ).toBe(true);
  });

  it('leaves no Vue Flow anywhere in that build', () => {
    // The assertion the facade exists for: one file stopped importing the
    // renderer, and 345 KB of it left the application. Anything that had
    // reached past the facade would still be dragging it in.
    const importers = appChunks.filter((chunk) =>
      chunk.modules.some((module) => module.includes('@vue-flow/core')),
    );

    expect(importers.map((chunk) => chunk.file)).toEqual([]);
    for (const chunk of appChunks) {
      expect(chunk.text, `${chunk.file} still carries the renderer`).not.toContain(
        'vue-flow__transformationpane',
      );
    }
  });

  it('renders a real four-hundred-node plan through the node slot', () => {
    expect(drawn.renderer).toBe('stub');
    expect(drawn.count).toBeGreaterThanOrEqual(400);
    // Through the caller's slot — the node body is the consumer's component,
    // which is the property that makes the facade worth having at all.
    expect(drawn.firstTitle).not.toBe('');
    // And with the accessible name the view-model prescribes, from the shared
    // `types.ts` rather than from either renderer's own idea of it.
    expect(drawn.firstLabel).toMatch(
      /^.+ .+, (pending|running|blocked|passed|failed|abandoned|awaiting-human), /,
    );
  });
});

suite('KAR-17.9 — the memory graph goes through the same one file', () => {
  it('draws the aggregate through the stub renderer, from the real blackboard', () => {
    // Row 7's red is *"something reached past the facade"*: a view holding a
    // `useVueFlow()` composable, a `.vue-flow__*` behaviour or a renderer type
    // would either fail the build in `beforeAll` or draw nothing here.
    expect(memory.renderer).toBe('stub');
    expect(memory.facts).toBe(3);
    // Five nodes wrote or read a fact in `happy-path-12`, plus the one fact of
    // the expanded producer.
    expect(memory.drawn).toBe(6);
    expect(memory.firstLabel).toContain('fact');
  });

  it('aggregates before it renders, with facts only where one was expanded', () => {
    // AC1 and AC2 at the far end of a real build: the bubbles are the default
    // and the single fact node is there because the request asked for it.
    expect(memory.drawnFacts).toBe(1);
    expect(memory.kinds.filter((kind) => kind === 'producer')).toHaveLength(5);
    expect(memory.kinds.filter((kind) => kind === 'fact')).toHaveLength(1);
  });
});
