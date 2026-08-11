/**
 * KAR-17.6 test plan row 9 / EPIC-17-S24 — **Playwright smoke**: follow a
 * failing verdict from where it is announced to the line of code it is about,
 * and back.
 *
 * Verifies: EPIC-17-S24 (scenario 1, and the round trip of scenario 3) ·
 * AC1, AC2, AC10
 *
 * The row's red is one sentence and it is the whole reason this file exists:
 *
 * > **Red when: the link carries a file but not a line.**
 *
 * A deep link that names a file lands the operator at the top of a diff and
 * leaves them to find the verdict themselves, which is the two-windows workflow
 * this surface was built to delete — and it is a failure no component spec can
 * see, because the link is written by the plan graph, resolved by the router,
 * answered by the daemon and acted on by the diff panel. Four seams, four
 * files, one journey. `../packages/web/src/views/diff-review.test.ts` mounts the
 * surface with a patch handed to it; nothing in this repository, before this
 * spec, ever asked whether an operator could *get there*.
 *
 * Nothing here is stubbed:
 *
 *   1. a **real repository** — the same one `packages/web/scripts/build-diff-fixture.ts`
 *      writes `test/fixtures/diffs/review.patch` out of, materialised into an
 *      `fs.mkdtemp` directory and left dirty, as an agent would have left it;
 *   2. a **real `DeFlowd`** over the `gate-failure-repair` recording, which
 *      shells out to a **real `git diff`** in that repository and serves the
 *      unified patch over `GET /api/runs/:id/diff?node=`;
 *   3. a **real Chromium**, running the shipped source through Vite exactly as
 *      `pnpm dev:replay` does.
 *
 * ## Rehoming the recording
 *
 * A recording carries the absolute path the run worked in — `run.created.cwd`,
 * which is what `RunState.repoRoot` is folded from — and that path belonged to
 * the machine that recorded it. The one field is rewritten to point at the
 * repository this spec built, and nothing else is touched: the events, their
 * `seq`s, the verdict and its finding are the recorded ones. Without it the
 * daemon would answer the diff request honestly and correctly with a refusal,
 * and the journey would end at an error message.
 *
 * ## What this spec deliberately does not claim
 *
 * EPIC-17-S24's third scenario ends on the **acceptance-criteria board** with
 * the criterion expanded, and that board is KAR-17.7 — it does not exist yet.
 * What is asserted here is the half that does: the round trip back to the graph
 * with the node still selected. The criterion's own deep link is asserted at
 * browser level in `../packages/web/src/views/diff-review.test.ts` (*"renders a
 * criterion as a link into the acceptance board"*), and the board end of it
 * belongs to KAR-17.7's own e2e rather than to a stub here. The same is true of
 * scenario 2's virtualised artifact viewer, which is KAR-17.5's.
 *
 * `page.evaluate` bodies are **source text** rather than closures, for the same
 * reason as `./plan-graph.test.ts`: this slice compiles with Node's libs and no
 * DOM, so a closure mentioning `document` would not type-check.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../packages/daemon/src/replay/harness.ts';
import { parseSpeed } from '../packages/daemon/src/replay/speed.ts';
import { materialiseReviewRepo } from '../packages/web/scripts/build-diff-fixture.ts';
import { repoRoot } from './support/daemon.ts';

const FIXTURE = join(repoRoot, 'test/fixtures/runs/gate-failure-repair/events.jsonl');

/** The node whose work the `typecheck` gate refused, from the recording. */
const FAILED_NODE = 'impl-1';

/** The finding that refusal carried, and the line it names. */
const FINDING = '65207341fbd9';
const FILE = 'src/date-picker.ts';
const LINE = 2;

/**
 * Deliberately short of a laptop's window.
 *
 * The scroll clause — *"the view is scrolled to line 42"* — is only a claim
 * about anything if the line is below the fold before the view acts on it. At
 * this height the repair-loop transition and the panel header sit between the
 * top of the page and the line the finding names, so a surface that ignored
 * `?line=` would leave the verdict off screen.
 */
const WINDOW = { width: 1000, height: 520 } as const;

/**
 * The recording, pointed at a repository that exists on this machine.
 *
 * One field, in one event. A rewrite of anything else would make this a
 * different run from the one the fixture recorded.
 */
async function rehome(fixture: string, repo: string, into: string): Promise<string> {
  const source = await readFile(fixture, 'utf8');
  const lines = source.split('\n').filter((line) => line.trim() !== '');
  const rehomed = lines.map((line) => {
    const event = JSON.parse(line) as { kind: string; payload: Record<string, unknown> };
    if (event.kind !== 'run.created') return line;
    return JSON.stringify({ ...event, payload: { ...event.payload, cwd: repo } });
  });
  const path = join(into, 'events.jsonl');
  await writeFile(path, `${rehomed.join('\n')}\n`, 'utf8');
  return path;
}

/** What the finding widget looks like, and whether an operator can see it. */
interface WidgetReport {
  /** `@git-diff-view`'s per-line widget slot renders as an `extend` row. */
  readonly rowState: string;
  /** Whether the row above it is the line the finding names. */
  readonly extendsTheLine: boolean;
  readonly severity: string;
  readonly message: string;
  readonly evidence: string;
  readonly seq: string;
  /** In the window, without the operator scrolling for it. */
  readonly onScreen: boolean;
  /** For the failure message: where it was, and how tall the window is. */
  readonly top: number;
  readonly bottom: number;
  readonly windowHeight: number;
  /** The fixed line, off the real repository through the real endpoint. */
  readonly patchIsReal: boolean;
}

const WIDGET = `(() => {
  const widget = document.querySelector('[data-diff-file] [data-review-finding="${FINDING}"]');
  if (widget === null) return null;
  const row = widget.closest('tr');
  const above = row === null ? null : row.previousElementSibling;
  const box = widget.getBoundingClientRect();
  return {
    rowState: row === null ? 'no row at all' : (row.getAttribute('data-state') ?? ''),
    extendsTheLine:
      above !== null && above.querySelector('[data-line-new-num="${LINE}"]') !== null,
    severity: widget.getAttribute('data-severity') ?? '',
    message: widget.querySelector('[data-finding-message]')?.textContent?.trim() ?? '',
    evidence: widget.querySelector('[data-evidence]')?.getAttribute('href') ?? '',
    seq: widget.getAttribute('data-seq') ?? '',
    onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
    top: box.top,
    bottom: box.bottom,
    windowHeight: window.innerHeight,
    patchIsReal: document.body.textContent.includes('Math.round'),
  };
})()`;

let browser: Browser;
let harness: ReplayHarness;
let runId: string;
let page: Page;
let workDir = '';

/** Waits until the plan graph has drawn the recording's four nodes. */
async function drewThePlan(on: Page, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await on.evaluate<number>('document.querySelectorAll("[data-plan-node]").length');
    if (count === 4) return count;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the plan graph drew ${count} of 4 nodes in ${timeoutMs} ms`);
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'DeFlow-review-journey-'));
  const repo = join(workDir, 'repo');
  await materialiseReviewRepo(repo);

  harness = await startReplay({
    fixture: await rehome(FIXTURE, repo, workDir),
    // The recording end to end before the browser opens: the journey starts
    // from a verdict that has already been returned.
    speed: parseSpeed('max'),
    port: 0,
    dev: true,
  });
  runId = harness.runIds[0] as string;
  await harness.played();

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { ...WINDOW } });
  await page.goto(`${harness.origin}/runs/${runId}#token=${harness.token}`);
  await drewThePlan(page);
}, 240_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await harness?.close();
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

suite('EPIC-17-S24 — from a red gate to a line of code', () => {
  it('makes the failing verdict chip a link that carries the file AND the line', async () => {
    const href = await page.evaluate<string>(
      `document.querySelector('[data-plan-node="${FAILED_NODE}"] [data-slot="verdict"]')
         ?.getAttribute('href') ?? ''`,
    );

    expect(href, 'the failing verdict chip is not a link to anything').not.toBe('');

    const url = new URL(href, harness.origin);
    expect(url.pathname).toBe(`/runs/${runId}/diff`);
    // The per-node diff, because the question is "what did *this* node do".
    expect(url.searchParams.get('scope')).toBe('node');
    expect(url.searchParams.get('node')).toBe(FAILED_NODE);
    expect(url.searchParams.get('file')).toBe(FILE);
    // The row's red, in one assertion.
    expect(url.searchParams.get('line')).toBe(String(LINE));
  });

  it('opens the per-node diff on that file with the verdict inline at that line', async () => {
    await page.click(`[data-plan-node="${FAILED_NODE}"] [data-slot="verdict"]`);

    await expect
      .poll(() => page.evaluate<string>('location.pathname'), { timeout: 30_000 })
      .toBe(`/runs/${runId}/diff`);

    // The patch is the daemon's, over the repository this spec built.
    await expect
      .poll(
        () => page.evaluate<boolean>(`!!document.querySelector('[data-diff-file="${FILE}"]')`),
        {
          timeout: 60_000,
        },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          page.evaluate<boolean>(
            `document.querySelector('[data-diff-file] [data-review-finding="${FINDING}"]') !== null`,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // Scrolling to the line happens after the renderer has drawn it, so the
    // report is re-read until it settles — and then asserted once, so a failure
    // says where the verdict actually ended up rather than "timed out".
    let report = await page.evaluate<WidgetReport>(WIDGET);
    for (let attempt = 0; attempt < 40 && !report.onScreen; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      report = await page.evaluate<WidgetReport>(WIDGET);
    }

    // AC2 — in the per-line extend slot, under the line it names, not appended
    // after the hunk.
    expect(report.rowState).toBe('extend');
    expect(report.extendsTheLine).toBe(true);

    expect(report.severity).toBe('blocker');
    expect(report.message).toContain("Type 'Date' is not assignable to type 'number'");
    expect(report.evidence).toContain('/api/artifacts/');
    // AC10 — the `gate.evaluated` this judgement was written at.
    expect(report.seq).toBe('11');

    // The line the daemon's own `git diff` produced, which is how this spec
    // knows the surface is showing a real patch and not a fixture.
    expect(report.patchIsReal).toBe(true);

    // The scroll clause. Without it the operator lands on a diff and hunts.
    expect(
      report.onScreen,
      `the verdict is at ${report.top}–${report.bottom} in a ${report.windowHeight}px window: ` +
        'the view opened on the file but not on the line',
    ).toBe(true);
  });
});

suite('EPIC-17-S24 — and back again', () => {
  it('returns to the plan graph with the node the verdict came from still selected', async () => {
    await page.click('[data-review-back]');

    await expect
      .poll(() => page.evaluate<string>('location.pathname'), { timeout: 30_000 })
      .toBe(`/runs/${runId}`);
    expect(
      await page.evaluate<string>('new URL(location.href).searchParams.get("node") ?? ""'),
    ).toBe(FAILED_NODE);

    expect(await drewThePlan(page)).toBe(4);
    await expect
      .poll(() =>
        page.evaluate<string>(
          `document.querySelector('[data-plan-node="${FAILED_NODE}"]')
             ?.getAttribute('data-selected') ?? ''`,
        ),
      )
      .toBe('true');
  });
});
