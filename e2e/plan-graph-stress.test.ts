/**
 * KAR-17.1 AC8 — four hundred nodes, in **the view** rather than in the harness.
 *
 * Verifies: EPIC-17-S4 (scenario 1, the interactivity clause) · AC8
 *
 * AC8 has three clauses and two of them were already held before this file
 * existed:
 *
 * - *"meets the budget recorded in `docs/measurements/vue-flow-400.md`"* —
 *   `./measure-graph.test.ts`, which re-takes the whole measurement against a
 *   real `deflow replay stress-400` daemon and fails on a regression;
 * - *"with `onlyRenderVisibleElements` set per that measurement"* —
 *   `../test/graph-culling-default.test.ts`, which derives the default from the
 *   committed numbers rather than restating it.
 *
 * The third is *"the view remains interactive: selecting a node opens the
 * inspector within the NF3 budget"*, and neither of those two can say anything
 * about it. Both measure `packages/web/measure/`, a harness page that mounts the
 * real `GraphCanvas` over the real `plan.ts` — and then renders the facade's
 * **default** node body, a title and a state word. The shipped view does not:
 * every one of those four hundred boxes is a `PlanNode` with a state chip, a
 * type glyph, a provider line, a verdict slot, an elapsed figure and a cost
 * figure, re-derived through `memoise` against a `useNow` ticker that fires once
 * a second for the life of the run.
 *
 * That difference is the whole risk. A per-node body that is forty times the
 * markup, on a clock, is exactly the shape of thing that renders four hundred
 * nodes beautifully and then answers a keystroke in three seconds — and the
 * measurement would keep passing while it did, because the measurement is not
 * looking at this page.
 *
 * **This is not a sixth Playwright smoke** ([14 §13](../docs/14-testing-strategy.md)
 * budgets roughly five and `./plan-graph.test.ts` is the first of them). It is a
 * budget spec, and its sibling is `./measure-graph.test.ts`: it asserts one
 * number about one interaction, and it asserts nothing at all about what the
 * graph looks like.
 *
 * NF3 is *"UI interactive < 1 s on localhost"* ([12 §10](../docs/12-frontend-architecture.md)),
 * and that is a product budget rather than a machine reading, so the ceiling is
 * the stated second and not a multiple of anything. What the spec does borrow
 * from EPIC-05's practice is the **control**: the same interaction is timed on
 * `happy-path-12`'s twelve nodes first, in the same browser, seconds earlier. A
 * run where the two are far apart is a run where the graph's size is the cost; a
 * run where both are slow is a loaded laptop, and the failure message says which
 * one happened instead of leaving the next reader to guess.
 *
 * Every `page.evaluate` body is source text rather than a closure, for the
 * reason `./plan-graph.test.ts` records: this slice compiles with Node's libs
 * and no DOM.
 */
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../packages/daemon/src/replay/harness.ts';
import { parseSpeed } from '../packages/daemon/src/replay/speed.ts';
import { repoRoot } from './support/daemon.ts';

const STRESS = join(repoRoot, 'test/fixtures/runs/stress-400/events.jsonl');
const CONTROL = join(repoRoot, 'test/fixtures/runs/happy-path-12/events.jsonl');

/** NF3, in milliseconds: *"UI interactive < 1s on localhost"* (docs/12 §10). */
const NF3_BUDGET_MS = 1_000;

/** What `stress-400`'s README describes: a `map` and its four hundred children. */
const AT_LEAST = 400;

/** How many node bodies the shipped view has drawn — `PlanNode`, not the facade's default. */
const DRAWN = 'document.querySelectorAll("[data-plan-node]").length';

/**
 * Selects the first node with `j` and opens the inspector with `Enter`, timing
 * the whole thing from inside the page.
 *
 * Timed in the page rather than around the two Playwright calls: a round trip
 * over the CDP socket is tens of milliseconds of somebody else's latency, and
 * NF3 is a budget about the tab. `performance.now()` either side of a poll for
 * the overlay is what the operator's hand actually waits for.
 *
 * The keys go through `page.keyboard` — the shell's real keymap, on `window` —
 * so this is the same traversal `./plan-graph.test.ts` asserts the behaviour of,
 * and not a store method called by name.
 */
async function timeSelectToInspector(on: Page): Promise<number> {
  await on.evaluate('window.__deflowMark = performance.now()');
  await on.keyboard.press('j');
  await on.keyboard.press('Enter');
  return on.evaluate<number>(
    `(async () => {
      const deadline = performance.now() + 30000;
      while (performance.now() < deadline) {
        if (document.querySelector('[data-overlay="inspector"]') !== null) {
          return performance.now() - window.__deflowMark;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error('the inspector never opened');
    })()`,
  );
}

/** Waits until the view has drawn at least `wanted` node bodies, or says how far it got. */
async function drew(on: Page, wanted: number, timeoutMs = 120_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await on.evaluate<number>(DRAWN);
    if (count >= wanted) return count;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the plan graph drew ${count} of ${wanted} node bodies in ${timeoutMs} ms`);
}

async function openRun(browser: Browser, harness: ReplayHarness): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${harness.origin}/runs/${harness.runIds[0] as string}#token=${harness.token}`);
  return page;
}

let browser: Browser;
let stress: ReplayHarness;
let control: ReplayHarness;
let stressPage: Page;
let drawn = 0;
let controlMs = 0;
let stressMs = 0;

beforeAll(async () => {
  browser = await chromium.launch();

  // The control first, and in the same browser: twelve nodes through the same
  // view, the same keymap and the same inspector, so the number below has
  // something on this machine to be compared against.
  control = await startReplay({
    fixture: CONTROL,
    speed: parseSpeed('max'),
    port: 0,
    dev: true,
  });
  await control.played();
  const controlPage = await openRun(browser, control);
  try {
    await drew(controlPage, 12);
    controlMs = await timeSelectToInspector(controlPage);
  } finally {
    await controlPage.close();
  }
  await control.close();

  stress = await startReplay({
    fixture: STRESS,
    speed: parseSpeed('max'),
    port: 0,
    dev: true,
  });
  await stress.played();

  stressPage = await openRun(browser, stress);
  drawn = await drew(stressPage, AT_LEAST);
  stressMs = await timeSelectToInspector(stressPage);
}, 900_000);

afterAll(async () => {
  await stressPage?.close();
  await browser?.close();
  await stress?.close();
  await control?.close();
});

suite('EPIC-17-S4 — the stress fixture, in the shipped view', () => {
  it('draws every one of the four hundred nodes as a real node body', () => {
    // With culling off — which is what the measurement decided — every node in
    // the plan is mounted at once, so this is also the honest statement of what
    // the default costs. A count that came back at a screenful would mean the
    // culling default had been flipped behind the measurement's back.
    expect(drawn).toBeGreaterThanOrEqual(AT_LEAST);
  });

  it('opens the inspector on a keystroke inside the NF3 budget', () => {
    expect(
      stressMs,
      `selecting a node and opening the inspector took ${stressMs.toFixed(0)} ms over ` +
        `${String(drawn)} nodes, against NF3's ${String(NF3_BUDGET_MS)} ms. The same interaction ` +
        `over twelve nodes took ${controlMs.toFixed(0)} ms in this browser moments earlier — so ` +
        (controlMs > NF3_BUDGET_MS / 2
          ? 'the machine was loaded and this may not be the graph.'
          : 'the machine was idle and the graph is the cost.'),
    ).toBeLessThan(NF3_BUDGET_MS);
  });

  it('is not materially slower at four hundred nodes than at twelve', () => {
    // The control's own job. NF3 is an absolute budget and the assertion above
    // is the one that gates; this one names the *reason* a future regression
    // failed, which is the difference between a red build somebody fixes and a
    // red build somebody re-runs. Ten times the control, with a floor so that a
    // 3 ms control cannot set an unreachable bar, is a shape change rather than
    // jitter.
    expect(stressMs).toBeLessThanOrEqual(Math.max(controlMs * 10, 250));
  });
});
