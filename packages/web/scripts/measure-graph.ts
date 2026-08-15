/**
 * KAR-16.6 AC3/AC4 — `pnpm measure:graph`.
 *
 * > _"Measure Vue Flow in week one of W10, not week four of W11."_
 * > — [roadmap §2.3](../../../docs/17-roadmap.md)
 *
 * The published guidance for this renderer — ~300–500 nodes smooth, 500–1,500
 * usable with culling, stalls past ~2,000 — is **extrapolated from React Flow**
 * and marked UNVERIFIED (A3-2, **High**), because no official Vue Flow benchmark
 * exists. This script replaces the extrapolation with a number, and it is
 * re-runnable so the number can be re-taken rather than remembered.
 *
 * What it does, end to end:
 *
 * 1. builds `../measure/` — the harness page, which renders the **real**
 *    `GraphCanvas` over the **real** `plan.ts` projection;
 * 2. serves the build over plain `node:http`, so nothing in the loop is a dev
 *    server;
 * 3. boots a real `deflow replay stress-400 --speed max` daemon and reads the
 *    recorded run's events off its API — the fixture is a recording of a real
 *    ledger, not a hand-written array;
 * 4. drives a real headless Chromium through a **scripted pan** and a
 *    **scripted zoom**, with real mouse and wheel input, twice: with
 *    `onlyRenderVisibleElements` off and on;
 * 5. samples the machine's own idle frame jitter as a control, because a frame
 *    budget with no control is a statement about the laptop rather than about
 *    the graph;
 * 6. prints the result as JSON, and — as `pnpm measure:graph` — writes
 *    `docs/measurements/vue-flow-400.md` and `.json` beside it.
 *
 * `e2e/measure-graph.test.ts` imports `measureGraph` and asserts the p95 frame
 * times against the committed budget. That is the difference between a number
 * that is filed and a number that is enforced.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import type { MeasureGlobal } from '../measure/api.ts';

/*
 * Every `page.evaluate` body below reaches the harness through
 * `(globalThis as unknown as MeasureGlobal).__deflowMeasure`, spelled out in
 * place rather than behind a helper: the bodies are serialised into the browser,
 * so a name defined *here* does not exist *there*. `globalThis` rather than
 * `window` because the e2e slice that imports this file compiles without the
 * DOM lib — the same convention `e2e/spike-s3-elk-worker.test.ts` uses.
 */

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The fixture the measurement is about (EPIC-16-S36). */
export const FIXTURE = 'stress-400';

export const MEASUREMENT_MD = 'docs/measurements/vue-flow-400.md';
export const MEASUREMENT_JSON = 'docs/measurements/vue-flow-400.json';

/** The command this file's own output tells a reader to run. */
export const REPRODUCE = 'pnpm measure:graph';

export interface FrameStats {
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
}

export interface GraphPass {
  /** `true` when `onlyRenderVisibleElements` was on for this pass. */
  readonly culling: boolean;
  readonly nodes: number;
  readonly edges: number;
  /** ELK, off the main thread, as the canvas reported it. */
  readonly layoutMs: number;
  /** Mount → the full graph on screen. */
  readonly firstPaintMs: number;
  readonly pan: FrameStats;
  readonly zoom: FrameStats;
}

export interface GraphMeasurement {
  readonly fixture: string;
  readonly takenAt: string;
  readonly machine: {
    readonly platform: string;
    readonly arch: string;
    readonly release: string;
    readonly cpu: string;
    readonly cores: number;
    readonly memoryGiB: number;
    readonly node: string;
  };
  readonly chromium: string;
  readonly versions: Readonly<Record<string, string>>;
  /** The same measurement, on an idle page: the machine's own jitter. */
  readonly idle: FrameStats;
  /** A twelve-node graph through the identical script: the small-graph control. */
  readonly control: GraphPass;
  readonly passes: readonly GraphPass[];
}

/** The committed budget, and the tolerance the assertion is allowed. */
export interface GraphBudget {
  readonly p95PanMs: number;
  readonly p95ZoomMs: number;
  /** Multiple of the recorded number a re-run may reach before it is a regression. */
  readonly tolerance: number;
  /** Never assert tighter than this, however fast the recording machine was. */
  readonly floorMs: number;
}

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return Number((sorted[index] ?? 0).toFixed(2));
};

const stats = (frames: readonly number[]): FrameStats => ({
  samples: frames.length,
  medianMs: percentile(frames, 0.5),
  p95Ms: percentile(frames, 0.95),
});

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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocketServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not find a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** A plain static server over `dir`. No Vite anywhere in the measured loop. */
async function serve(dir: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const port = await freePort();
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const file = join(dir, path === '/' ? 'index.html' : decodeURIComponent(path));
    stat(file)
      .then(() => {
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        });
        createReadStream(file).pipe(response);
      })
      .catch(() => {
        response.writeHead(404).end('not found');
      });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Replay {
  readonly origin: string;
  readonly token: string;
  readonly stop: () => Promise<void>;
}

/** Boots `deflow replay <fixture> --speed max` and waits for it to be up. */
async function startReplay(fixture: string, dataDir: string): Promise<Replay> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, 'packages/daemon/src/replay/main.ts'),
      fixture,
      '--speed',
      'max',
      '--port',
      String(port),
      '--data-dir',
      dataDir,
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });

  const origin = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  let token: string | undefined;
  for (;;) {
    // The handoff URL carries the token in the fragment and is the first line
    // the harness prints — the same line `deflow up` prints, read the same way.
    token ??= /#token=([A-Za-z0-9_-]+)/.exec(out)?.[1];
    if (token !== undefined) {
      try {
        const health = await fetch(`${origin}/api/health`);
        if (health.ok) break;
      } catch {
        // still coming up
      }
    }
    if (child.exitCode !== null) throw new Error(`deflow replay exited early:\n${out}`);
    if (Date.now() > deadline) throw new Error(`deflow replay never came up:\n${out}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    origin,
    token: token as string,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }),
  };
}

/**
 * The run the fixture records, read off the fixture's first line.
 *
 * There is no `GET /api/runs` listing to ask — the API is per-run by design
 * (docs/11 §7) — and the recording names its own run in every envelope, so the
 * file is the honest place to read it from.
 */
async function recordedRunId(fixture: string): Promise<string> {
  const path = join(repoRoot, 'test/fixtures/runs', fixture, 'events.jsonl');
  const first = (await readFile(path, 'utf8')).split('\n', 1)[0] ?? '';
  const runId = (JSON.parse(first) as { runId?: string }).runId;
  if (runId === undefined) throw new Error(`${fixture}'s first event names no run`);
  return runId;
}

/** Every event of the replayed run, read off the daemon's own API. */
async function recordedEvents(replay: Replay, first: string): Promise<unknown[]> {
  const headers = { authorization: `Bearer ${replay.token}` };
  const events: unknown[] = [];
  let since = 0;
  for (;;) {
    const response = await fetch(
      `${replay.origin}/api/runs/${first}/events?since=${String(since)}&limit=1000`,
      { headers },
    );
    if (!response.ok) throw new Error(`reading events failed with ${String(response.status)}`);
    const page = (await response.json()) as {
      events: unknown[];
      cursor: number;
      more: boolean;
    };
    events.push(...page.events);
    since = page.cursor;
    if (!page.more) break;
  }
  return events;
}

/** A scripted pan: a real pointer drag across the pane, in small steps. */
async function scriptedPan(page: Page): Promise<number[]> {
  const box = await page.locator('.vue-flow__pane').boundingBox();
  if (box === null) throw new Error('the canvas has no box to pan across');

  await page.evaluate(() => {
    (globalThis as unknown as MeasureGlobal).__deflowMeasure.startFrames();
  });
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let step = 1; step <= 40; step += 1) {
    await page.mouse.move(
      box.x + box.width * 0.75 - step * (box.width * 0.012),
      box.y + box.height * 0.5 + step * 2,
    );
  }
  await page.mouse.up();
  return page.evaluate(() => (globalThis as unknown as MeasureGlobal).__deflowMeasure.stopFrames());
}

/** A scripted zoom: real wheel events over the pane, out and back in. */
async function scriptedZoom(page: Page): Promise<number[]> {
  const box = await page.locator('.vue-flow__pane').boundingBox();
  if (box === null) throw new Error('the canvas has no box to zoom');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    (globalThis as unknown as MeasureGlobal).__deflowMeasure.startFrames();
  });
  for (let step = 0; step < 20; step += 1) await page.mouse.wheel(0, -120);
  for (let step = 0; step < 20; step += 1) await page.mouse.wheel(0, 120);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return page.evaluate(() => (globalThis as unknown as MeasureGlobal).__deflowMeasure.stopFrames());
}

/** The machine's own frame jitter, with nothing happening. */
async function idleFrames(page: Page): Promise<number[]> {
  await page.evaluate(() => {
    (globalThis as unknown as MeasureGlobal).__deflowMeasure.startFrames();
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  return page.evaluate(() => (globalThis as unknown as MeasureGlobal).__deflowMeasure.stopFrames());
}

async function onePass(
  page: Page,
  events: readonly unknown[],
  options: { culling: boolean; limit?: number },
): Promise<GraphPass> {
  const rendered = await page.evaluate(
    ([payload, culling, limit]) =>
      (globalThis as unknown as MeasureGlobal).__deflowMeasure.render({
        events: payload as unknown[],
        onlyRenderVisibleElements: culling as boolean,
        ...(limit === undefined ? {} : { limit: limit as number }),
      }),
    [events, options.culling, options.limit] as const,
  );

  return {
    culling: options.culling,
    nodes: rendered.nodes,
    edges: rendered.edges,
    layoutMs: Number(rendered.layoutMs.toFixed(2)),
    firstPaintMs: Number(rendered.firstPaintMs.toFixed(2)),
    pan: stats(await scriptedPan(page)),
    zoom: stats(await scriptedZoom(page)),
  };
}

async function pinnedVersions(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(webRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const workspace = await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const pinOf = (name: string): string =>
    new RegExp(`^\\s*"?${name.replaceAll('/', '\\/')}"?:\\s*(\\S+)`, 'm').exec(workspace)?.[1] ??
    manifest.dependencies?.[name] ??
    'unknown';

  return {
    '@vue-flow/core': pinOf('@vue-flow/core'),
    elkjs: pinOf('elkjs'),
    vue: pinOf('vue'),
    vite: pinOf('vite'),
  };
}

export interface MeasureOptions {
  /** Where to build the harness. A temporary directory by default. */
  readonly outDir?: string;
}

/** Runs the whole measurement and returns it. Nothing is written to the repo. */
export async function measureGraph(options: MeasureOptions = {}): Promise<GraphMeasurement> {
  const outDir = options.outDir ?? (await mkdtemp(join(repoRoot, 'node_modules/.deflow-measure-')));
  const dataDir = await mkdtemp(join(repoRoot, 'node_modules/.deflow-replay-'));

  await run(
    process.execPath,
    [
      join(webRoot, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      join(webRoot, 'measure/vite.config.ts'),
      '--outDir',
      outDir,
      '--emptyOutDir',
    ],
    webRoot,
  );

  const site = await serve(outDir);
  const replay = await startReplay(FIXTURE, dataDir);
  let browser: Browser | undefined;

  try {
    const events = await recordedEvents(replay, await recordedRunId(FIXTURE));
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(site.origin);
    await page.waitForFunction(
      () => (globalThis as unknown as Partial<MeasureGlobal>).__deflowMeasure !== undefined,
    );

    const idle = stats(await idleFrames(page));
    // The control first, so a machine that is already thrashing shows up as a
    // twelve-node graph that is slow rather than as a four-hundred-node one.
    const control = await onePass(page, events, { culling: false, limit: 12 });
    const passes = [
      await onePass(page, events, { culling: false }),
      await onePass(page, events, { culling: true }),
    ];

    return {
      fixture: FIXTURE,
      takenAt: new Date().toISOString().slice(0, 10),
      machine: {
        platform: platform(),
        arch: arch(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
        node: process.version,
      },
      chromium: browser.version(),
      versions: await pinnedVersions(),
      idle,
      control,
      passes,
    };
  } finally {
    await browser?.close();
    await replay.stop();
    await site.close();
    if (options.outDir === undefined) await rm(outDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

const round = (value: number): string => value.toFixed(1);

/** The committed markdown, generated so it cannot drift from the numbers. */
export function renderMeasurement(measurement: GraphMeasurement, budget: GraphBudget): string {
  const row = (pass: GraphPass): string =>
    `| ${pass.culling ? 'on' : 'off'} | ${String(pass.nodes)} | ${String(pass.edges)} | ` +
    `${round(pass.layoutMs)} | ${round(pass.firstPaintMs)} | ${round(pass.pan.medianMs)} | ` +
    `${round(pass.pan.p95Ms)} | ${round(pass.zoom.medianMs)} | ${round(pass.zoom.p95Ms)} |`;

  const full = measurement.passes.find((pass) => !pass.culling) ?? measurement.passes[0];
  /**
   * Two frames at 60 Hz, and the bar both decisions below turn on: the culling
   * default and — KAR-17.9 AC8 / EPIC-17-S34 — whether this project can afford
   * a **second** Vue Flow surface at all. `test/memory-graph-decision.test.ts`
   * derives the same boolean from the committed JSON and fails if the router
   * disagrees with this paragraph.
   */
  const affordable =
    (full?.pan.p95Ms ?? 0) <= budget.floorMs && (full?.zoom.p95Ms ?? 0) <= budget.floorMs;
  // Wrapped here rather than by a formatter: this file's output is markdown
  // somebody reads in a diff, and one 400-column bullet in a document wrapped
  // at a hundred is the kind of thing nobody fixes because nobody owns it.
  const secondSurface = affordable
    ? "**KAR-17.9's memory graph ships.** F10.4's blackboard view is a second graph on this\n" +
      '  renderer, and the number above is what unblocked it: the story sat at `Blocked` by design\n' +
      '  until this file existed and its figures supported one. The view is a lazy route and\n' +
      '  aggregates by producing node before it renders, so what it asks of the renderer is the\n' +
      '  plan graph’s order of magnitude and not the blackboard’s.'
    : '**KAR-17.9’s memory graph slips to M2.** A second graph surface is not affordable at this\n' +
      '  frame time, and roadmap §3 says what happens instead: F10.4’s M1 coverage is KAR-17.3’s\n' +
      '  provenance table plus the `blackboard.ts` projection. Nothing is lost — `fact.written`\n' +
      '  and `fact.read` are ledger events regardless, so the data accrues from day one and\n' +
      '  adding the view later needs no migration and no re-run.';
  const verdict =
    (full?.pan.p95Ms ?? 0) <= 32 && (full?.zoom.p95Ms ?? 0) <= 32
      ? `**${String(full?.nodes ?? 0)} nodes render and interact inside two frames at the 95th ` +
        'percentile with culling off.** The ~300–500 estimate was pessimistic on this machine; ' +
        'F10.4 is not at risk from the renderer, and `onlyRenderVisibleElements` stays **off** ' +
        'by default (see “What the number decides” below).'
      : `**${String(full?.nodes ?? 0)} nodes exceed a two-frame p95 with culling off on this ` +
        'machine.** Read “What the number decides” below before shipping the memory graph.';

  return `<!--
  GENERATED by \`${REPRODUCE}\` (packages/web/scripts/measure-graph.ts).
  Edit the script or re-run the command; hand edits are lost on the next run.
-->

# Vue Flow at 400 nodes — the measurement

> KAR-16.6 AC3/AC4 · replaces the **UNVERIFIED** estimate in
> [12 §6.1](../12-frontend-architecture.md) and closes A3-2.
> Scenario: [EPIC-16-S36](../delivery/flows/EPIC-16-ui-foundation-flows.md).

**Reproduce:** \`${REPRODUCE}\`
**Enforced by:** \`e2e/measure-graph.test.ts\`, against \`${MEASUREMENT_JSON}\`

**Date:** ${measurement.takenAt}. **Machine:** ${measurement.machine.platform}/${measurement.machine.arch} ${measurement.machine.release}, ${measurement.machine.cpu} × ${String(measurement.machine.cores)}, ${String(measurement.machine.memoryGiB)} GiB, Node ${measurement.machine.node}. **Browser:** Chromium ${measurement.chromium} (headless, 1440×900, via playwright).
**Pins:** ${Object.entries(measurement.versions)
    .map(([name, version]) => `\`${name}@${version}\``)
    .join(', ')}.

## The claim being replaced

[12 §6.1](../12-frontend-architecture.md) says ~300–500 nodes smooth at 60 fps with custom node
components, 500–1,500 usable with \`onlyRenderVisibleElements\`, stalling past roughly 2,000 nodes or
4,000 edges — and marks it **UNVERIFIED**. It is extrapolated from React Flow's guidance and the
identical one-DOM-subtree-per-node architecture; no official Vue Flow benchmark exists. After this
file, this project has its own number.

## Method

\`${REPRODUCE}\` builds \`packages/web/measure/\` — a harness page that renders the **real**
\`GraphCanvas\` over the **real** \`plan.ts\` projection — serves it over plain \`node:http\` with no
dev server anywhere in the loop, boots
\`deflow replay ${measurement.fixture} --speed max\` as a real daemon, reads that run's events off its
API, and drives a real headless Chromium through a scripted pan (a 40-step pointer drag) and a
scripted zoom (20 wheel steps out, 20 back in), sampling every animation frame. Each figure is taken
twice: with \`onlyRenderVisibleElements\` off and on.

## The numbers

| culling | nodes | edges | ELK layout (ms, off-main-thread) | first paint (ms) | pan median (ms) | pan p95 (ms) | zoom median (ms) | zoom p95 (ms) |
| ------- | ----- | ----- | -------------------------------- | ---------------- | --------------- | ------------ | ---------------- | ------------- |
${measurement.passes.map(row).join('\n')}

Two things this table is **not** claiming, both of which matter when reading it later:

- **First paint means different things in the two rows.** With culling off it is mount → every node
  of the plan on screen, which is the number AC3 asks for. With culling on the renderer draws only
  what fits, so "every node" never happens by construction and the figure is mount → the first
  nodes painted. Comparing the two columns down the page is comparing two definitions.
- **\`${measurement.fixture}\` is node-heavy and edge-light** — ${String(full?.nodes ?? 0)} nodes and
  ${String(full?.edges ?? 0)} edges, because it records a fan-out of map children rather than a deep
  dependency graph. So these figures bound **node** rendering, which is the one-DOM-subtree-per-node
  cost the estimate was about. The published estimate's other half — stalling past roughly 4,000
  *edges* — is not measured here and remains unverified.

**Controls on the same machine, in the same run.** Idle frame time with nothing happening:
median ${round(measurement.idle.medianMs)} ms, p95 ${round(measurement.idle.p95Ms)} ms over
${String(measurement.idle.samples)} frames — the machine's own jitter, which is the floor under
every number above. The same script over a **${String(measurement.control.nodes)}-node** graph:
pan p95 ${round(measurement.control.pan.p95Ms)} ms, zoom p95 ${round(measurement.control.zoom.p95Ms)} ms.
A run in which the ${String(full?.nodes ?? 0)}-node figures are not materially worse than these two
is a run in which the graph was not the cost.

## The verdict

${verdict}

## What the number decides

- \`onlyRenderVisibleElements\` defaults to **${String(
    (measurement.passes.find((pass) => !pass.culling)?.pan.p95Ms ?? 0) > 32,
  )}** in \`packages/web/src/components/graph/defaults.ts\`, and that file names this one.
- Culling is not free: every node body re-mounts as it scrolls into view, so the state chip and the
  streaming badge flicker during a pan. It buys first paint and costs steadiness, which is why the
  default follows the measurement rather than the instinct.
- ${secondSurface}
- If a future re-run puts the 400-node p95 above the budget, the roadmap §3 recommendation applies:
  \`onlyRenderVisibleElements\` becomes the default for the plan graph and KAR-17.9's memory graph
  slips to M2. **That decision is recorded here rather than in someone's memory.**

## The budget this enforces

\`${MEASUREMENT_JSON}\` holds \`p95PanMs: ${round(budget.p95PanMs)}\`,
\`p95ZoomMs: ${round(budget.p95ZoomMs)}\`, a tolerance of ×${String(budget.tolerance)} and a floor of
${round(budget.floorMs)} ms. The e2e spec re-measures and fails if the p95 exceeds the *widest* of:
the recorded number × the tolerance, the floor, and three times the same run's own idle p95. A
regression is caught; jitter — and a loaded laptop — is not.

## Layout

ELK runs **in a Web Worker**, off the main thread, in the built output — the recipe
[S3](../spikes/S3-elk-worker.md) settled and \`packages/web/test/integration/graph-worker-chunk.test.ts\`
holds. The fallback S3 describes (\`@dagrejs/dagre\` driving the live graph with ELK on the main
thread for cached scrubber layouts) was **not** taken: the worker path builds, the hashed chunk loads
over plain HTTP, and the layout figure above is what it costs.

## Re-run this when

The \`vue\`, \`@vue-flow/core\` or \`elkjs\` pin moves. Vue 3.6's reactivity rewrite could shift these
either way, and Vue Flow's store leans hard on the internals 3.6 rewrites.
`;
}

/** The budget a fresh measurement writes: the numbers it just took. */
export function budgetOf(measurement: GraphMeasurement): GraphBudget {
  const worst = (pick: (pass: GraphPass) => number): number =>
    Number(Math.max(...measurement.passes.map(pick)).toFixed(2));

  return {
    p95PanMs: worst((pass) => pass.pan.p95Ms),
    p95ZoomMs: worst((pass) => pass.zoom.p95Ms),
    // Wide enough not to be flaky, narrow enough to catch a regression: a
    // doubling of the 95th-percentile frame time is not jitter.
    tolerance: 2,
    // Two frames at 60 Hz. Below this the assertion would be about the
    // recording machine's speed rather than about the graph.
    floorMs: 32,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const measurement = await measureGraph();
  const budget = budgetOf(measurement);

  await writeFile(
    join(repoRoot, MEASUREMENT_JSON),
    `${JSON.stringify({ budget, measurement }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(repoRoot, MEASUREMENT_MD), renderMeasurement(measurement, budget), 'utf8');
  process.stdout.write(`${MEASUREMENT_MD} and ${MEASUREMENT_JSON} written\n`);
}
