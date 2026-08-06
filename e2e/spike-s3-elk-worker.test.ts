/**
 * KAR-00.4 — the half of the spike that only a real browser, over real HTTP,
 * against the real `dist/`, can answer.
 *
 * AC1 is explicit that a `vite dev` pass proves nothing: the dev server
 * resolves worker URLs differently from the built, hashed assets the daemon
 * will actually serve, and the whole risk in A3-4 is about those hashed URLs.
 * So everything below runs against `vite build` output served by a plain static
 * HTTP server — no Vite in the loop at all.
 *
 * Every `page.evaluate` body below reaches the app through `globalThis.__s3`.
 * `globalThis` rather than `window` because the e2e slice compiles without the
 * DOM lib, and these bodies are serialised into the browser rather than run
 * here — where the two names are the same object anyway.
 *
 * Every number below is measured fresh on every run — that is what makes it a
 * measurement — and written to `measurementsOutDir()`, which is a temporary
 * directory unless `pnpm spike:s3:record` says otherwise. What is committed
 * under `measurements/` is the golden this run is compared against, so a
 * `pnpm test` leaves the working tree clean while still re-deriving every
 * number in the note.
 *
 * Verifies: EPIC-00-S14 (scenarios 1 and 3), EPIC-00-S15, EPIC-00-S16
 * · AC1, AC3, AC4, AC5.
 */
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  type BuildResult,
  build,
  readMeasurement,
  type StaticServer,
  serveDist,
  writeMeasurement,
} from '../spikes/s3-elk-worker/src/harness.ts';

interface Point {
  readonly x: number;
  readonly y: number;
}
type Positions = Record<string, Point>;

interface SixtyResult {
  readonly count: number;
  readonly positions: Positions;
  readonly heartbeatDelta: number;
  readonly durationMs: number;
  readonly workerUrl: string | null;
}

interface ConstraintProbe {
  readonly targetNode: string;
  readonly baselineLayer: number;
  readonly requestedLayer: number;
  /** Whether ELK itself lists the option id — "ignored" must not mean "misspelt". */
  readonly optionIsKnown: boolean;
  readonly baseline: Positions;
  readonly withoutInteractive: Positions;
  readonly withInteractive: Positions;
  readonly withInteractiveStrategy: Positions;
  readonly interactiveStrategyNoConstraint: Positions;
  readonly semiInteractivePosition: Positions;
  /** Which layer the target actually landed in, per configuration tried. */
  readonly layers: Record<string, number>;
  readonly errors: string[];
}

interface S3Api {
  layoutSixty(): Promise<SixtyResult>;
  prepare(mode: 'union' | 'per-version'): Promise<void>;
  showVersion(version: number): void;
  domPositions(): Positions;
  constraintProbe(): Promise<ConstraintProbe>;
  dagreSixty(): Promise<{ count: number; positions: Positions; version: string }>;
}

/** The committed shape of `measurements/browser-layout.json`. */
interface BrowserLayoutMeasurement {
  readonly nodes: number;
  readonly durationMs: number;
  readonly heartbeatTicks: number;
  /**
   * The worker's path, not its URL: the static server binds an ephemeral port,
   * so recording the origin would put a different number in a tracked file on
   * every run. The path is the part the spike is about — a hashed asset,
   * resolved from the built bundle.
   */
  readonly workerAsset: string;
}

let built: BuildResult;
let server: StaticServer;
let browser: Browser;
let page: Page;

const consoleErrors: string[] = [];
const failedRequests: string[] = [];
const responses: { url: string; status: number }[] = [];

beforeAll(async () => {
  built = await build('elk');
  expect(built.exitCode, built.output).toBe(0);
  server = await serveDist(built.outDir);
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));
  page.on('response', (response) =>
    responses.push({ url: response.url(), status: response.status() }),
  );
  await page.goto(server.origin, { waitUntil: 'load' });
  await page.waitForFunction(
    () => (globalThis as unknown as { __s3?: S3Api }).__s3 !== undefined,
    undefined,
    { timeout: 30_000 },
  );
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

suite('EPIC-00-S14 — the built worker loads from its hashed URL (AC1, AC3)', () => {
  it('lays out 60 nodes off the main thread, from a hashed worker chunk fetched with a 200', async () => {
    const result = await page.evaluate(() =>
      (globalThis as unknown as { __s3: S3Api }).__s3.layoutSixty(),
    );

    expect(result.count).toBe(60);
    expect(Object.keys(result.positions)).toHaveLength(60);
    const spread = new Set(Object.values(result.positions).map((point) => `${point.x},${point.y}`));
    expect(spread.size, 'sixty nodes stacked at one point is not a layout').toBeGreaterThan(50);

    expect(result.workerUrl, 'the app must have constructed a worker at all').not.toBeNull();
    expect(result.workerUrl).toMatch(/assets\/.*worker.*-[A-Za-z0-9_-]{8}\.js/);

    const worker = responses.find((response) => response.url === result.workerUrl);
    expect(worker, `never requested; responses: ${JSON.stringify(responses)}`).toBeDefined();
    expect(worker?.status).toBe(200);

    expect(responses.filter((response) => response.status >= 400)).toEqual([]);
    expect(failedRequests).toEqual([]);

    // AC3: the counter ticked while ELK worked, which is the whole claim.
    expect(
      result.heartbeatDelta,
      `layout took ${result.durationMs} ms and the main thread ticked ${result.heartbeatDelta} times`,
    ).toBeGreaterThanOrEqual(5);

    const measured: BrowserLayoutMeasurement = {
      nodes: result.count,
      // One decimal, because that is the resolution `performance.now()` gives
      // in Chromium and the rest is float noise from the subtraction.
      durationMs: Number(result.durationMs.toFixed(1)),
      heartbeatTicks: result.heartbeatDelta,
      workerAsset: new URL(result.workerUrl ?? '', server.origin).pathname,
    };
    writeMeasurement('browser-layout.json', measured);

    // The committed copy is a golden. A duration and a tick count are different
    // numbers on every machine and cannot be asserted equal — the assertions
    // that matter are above, on this run's own numbers — but what the recording
    // claims has to stay recognisable as the same measurement, and the recorded
    // run has to be one that would pass AC3 today.
    const golden = readMeasurement<BrowserLayoutMeasurement>('browser-layout.json');
    expect(measured.nodes).toBe(golden.nodes);
    expect(measured.workerAsset).toBe(golden.workerAsset);
    expect(golden.heartbeatTicks).toBeGreaterThanOrEqual(5);
    expect(golden.durationMs).toBeGreaterThan(0);
  });
});

suite('EPIC-00-S15 — one layout over the union keeps positions still (AC4)', () => {
  it('gives every surviving node byte-identical coordinates across v1 to v5', async () => {
    const steps = await page.evaluate(async () => {
      const api = (globalThis as unknown as { __s3: S3Api }).__s3;
      await api.prepare('union');
      const seen: Positions[] = [];
      for (const version of [1, 2, 3, 4, 5]) {
        api.showVersion(version);
        seen.push(api.domPositions());
      }
      return seen;
    });

    expect(steps).toHaveLength(5);
    for (const step of steps) expect(Object.keys(step).length).toBeGreaterThan(3);

    let comparisons = 0;
    for (let index = 1; index < steps.length; index += 1) {
      const before = steps[index - 1] as Positions;
      const after = steps[index] as Positions;
      const survivors = Object.keys(before).filter((id) => id in after);
      expect(survivors.length, `nothing survived v${index} to v${index + 1}`).toBeGreaterThan(3);
      for (const id of survivors) {
        comparisons += 1;
        expect(JSON.stringify(after[id]), `${id} moved between v${index} and v${index + 1}`).toBe(
          JSON.stringify(before[id]),
        );
      }
    }
    expect(comparisons).toBeGreaterThan(15);
  });

  it('measures the alternative: laying out each version alone does move them', async () => {
    const steps = await page.evaluate(async () => {
      const api = (globalThis as unknown as { __s3: S3Api }).__s3;
      await api.prepare('per-version');
      const seen: Positions[] = [];
      for (const version of [1, 2, 3, 4, 5]) {
        api.showVersion(version);
        seen.push(api.domPositions());
      }
      return seen;
    });

    const moved: string[] = [];
    for (let index = 1; index < steps.length; index += 1) {
      const before = steps[index - 1] as Positions;
      const after = steps[index] as Positions;
      for (const id of Object.keys(before).filter((key) => key in after)) {
        if (JSON.stringify(after[id]) !== JSON.stringify(before[id])) {
          moved.push(`v${index}->v${index + 1}:${id}`);
        }
      }
    }

    expect(
      moved.length,
      'if a per-version layout never moves anything, this fixture cannot tell the two mechanisms apart',
    ).toBeGreaterThan(0);

    const measured = { perVersionMoves: moved.length, moved };
    writeMeasurement('union-vs-per-version.json', measured);
    // Same layout, same fixture, same engine: this one is not a timing, so the
    // golden can be held to the number the note quotes.
    expect(measured.perVersionMoves).toBe(
      readMeasurement<{ perVersionMoves: number }>('union-vs-per-version.json').perVersionMoves,
    );
  });
});

suite('EPIC-00-S16 — the constraint recipe, actually tried (AC5)', () => {
  it('is silently ignored without org.eclipse.elk.interactiveLayout', async () => {
    const before = consoleErrors.length;
    const probe = await page.evaluate(() =>
      (globalThis as unknown as { __s3: S3Api }).__s3.constraintProbe(),
    );

    expect(probe.errors).toEqual([]);
    expect(
      probe.requestedLayer,
      'the constraint must ask for a layer the unconstrained layout did not choose',
    ).not.toBe(probe.baselineLayer);
    expect(
      probe.optionIsKnown,
      'ELK must list the option id, or "silently ignored" is just a typo in this spike',
    ).toBe(true);

    expect(
      JSON.stringify(probe.withoutInteractive),
      'layerChoiceConstraint had an effect without interactiveLayout — the research finding is wrong for 0.12.0',
    ).toBe(JSON.stringify(probe.baseline));

    expect(consoleErrors.slice(before), 'and it fails silently, which is the point').toEqual([]);

    // The claim W11 needs is not "the coordinates were equal" — it is which
    // configurations get the node into the layer it asked for. As written
    // online the recipe does not: neither the bare constraint nor
    // `interactiveLayout: true` moves it off the layer the unconstrained
    // layout chose.
    expect(probe.layers.withoutInteractive).toBe(probe.layers.baseline);
    expect(
      probe.layers.withInteractive,
      'interactiveLayout: true, on its own, is not enough — that is the finding',
    ).toBe(probe.layers.baseline);
    expect(
      probe.layers.semiInteractivePosition,
      'org.eclipse.elk.position + semiInteractive does not move it either',
    ).toBe(probe.layers.baseline);

    for (const key of [
      'baseline',
      'withoutInteractive',
      'withInteractive',
      'withInteractiveStrategy',
      'interactiveStrategyNoConstraint',
      'semiInteractivePosition',
    ]) {
      expect(typeof probe.layers[key], `layers.${key} must be a measured number`).toBe('number');
    }
    // The trap this control exists to catch. Switching the layering strategy to
    // INTERACTIVE *does* redraw the graph, and the target *does* land in the
    // requested layer — which is exactly the screenshot a blog post would call
    // success. Laying the same graph out with the same INTERACTIVE strategies
    // and **no constraint at all** produces the identical drawing: INTERACTIVE
    // reads node coordinates, these nodes have none, and the layer the node
    // "obeyed" is where it was going regardless.
    expect(probe.layers.withInteractiveStrategy).toBe(probe.requestedLayer);
    expect(
      JSON.stringify(probe.withInteractiveStrategy),
      'the constraint changed the INTERACTIVE layout — it is being honoured after all, and the note is wrong',
    ).toBe(JSON.stringify(probe.interactiveStrategyNoConstraint));

    const measured = {
      targetNode: probe.targetNode,
      baselineLayer: probe.baselineLayer,
      requestedLayer: probe.requestedLayer,
      optionIsKnown: probe.optionIsKnown,
      layers: probe.layers,
      ignoredWithoutInteractiveLayout:
        JSON.stringify(probe.withoutInteractive) === JSON.stringify(probe.baseline),
      changedWithInteractiveLayout:
        JSON.stringify(probe.withInteractive) !== JSON.stringify(probe.baseline),
      changedWithInteractiveLayeringStrategy:
        JSON.stringify(probe.withInteractiveStrategy) !== JSON.stringify(probe.baseline),
      interactiveStrategyHonouredTheConstraint:
        JSON.stringify(probe.withInteractiveStrategy) !==
        JSON.stringify(probe.interactiveStrategyNoConstraint),
      changedWithSemiInteractivePosition:
        JSON.stringify(probe.semiInteractivePosition) !== JSON.stringify(probe.baseline),
      errors: probe.errors,
    };
    writeMeasurement('constraint-probe.json', measured);
    // Layer numbers, not timings: the golden holds them.
    expect(measured.layers).toEqual(
      readMeasurement<{ layers: Record<string, number> }>('constraint-probe.json').layers,
    );
  });
});

suite('EPIC-00-S16 — the documented fallback is real, not just written down', () => {
  it('lays out the same 60 nodes with @dagrejs/dagre 3.0.0', async () => {
    const result = await page.evaluate(() =>
      (globalThis as unknown as { __s3: S3Api }).__s3.dagreSixty(),
    );

    expect(result.count).toBe(60);
    expect(Object.keys(result.positions)).toHaveLength(60);
    expect(
      result.version,
      'the Vue Flow docs pin 1.1.2, two majors behind what a fresh install gets',
    ).toMatch(/^3\./);
    const spread = new Set(Object.values(result.positions).map((point) => `${point.x},${point.y}`));
    expect(spread.size).toBeGreaterThan(50);
  });
});
