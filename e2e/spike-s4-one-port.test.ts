/**
 * KAR-00.3 — the halves of the spike that only a real browser can answer.
 *
 * Two of this story's acceptance criteria are claims about a browser, not about
 * a socket: AC3 says the `.vue` edit hot-reloads **in the browser** without the
 * SSE connection closing, and AC5 says the browser sends **no** `Last-Event-ID`
 * on a fresh `EventSource` after a page reload. A Node client cannot settle
 * either — it would only prove that *our* client omits the header. So these run
 * against the real Chromium already installed for the web slice
 * (docs/14-testing-strategy.md §13), driving the real harness at
 * spikes/s4-one-port/ on one port.
 *
 * Verifies: EPIC-00-S11 (SFC edit scenario), EPIC-00-S13 (scenarios 1 and 3)
 * · AC3, AC5.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  type Harness,
  observations,
  SPIKE_ROOT,
  sleep,
  startHarness,
  stopAll,
} from '../spikes/s4-one-port/src/harness.ts';

const SFC = join(SPIKE_ROOT, 'app/src/Live.vue');

/** What the page records about its own stream, read out of the browser. */
interface PageState {
  readonly pageId: string;
  readonly seqs: number[];
  readonly opens: number;
  readonly errors: number;
  readonly everNotOpen: boolean;
  readonly hydratedSince: number | null;
  readonly readyState: number;
}

/**
 * `globalThis` rather than `window`: the e2e slice compiles without the DOM
 * lib, and this function's body is serialised into the browser rather than run
 * here, so the two names are the same object at the only moment that matters.
 */
const state = (page: Page): Promise<PageState> =>
  page.evaluate(() => (globalThis as unknown as { __s4: PageState }).__s4);

async function waitForEvents(page: Page, count: number, timeoutMs = 30_000): Promise<PageState> {
  const deadline = Date.now() + timeoutMs;
  let last: PageState | undefined;
  while (Date.now() < deadline) {
    // Undefined for the first instants after a reload, before the page's own
    // module has run.
    last = (await state(page)) as PageState | undefined;
    if (last !== undefined && last.seqs.length >= count) return last;
    await sleep(100);
  }
  throw new Error(`the page recorded only ${last?.seqs.length ?? 0} events, wanted ${count}`);
}

/** Edit the real SFC and put it back exactly as it was. */
async function withEdit(edit: (text: string) => string, body: () => Promise<void>): Promise<void> {
  const original = readFileSync(SFC, 'utf8');
  try {
    writeFileSync(SFC, edit(original));
    await body();
  } finally {
    writeFileSync(SFC, original);
  }
}

let harness: Harness;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  harness = await startHarness({ S4_INTERVAL_MS: '250' });
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`${harness.origin}/`, { waitUntil: 'load' });
  await waitForEvents(page, 2);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await stopAll();
});

suite('EPIC-00-S11 — an SFC edit hot-reloads without dropping the stream (AC3)', () => {
  it('applies the update in the browser while the EventSource stays OPEN', async () => {
    const before = await state(page);
    expect(before.everNotOpen).toBe(false);
    await expect.poll(() => page.textContent('#marker')).toContain('one port');

    await withEdit(
      (text) => text.replace('one port, one process', 'one port, one process, still'),
      async () => {
        await expect
          .poll(() => page.textContent('#marker'), { timeout: 20_000 })
          .toContain('one port, one process, still');

        const after = await state(page);
        // A full page reload would mint a new page id and re-open the stream;
        // an HMR update touches neither.
        expect(after.pageId).toBe(before.pageId);
        expect(after.opens, 'the stream must not have reconnected').toBe(before.opens);
        expect(after.errors).toBe(0);
        expect(after.everNotOpen, 'readyState must never have left OPEN').toBe(false);
        expect(after.readyState).toBe(1);

        // And the event sequence has no gap and no duplicate around the edit.
        // Nothing burns a seq in this harness, so "no gap" is literal: every
        // event is its predecessor plus one, right across the reload boundary.
        const grown = await waitForEvents(page, after.seqs.length + 3);
        expect(new Set(grown.seqs).size).toBe(grown.seqs.length);
        for (let index = 1; index < grown.seqs.length; index += 1) {
          expect(grown.seqs[index]).toBe((grown.seqs[index - 1] ?? 0) + 1);
        }
      },
    );
  }, 120_000);
});

suite('EPIC-00-S13 — what the browser sends, and does not send (AC5)', () => {
  it('sends no Last-Event-ID on a fresh EventSource after a reload, and hydrates with ?since', async () => {
    const before = await waitForEvents(page, 4);
    const lastSeen = before.seqs.at(-1) ?? 0;
    expect(lastSeen).toBeGreaterThan(0);

    // Events keep being produced while the page is reloading; that window is
    // exactly what ?since= has to close.
    await page.reload({ waitUntil: 'load' });
    const after = await waitForEvents(page, 3);

    expect(after.pageId, 'this really is a fresh page').not.toBe(before.pageId);
    // The page's own cursor, not the snapshot above: a tick can land between
    // reading the state and the reload, and the page would rightly remember it.
    const cursor = after.hydratedSince ?? -1;
    expect(cursor).toBeGreaterThanOrEqual(lastSeen);

    const fresh = (await observations(harness.origin)).connections.at(-1);
    expect(
      fresh?.lastEventId,
      'a fresh EventSource must send no Last-Event-ID — if it does, the ?since contract can be revisited',
    ).toBeNull();
    expect(fresh?.since).toBe(String(cursor));
    expect(fresh?.mode).toBe('since');

    // Nothing lost across the reload, nothing delivered twice: the first event
    // of the new page is exactly the one after the cursor it hydrated from.
    expect(after.seqs[0] ?? 0).toBe(cursor + 1);
    expect(new Set(after.seqs).size).toBe(after.seqs.length);
  }, 120_000);

  it('does send Last-Event-ID when the browser reconnects on its own', async () => {
    const before = await waitForEvents(page, 2);
    const lastSeen = before.seqs.at(-1) ?? 0;

    // Severed by the network rather than by a reload: the server destroys the
    // socket, the browser reconnects by itself, and *that* request carries the
    // header the reload did not.
    await fetch(`${harness.origin}/api/drop`, { method: 'POST' });

    const deadline = Date.now() + 30_000;
    let reconnect: Awaited<ReturnType<typeof observations>>['connections'][number] | undefined;
    while (Date.now() < deadline) {
      const latest = (await observations(harness.origin)).connections.at(-1);
      if (latest?.lastEventId != null) {
        reconnect = latest;
        break;
      }
      await sleep(200);
    }

    expect(reconnect, 'the browser never reconnected within 30 s').toBeDefined();
    expect(Number(reconnect?.lastEventId)).toBeGreaterThanOrEqual(lastSeen);
    expect(reconnect?.mode).toBe('last-event-id');
    expect(reconnect?.resumedAfter).toBe(Number(reconnect?.lastEventId));

    // The page never lost an event across the reconnect, and never saw one twice.
    const after = await waitForEvents(page, before.seqs.length + 3);
    expect(after.pageId).toBe(before.pageId);
    expect(new Set(after.seqs).size).toBe(after.seqs.length);
    expect(after.opens).toBeGreaterThan(before.opens);
  }, 120_000);
});
