/**
 * KAR-17.4 — the context budget view, mounted in the real shell over two real
 * recordings.
 *
 * Verifies: EPIC-17-S17 (scenarios 3 and 4), EPIC-17-S18 (scenarios 1 and 2),
 * EPIC-17-S19 (scenarios 1 and 3), EPIC-17-S32 · AC3, AC4, AC5, AC6, AC7, AC8,
 * AC9, AC10
 *
 * Test plan rows 4, 5, 6, 7 and 8. The arithmetic is `../lib/context-budget.ts`'s
 * and is asserted next door without a browser; what is here is the half a
 * browser is the only honest place for — what is *in the DOM*, and in
 * particular what is **not**.
 *
 * Row 4 is the one to read. `context.compacted` with `fidelity: 'partial'`
 * carries no post-compaction count, because the vendor's `compact_boundary`
 * frame reports `pre_tokens` and nothing else. The assertion is therefore
 * negative — no numeric after value anywhere in that mark's DOM — because every
 * positive assertion about it would pass just as well against a fabricated zero.
 *
 * Two recordings rather than one: `compaction` is the only ledger holding one
 * `context.compacted` of each fidelity, and `happy-path-12` is the only one
 * holding a `pin.integrity_violated` and the `safety.pin-integrity-violated`
 * failure that goes with it.
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import {
  COMPACTION_RUN,
  compactionRun,
  HAPPY_PATH_RUN,
  happyPath12,
} from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { DARK_CLASS } from '../app/theme.ts';
import { VENDOR_POST_COUNT_UNAVAILABLE } from '../lib/context-budget.ts';
import { useRunStore } from '../stores/useRunStore.ts';

let shell: MountedShell;

/** The named recording, folded through the store the view renders from. */
async function openBudget(
  runId: string,
  events: readonly ReturnType<typeof happyPath12>[number][],
  bars: number,
): Promise<void> {
  shell = await mountShell({ at: { name: 'run-context', params: { runId } } });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  for (const event of events) run.applyEvent(event);
  await expect.poll(() => shell.container.querySelectorAll('[data-budget-bar]').length).toBe(bars);
}

const one = (selector: string): HTMLElement =>
  shell.container.querySelector<HTMLElement>(selector) as HTMLElement;

const all = (selector: string): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>(selector),
];

beforeEach(() => {
  setActivePinia(undefined as never);
  document.documentElement.classList.remove(DARK_CLASS);
});

afterEach(() => {
  shell?.unmount();
  document.documentElement.classList.remove(DARK_CLASS);
});

suite('KAR-17.4 test 4 — the compaction whose "after" does not exist (AC4)', () => {
  it('renders the vendor mark with no numeric after value anywhere in its DOM', async () => {
    await openBudget(COMPACTION_RUN, compactionRun(), 1);

    // The vendor compaction is the `seq: 3` event: scope vendor.session,
    // fidelity partial, after null, droppedSegments [].
    const mark = one('[data-compaction="3"]');
    const after = mark.querySelector('[data-slot="after"]') as HTMLElement;

    expect(after).not.toBeNull();
    expect(after.querySelector('[data-value]')).toBeNull();
    // No digit at all: not a zero, not an interpolation, not a dashed guess.
    expect(after.textContent ?? '').not.toMatch(/\d/);
    expect(mark.querySelector('[data-gap-label]')?.textContent?.trim()).toBe(
      VENDOR_POST_COUNT_UNAVAILABLE,
    );
    // And nothing computed a delta out of a number nobody reported.
    expect(mark.querySelector('[data-delta]')).toBeNull();
  });

  it('still says what the vendor did report, so the gap is a gap and not a silence', async () => {
    await openBudget(COMPACTION_RUN, compactionRun(), 1);
    const mark = one('[data-compaction="3"]');

    expect(
      mark.querySelector('[data-slot="before"] [data-value]')?.getAttribute('data-value'),
    ).toBe('167000');
    expect(mark.getAttribute('data-scope')).toBe('vendor.session');
    expect(mark.getAttribute('data-fidelity')).toBe('partial');
  });
});

suite('KAR-17.4 test 5 — the exact compaction keeps every part of its story (AC3)', () => {
  it('shows before, after, the delta, the dropped list and the original handle', async () => {
    await openBudget(COMPACTION_RUN, compactionRun(), 1);
    const mark = one('[data-compaction="2"]');

    expect(
      mark.querySelector('[data-slot="before"] [data-value]')?.getAttribute('data-value'),
    ).toBe('3165');
    expect(mark.querySelector('[data-slot="after"] [data-value]')?.getAttribute('data-value')).toBe(
      '211',
    );
    expect(mark.querySelector('[data-delta]')?.textContent).toContain('2,954');
    expect(
      [...mark.querySelectorAll('[data-segment]')].map((el) => el.textContent?.trim()),
    ).toEqual(['build-log']);

    const original = mark.querySelector('[data-original-handle]');
    expect(original?.getAttribute('data-original-handle')).toBe(
      'artifact://820c387f09b46c3598f167ef8c9ded9fbc14167219492bbc88b8561a768d226a',
    );
  });

  it('surfaces pinnedKept as a positive assertion, on both marks (AC5)', async () => {
    await openBudget(COMPACTION_RUN, compactionRun(), 1);

    for (const seq of ['2', '3']) {
      const kept = one(`[data-compaction="${seq}"] [data-pinned-kept]`);
      expect(kept.querySelectorAll('[data-digest]')).toHaveLength(5);
      expect(kept.textContent).toContain('survived');
    }
  });

  it('draws both fidelities in the one view (AC10)', async () => {
    await openBudget(COMPACTION_RUN, compactionRun(), 1);

    expect(all('[data-compaction]').map((el) => el.getAttribute('data-fidelity'))).toEqual([
      'exact',
      'partial',
    ]);
    // The bar itself is annotated at each compaction, not only the panel below.
    expect(all('[data-compaction-mark]')).toHaveLength(2);
  });
});

suite('KAR-17.4 test 6 — a pinned constraint that did not survive (AC6)', () => {
  it('blocks the invocation, names the digests and the segment ids, and the reason', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);

    const bar = one('[data-bar-detail="impl-login#0"]');
    const violation = bar.querySelector('[data-violation]') as HTMLElement;

    expect(violation).not.toBeNull();
    expect(
      [...violation.querySelectorAll('[data-missing-digest]')].map((el) => el.textContent?.trim()),
    ).toEqual(['sha256-aacd366f09f3c8b831f0d2f385eed98ddd6698b8591b2f081bd160f09bf15375']);
    expect(
      [...violation.querySelectorAll('[data-segment-id]')].map((el) => el.textContent?.trim()),
    ).toEqual(['pinned-spec-goal']);
    expect(violation.querySelector('[data-failure-reason]')?.textContent).toContain(
      'safety.pin-integrity-violated',
    );
  });

  it('leaves the other two invocations unmarked, so the absence is evidence', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);

    expect(all('[data-violation]')).toHaveLength(1);
    expect(one('[data-bar-detail="impl-signup#0"]').querySelector('[data-violation]')).toBeNull();
  });
});

suite('KAR-17.4 test 7 — the data-table twin (AC9, EPIC-17-S32)', () => {
  it('carries a title and a label on the drawing itself', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    const svg = one('[data-budget-chart]');

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('Context budget');
    expect(svg.querySelector('title')?.textContent).toContain('3 invocations');
  });

  it('lists invocation, segment kind, tokens and method, from the chart’s own bars', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    expect(shell.container.querySelector('[data-budget-table]')).toBeNull();
    await userEvent.click(one('[data-budget-table-toggle]'));

    expect(
      [...shell.container.querySelectorAll('[data-budget-table] thead th')].map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(['Invocation', 'Segment kind', 'Tokens', 'Method']);

    // One row per rect, in the same order, with the same numbers. A table built
    // from a second derivation is a second source of truth, and it disagrees
    // with the drawing for exactly as long as nobody compares them.
    const rows = all('[data-budget-table] tbody tr');
    const slices = all('[data-slice]');
    expect(rows).toHaveLength(slices.length);
    expect(rows.map((row) => row.getAttribute('data-row'))).toEqual(
      slices.map(
        (slice) => `${slice.getAttribute('data-invocation')}/${slice.getAttribute('data-slice')}`,
      ),
    );

    const first = rows[0] as HTMLElement;
    expect(first.textContent).toContain('impl-login#0');
    expect(first.textContent).toContain('pinned.spec');
    expect(first.textContent).toContain('46');
    expect(first.textContent).toContain('heuristic');
  });

  it('states the bar total once per counting method and never as one figure (AC8)', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    const totals = all('[data-bar-detail="impl-login#0"] [data-bar-total]');

    expect(totals.map((el) => el.getAttribute('data-method'))).toEqual(['heuristic']);
    expect(totals[0]?.getAttribute('data-tokens')).toBe('290');
  });
});

suite('KAR-17.4 test 8 — the segments are painted from the palette (AC1)', () => {
  /** The fill of a slice, resolved through the live cascade. */
  const fillOf = (kind: string): string =>
    getComputedStyle(one(`[data-slice][data-kind="${kind}"]`)).fill;

  /** `colour` painted into a canvas and read back, as sRGB bytes. */
  function paint(colour: string): readonly [number, number, number] {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r as number, g as number, b as number];
  }

  const luminance = (rgb: readonly [number, number, number]): number => {
    const [r, g, b] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const contrast = (a: string, b: string): number => {
    const [high, low] = [luminance(paint(a)), luminance(paint(b))].toSorted((x, y) => y - x);
    return ((high as number) + 0.05) / ((low as number) + 0.05);
  };

  const KINDS = [
    'pinned.constraints',
    'pinned.spec',
    'pinned.pathscope',
    'task.brief',
    'fact',
    'artifact.handle',
    'retrieved',
    'history.summary',
    'tool.output',
  ];

  it('gives each kind its own colour, and each one is legible on the surface', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();

    const fills = KINDS.map(fillOf);
    expect(new Set(fills).size, `nine kinds, ${new Set(fills).size} colours`).toBe(KINDS.length);
    for (const [index, fill] of fills.entries()) {
      expect(fill, KINDS[index]).not.toBe('');
      // WCAG 1.4.11's 3:1 for a non-text graphic.
      expect(contrast(fill, surface), KINDS[index]).toBeGreaterThanOrEqual(3);
    }
  });

  it('repaints from the same tokens in the dark theme, and stays legible there', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    const light = KINDS.map(fillOf);

    document.documentElement.classList.add(DARK_CLASS);
    const dark = KINDS.map(fillOf);
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();

    // A hardcoded colour per kind survives the class flip unchanged, which is
    // exactly the failure this row names.
    expect(dark).not.toEqual(light);
    for (const [index, fill] of dark.entries()) {
      expect(contrast(fill, surface), KINDS[index]).toBeGreaterThanOrEqual(3);
    }
  });
});

suite('AC7 — a segment says what it is, and opens where it came from', () => {
  it('names the kind, the tokens, the method and the source event on hover', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    const slice = one('[data-slice="pinned-spec-goal"]');

    const label = slice.querySelector('title')?.textContent ?? '';
    expect(label).toContain('pinned.spec');
    expect(label).toContain('46');
    expect(label).toContain('heuristic');
    expect(label).toContain('4');
    expect(slice.getAttribute('data-source-event')).toBe('4');
  });

  it('clicks through to the inspector, on that segment', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    await userEvent.click(one('[data-slice="pinned-spec-goal"]'));

    await expect
      .poll(() => shell.router.currentRoute.value.query['segment'])
      .toBe('pinned-spec-goal');
    expect(shell.router.currentRoute.value.query['node']).toBe('impl-login');
    expect(shell.ui.isOverlayOpen('inspector')).toBe(true);
  });
});

suite('AC2 — the budget line is drawn from the budget', () => {
  it('draws one line per bar, at limitTokens, with the fraction stated', async () => {
    await openBudget(HAPPY_PATH_RUN, happyPath12(), 3);
    const lines = all('[data-budget-line]');

    expect(lines).toHaveLength(3);
    expect(lines[0]?.getAttribute('data-limit-tokens')).toBe('100000');
    expect(one('[data-bar-detail="impl-login#0"] [data-budget-caption]').textContent).toContain(
      '50%',
    );
  });
});
