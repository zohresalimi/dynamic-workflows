/**
 * KAR-17.1 AC1 — **Playwright smoke #1**: a completed run, opened in a real
 * browser against a real `DeFlow replay` daemon, with every node at its correct
 * state and every edge with its direction.
 *
 * Verifies: EPIC-17-S1 (scenario 1), EPIC-16-S1 (both rendering clauses) ·
 * AC1, AC2, AC4, AC7, AC10
 *
 * One of the five smokes [14 §13](../docs/14-testing-strategy.md) budgets for,
 * and the only test in this repository that exercises the **whole** path:
 * daemon → SSE → `openLedgerStream` → `../packages/web/src/ledger/feed.ts` →
 * `useRunStore` → `plan.ts` → `GraphCanvas` → a node body. Nothing here is
 * injected and nothing is stubbed. That matters more than usual, because the
 * failure it exists to catch is exactly the state EPIC-16 shipped in: every
 * piece built, every spec green, and **no wire between any two of them** — an
 * application that opened against a real replay and drew an empty graph
 * however deep the ledger was. A browser spec cannot see that. This can.
 *
 * The recording is `happy-path-12`: twelve nodes which between them occupy all
 * seven display states — pending, running, blocked, passed, failed, abandoned
 * and awaiting-human — so *"every node with its correct state colour"* is a
 * claim about all seven and not about the two a smaller fixture would have.
 *
 * Served through Vite in middleware mode (`dev: true`), the way
 * `pnpm dev:replay` does and the way `./replay-stream.test.ts` does — the
 * module under test is the shipped source, reached from the daemon's own
 * origin. `./ui-bootstrap.test.ts` covers the built-bundle path.
 *
 * Every `page.evaluate` body is passed as **source text** rather than as a
 * closure: this slice compiles with Node's libs and no DOM, so a closure
 * mentioning `document` would not type-check against a module graph that only
 * exists inside the browser. Same convention as the two specs beside it.
 */
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../packages/daemon/src/replay/harness.ts';
import { parseSpeed } from '../packages/daemon/src/replay/speed.ts';
import { repoRoot } from './support/daemon.ts';

const FIXTURE = join(repoRoot, 'test/fixtures/runs/happy-path-12/events.jsonl');

/** `packages/web/src/lib/state-palette.ts` — the seven, in its own order. */
const DISPLAY_STATES = [
  'pending',
  'running',
  'blocked',
  'passed',
  'failed',
  'abandoned',
  'awaiting-human',
] as const;

/** What the fixture's own projection snapshot records, node by node. */
const EXPECTED: Readonly<Record<string, string>> = {
  'recon-auth-surface': 'passed',
  'plan-migration': 'passed',
  'impl-login': 'failed',
  'impl-signup': 'running',
  'impl-logout': 'passed',
  'impl-profile': 'blocked',
  'impl-legacy-shim': 'abandoned',
  'gate-typecheck': 'passed',
  'gate-contract': 'passed',
  'review-security': 'running',
  'approve-release': 'awaiting-human',
  'smoke-tests': 'pending',
};

interface DrawnNode {
  readonly id: string;
  readonly state: string;
  /** The computed border colour — the graph's own colour, as painted. */
  readonly border: string;
  /** The palette's value for that state, resolved in the same document. */
  readonly palette: string;
  readonly label: string;
  readonly glyphs: number;
  readonly text: string;
  readonly ariaLabel: string;
}

/**
 * Every node the page actually drew, read out of the live DOM.
 *
 * Deliberately a single evaluation returning plain data rather than a series of
 * queries: what is being asserted is a *whole picture at one instant*, and a
 * dozen round trips would sample a graph that is still streaming.
 */
const DRAWN = `Array.from(document.querySelectorAll('[data-plan-node]')).map((body) => {
  const shell = body.closest('.vue-flow__node');
  const state = body.dataset.state;
  return {
    id: body.dataset.planNode,
    state,
    border: getComputedStyle(body).borderColor,
    palette: getComputedStyle(document.documentElement)
      .getPropertyValue('--state-' + state).trim(),
    label: body.querySelector('[data-slot="label"]')?.textContent?.trim() ?? '',
    glyphs: body.querySelectorAll('svg').length,
    text: body.textContent.replace(/\\s+/g, ' ').trim(),
    ariaLabel: shell?.getAttribute('aria-label') ?? '',
  };
})`;

let browser: Browser;
let harness: ReplayHarness;
let runId: string;
let page: Page;
let drawn: DrawnNode[];

/** Opens the run's own route with the token in the fragment, as `DeFlow up` prints it. */
async function openTheRun(): Promise<Page> {
  const opened = await browser.newPage();
  await opened.goto(`${harness.origin}/runs/${runId}#token=${harness.token}`);
  return opened;
}

/**
 * Waits until the page has drawn all twelve node bodies.
 *
 * A hand-rolled poll rather than `expect.poll`, which refuses to run outside a
 * test — and this wait belongs in `beforeAll`, because the whole suite asserts
 * on one instant of one drawing and re-fetching it per test would sample a
 * graph that had moved on. It is also the assertion that the wire exists at
 * all: the nodes can only come from the stream.
 */
async function drewTheWholePlan(on: Page, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await on.evaluate<number>('document.querySelectorAll("[data-plan-node]").length');
    if (count === 12) return count;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `the plan graph drew ${count} of 12 nodes in ${timeoutMs} ms — the ledger reached the ` +
      'page, or it did not: check that openLedgerStream is still wired to useRunStore ' +
      '(packages/web/src/ledger/feed.ts)',
  );
}

beforeAll(async () => {
  browser = await chromium.launch();
  harness = await startReplay({
    fixture: FIXTURE,
    // The whole recording, as fast as it will go: AC1 is about a **completed**
    // run, so the interesting instant is after the last event and not during.
    speed: parseSpeed('max'),
    port: 0,
    dev: true,
  });
  runId = harness.runIds[0] as string;
  await harness.played();

  page = await openTheRun();
  await drewTheWholePlan(page);
  drawn = await page.evaluate<DrawnNode[]>(DRAWN);
}, 240_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await harness?.close();
});

suite('EPIC-17-S1 — opening a completed run draws all of it', () => {
  it('renders every node the ledger holds, and no others', () => {
    expect(drawn.map((node) => node.id).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  it('puts every node at the state the ledger folded it to', () => {
    const states = Object.fromEntries(drawn.map((node) => [node.id, node.state]));
    expect(states).toEqual(EXPECTED);
    // All seven, in one drawing: a fixture that exercised three would make the
    // assertion above true and this smoke much less interesting.
    expect(new Set(Object.values(states)).size).toBe(DISPLAY_STATES.length);
  });

  it('paints each one in its own state colour, through the palette', () => {
    for (const node of drawn) {
      expect(node.palette, `--state-${node.state} resolved to nothing`).not.toBe('');
      // The colour on screen *is* the custom property's value — not a literal
      // that happens to look like it, which is what a component computing its
      // own colour would produce and what dark mode would then not change.
      expect(node.border, `${node.id} is not painted with --state-${node.state}`).toBe(
        node.palette,
      );
    }
    // Seven states, seven colours: a graph that resolved every state to the
    // same variable would satisfy every assertion above.
    expect(new Set(drawn.map((node) => node.border)).size).toBe(DISPLAY_STATES.length);
  });

  it('says the state in words and in a glyph as well as in colour', () => {
    for (const node of drawn) {
      // WCAG 1.4.1 at the end of the whole pipeline rather than in a component
      // spec: colour + glyph + text, on a real run, in a real browser.
      expect(node.label.toLowerCase().replace(' ', '-')).toBe(node.state);
      // Two at least: the node's type glyph and the state chip's.
      expect(node.glyphs).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives every node the accessible name a reader navigates by', () => {
    const signup = drawn.find((node) => node.id === 'impl-signup');
    expect(signup?.ariaLabel).toBe('agent Migrate the signup view, running, claude-code');
    for (const node of drawn) expect(node.ariaLabel).not.toContain('null');
  });

  it('shows what ran each node, at what permission, for how long and at what cost', () => {
    const recon = drawn.find((node) => node.id === 'recon-auth-surface');
    expect(recon?.text).toContain('Survey the auth surface');
    expect(recon?.text).toContain('claude-code');
    expect(recon?.text).toContain('read');
    // Three seconds and six cents, off this run's own events.
    expect(recon?.text).toContain('3.0 s');
    expect(recon?.text).toContain('$0.06');
  });

  it('draws every edge with a direction', async () => {
    const edges = await page.evaluate<{ count: number; directed: number }>(
      `(() => {
        const paths = Array.from(document.querySelectorAll('.vue-flow__edge-path'));
        return {
          count: paths.length,
          directed: paths.filter((path) => (path.getAttribute('marker-end') ?? '') !== '').length,
        };
      })()`,
    );

    expect(edges.count).toBeGreaterThan(10);
    // A DAG drawn without arrow heads is a picture of a graph with no
    // dependencies in it, which is the one thing this drawing is for.
    expect(edges.directed).toBe(edges.count);
  });
});

suite('EPIC-17-S1 — and it is navigable once it is drawn', () => {
  it('selects with j, opens the inspector with Enter, and says so in the URL', async () => {
    const opened = await openTheRun();
    try {
      expect(await drewTheWholePlan(opened)).toBe(12);

      await opened.keyboard.press('j');
      await expect
        .poll(() =>
          opened.evaluate<string>('new URL(location.href).searchParams.get("node") ?? ""'),
        )
        .toBe('recon-auth-surface');

      await opened.keyboard.press('Enter');
      await expect
        .poll(() =>
          opened.evaluate<boolean>('!!document.querySelector("[data-overlay=inspector]")'),
        )
        .toBe(true);
    } finally {
      await opened.close();
    }
  }, 120_000);

  it('offers the same graph as a table, for pasting into a PR description', async () => {
    const rows = await page.evaluate<readonly string[]>(
      `(async () => {
        document.querySelector('[data-graph-table-toggle]').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return Array.from(document.querySelectorAll('[data-graph-table] tbody tr')).map((row) =>
          row.textContent.replace(/\\s+/g, ' ').trim(),
        );
      })()`,
    );

    expect(rows).toHaveLength(12);
    // Node, type, state, provider, permission, duration and cost — AC10, on the
    // real run rather than on a fixture built to suit the table.
    expect(rows[0]).toContain('Survey the auth surface');
    expect(rows[0]).toContain('agent');
    expect(rows[0]).toContain('passed');
    expect(rows[0]).toContain('claude-code');
    expect(rows[0]).toContain('read');
    expect(rows[0]).toContain('$0.06');
  });
});
