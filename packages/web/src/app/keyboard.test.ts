/**
 * KAR-16.1 — the keyboard map, driven with no pointer at all.
 *
 * Verifies: EPIC-16-S4 (scenarios 1 and 2) · AC7
 *
 * *"For hours-long work this is the accessibility feature you will personally
 * use most"* (docs/12-frontend-architecture.md §9.5). Eight keys, and the floor
 * underneath them: a skip-link that is the first focusable element, and a
 * visible focus ring on everything.
 *
 * The failure this file is written against is named in the epic's test plan:
 * *"handlers are bound to a component that is not always mounted"*. So the
 * third suite mounts the **whole application**, navigates it, and presses the
 * keys again — a map that only works on the landing route is the bug, and a map
 * asserted only against a directly-installed listener would never show it.
 *
 * Keys go in as real `KeyboardEvent`s on `document`, which is where the map
 * lives. `userEvent.keyboard` would type into whatever happens to be focused,
 * and half of what is under test here is precisely that the map does *not* fire
 * while the operator is typing. The one place `userEvent` is used is the tab
 * order, because "first in the tab order" is a claim about the browser's own
 * sequential navigation and cannot be asserted by calling `.focus()`.
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { freshUiStore, type MountedShell, mountShell } from '../../test/shell.ts';
import { INSPECTOR_OVERLAY, JUMPER_OVERLAY, MAIN_CONTENT_ID, SEARCH_INPUT_ID } from './ids.ts';
import { installKeyboardMap } from './keyboard.ts';

interface KeyboardInit {
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly on?: EventTarget;
}

const press = (key: string, init: KeyboardInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
  });
  (init.on ?? document).dispatchEvent(event);
  return event;
};

/**
 * A visible focus ring on `element`.
 *
 * `outline-style` is asserted **before** the width, and that is not belt and
 * braces: with `outline: none` Chromium still reports the specified
 * `outline-width` from `getComputedStyle`, so a width check on its own passes
 * against an element whose ring has been switched off — which is exactly the
 * `focus:outline-none` regression AC7 bans.
 */
function expectRing(element: HTMLElement): void {
  const style = getComputedStyle(element);

  expect(style.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThan(0);
  expect(style.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
}

const NODES = [
  { id: 'n_plan', title: 'Plan the work', status: 'completed' as const },
  { id: 'n_impl_1', title: 'Implement the reducer', status: 'running' as const },
  { id: 'n_impl_2', title: 'Implement the view', status: 'scheduled' as const },
];

suite('EPIC-16-S4 — the map an operator uses for hours (AC7)', () => {
  let ui: ReturnType<typeof freshUiStore>;
  let uninstall: () => void;

  beforeEach(() => {
    ui = freshUiStore();
    ui.setNodes(NODES);
    ui.setPlanVersions([1, 2, 3]);
    uninstall = installKeyboardMap(document, ui);
  });

  afterEach(() => uninstall());

  it('moves selection to the next node on "j"', () => {
    ui.selectNode('n_plan');

    press('j');

    expect(ui.selectedNodeId).toBe('n_impl_1');
  });

  it('moves selection to the previous node on "k"', () => {
    ui.selectNode('n_impl_2');

    press('k');

    expect(ui.selectedNodeId).toBe('n_impl_1');
  });

  it('does not fall off either end of the graph', () => {
    ui.selectNode('n_plan');
    press('k');
    expect(ui.selectedNodeId).toBe('n_plan');

    ui.selectNode('n_impl_2');
    press('j');
    expect(ui.selectedNodeId).toBe('n_impl_2');
  });

  it('selects the first node when nothing is selected yet', () => {
    press('j');

    expect(ui.selectedNodeId).toBe('n_plan');
  });

  it('opens the node inspector for the selected node on Enter', () => {
    ui.selectNode('n_impl_1');

    press('Enter');

    expect(ui.overlays).toEqual([INSPECTOR_OVERLAY]);
    expect(ui.inspectedNodeId).toBe('n_impl_1');
  });

  it('does not open an inspector for nothing', () => {
    press('Enter');

    expect(ui.overlays).toEqual([]);
  });

  it('steps the plan-version scrubber back on ArrowLeft and forward on ArrowRight', () => {
    ui.selectPlanVersion(2);

    press('ArrowLeft');
    expect(ui.planVersion).toBe(1);

    press('ArrowRight');
    press('ArrowRight');
    expect(ui.planVersion).toBe(3);

    // Clamped at both ends: a scrubber that walks past v3 renders a version
    // that does not exist.
    press('ArrowRight');
    expect(ui.planVersion).toBe(3);
    press('ArrowLeft');
    press('ArrowLeft');
    press('ArrowLeft');
    expect(ui.planVersion).toBe(1);
  });

  it('opens the run/node jumper on Cmd-K and on Ctrl-K', () => {
    press('k', { metaKey: true });
    expect(ui.overlays).toEqual([JUMPER_OVERLAY]);

    ui.closeTopOverlay();
    press('k', { ctrlKey: true });
    expect(ui.overlays).toEqual([JUMPER_OVERLAY]);
  });

  it('closes only the topmost overlay on Escape', () => {
    ui.openOverlay(INSPECTOR_OVERLAY);
    ui.openOverlay(JUMPER_OVERLAY);

    press('Escape');

    expect(ui.overlays).toEqual([INSPECTOR_OVERLAY]);

    press('Escape');
    expect(ui.overlays).toEqual([]);
  });

  it('claims the keys it handles, so the browser does not also act on them', () => {
    expect(press('/').defaultPrevented).toBe(true);
    expect(press('j').defaultPrevented).toBe(true);
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(press('k', { metaKey: true }).defaultPrevented).toBe(true);
  });

  it('leaves keys it does not own alone', () => {
    expect(press('a').defaultPrevented).toBe(false);
    expect(press('r', { metaKey: true }).defaultPrevented).toBe(false);
    expect(ui.overlays).toEqual([]);
  });

  it('gives the navigation keys to whichever overlay is open', () => {
    ui.selectNode('n_plan');
    ui.openOverlay(JUMPER_OVERLAY);

    // While the jumper is up, `j` and `k` move through *its* list. A map that
    // also moved the graph behind it would scroll two things at once.
    expect(press('j').defaultPrevented).toBe(false);
    expect(ui.selectedNodeId).toBe('n_plan');

    // Escape and Cmd-K still reach past it, because they are how you leave.
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(ui.overlays).toEqual([]);
  });
});

suite('EPIC-16-S4 — the map does not fire while the operator is typing', () => {
  let ui: ReturnType<typeof freshUiStore>;
  let uninstall: () => void;
  let field: HTMLInputElement;

  beforeEach(() => {
    ui = freshUiStore();
    ui.setNodes(NODES);
    uninstall = installKeyboardMap(document, ui);
    field = document.createElement('input');
    document.body.append(field);
    field.focus();
  });

  afterEach(() => {
    uninstall();
    field.remove();
  });

  it('lets "j" and "/" through to a focused text field', () => {
    expect(press('j', { on: field }).defaultPrevented).toBe(false);
    expect(press('/', { on: field }).defaultPrevented).toBe(false);
    expect(ui.selectedNodeId).toBeNull();
  });

  it('still answers Escape and Cmd-K, which are how you get out of a field', () => {
    ui.openOverlay(JUMPER_OVERLAY);

    press('Escape', { on: field });
    expect(ui.overlays).toEqual([]);

    press('k', { on: field, metaKey: true });
    expect(ui.overlays).toEqual([JUMPER_OVERLAY]);
  });
});

suite('EPIC-16-S4 — the map is the application’s, not one component’s', () => {
  let shell: MountedShell;

  beforeEach(async () => {
    shell = await mountShell();
    shell.ui.setNodes(NODES);
    shell.ui.setPlanVersions([1, 2, 3]);
  });

  afterEach(() => shell.unmount());

  it('focuses the search field on "/" wherever the app is', async () => {
    press('/');

    expect(document.activeElement?.id).toBe(SEARCH_INPUT_ID);
  });

  it('still answers after a route change, not only on the landing route', async () => {
    await shell.router.push({ name: 'plan-evolution', params: { runId: 'r_01JXQ' } });

    press('j');
    expect(shell.ui.selectedNodeId).toBe('n_plan');

    press('k', { metaKey: true });
    expect(shell.ui.overlays).toEqual([JUMPER_OVERLAY]);
  });

  it('stops listening once the app is unmounted', () => {
    shell.unmount();

    press('j');

    expect(shell.ui.selectedNodeId).toBeNull();
  });
});

suite('EPIC-16-S4 — the floor under all of it (scenario 2)', () => {
  let shell: MountedShell;

  beforeEach(async () => {
    shell = await mountShell();
  });

  afterEach(() => shell.unmount());

  it('reaches the skip-link with the very first Tab, and rings it', async () => {
    await userEvent.tab();

    const focused = document.activeElement as HTMLElement;
    expect(focused.tagName).toBe('A');
    expect(focused.getAttribute('href')).toBe(`#${MAIN_CONTENT_ID}`);
    expect(focused.textContent).toMatch(/skip/i);

    // The ring, asserted where it actually lives: `:focus-visible` matched by
    // the engine after real sequential navigation, not a rule read out of a
    // stylesheet.
    expect(focused.matches(':focus-visible')).toBe(true);
    expectRing(focused);
  });

  it('points at a main element that can actually take focus', async () => {
    const main = document.getElementById(MAIN_CONTENT_ID);

    expect(main).not.toBeNull();
    // `tabindex="-1"`, because an anchor that scrolls the viewport without
    // moving focus leaves a keyboard user exactly where they were.
    expect(main?.getAttribute('tabindex')).toBe('-1');
    expect(main?.tagName).toBe('MAIN');
  });

  it('rings the search field too, so the ring is not one element’s special case', async () => {
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();

    const focused = document.activeElement as HTMLElement;
    expect(focused.matches(':focus-visible')).toBe(true);
    expectRing(focused);
  });
});
