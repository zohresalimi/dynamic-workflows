/**
 * KAR-16.2's e2e half — the ledger client in a **real browser**, against a real
 * `deflow replay` daemon.
 *
 * Verifies: EPIC-16-S7 (all four scenarios), EPIC-16-S8 (scenarios 1 and 2)
 *
 * This is Playwright smoke #4 of the five [14 §13](../docs/14-testing-strategy.md)
 * budgets for — *"replay at speed, kill the connection, assert the UI reconnects
 * and backfills without a gap or a duplicate"* — and it is the reason those two
 * scenarios are declared `integration + e2e` rather than `integration`.
 *
 * **What a browser can say that `stream.test.ts` cannot.** The unit specs drive
 * `openLedgerStream` against a real socket, but they drive it in *Node*, where
 * `Last-Event-ID` is not a mechanism that exists: undici will never send one, so
 * "the client does not rely on it" is unfalsifiable there. It is only a claim
 * once a real browser is on the other end — a browser that owns `sessionStorage`
 * across a genuine reload, that has its own opinion about resuming a stream, and
 * whose outgoing headers can be watched from outside the page. All three are
 * what this file adds.
 *
 * **The module under test is the shipped one.** The harness is booted with
 * `dev: true`, so DeFlowd serves `packages/web` through Vite on its own origin
 * exactly as `pnpm dev:replay` does, and the page reaches `openLedgerStream` by
 * importing `/src/ledger/stream.ts` from that origin. Nothing here re-implements
 * the client: the fold is the real `PROJECTIONS`, the cursor is the real
 * `sessionStorage` one, and the token is the real fragment handoff.
 *
 * Every `page.evaluate` body is passed as **source text** rather than as a
 * closure. This slice compiles with Node's libs and no DOM, so a closure that
 * said `import('/src/ledger/stream.ts')` would not type-check against a module
 * graph that only exists inside the browser — the same convention
 * `./ui-bootstrap.test.ts` uses, and for the same reason.
 */
import { join } from 'node:path';
import { type Browser, chromium, type Page, type Request } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../packages/daemon/src/replay/harness.ts';
import { parseSpeed } from '../packages/daemon/src/replay/speed.ts';
import { repoRoot } from './support/daemon.ts';

/** The 400-node stress recording — the fixture EPIC-16-S8 names. */
const FIXTURE = join(repoRoot, 'test/fixtures/runs/stress-400/events.jsonl');

/** `../packages/web/src/api/token.ts`. */
const TOKEN_KEY = 'DeFlow.daemonToken';
/** `../packages/web/src/ledger/cursor.ts`. */
const CURSOR_KEY = 'DeFlow.cursor';
/** `../packages/web/src/ledger/stream.ts` — the interval both sides must agree on. */
const RECONNECT_INTERVAL_MS = 2000;

/**
 * The page-side driver: the **real** `openLedgerStream`, the **real** seven
 * projections and the **real** token reader, with a handle the spec can ask
 * questions of. It adds no behaviour — every field it reports is one the client
 * already exposes through `state()`.
 */
const DRIVER = `(async () => {
  const [stream, projections, token] = await Promise.all([
    import('/src/ledger/stream.ts'),
    import('/src/ledger/projections/index.ts'),
    import('/src/api/token.ts'),
  ]);

  const applied = [];
  let open = null;

  globalThis.__deflowE2e = {
    async watch(runId) {
      open = stream.openLedgerStream({
        projections: projections.PROJECTIONS,
        token: token.readToken,
        onApplied: (event) => applied.push(event.seq),
      });
      await open.watch(runId);
    },
    applied: () => applied.slice(),
    state: () => {
      const s = open.state();
      return {
        status: s.status,
        cursor: s.cursor,
        connects: s.connects,
        reconnectDelays: s.reconnectDelays.slice(),
      };
    },
    connections: () => open.connections(),
    close: () => { open?.close(); },
  };
})()`;

interface DriverState {
  readonly status: string;
  readonly cursor: number;
  readonly connects: number;
  readonly reconnectDelays: readonly number[];
}

/** One request the browser actually issued, as Playwright saw it leave. */
interface Sent {
  readonly url: string;
  readonly lastEventId: string | undefined;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

/** A page that records every request it makes, before any navigation. */
function watchedPage(): Promise<{ page: Page; sent: Sent[] }> {
  const sent: Sent[] = [];
  return browser.newPage().then((page) => {
    page.on('request', (request: Request) => {
      sent.push({ url: request.url(), lastEventId: request.headers()['last-event-id'] });
    });
    return { page, sent };
  });
}

/** Navigates to the handoff URL and installs the driver. */
async function boot(page: Page, harness: ReplayHarness): Promise<void> {
  await page.goto(`${harness.origin}/#token=${harness.token}`);
  await expect
    .poll(() => page.evaluate<string | null>(`sessionStorage.getItem('${TOKEN_KEY}')`), {
      timeout: 30_000,
    })
    .toBe(harness.token);
  await page.evaluate(DRIVER);
}

const applied = (page: Page): Promise<number[]> =>
  page.evaluate<number[]>('globalThis.__deflowE2e.applied()');

const driverState = (page: Page): Promise<DriverState> =>
  page.evaluate<DriverState>('globalThis.__deflowE2e.state()');

/** Every `/api/stream` request this page made, oldest first, whoever opened it.
 *
 * Matched on the **pathname**, not on a substring: the page is served by Vite
 * from the daemon's own origin, so `/src/api/stream.ts` is a real request this
 * page makes and `url.includes('/api/stream')` collects it — which reads as the
 * client having opened a stream with no `?since=` at all.
 */
const allStreams = (sent: readonly Sent[]): Sent[] =>
  sent.filter((one) => new URL(one.url).pathname === '/api/stream');

const runsOf = (url: string): string => new URL(url).searchParams.get('runs') ?? '';

/**
 * The connections **this spec's driver** opened.
 *
 * Since KAR-19.1 the pathname alone no longer names one connection. The page
 * this file boots lands on the root route, and `useRunList` opens a connection
 * of its own there — `?runs=*`, the global lifecycle topic — before the driver
 * has run at all. It is a real part of the shipped app, and it resumes from
 * *its* cursor: the handful of lifecycle seqs it applied, not the several
 * hundred run events the driver folded. So `streams(sent)[0]` used to be the
 * driver's first connection and quietly became the run list's, and two
 * assertions about where the driver reopened started reading a number that was
 * never about the driver — `since=401` for a driver that reopened at 934,
 * `since=1` for one that reconnected at 50.
 *
 * Selected by `runs` rather than by position, because position is what broke.
 * Nothing is suppressed by narrowing it: the cardinality assertions below still
 * go red if this filter ever selects nothing, and the `Last-Event-ID`
 * assertions deliberately stay on `allStreams` so the run list's connection is
 * held to the same rule as the driver's.
 */
const streams = (sent: readonly Sent[]): Sent[] =>
  allStreams(sent).filter((one) => runsOf(one.url) !== '*');

const sinceOf = (url: string): number => Number(new URL(url).searchParams.get('since') ?? '-1');

suite('EPIC-16-S7 — the page reloads and Last-Event-ID is not sent', () => {
  let harness: ReplayHarness;
  let runId: string;

  beforeAll(async () => {
    // Paused, and driven forward by `seek`. A reload has to happen at a *known*
    // position with a *known* set of events appended while the tab was away, and
    // a wall-clock speed cannot give either — it would make "the applied set is
    // identical" a statement about how long Chromium took to reload.
    harness = await startReplay({
      fixture: FIXTURE,
      speed: parseSpeed('max'),
      port: 0,
      dev: true,
      startPaused: true,
      keepaliveMs: 500,
    });
    runId = harness.runIds[0] as string;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('reopens at its own persisted cursor, and sends no Last-Event-ID', async () => {
    // Scenario 1 verbatim: the tab has applied up to a seq and persisted it,
    // the operator reloads, and the stream reopens at *that* number.
    const { page, sent } = await watchedPage();
    try {
      const head = harness.seqs[300] as number;
      await harness.seek(head);
      await boot(page, harness);
      await page.evaluate(`globalThis.__deflowE2e.watch(${JSON.stringify(runId)})`);

      const firstPass = await applied(page);
      expect(firstPass.length).toBeGreaterThan(100);
      expect((await driverState(page)).cursor).toBe(head);
      // The cursor is the tab's own, in the tab's own storage — not the
      // browser's idea of where a stream got to.
      expect(await page.evaluate<string | null>(`sessionStorage.getItem('${CURSOR_KEY}')`)).toBe(
        String(head),
      );

      // When: the page is reloaded, with the run where it was.
      sent.length = 0;
      await page.reload();
      await page.evaluate(DRIVER);
      await page.evaluate(`globalThis.__deflowE2e.watch(${JSON.stringify(runId)})`);

      // Then: no Last-Event-ID, on any request the browser sent — including the
      // ones nobody wrote. It is sent only on the browser's own automatic
      // reconnect of a previously-opened connection, and a reload has none.
      for (const request of sent) {
        expect(request.lastEventId, `${request.url} carried a Last-Event-ID`).toBeUndefined();
      }

      // And the stream was opened from the persisted cursor rather than from 0
      // or from the head the server would have picked for it.
      const opened = streams(sent);
      expect(opened.length).toBeGreaterThan(0);
      expect(sinceOf((opened[0] as Sent).url)).toBe(head);

      // And it holds the same run it held before: a reload re-folds the log
      // rather than resuming a projection set it no longer has.
      expect(await applied(page)).toEqual(firstPass);
    } finally {
      await page.close();
    }
  }, 180_000);

  it('misses nothing that was appended while it was down', async () => {
    // Scenario 2 — the developer case. The tab is gone across an append, and
    // the applied set afterwards is that of a tab that never reloaded.
    const { page, sent } = await watchedPage();
    try {
      await harness.seek(harness.seqs[300] as number);
      await boot(page, harness);
      await page.evaluate(`globalThis.__deflowE2e.watch(${JSON.stringify(runId)})`);
      const before = (await driverState(page)).cursor;

      await page.evaluate('globalThis.__deflowE2e.close()');
      const afterOutage = harness.seqs[700] as number;
      await harness.seek(afterOutage);
      expect(afterOutage).toBeGreaterThan(before);

      sent.length = 0;
      await page.reload();
      await page.evaluate(DRIVER);
      await page.evaluate(`globalThis.__deflowE2e.watch(${JSON.stringify(runId)})`);

      // Every recorded event up to the new head, in order, none twice, and
      // nothing from the outage missing.
      const seqs = await applied(page);
      expect(seqs).toEqual(harness.seqs.filter((seq) => seq <= afterOutage));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect((await driverState(page)).cursor).toBe(afterOutage);

      // Still no Last-Event-ID: the resume was the client's own `?since=`, and
      // the stream opened at the cursor the hydrate ended on.
      for (const request of sent) {
        expect(request.lastEventId).toBeUndefined();
      }
      expect(sinceOf((streams(sent)[0] as Sent).url)).toBe(afterOutage);
    } finally {
      await page.close();
    }
  }, 180_000);

  it('loses the outage when ?since= is stripped, with no Last-Event-ID to save it', async () => {
    // EPIC-16-S7 scenario 4, automated as the failure it describes rather than
    // as prose. This is what the assertion above is worth: the *same* reload,
    // through a connection whose `?since=` a build never sent, and the events of
    // the outage are gone — with no `Last-Event-ID` fallback, because the
    // connection this tab opens has never opened before.
    const { page, sent } = await watchedPage();
    try {
      await page.route('**/api/stream*', async (route) => {
        const url = new URL(route.request().url());
        url.searchParams.delete('since');
        await route.continue({ url: url.toString() });
      });
      // The hydrate is the other half of the explicit path; a build that relies
      // on `Last-Event-ID` has neither. Refusing it here is what makes the
      // stream the only way the outage could arrive.
      await page.route('**/api/runs/*/events*', (route) => route.abort());

      const start = harness.seqs[300] as number;
      await harness.seek(start);
      await boot(page, harness);
      await page.evaluate(`globalThis.__deflowE2e.watch(${JSON.stringify(runId)}).catch(() => {})`);

      const outage = harness.seqs.slice(300, 700);
      await harness.seek(harness.seqs[700] as number);

      // Give the stripped connection every chance to deliver them.
      await expect
        .poll(() => applied(page).then((seqs) => seqs.length), {
          timeout: 10_000,
          interval: 250,
        })
        .toBeGreaterThanOrEqual(0);
      await page.waitForTimeout(3_000);

      const got = new Set(await applied(page));
      const recovered = outage.filter((seq) => got.has(seq));
      expect(
        recovered,
        'a build that omits ?since= must lose the outage — if these arrived, the assertion ' +
          'above is not testing what it claims to test',
      ).toEqual([]);

      // And nothing tried to make up for it.
      for (const request of sent) {
        expect(request.lastEventId).toBeUndefined();
      }
    } finally {
      await page.close();
    }
  }, 180_000);
});

suite('EPIC-16-S8 — the connection drops mid-run and comes back with no seam', () => {
  let harness: ReplayHarness;
  let runId: string;

  beforeAll(async () => {
    harness = await startReplay({
      fixture: FIXTURE,
      speed: parseSpeed('50x'),
      port: 0,
      dev: true,
      keepaliveMs: 500,
    });
    runId = harness.runIds[0] as string;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('reconnects across a severed connection with no gap and no duplicate', async () => {
    const { page, sent } = await watchedPage();
    try {
      await boot(page, harness);
      await page.evaluate(`globalThis.__deflowE2e.watch(${JSON.stringify(runId)})`);

      // Given: the recording is streaming, and the client has applied a prefix.
      await expect
        .poll(() => applied(page).then((seqs) => seqs.length), {
          timeout: 60_000,
          interval: 200,
        })
        .toBeGreaterThan(20);
      const before = await driverState(page);

      // When: the connection is severed mid-burst — every socket destroyed, no
      // final frame, no clean end. Playback keeps running at 50x while the tab
      // is down, so there is a real burst on the other side of the seam rather
      // than a quiet gap.
      harness.sever();
      await expect
        .poll(() => driverState(page).then((s) => s.status), {
          timeout: 30_000,
          interval: 200,
        })
        .toBe('reconnecting');

      // Then: it comes back on its own reconnection policy.
      await expect
        .poll(() => driverState(page).then((s) => s.connects), {
          timeout: 60_000,
          interval: 200,
        })
        .toBeGreaterThan(before.connects);

      // And it catches up past where it was.
      await expect
        .poll(() => driverState(page).then((s) => s.cursor), {
          timeout: 60_000,
          interval: 200,
        })
        .toBeGreaterThan(before.cursor);

      const seqs = await applied(page);

      // The applied sequence across the seam is strictly increasing …
      for (let index = 1; index < seqs.length; index += 1) {
        expect(
          seqs[index] as number,
          `seq ${String(seqs[index])} followed ${String(seqs[index - 1])} across the seam`,
        ).toBeGreaterThan(seqs[index - 1] as number);
      }
      // … nothing was applied twice …
      expect(new Set(seqs).size).toBe(seqs.length);
      // … and nothing recorded below the head it reached is missing.
      const head = seqs.at(-1) as number;
      expect(seqs).toEqual(harness.seqs.filter((seq) => seq <= head));

      // And the reconnect asked for the tab's own cursor at the time, not the
      // one it first opened with.
      const opened = streams(sent);
      expect(opened.length).toBeGreaterThan(1);
      expect(sinceOf((opened.at(-1) as Sent).url)).toBeGreaterThanOrEqual(before.cursor);

      // And where the browser *did* supply a `Last-Event-ID` — this is the
      // library's own automatic reconnect, so it does — the two agree, which is
      // what makes the server's `since` > `Last-Event-ID` precedence a
      // no-op rather than a silent rewind. Over every connection the tab held,
      // the run list's included: each resumes from its own cursor, and the rule
      // is that the header never disagrees with the query string it rode in on.
      for (const request of allStreams(sent)) {
        if (request.lastEventId === undefined) continue;
        expect(
          Number(request.lastEventId),
          `Last-Event-ID ${request.lastEventId} disagreed with ${request.url}`,
        ).toBe(sinceOf(request.url));
      }

      // And it was still one connection's worth of sockets, not one per attempt.
      expect(await page.evaluate<number>('globalThis.__deflowE2e.connections()')).toBe(1);
    } finally {
      await page.close();
    }
  }, 180_000);

  it('schedules its reconnect at the interval the server wrote as retry: 2000', async () => {
    // Scenario 2, asserted against the interval the library actually scheduled
    // rather than against the constant: `eventsource-client` starts at its own
    // default and *replaces* it with whatever the `retry:` line says, so a
    // client that disagreed would silently adopt the server's and the
    // disagreement would never surface.
    const { page } = await watchedPage();
    const controller = new AbortController();
    try {
      // The server wrote it once, immediately after the headers. Aborted rather
      // than cancelled through the reader: cancelling leaves the daemon writing
      // into a half-closed response and it logs a headers-already-sent error
      // that has nothing to do with this assertion.
      const response = await fetch(`${harness.origin}/api/stream?runs=*&since=0`, {
        headers: { authorization: `Bearer ${harness.token}` },
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let head = '';
      while (reader !== undefined && !head.includes('retry:')) {
        const { value, done } = await reader.read();
        if (done) break;
        head += decoder.decode(value, { stream: true });
      }
      expect(head).toContain(`retry: ${String(RECONNECT_INTERVAL_MS)}`);
      controller.abort();

      // And the client scheduled at it.
      await boot(page, harness);
      await page.evaluate(`globalThis.__deflowE2e.watch(${JSON.stringify(runId)})`);
      harness.sever();
      await expect
        .poll(() => driverState(page).then((s) => s.reconnectDelays.length), {
          timeout: 30_000,
          interval: 200,
        })
        .toBeGreaterThan(0);

      const delays = (await driverState(page)).reconnectDelays;
      for (const delay of delays) {
        expect(delay, `the client scheduled ${String(delay)} ms against retry: 2000`).toBe(
          RECONNECT_INTERVAL_MS,
        );
      }
    } finally {
      controller.abort();
      await page.close();
    }
  }, 180_000);
});
