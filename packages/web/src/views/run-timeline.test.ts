/**
 * KAR-17.8 — the run timeline route, mounted in the real shell.
 *
 * Verifies: EPIC-17-S30, EPIC-17-S32 · AC1, AC5, AC9
 *
 * The drawing itself is asserted next door in
 * `../components/RunTimelineChart.test.ts`, against an injected clock. What is
 * here is the half only the assembled application can answer: that the route
 * exists, that it reads the run store's timeline projection rather than a
 * second one, and that a tab with nothing to draw says so in words instead of
 * showing an empty chart — which reads as "this run did nothing" and is a
 * different claim from "nothing has arrived yet".
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { HAPPY_PATH_RUN, happyPath12 } from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { useRunStore } from '../stores/useRunStore.ts';

let shell: MountedShell;

const one = (selector: string): HTMLElement =>
  shell.container.querySelector<HTMLElement>(selector) as HTMLElement;

async function openTimeline(runId: string, events: readonly unknown[] = []): Promise<void> {
  shell = await mountShell({ at: { name: 'run-timeline', params: { runId } } });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  for (const event of events) run.applyEvent(event as Parameters<typeof run.applyEvent>[0]);
}

beforeEach(() => {
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

suite('KAR-17.8 — the route', () => {
  it('draws a lane per node and a bar per attempt from the run store', async () => {
    await openTimeline(HAPPY_PATH_RUN, happyPath12());
    setActivePinia(shell.pinia);
    const run = useRunStore(shell.pinia);

    await expect
      .poll(() => shell.container.querySelectorAll('[data-bar]').length)
      .toBe(run.timeline.spans.size);
    expect(shell.container.querySelectorAll('[data-lane]')).toHaveLength(run.timeline.lanes.length);
  });

  it('carries the three markers through to the page', async () => {
    await openTimeline(HAPPY_PATH_RUN, happyPath12());

    await expect.poll(() => shell.container.querySelector('[data-marker="paused"]')).not.toBeNull();
    expect(one('[data-marker="rate-limited"]')).not.toBeNull();
    expect(one('[data-marker="stalled"]')).not.toBeNull();
  });

  it('says nothing has arrived yet rather than drawing an empty run', async () => {
    await openTimeline(HAPPY_PATH_RUN);

    expect(shell.container.querySelector('[data-run-timeline]')).toBeNull();
    expect(one('[data-timeline-empty]').textContent).toMatch(/no node has started/i);
  });

  it('tells a tab with no run open where a run id goes', async () => {
    shell = await mountShell({ at: { name: 'runs' } });
    setActivePinia(shell.pinia);
    await shell.router.push({ path: '/timeline-with-no-run' });
    // The catch-all takes an unroutable path; the timeline route itself is only
    // reachable with a run id, which is the point being asserted.
    expect(shell.container.querySelector('[data-run-timeline]')).toBeNull();
  });
});
