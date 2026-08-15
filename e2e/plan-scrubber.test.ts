/**
 * KAR-17.2 AC10 — **Playwright smoke #2**: drag the scrubber back to v1 and
 * step forward through every patch, with the diff rendering each time.
 *
 * Verifies: EPIC-17-S5 (the marquee journey), EPIC-17-S9 · AC1, AC2, AC3, AC5,
 * AC9, AC10
 *
 * The second of the five smokes [14 §13](../docs/14-testing-strategy.md)
 * budgets for, and the one the roadmap calls the demo: *"why is there a step
 * here that I didn't ask for?"*, answered in four keystrokes.
 *
 * Nothing here is injected. A real `deflow replay` daemon serves the
 * `three-patches` recording out of a real ledger; the version rail comes from
 * `GET /api/runs/:id/plans`, the refusal from `GET …/patches`, each plan
 * document from `GET …/plans/:version` and each diff from `…/plans/diff` —
 * computed by the daemon's own `diffPlanGraphs`, not by the fixture that states
 * it in `packages/web/src/views/plan-scrubber.test.ts`. That is the whole
 * reason this file exists beside that one: the browser spec asserts the view
 * renders what the endpoint says, and this asserts that what the endpoint says
 * is right.
 *
 * `three-patches` is the recording AC9 names: an **insert** (v1→v2), a **split**
 * with `derivedFrom` (v2→v3), a **provider replace** (v3→v4), and a fourth
 * proposal that was **refused** — so all three patch kinds and the refusal are
 * exercised by walking the rail once.
 *
 * Every `page.evaluate` body is passed as **source text** rather than as a
 * closure: this slice compiles with Node's libs and no DOM, so a closure
 * mentioning `document` would not type-check against a module graph that only
 * exists inside the browser. Same convention as the specs beside it.
 */
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../packages/daemon/src/replay/harness.ts';
import { parseSpeed } from '../packages/daemon/src/replay/speed.ts';
import { repoRoot } from './support/daemon.ts';

const FIXTURE = join(repoRoot, 'test/fixtures/runs/three-patches/events.jsonl');

/**
 * What the drawing holds at each stop of the forward journey.
 *
 * Two versions are laid out together and the operator stands on one of them, so
 * what is drawn is *that* version plus whatever the patch removed:
 *
 * - **v1** — the plan exactly as approved, on the older half of `(1, 2)`. The
 *   review the next patch inserts is not here, because it had not been inserted.
 * - **v2** — `(1, 2)` from the newer side: the review has arrived.
 * - **v3** — `(2, 3)` from the newer side: the split, with `impl-checkout`
 *   still drawn in place because a node that simply vanished would be
 *   indistinguishable from one that moved off screen.
 * - **v4** — `(3, 4)`: nothing added or removed, one provider re-routed.
 */
const DRAWN_AT: Readonly<Record<number, readonly string[]>> = {
  1: ['recon', 'impl-checkout'],
  2: ['recon', 'impl-checkout', 'review-checkout'],
  3: ['recon', 'impl-checkout', 'impl-checkout-cart', 'impl-checkout-payment', 'review-checkout'],
  4: ['recon', 'impl-checkout-cart', 'impl-checkout-payment', 'review-checkout'],
};

/** Every node the scrubber drew, with its diff class and where it was put. */
const DRAWN = `Array.from(document.querySelectorAll('[data-diff-node]')).map((body) => ({
  id: body.dataset.diffNode,
  diffClass: body.dataset.diffClass,
  transform: body.closest('.vue-flow__node')?.style.transform ?? '',
  text: body.textContent.replace(/\\s+/g, ' ').trim(),
}))`;

interface DrawnNode {
  readonly id: string;
  readonly diffClass: string;
  readonly transform: string;
  readonly text: string;
}

let browser: Browser;
let harness: ReplayHarness;
let runId: string;
let page: Page;

/**
 * Waits until the scrubber has settled on `version` with `count` nodes drawn.
 *
 * `count` defaults to the forward journey's table above, and is passed
 * explicitly by the one test that walks **backwards** into a transition: v3 on
 * the older half of `(3, 4)` draws four nodes, not the five it draws when
 * reached from v2.
 */
async function settledOn(
  version: number,
  count = (DRAWN_AT[version] ?? []).length,
  timeoutMs = 60_000,
): Promise<DrawnNode[]> {
  const deadline = Date.now() + timeoutMs;
  let drawn: DrawnNode[] = [];
  while (Date.now() < deadline) {
    const shown = await page.evaluate<string | null>(
      `document.querySelector('[data-scrub-version]')?.getAttribute('data-scrub-version') ?? null`,
    );
    drawn = await page.evaluate<DrawnNode[]>(DRAWN);
    if (shown === String(version) && drawn.length === count) return drawn;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `the scrubber drew ${drawn.length} of ${count} nodes at v${version} — ` +
      'the rail, the plan documents and the diff all come from the daemon, so check ' +
      'GET /api/runs/:id/plans, …/plans/:version and …/plans/diff',
  );
}

/** Presses `←`, which steps the rail back through the shared keyboard map. */
async function stepBack(): Promise<void> {
  await page.keyboard.press('ArrowLeft');
}

/** Presses `→` on the document, the way the keyboard map receives it. */
async function stepForward(): Promise<void> {
  await page.keyboard.press('ArrowRight');
}

beforeAll(async () => {
  browser = await chromium.launch();
  harness = await startReplay({
    fixture: FIXTURE,
    // The whole recording as fast as it will go: the scrubber is a view of a
    // run's *history*, so the interesting instant is after the last event.
    speed: parseSpeed('max'),
    port: 0,
    dev: true,
  });
  runId = harness.runIds[0] as string;
  await harness.played();

  page = await browser.newPage();
  await page.goto(`${harness.origin}/runs/${runId}/evolution#token=${harness.token}`);
  await settledOn(4);
}, 240_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await harness?.close();
});

suite('EPIC-17-S5 — the marquee journey, end to end (AC10)', () => {
  it('shows the plan exactly as it was approved when dragged back to v1', async () => {
    await page.click('[data-rail-version="1"]');
    const drawn = await settledOn(1);

    expect(drawn.map((node) => node.id).toSorted()).toEqual([...(DRAWN_AT[1] ?? [])].toSorted());
    // No diff against the empty graph: v1 is the plan, not a set of additions.
    expect(new Set(drawn.map((node) => node.diffClass))).toEqual(new Set(['unchanged']));
  });

  it('steps forward through every patch, rendering the diff each time', async () => {
    await page.click('[data-rail-version="1"]');
    await settledOn(1);

    // ── v2: the insert ───────────────────────────────────────────────────────
    await stepForward();
    const v2 = await settledOn(2);
    expect(classesOf(v2)['review-checkout']).toBe('added');
    expect(classesOf(v2)['recon']).toBe('unchanged');
    await expectReason('a security review is required before checkout ships', 'auto');

    // ── v3: the split, with derivedFrom visible (AC9) ────────────────────────
    await stepForward();
    const v3 = await settledOn(3);
    expect(classesOf(v3)['impl-checkout']).toBe('removed');
    expect(classesOf(v3)['impl-checkout-cart']).toBe('added');
    expect(classesOf(v3)['impl-checkout-payment']).toBe('added');
    for (const node of v3.filter((one) => one.id.startsWith('impl-checkout-'))) {
      expect(node.text, `${node.id} does not say what it was derived from`).toContain(
        'derived from impl-checkout',
      );
    }
    await expectReason('the checkout rewrite is two independent changes', 'approved');

    // ── v4: the provider replace ─────────────────────────────────────────────
    await stepForward();
    const v4 = await settledOn(4);
    expect(classesOf(v4)['impl-checkout-payment']).toBe('changed');
    await expectReason('claude-code is out of quota for the next four hours', 'auto');
  });

  it('holds every surviving node still across the last step (AC3)', async () => {
    // Stepped, not jumped: `←` and `→` between the two halves of the `(3, 4)`
    // transition stay on the one union layout ELK computed for it. A view that
    // rebased the pair on every move would recompute it here, and every
    // coordinate below would differ — which is the failure this whole view
    // exists to prevent.
    await page.click('[data-rail-version="4"]');
    await settledOn(4);

    await stepBack();
    const before = await settledOn(3, 4);

    await stepForward();
    const after = await settledOn(4);

    // Every node in both versions, at the same rendered transform — numeric, on
    // the drawing, not by eye. This is the property the whole view is for.
    const shared = after.filter((node) => before.some((one) => one.id === node.id));
    expect(shared.length).toBeGreaterThanOrEqual(4);
    for (const node of shared) {
      const was = before.find((one) => one.id === node.id);
      expect(node.transform, `${node.id} moved between v3 and v4`).toBe(was?.transform);
    }
  });

  it('opens the field-level patch beside the human reason (AC5)', async () => {
    await page.click('[data-rail-version="4"]');
    await settledOn(4);

    await page.click('[data-diff-node="impl-checkout-payment"] button[data-diff-open]');
    await page.waitForSelector('[data-patch-panel]', { timeout: 15_000 });

    const panel = await page.evaluate<{ node: string | null; ops: string[]; text: string }>(
      `(() => {
        const panel = document.querySelector('[data-patch-panel]');
        return {
          node: panel?.getAttribute('data-patch-node') ?? null,
          ops: Array.from(panel?.querySelectorAll('[data-patch-op]') ?? [], (op) => op.textContent ?? ''),
          text: (panel?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        };
      })()`,
    );

    expect(panel.node).toBe('impl-checkout-payment');
    // The RFC 6902 operation the daemon computed, not one this view derived.
    expect(panel.ops.join(' ')).toContain('"op": "replace"');
    expect(panel.ops.join(' ')).toContain('/provider');
    expect(panel.ops.join(' ')).toContain('codex');
    expect(panel.text).toContain('claude-code is out of quota for the next four hours');
  });
});

suite('EPIC-17-S9 — a patch that was proposed and refused (AC1)', () => {
  it('marks the refusal on the rail, off the daemon’s own patch list', async () => {
    const marks = await page.evaluate<{ id: string | null; rule: string | null }[]>(
      `Array.from(document.querySelectorAll('[data-rail-rejected]')).map((mark) => ({
        id: mark.getAttribute('data-rail-rejected'),
        rule: mark.getAttribute('data-rule'),
      }))`,
    );

    expect(marks).toHaveLength(1);
    expect(marks[0]?.id).toBe('p-widen-scope');
    expect(marks[0]?.rule).toBe('escalates-permission');
  });

  it('did not advance the plan version across it', async () => {
    const versions = await page.evaluate<number>(
      `document.querySelectorAll('[data-rail-version]').length`,
    );

    // Four versions and one refusal: the run proposed five times and moved four.
    expect(versions).toBe(4);
  });

  it('says what was proposed, which rule refused it and who, when clicked', async () => {
    await page.click('[data-rail-rejected="p-widen-scope"]');
    await page.waitForSelector('[data-rejected-panel]', { timeout: 15_000 });

    const text = await page.evaluate<string>(
      `(document.querySelector('[data-rejected-panel]')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`,
    );

    expect(text).toContain('the payment step needs to edit the shared money helper');
    expect(text).toContain('escalates-permission');
    expect(text).toContain('policy');
  });
});

function classesOf(drawn: readonly DrawnNode[]): Record<string, string> {
  return Object.fromEntries(drawn.map((node) => [node.id, node.diffClass]));
}

/** The reason panel says the reason and the decision the ledger recorded. */
async function expectReason(reason: string, decision: string): Promise<void> {
  const text = await page.evaluate<string>(
    `(document.querySelector('[data-reason-panel]')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`,
  );
  expect(text).toContain(reason);
  expect(text).toContain(decision);
}
