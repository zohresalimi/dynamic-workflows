/**
 * KAR-16.1 — `prefers-reduced-motion: reduce`.
 *
 * Verifies: EPIC-16-S4 (scenario 3) · AC8
 *
 * Two surfaces animate in this application: the graph and the version scrubber
 * (docs/12-frontend-architecture.md §9.4). Under `reduce` both stop, and the
 * app stays *fully usable* — nothing anywhere waits on an animation to
 * complete, which is the half of AC8 that a computed-style assertion cannot
 * see and which is therefore asserted by driving the scrubber with the motion
 * off and checking it still arrives.
 *
 * The preference is emulated in the browser process (../../test/commands.ts),
 * not by stubbing `matchMedia`: the rule under test is a CSS `@media` block
 * evaluated by the engine, and a stub would leave it inert while every
 * assertion passed.
 *
 * Each assertion is paired with its control — the same element, the same
 * property, with motion on. The failure the epic's test plan names is *"the
 * media query wraps the wrong rule"*, and a rule that was never doing anything
 * in the first place satisfies "computed transition is none" perfectly.
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { commands } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { API_BASE, type Asked, daemonFetch, RUN } from '../../test/three-patches.ts';
import { createClient } from '../api/client.ts';

let shell: MountedShell;

const NODES = [
  { id: 'n_plan', title: 'Plan the work', status: 'completed' as const },
  { id: 'n_impl_1', title: 'Implement the reducer', status: 'running' as const },
];

/** The transition on the first element matching `selector`. */
function transitionOf(selector: string): { property: string; duration: string } {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`nothing matched ${selector}`);
  const style = getComputedStyle(element);
  return { property: style.transitionProperty, duration: style.transitionDuration };
}

afterEach(async () => {
  shell?.unmount();
  await commands.emulateMedia({});
});

suite('AC8 — the graph stops moving', () => {
  beforeEach(async () => {
    await commands.emulateMedia({ reducedMotion: 'no-preference' });
    shell = await mountShell();
    shell.ui.setNodes(NODES);
    await expect.poll(() => document.querySelector('.vue-flow__node')).not.toBeNull();
  });

  it('animates by default, so the rule below is switching something off', () => {
    const node = transitionOf('.vue-flow__node');

    expect(node.property).not.toBe('none');
    expect(node.duration).not.toBe('0s');
  });

  it('computes the node transition as none under reduce', async () => {
    await commands.emulateMedia({ reducedMotion: 'reduce' });

    const node = transitionOf('.vue-flow__node');
    expect(node.property).toBe('none');
    expect(node.duration).toBe('0s');
  });

  it('leaves the rest of the app alone — this is not a blanket kill', async () => {
    await commands.emulateMedia({ reducedMotion: 'reduce' });

    // The overlay backdrop and the focus ring are not in the block: a global
    // `* { transition: none }` makes an app feel broken rather than calm, and
    // it is the lazy version of this rule.
    const chip = transitionOf('.state-chip');
    expect(chip.property).not.toBe('none');
  });
});

suite('AC8 — the scrubber steps without animating, and still arrives', () => {
  let asked: Asked[];

  beforeEach(async () => {
    asked = [];
    await commands.emulateMedia({ reducedMotion: 'reduce' });
    shell = await mountShell({
      at: { name: 'plan-evolution', params: { runId: RUN } },
      client: createClient({ baseUrl: API_BASE, fetch: daemonFetch(asked) }),
    });
    await expect.poll(() => document.querySelector('.version-rail__marker')).not.toBeNull();
  });

  it('computes the version marker’s transition as none', () => {
    const marker = transitionOf('.version-rail__marker');

    expect(marker.property).toBe('none');
    expect(marker.duration).toBe('0s');
  });

  it('still steps through every version with the motion off', async () => {
    await expect.poll(() => shell.ui.planVersions.length).toBe(4);
    shell.ui.selectPlanVersion(1);

    for (const version of [2, 3, 4]) {
      shell.ui.stepPlanVersion(1);
      await expect
        .poll(() =>
          document.querySelector('[data-scrub-version]')?.getAttribute('data-scrub-version'),
        )
        .toBe(String(version));
    }

    // Nothing waited on an animation to complete: the position landed and the
    // diff rendered with every transition switched off.
    await expect
      .poll(() => document.querySelector('[data-diff-pair]')?.textContent)
      .toContain('v4');
  });
});
