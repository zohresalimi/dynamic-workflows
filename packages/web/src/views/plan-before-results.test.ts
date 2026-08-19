/**
 * KAR-19.3 AC6 / EPIC-19-S17 — the graph is drawn as it is compiled, not after
 * the first node result.
 *
 * *"No plan yet. A run's graph appears here as soon as its first plan is
 * compiled."* was the honest report of an empty ledger on 2026-08-12, and the
 * operator read it for an afternoon. The **other half** of that sentence — that
 * a compiled plan draws itself immediately — had never been exercised against a
 * live compilation, because until KAR-19.3 there was no live compilation to
 * exercise it with. This file asserts it the only way a browser can: fold a
 * recorded ledger **up to and including its first `plan.proposed`** and nothing
 * after it, then look at the DOM.
 *
 * The prefix is the whole design of the spec. Every other plan-graph suite
 * folds a complete recording, in which the nodes are drawn *and* every one of
 * them has a result — so a view that quietly waited for a `node.started` before
 * drawing would pass all of them. Cutting the recording at the compilation is
 * what makes the wait observable.
 *
 * Events come from the recorded fixture through the production `parseEvent`,
 * never hand-written (see `test/fixture-events.ts`): a spec that fed the store
 * a shape nothing on the wire produces would keep passing after the payload
 * changed underneath it.
 *
 * Verifies: EPIC-19-S17 · KAR-19.3 AC6 · test plan #6
 */
import type { Event } from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { HAPPY_PATH_RUN, happyPath12 } from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';

/** KAR-25.1 — the run views are project-scoped now; the value is never
 * asserted on, only threaded through so the named route resolves. */
const PROJECT_ID = 'prj_test';

import { useRunStore } from '../stores/useRunStore.ts';

let shell: MountedShell;

/** The recording, cut after the first event of `kind` — inclusive. */
function upToFirst(kind: string): readonly Event[] {
  const events = happyPath12();
  const at = events.findIndex((event) => event.kind === kind);
  if (at === -1) throw new Error(`the happy-path recording holds no ${kind}`);
  return events.slice(0, at + 1);
}

/** Folds `events` into a freshly mounted run store and lets the layout settle. */
async function open(events: readonly Event[]): Promise<void> {
  shell = await mountShell({
    at: { name: 'run-plan', params: { projectId: PROJECT_ID, runId: HAPPY_PATH_RUN } },
  });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  for (const event of events) run.applyEvent(event);
}

const bodies = (): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>('[data-plan-node]'),
];

beforeEach(() => {
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-19-S17 — a plan with no results yet is still a plan', () => {
  it('renders the compiled nodes with no node.started anywhere in the prefix', async () => {
    const prefix = upToFirst('plan.proposed');

    // The premise, asserted rather than assumed: if the recording happened to
    // start a node before it compiled its plan, everything below would be
    // proving something else entirely.
    expect(prefix.some((event) => event.kind === 'node.started')).toBe(false);
    expect(prefix.some((event) => event.kind === 'node.completed')).toBe(false);

    await open(prefix);

    // The graph is drawn from the plan document itself. `plan.proposed` is the
    // only event in the prefix that carries one, so every node on screen came
    // from the compilation and from nothing else.
    await expect.poll(() => bodies().length, { timeout: 15_000 }).toBeGreaterThan(1);
    expect(shell.container.textContent).not.toContain('No plan yet');
  });

  it('and the assertion discriminates: without the compilation, the empty state is what shows', async () => {
    // The negative control. Without it, "four nodes are rendered" could be true
    // of a view that renders four of anything, and the suite above would be
    // green against the very ledger the incident produced.
    const before = upToFirst('plan.proposed').slice(0, -1);
    await open(before);

    expect(bodies()).toHaveLength(0);
    await expect.poll(() => shell.container.textContent ?? '').toContain('No plan yet');
  });

  it('adds the patched version’s nodes without remounting the ones already drawn', async () => {
    const compiled = upToFirst('plan.proposed');
    await open(compiled);
    await expect.poll(() => bodies().length, { timeout: 15_000 }).toBeGreaterThan(1);

    const before = bodies().map((body) => body.dataset.planNode ?? '');
    const firstBody = bodies()[0] as HTMLElement;

    const run = useRunStore(shell.pinia);
    for (const event of upToFirst('plan.patched').slice(compiled.length)) run.applyEvent(event);

    await expect
      .poll(() => bodies().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(before.length);

    // Every node that was on screen is still on screen…
    const after = bodies().map((body) => body.dataset.planNode ?? '');
    for (const id of before) expect(after).toContain(id);
    // …and it is the *same element*, not a re-created one. That is what "without
    // a full re-layout" means in a DOM: a patched version that tore the graph
    // down and rebuilt it would lose scroll, selection and every running node's
    // output pane, which is the opposite of watching a run.
    expect(bodies()[after.indexOf(before[0] ?? '')]).toBe(firstBody);
  });
});
