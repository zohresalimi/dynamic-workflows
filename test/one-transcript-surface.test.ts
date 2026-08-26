/**
 * KAR-28.2 AC3 — a node's transcript has exactly one renderer, and the agent
 * list reaches it rather than growing another.
 *
 * Verifies: EPIC-28-S10
 *
 * > Every row carries an **output** control that opens that node's transcript —
 * > the existing `run-node-output` route or the docked inspector, not a third
 * > renderer.
 *
 * Modelled on `./one-workspace-surface.test.ts` and `./one-terminal-facade.test.ts`
 * beside it, and it exists for the same reason they do: the failure it guards
 * against is not dramatic. Somebody needs a node's output on a new surface,
 * copies eighty lines of `NodeOutputPanel` rather than linking to it, and for a
 * month the two agree. Then the follow-tail rule changes in one of them, or the
 * archive fallback, or the scrollback budget — and the bug reads as "the output
 * stops updating sometimes", which nobody can reproduce.
 *
 * The three renderers are the ones that actually put a transcript on a screen:
 * `AgentMessageList` (the typed ACP list), `NodeTerminal` (xterm) and
 * `FullLogViewer` (the archive). All three are `NodeOutputPanel`'s, and that
 * panel is `NodeOutputView`'s, and that view is the `run-node-output` route's.
 * One chain, asserted end to end, so a second mount site anywhere fails here.
 */
import { expect, it, describe as suite } from 'vitest';
import { stripComments, webSourceFiles } from '../packages/web/scripts/check-graph-facade.ts';

const sources = webSourceFiles();

/** Comments stripped, so naming the rule is never a breach of it. */
const bodies = sources
  .filter((file) => !file.path.endsWith('.test.ts'))
  .map((file) => ({ path: file.path, text: stripComments(file.text) }));

const importersOf = (name: string): string[] =>
  bodies.filter((file) => file.text.includes(name)).map((file) => file.path);

const PANEL = 'src/components/output/NodeOutputPanel.vue';

suite('EPIC-28-S10 — one transcript renderer', () => {
  it('scans a real tree, so a clean result is not an empty one', () => {
    expect(sources.length).toBeGreaterThan(30);
    expect(bodies.some((file) => file.path === PANEL)).toBe(true);
  });

  it('has exactly one module that mounts the three transcript renderers', () => {
    for (const renderer of ['AgentMessageList.vue', 'NodeTerminal.vue', 'FullLogViewer.vue']) {
      expect(importersOf(renderer), `${renderer} is mounted more than once`).toEqual([PANEL]);
    }
  });

  it('has exactly one module that mounts the panel, and it is the route’s view', () => {
    expect(importersOf('NodeOutputPanel.vue')).toEqual(['src/views/NodeOutputView.vue']);
    // And exactly one route reaches that view.
    const router = bodies.find((file) => file.path === 'src/router/index.ts')?.text ?? '';
    expect(router.match(/'run-node-output'/g)).toHaveLength(1);
    expect(router).toContain('NodeOutputView.vue');
  });

  it('opens the agent list’s rows through that route rather than a renderer', () => {
    const list = bodies.find((file) => file.path === 'src/components/TaskBoard.vue')?.text ?? '';

    expect(list, 'the agent list must offer an output control').toContain('run-node-output');
    // AC3's "not a third renderer", stated over the file that would grow one.
    for (const renderer of [
      'NodeOutputPanel',
      'AgentMessageList',
      'NodeTerminal',
      'FullLogViewer',
    ]) {
      expect(list, `the agent list renders ${renderer} itself`).not.toContain(renderer);
    }
  });
});
