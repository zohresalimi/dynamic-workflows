/**
 * KAR-17.3 AC3 — **Playwright smoke #3**: open the node inspector, and assert
 * that the context packet's segment token breakdown sums to the header total.
 *
 * Verifies: EPIC-17-S12 (scenario 2) · AC1, AC2, AC3, AC6, AC7, AC9
 *
 * One of the five smokes [14 §13](../docs/14-testing-strategy.md) budgets for,
 * quoted there in exactly those words. It is a smoke rather than a unit test
 * **because of what a unit test cannot say**: the sum is asserted three times
 * over in this repository — in `packages/web/src/lib/node-inspector.test.ts`
 * against the projection, in `packages/web/src/components/node-inspector.test.ts`
 * against the rendered DOM, and here. Only this one proves the *endpoint*, the
 * projection and the render agree, which is where a divergence would actually
 * hide: three layers each self-consistent and disagreeing with each other is
 * indistinguishable from correctness at any single layer.
 *
 * The recording is `repair-attempts` — the only one with more than one context
 * packet for the same node, so the attempt selector has something to select and
 * the sum is asserted for **every** attempt rather than for the one that
 * happened to be on screen.
 *
 * Served through Vite in middleware mode (`dev: true`), the way `pnpm
 * dev:replay` does, so the modules exercised are the shipped source reached
 * from the daemon's own origin. Every `page.evaluate` body is passed as
 * **source text** rather than as a closure, for the reason
 * `./plan-graph.test.ts` states: this slice compiles with Node's libs and no
 * DOM, so a closure mentioning `document` would not type-check.
 */
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../packages/daemon/src/replay/harness.ts';
import { parseSpeed } from '../packages/daemon/src/replay/speed.ts';
import { repoRoot } from './support/daemon.ts';

const FIXTURE = join(repoRoot, 'test/fixtures/runs/repair-attempts/events.jsonl');

/** The node with three attempts and a packet for each. */
const NODE = 'impl-oauth';

/** What the packet builder wrote, attempt by attempt. Read off the fixture. */
const DECLARED: Readonly<Record<number, { total: number; segments: number }>> = {
  0: { total: 262, segments: 9 },
  1: { total: 290, segments: 11 },
  2: { total: 290, segments: 11 },
};

interface PacketReadout {
  /** `data-packet-total` — the header, as the endpoint delivered it. */
  readonly headerTotal: number;
  /** Every `data-segment-tokens` on the page, as rendered. */
  readonly segmentTokens: readonly number[];
  readonly groups: readonly string[];
  readonly status: string;
}

/**
 * The packet section, read out of the live DOM in one evaluation.
 *
 * One round trip rather than several: what is asserted is a *whole packet at
 * one instant*, and sampling it in pieces would let a re-render between two
 * queries produce a header from one attempt and segments from another — which
 * is precisely the divergence this smoke exists to detect, arriving as a false
 * positive instead of a real one.
 */
const READ_PACKET = `(() => {
  const section = document.querySelector('[data-packet]');
  const totalEl = document.querySelector('[data-packet-total]');
  return {
    headerTotal: Number(totalEl?.getAttribute('data-packet-total') ?? -1),
    segmentTokens: Array.from(document.querySelectorAll('[data-segment-tokens]'))
      .map((cell) => Number(cell.getAttribute('data-segment-tokens'))),
    groups: Array.from(document.querySelectorAll('[data-segment-group]'))
      .map((group) => group.getAttribute('data-segment-group')),
    status: section?.getAttribute('data-status') ?? 'absent',
  };
})()`;

let browser: Browser;
let harness: ReplayHarness;
let runId: string;
let page: Page;

async function waitFor(on: Page, expression: string, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await on.evaluate<boolean>(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`);
}

/** Opens the inspector on `NODE` by clicking its body and pressing Enter. */
async function openInspector(on: Page): Promise<void> {
  // Three: `impl-oauth`, `probe-oauth-tokens` and the `gate-contract` that
  // never ran. This is also the assertion that the wire exists at all — the
  // nodes can only have come from the stream.
  await waitFor(
    on,
    `document.querySelectorAll('[data-plan-node]').length === 3`,
    'the plan graph drew all three nodes — the ledger reached the page, or it did not',
  );
  await on.click(`[data-plan-node="${NODE}"]`);
  await on.keyboard.press('Enter');
  await waitFor(
    on,
    `document.querySelector('[data-overlay="inspector"]') !== null`,
    'the inspector opened',
  );
}

/** Switches the panel to `attempt` and waits for the packet to follow. */
async function showAttempt(on: Page, attempt: number): Promise<PacketReadout> {
  await on.click(`[data-attempt-tab="${attempt}"]`);
  const expected = DECLARED[attempt]?.segments ?? 0;
  await waitFor(
    on,
    `document.querySelectorAll('[data-segment-tokens]').length === ${expected}`,
    `attempt ${attempt}'s packet rendered`,
  );
  return on.evaluate<PacketReadout>(READ_PACKET);
}

beforeAll(async () => {
  browser = await chromium.launch();
  harness = await startReplay({
    fixture: FIXTURE,
    // The whole recording as fast as it will go: the interesting instant is
    // after the last event, when all three attempts exist to be compared.
    speed: parseSpeed('max'),
    port: 0,
    dev: true,
  });
  runId = harness.runIds[0] as string;
  await harness.played();

  page = await browser.newPage();
  await page.goto(`${harness.origin}/runs/${runId}#token=${harness.token}`);
  await openInspector(page);
}, 240_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await harness?.close();
});

suite('KAR-17.3 AC3 — Playwright smoke #3: the breakdown sums to the header', () => {
  it('sums the rendered per-segment counts to the rendered header total', async () => {
    for (const attempt of [0, 1, 2]) {
      const packet = await showAttempt(page, attempt);
      const summed = packet.segmentTokens.reduce((total, count) => total + count, 0);

      expect(packet.status, `attempt ${attempt}`).toBe('built');
      expect(summed, `attempt ${attempt}`).toBe(packet.headerTotal);
    }
  });

  it('agrees with what the packet builder itself declared', async () => {
    // The assertion above would also pass if every number on the page were the
    // same wrong number. This one pins them to the fixture the daemon served.
    for (const attempt of [0, 1, 2]) {
      const packet = await showAttempt(page, attempt);

      expect(packet.headerTotal, `attempt ${attempt}`).toBe(DECLARED[attempt]?.total);
      expect(packet.segmentTokens, `attempt ${attempt}`).toHaveLength(
        DECLARED[attempt]?.segments as number,
      );
    }
  });

  it('renders all nine segment kinds, pinned first, whatever the packet holds', async () => {
    const packet = await showAttempt(page, 0);

    expect(packet.groups).toEqual([
      'pinned.constraints',
      'pinned.spec',
      'pinned.pathscope',
      'task.brief',
      'fact',
      'artifact.handle',
      'retrieved',
      'history.summary',
      'tool.output',
    ]);
  });

  it('carries the whole path — endpoint, projection and render — for every attempt', async () => {
    // The point of doing this end to end rather than in a browser spec. The
    // segment counts arrived over SSE from a real daemon, were folded by
    // `context.ts`, grouped by `node-inspector.ts` and rendered by
    // `NodeInspector.vue`; three self-consistent layers that disagreed with
    // each other would pass every other test in this repository.
    const first = await showAttempt(page, 0);
    const second = await showAttempt(page, 1);

    expect(first.headerTotal).not.toBe(second.headerTotal);
    expect(second.segmentTokens.length).toBeGreaterThan(first.segmentTokens.length);
  });
});

suite('KAR-17.3 — the attempt selector and the honest absence, end to end', () => {
  it('shows every attempt of the retried node', async () => {
    const tabs = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('[data-attempt-tab]'))
         .map((tab) => tab.getAttribute('data-attempt-tab'))`,
    );

    expect(tabs).toEqual(['0', '1', '2']);
  });

  it('states the absence for the node that died before a packet existed (AC9)', async () => {
    // `probe-oauth-tokens` failed at `adapter.spawn-failed`. Asserted here as
    // well as in the browser spec because "the endpoint served no packet" and
    // "the component rendered no packet" are different failures that look the
    // same from inside the tab.
    await page.keyboard.press('Escape');
    await page.click('[data-plan-node="probe-oauth-tokens"]');
    await page.keyboard.press('Enter');
    await waitFor(
      page,
      `document.querySelector('[data-packet]')?.getAttribute('data-status') === 'none'`,
      'the inspector reported no packet',
    );

    const absence = await page.evaluate<string>(
      `document.querySelector('[data-packet-absence] [data-failure-reason]')?.textContent ?? ''`,
    );
    expect(absence).toBe('adapter.spawn-failed');
  });
});
