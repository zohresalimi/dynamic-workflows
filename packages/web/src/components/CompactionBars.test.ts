/**
 * KAR-09.6 AC5 / EPIC-09-S33 — the honest rendering contract, in a real
 * Chromium.
 *
 * The component belongs to EPIC-17; the *contract* and the fixture belong to
 * this epic, and this spec is where the two meet. It renders the committed
 * fixture — `test/fixtures/runs/compaction/compactions.json`, projected from
 * the real ledger beside it — and asserts what may and may not appear in the
 * DOM:
 *
 * - an `exact` compaction draws two solid bars;
 * - a `partial` one draws a solid `before`, a **hatched** `after` labelled
 *   _inferred_, and a plain sentence saying the vendor does not report what it
 *   dropped;
 * - a `partial` whose `after` is still `null` draws an explicit **gap**, and
 *   the string `0` never appears as a value.
 *
 * **Browser mode with a real Chromium is mandatory here**, and it is not
 * ceremony: jsdom and happy-dom return `0` from `getBBox()` and report zero
 * element sizes, so a spec asserting "a bar was drawn" passes against nothing
 * having rendered. The width assertions below are the reason this file is in
 * the `web` project and not the unit one.
 *
 * Verifies: EPIC-09-S33 · AC5
 */
import { type CompactionView, compactionChart, INFERRED_LABEL } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import fixture from '../../../../test/fixtures/runs/compaction/compactions.json' with {
  type: 'json',
};
import CompactionBars from './CompactionBars.vue';

interface FixtureCompaction {
  readonly scope: string;
  readonly fidelity: string;
  readonly trigger: string;
  readonly before: number;
  readonly after: number | null;
  readonly droppedSegments: readonly string[];
  readonly demotedToHandles: readonly string[];
  readonly originalHandle: string | null;
}

const committed = fixture.compactions as readonly FixtureCompaction[];

/** The fixture's rows as the projection a consumer renders. `later` is passed
 * only where a following envelope exists, which is what makes the third case
 * ("still null") reachable at all. */
function viewOf(row: FixtureCompaction, inputTokens?: number): CompactionView {
  return {
    scope: row.scope as CompactionView['scope'],
    fidelity: row.fidelity as CompactionView['fidelity'],
    trigger: row.trigger as CompactionView['trigger'],
    before: row.before,
    after: row.fidelity === 'exact' ? row.after : (inputTokens ?? null),
    inferred: row.fidelity !== 'exact' && inputTokens !== undefined,
    droppedSegments: row.droppedSegments as CompactionView['droppedSegments'],
    demotedToHandles: row.demotedToHandles as CompactionView['demotedToHandles'],
    originalHandle: row.originalHandle as CompactionView['originalHandle'],
  };
}

const exactRow = committed.find((row) => row.fidelity === 'exact');
const partialRow = committed.find((row) => row.fidelity === 'partial');
if (exactRow === undefined || partialRow === undefined) {
  throw new Error('the committed fixture must hold one compaction of each fidelity');
}

const widthOf = (element: Element): number => element.getBoundingClientRect().width;

suite('the fixture is the one this contract is written against', () => {
  it('holds an exact compaction and a partial one', () => {
    expect(exactRow.after).toBeTypeOf('number');
    expect(partialRow.after).toBeNull();
  });
});

suite('exact renders as a solid before→after pair', () => {
  it('draws two solid bars, both with a real width', async () => {
    const screen = render(CompactionBars, { props: { chart: compactionChart(viewOf(exactRow)) } });

    const bars = screen.container.querySelectorAll('[data-bar]');
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.getAttribute('data-style')).toBe('solid');
      expect(widthOf(bar), 'a bar with no width is a bar nobody drew').toBeGreaterThan(0);
    }
    expect(screen.container.querySelector('[data-note]')).toBeNull();
  });

  it('lists the segments it dropped, by id', async () => {
    const screen = render(CompactionBars, { props: { chart: compactionChart(viewOf(exactRow)) } });

    expect(screen.container.textContent).toContain(exactRow.droppedSegments[0]);
  });
});

suite('partial renders hatched, labelled and explained', () => {
  const chart = compactionChart(viewOf(partialRow, 84_210));

  it('keeps before solid and marks after as inferred', async () => {
    const screen = render(CompactionBars, { props: { chart } });

    const bars = [...screen.container.querySelectorAll('[data-bar]')];
    expect(bars[0]?.getAttribute('data-style')).toBe('solid');
    expect(bars[1]?.getAttribute('data-style')).toBe('hatched');
    expect(bars[1]?.textContent).toContain(INFERRED_LABEL);
    expect(widthOf(bars[1] as Element)).toBeGreaterThan(0);
  });

  it('states plainly that the vendor does not report what it dropped', async () => {
    const screen = render(CompactionBars, { props: { chart } });

    expect(screen.container.querySelector('[data-note]')?.textContent).toContain('does not report');
  });

  it('presents no after figure as measured', async () => {
    const screen = render(CompactionBars, { props: { chart } });

    // The negative is the assertion EPIC-17 is held to: a `partial` event that
    // renders as a solid two-bar chart is a defect, and this is the fixture
    // that proves it.
    const solid = [...screen.container.querySelectorAll('[data-bar]')].filter(
      (bar) => bar.getAttribute('data-style') === 'solid',
    );
    expect(solid).toHaveLength(1);
    expect(solid[0]?.getAttribute('data-slot')).toBe('before');
  });
});

suite('a partial with no later envelope renders a gap, not a zero', () => {
  const chart = compactionChart(viewOf(partialRow));

  it('draws the after position as an explicit gap', async () => {
    const screen = render(CompactionBars, { props: { chart } });

    const after = screen.container.querySelector('[data-slot="after"]');
    expect(after?.getAttribute('data-style')).toBe('gap');
    expect(after?.textContent).toContain('not reported');
  });

  it('never shows 0 as the after value', async () => {
    const screen = render(CompactionBars, { props: { chart } });

    const values = [...screen.container.querySelectorAll('[data-value]')].map((node) =>
      node.getAttribute('data-value'),
    );
    expect(values).not.toContain('0');
    expect(screen.container.querySelector('[data-slot="after"]')?.textContent).not.toMatch(/\b0\b/);
  });
});
