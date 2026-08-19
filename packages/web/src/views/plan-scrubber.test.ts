/**
 * KAR-17.2 — the plan-evolution scrubber, drawn: tests 6 and 7 of the story's
 * plan, and the browser half of five scenarios.
 *
 * Verifies: EPIC-17-S6, EPIC-17-S7, EPIC-17-S8, EPIC-17-S9, EPIC-17-S10 ·
 * AC1, AC2, AC3, AC4, AC5, AC8, AC9
 *
 * The fixture is the **recording**, not a hand-built row set: `three-patches`
 * has real `PlanGraph` documents at all four versions — an insert, a split with
 * `derivedFrom`, a provider replace, and a fourth proposal that was refused —
 * which is exactly AC9's list. See `../../test/scrubber-daemon.ts` for why the
 * diff documents are the endpoint's answer rather than something this fixture
 * computed.
 *
 * `../views/plan-evolution.test.ts` beside this one owns the *request pattern*
 * (EPIC-15-S47): which endpoint was called for which pair, and that nothing is
 * folded from zero in the tab. This file owns what was **drawn**.
 *
 * A real Chromium, because every assertion here is about geometry or computed
 * style: jsdom returns 0 from `getBBox()` and reports every element as 0×0, so
 * *"every surviving node has byte-identical coordinates"* would pass against a
 * graph that drew nothing at all (docs/14 §13).
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { commands } from 'vitest/browser';
import {
  API_BASE,
  type Asked,
  DIFFS,
  daemonFetch,
  PLAN_PATCHES,
  PLAN_VERSIONS,
  RUN,
} from '../../test/scrubber-daemon.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';

/** KAR-25.1 — the run views are project-scoped now; the value is never
 * asserted on, only threaded through so the named route resolves. */
const PROJECT_ID = 'prj_test';

import { createClient } from '../api/client.ts';

let shell: MountedShell;
let asked: Asked[];

const mountAtEvolution = async (): Promise<MountedShell> => {
  asked = [];
  return mountShell({
    at: { name: 'plan-evolution', params: { projectId: PROJECT_ID, runId: RUN } },
    client: createClient({ baseUrl: API_BASE, fetch: daemonFetch(asked) }),
  });
};

const one = <T extends Element = HTMLElement>(selector: string): T | null =>
  shell.container.querySelector<T>(selector);

const all = (selector: string): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>(selector),
];

/** Waits until the graph has drawn `count` node bodies for `version`. */
async function drawn(version: number, count: number): Promise<void> {
  await expect
    .poll(() => one('[data-scrub-version]')?.getAttribute('data-scrub-version'), {
      timeout: 15_000,
    })
    .toBe(String(version));
  await expect.poll(() => all('[data-diff-node]').length, { timeout: 15_000 }).toBe(count);
}

/** Where the renderer actually put each node, read off the drawing. */
function coordinates(): Record<string, string> {
  const at: Record<string, string> = {};
  for (const body of all('[data-diff-node]')) {
    const shellElement = body.closest<HTMLElement>('.vue-flow__node');
    const id = body.dataset['diffNode'];
    if (id !== undefined && shellElement !== null) at[id] = shellElement.style.transform;
  }
  return at;
}

/** Every drawn node's diff class, by id. */
function classes(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const body of all('[data-diff-node]')) {
    const id = body.dataset['diffNode'];
    if (id !== undefined) found[id] = body.dataset['diffClass'] ?? '';
  }
  return found;
}

afterEach(async () => {
  shell?.unmount();
  await commands.emulateMedia({});
});

suite('AC1 — the rail is every decision, not every version', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await drawn(4, 4);
  });

  it('renders one tick per version, with its seq, planHash and decision', () => {
    const ticks = all('[data-rail-version]');

    expect(ticks.map((tick) => Number(tick.dataset['railVersion']))).toEqual([1, 2, 3, 4]);
    expect(ticks.map((tick) => tick.dataset['seq'])).toEqual(
      PLAN_VERSIONS.map((row) => String(row.seq)),
    );
    expect(ticks.map((tick) => tick.dataset['planHash'])).toEqual(
      PLAN_VERSIONS.map((row) => row.planHash),
    );
    // v1 is an initial compile and has no decision behind it; the other three
    // carry the one the ledger recorded, never a guess.
    expect(ticks.map((tick) => tick.dataset['decision'])).toEqual([
      'none',
      'auto',
      'approved',
      'auto',
    ]);
  });

  it('colours each tick by its decision, and by nothing else', () => {
    for (const tick of all('[data-rail-version]')) {
      const painted = getComputedStyle(tick).getPropertyValue('--tick').trim();
      expect(painted, `no colour for decision ${tick.dataset['decision']}`).not.toBe('');
    }
  });

  it('marks the refused proposal on the rail, which no version rail can (S9)', () => {
    const refused = all('[data-rail-rejected]');

    expect(refused).toHaveLength(1);
    expect(refused[0]?.dataset['railRejected']).toBe('p-widen-scope');
    // Distinct from a version tick in shape as well as in colour: a mark that
    // only differed by hue would be a mark 8% of readers cannot find.
    expect(refused[0]?.dataset['railKind']).toBe('rejected');
    expect(refused[0]?.hasAttribute('data-rail-version')).toBe(false);
  });

  it('did not advance the plan version across the refusal', () => {
    // The rail has four versions and one refusal, and the refusal sits between
    // v4 and nothing: the plan stopped at 4.
    expect(all('[data-rail-version]')).toHaveLength(4);
    expect(one('[data-scrub-version]')?.getAttribute('data-scrub-version')).toBe('4');
  });

  it('says what was proposed, which rule refused it and who, when clicked', async () => {
    all('[data-rail-rejected]')[0]?.click();
    await expect.poll(() => one('[data-rejected-panel]')).not.toBeNull();

    const text = one('[data-rejected-panel]')?.textContent ?? '';
    expect(text).toContain('the payment step needs to edit the shared money helper');
    expect(text).toContain('escalates-permission');
    expect(text).toContain('policy');
  });
});

suite('AC2 — dragging back to v1 and stepping forward', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await drawn(4, 4);
  });

  it('shows the plan exactly as it was approved, and no other nodes', async () => {
    shell.ui.selectPlanVersion(1);
    // Two nodes, and specifically **not** the review the next patch inserts.
    // v1 is the older half of the transition `(1, 2)`: it is laid out with v2
    // so that stepping forward moves nothing, and it draws only what v1 held.
    await drawn(1, 2);

    expect(Object.keys(classes()).toSorted()).toEqual(['impl-checkout', 'recon']);
    // Nothing is marked here: the patch has not happened yet.
    expect(new Set(Object.values(classes()))).toEqual(new Set(['unchanged']));
  });

  it('steps one version at a time with the arrow keys', async () => {
    shell.ui.selectPlanVersion(1);
    await drawn(1, 2);

    shell.ui.stepPlanVersion(1);
    // v1 ∪ v2 is three nodes: the review the patch inserted arrives, at the
    // coordinates it already had in the union.
    await drawn(2, 3);
    expect(one('[data-transition]')?.getAttribute('data-transition')).toBe('1:2');
    expect(classes()['review-checkout']).toBe('added');
  });

  it('shows the reason string from the plan.patched event for the transition', async () => {
    for (const version of [1, 2, 3, 4] as const) {
      shell.ui.selectPlanVersion(version);
      await expect
        .poll(() => one('[data-scrub-version]')?.getAttribute('data-scrub-version'))
        .toBe(String(version));

      if (version === 1) {
        expect(one('[data-reason-panel]')?.textContent).toContain('initial');
        continue;
      }

      // The rail's own row for this version, which the daemon joined from the
      // `plan.patched` event and its proposal — the same string the diff
      // endpoint reports for the pair that produced it.
      const expected = PLAN_VERSIONS.find((row) => row.version === version);
      const fromDiff = DIFFS[`${version - 1}:${version}`] as { reason: string };
      expect(expected?.reason).toBe(fromDiff.reason);
      await expect
        .poll(() => one('[data-reason-panel]')?.textContent ?? '')
        .toContain(expected?.reason ?? '');
      expect(one('[data-reason-panel]')?.textContent).toContain(expected?.decision ?? '');
    }
  });
});

suite('AC3 — nothing moves as you scrub (test 6)', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await drawn(4, 4);
  });

  it('leaves every surviving node’s transform byte-identical from v3 to v4', async () => {
    // Stepped, not jumped, and that is the point: `←` and `→` between the two
    // halves of one transition stay on **one** union layout. A view that
    // rebased the pair on every move would recompute it here and every
    // coordinate below would differ by a few pixels — which is the failure the
    // whole story exists to prevent, at the smallest possible scale.
    shell.ui.stepPlanVersion(-1);
    await drawn(3, 4);
    const before = coordinates();
    expect(Object.keys(before)).toHaveLength(4);

    shell.ui.stepPlanVersion(1);
    await drawn(4, 4);
    const after = coordinates();

    // Numeric and on the rendered transform, not by eye. Every one of the four
    // nodes is in both versions, and every one of them is in the same place.
    expect(after).toEqual(before);
    for (const transform of Object.values(after)) {
      expect(transform).toMatch(/translate/);
    }
  });

  it('holds a removed node at its union coordinates rather than dropping it', async () => {
    // v2 → v3 is the split: `impl-checkout` is removed, and it must be drawn,
    // in place, or a removal is indistinguishable from a node that moved away.
    shell.ui.selectPlanVersion(3);
    await drawn(3, 5);

    expect(classes()['impl-checkout']).toBe('removed');
    expect(coordinates()['impl-checkout']).toMatch(/translate/);
  });

  it('re-scrubs the same pair without moving anything (S6, scenario 3)', async () => {
    // v4 → v3 → v4 → v3, the back-and-forth the scenario describes.
    shell.ui.stepPlanVersion(-1);
    await drawn(3, 4);
    const first = coordinates();

    shell.ui.stepPlanVersion(1);
    await drawn(4, 4);
    shell.ui.stepPlanVersion(-1);
    await drawn(3, 4);

    expect(coordinates()).toEqual(first);
  });
});

suite('AC4 — added, removed, changed, unchanged, encoded four ways (test 7)', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await drawn(4, 4);
  });

  it('classifies every node in the union of the pair', async () => {
    shell.ui.selectPlanVersion(3);
    await drawn(3, 5);

    expect(classes()).toEqual({
      recon: 'unchanged',
      'impl-checkout': 'removed',
      'impl-checkout-cart': 'added',
      'impl-checkout-payment': 'added',
      'review-checkout': 'changed',
    });
  });

  it('gives an added node a solid accent border and a "+" badge', async () => {
    shell.ui.selectPlanVersion(3);
    await drawn(3, 5);

    const added = one<HTMLElement>('[data-diff-node="impl-checkout-cart"]');
    if (added === null) throw new Error('the added node must be drawn');
    expect(getComputedStyle(added).borderStyle).toBe('solid');
    expect(added.querySelector('[data-diff-badge]')?.textContent?.trim()).toBe('+');
  });

  it('gives a removed node a dashed stroke and reduced opacity', async () => {
    shell.ui.selectPlanVersion(3);
    await drawn(3, 5);

    const removed = one<HTMLElement>('[data-diff-node="impl-checkout"]');
    if (removed === null) throw new Error('the removed node must be drawn');
    const style = getComputedStyle(removed);
    expect(style.borderStyle).toBe('dashed');
    expect(Number(style.opacity)).toBeLessThan(1);
  });

  it('gives a changed node a marker and a click-through', async () => {
    shell.ui.selectPlanVersion(4);
    await drawn(4, 4);

    const changed = one<HTMLElement>('[data-diff-node="impl-checkout-payment"]');
    expect(changed?.querySelector('[data-diff-marker]')).not.toBeNull();
    // A click-through is a real control, so the panel is reachable by keyboard
    // as well as by pointer.
    expect(changed?.querySelector('button[data-diff-open]')).not.toBeNull();
  });

  it('leaves an unchanged node with none of the three signals', async () => {
    shell.ui.selectPlanVersion(4);
    await drawn(4, 4);

    const unchanged = one<HTMLElement>('[data-diff-node="recon"]');
    if (unchanged === null) throw new Error('the unchanged node must be drawn');
    expect(getComputedStyle(unchanged).borderStyle).toBe('solid');
    expect(Number(getComputedStyle(unchanged).opacity)).toBe(1);
    expect(unchanged.querySelector('[data-diff-badge]')).toBeNull();
    expect(unchanged.querySelector('[data-diff-marker]')).toBeNull();
  });

  it('distinguishes all four with colour disabled', async () => {
    shell.ui.selectPlanVersion(3);
    await drawn(3, 5);

    // The non-colour signal for each class, as a tuple: border style, whether
    // it is faded, and which glyph it carries. Four classes, four distinct
    // tuples — which is the whole of "not colour-only".
    const signature = (id: string): string => {
      const body = one<HTMLElement>(`[data-diff-node="${id}"]`);
      if (body === null) throw new Error(`${id} was not drawn`);
      const style = getComputedStyle(body);
      const glyph =
        body.querySelector('[data-diff-badge]')?.textContent?.trim() ??
        body.querySelector('[data-diff-marker]')?.textContent?.trim() ??
        '';
      return `${style.borderStyle}/${Number(style.opacity) < 1 ? 'faded' : 'solid'}/${glyph}`;
    };

    const signatures = [
      signature('impl-checkout-cart'),
      signature('impl-checkout'),
      signature('review-checkout'),
      signature('recon'),
    ];

    expect(new Set(signatures).size).toBe(4);
  });

  it('shows a split node’s derivedFrom, which is how a split reads as one (AC9)', async () => {
    shell.ui.selectPlanVersion(3);
    await drawn(3, 5);

    for (const id of ['impl-checkout-cart', 'impl-checkout-payment']) {
      expect(one(`[data-diff-node="${id}"]`)?.textContent).toContain('impl-checkout');
    }
  });
});

suite('AC5 — "why did this change", at field level (S8)', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await drawn(4, 4);
  });

  it('opens the RFC 6902 patch beside the human reason when a changed node is clicked', async () => {
    shell.ui.selectPlanVersion(4);
    await drawn(4, 4);

    one<HTMLElement>('[data-diff-node="impl-checkout-payment"] button[data-diff-open]')?.click();
    await expect.poll(() => one('[data-patch-panel]')).not.toBeNull();

    const panel = one('[data-patch-panel]');
    expect(panel?.getAttribute('data-patch-node')).toBe('impl-checkout-payment');

    const operations = [...(panel?.querySelectorAll('[data-patch-op]') ?? [])].map(
      (line) => line.textContent ?? '',
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]).toContain('"op": "replace"');
    expect(operations[0]).toContain('/provider');
    expect(operations[0]).toContain('"codex"');

    // Beside it, the reason and the decision off the ledger — and the patch id,
    // so the panel deep-links to the events that produced it (NF10).
    const text = panel?.textContent ?? '';
    expect(text).toContain('claude-code is out of quota for the next four hours');
    expect(text).toContain('auto');
  });

  it('does not open a patch panel on an unchanged node', async () => {
    shell.ui.selectPlanVersion(4);
    await drawn(4, 4);

    expect(one('[data-diff-node="recon"] button[data-diff-open]')).toBeNull();
  });
});

suite('AC8 — comparing versions that are not adjacent (S10)', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await drawn(4, 4);
  });

  it('steps adjacent versions in the union mode, always', async () => {
    shell.ui.selectPlanVersion(3);
    await drawn(3, 5);

    expect(one('[data-scrub-mode]')?.getAttribute('data-scrub-mode')).toBe('step');
  });

  it('enters a labelled comparison mode for a non-adjacent pair', async () => {
    const picker = one<HTMLSelectElement>('select[data-compare-from]');
    if (picker === null) throw new Error('the comparison picker must be rendered');

    picker.value = '1';
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    await expect
      .poll(() => one('[data-scrub-mode]')?.getAttribute('data-scrub-mode'))
      .toBe('compare');
    // Explicitly a comparison, not stepping: an operator who cannot tell which
    // mode they are in cannot trust either.
    expect(one('[data-scrub-mode]')?.textContent).toContain('Comparing');
    await expect.poll(() => one('[data-transition]')?.getAttribute('data-transition')).toBe('1:4');
  });

  it('reflows in the comparison, which is exactly what the primary mode must not do', async () => {
    const before = coordinates();
    expect(Object.keys(before)).toHaveLength(4);

    const picker = one<HTMLSelectElement>('select[data-compare-from]');
    if (picker === null) throw new Error('the comparison picker must be rendered');
    picker.value = '1';
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    await expect
      .poll(() => one('[data-scrub-mode]')?.getAttribute('data-scrub-mode'))
      .toBe('compare');
    await expect.poll(() => all('[data-diff-node]').length).toBe(5);

    // The union of v1 and v4 is five nodes rather than the four v3∪v4 had, so
    // this is a different layout by construction — the full reflow AC8 names,
    // and the reason it is never the primary mode.
    expect(Object.keys(coordinates())).not.toEqual(Object.keys(before));
  });

  it('applies the four-way encoding in the comparison too', async () => {
    const picker = one<HTMLSelectElement>('select[data-compare-from]');
    if (picker === null) throw new Error('the comparison picker must be rendered');
    picker.value = '1';
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    await expect.poll(() => all('[data-diff-node]').length).toBe(5);
    expect(classes()['impl-checkout']).toBe('removed');
    expect(classes()['recon']).toBe('unchanged');
  });
});

suite('AC8 — the FLIP animation yields to prefers-reduced-motion', () => {
  it('animates the comparison by default, so the rule below switches something off', async () => {
    await commands.emulateMedia({ reducedMotion: 'no-preference' });
    shell = await mountAtEvolution();
    await drawn(4, 4);

    expect(one('[data-flip]')?.getAttribute('data-flip')).toBe('on');
  });

  it('renders the comparison directly under reduce', async () => {
    await commands.emulateMedia({ reducedMotion: 'reduce' });
    shell = await mountAtEvolution();
    await drawn(4, 4);

    expect(one('[data-flip]')?.getAttribute('data-flip')).toBe('off');

    // And it still arrives: nothing waits on an animation that is not playing.
    const picker = one<HTMLSelectElement>('select[data-compare-from]');
    if (picker === null) throw new Error('the comparison picker must be rendered');
    picker.value = '1';
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    await expect.poll(() => all('[data-diff-node]').length).toBe(5);
  });
});

suite('AC1 — the rail is read from the daemon, not guessed', () => {
  it('asks for the patches as well as the plans', async () => {
    shell = await mountAtEvolution();
    await drawn(4, 4);

    const paths = asked.map((request) => request.path);
    expect(paths.some((path) => path.endsWith('/plans'))).toBe(true);
    expect(paths.some((path) => path.endsWith('/patches'))).toBe(true);
    // And every refusal the endpoint reported is on the rail.
    expect(all('[data-rail-rejected]')).toHaveLength(
      PLAN_PATCHES.filter((row) => row.outcome === 'rejected').length,
    );
  });
});
