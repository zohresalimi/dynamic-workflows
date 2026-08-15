/**
 * KAR-22.3 AC1, AC3 — the control center reuses the frontend EPIC-16 and
 * EPIC-17 built, and does not grow a second copy of any of it.
 *
 * Verifies: EPIC-22-S35 · test plan #2
 *
 * The epic is explicit that *"a second graph canvas, a second run store, a
 * second projection set or a second API client"* is out of scope, and that
 * "they can never disagree" should be **a test rather than an intention**. The
 * failure this guards against is not dramatic: somebody needing the plan graph
 * in a project workspace copies eighty lines of `PlanGraphView` rather than
 * mounting it, and for a month the two agree. Then a palette changes in one of
 * them, or a reduced-motion rule, or a memoisation cache — and the bug reads as
 * "the board flickers", which nobody can reproduce.
 *
 * `test/one-vue-flow-importer.test.ts` beside this one owns the renderer half
 * in depth (every spelling of an import, over the real tree). What is added
 * here is the other three singletons and, crucially, the claim about **this
 * epic's own views**: that they import the shared modules rather than copies.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import {
  FACADE,
  graphFacadeViolations,
  webSourceFiles,
} from '../packages/web/scripts/check-graph-facade.ts';

const sources = webSourceFiles();

/** Comments stripped, so an explanation of the rule is not a breach of it. */
const code = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

const bodies = (predicate: (path: string) => boolean): { path: string; text: string }[] =>
  sources.filter((file) => predicate(file.path) && !file.path.endsWith('.test.ts'));

const fileNamed = (path: string): string => {
  const found = sources.find((file) => file.path === path);
  if (found === undefined) throw new Error(`${path} does not exist in packages/web/src`);
  return code(found.text);
};

/** The views and components KAR-22.3 adds, which are the ones at risk. */
const WORKSPACE_VIEW = 'src/views/ProjectWorkspaceView.vue';
const TASK_BOARD = 'src/components/TaskBoard.vue';

suite('EPIC-22-S35 — exactly one canvas, one run store, one client', () => {
  it('scans a real tree, so a clean result is not an empty one', () => {
    expect(sources.length).toBeGreaterThan(30);
  });

  it('has exactly one module importing the renderer, and it is the facade', () => {
    const importers = sources.filter((file) => file.text.includes('@vue-flow/'));

    expect(importers.map((file) => file.path)).toContain(FACADE);
    // Everything else that mentions it does so in prose or in a stylesheet the
    // rule names; the rule itself is the arbiter.
    expect(graphFacadeViolations(sources)).toEqual([]);
  });

  it('has exactly one run store module', () => {
    // The store is a Pinia setup store, so "how many run stores are there" is
    // answerable exactly: `defineStore('run'` appears once in the package.
    const definers = bodies(() => true).filter((file) => file.text.includes("defineStore('run'"));

    expect(definers.map((file) => file.path)).toEqual(['src/stores/useRunStore.ts']);
  });

  it('has exactly one API client module', () => {
    // `hc<ApiType>` is the only way a typed client comes into existence, and a
    // second call to it would be a second base URL and a second token policy.
    const builders = bodies(() => true).filter((file) => code(file.text).includes('hc<ApiType>'));

    expect(builders.map((file) => file.path)).toEqual(['src/api/client.ts']);
  });

  it('has exactly one projection set', () => {
    // Nine reducers behind one barrel. A second `PROJECTIONS` array would be a
    // second fold of the same events into a set nothing renders from.
    const sets = bodies(() => true).filter((file) => /export const PROJECTIONS\b/.test(file.text));

    expect(sets.map((file) => file.path)).toEqual(['src/ledger/projections/index.ts']);
  });
});

suite("EPIC-22-S35 — this epic's views import those, and not copies of them", () => {
  it('renders the graph through the existing plan-graph view rather than a new canvas', () => {
    const workspace = fileNamed(WORKSPACE_VIEW);

    expect(workspace).toContain('PlanGraphView.vue');
    // Not through the renderer, and not through the facade either: a second
    // mount site for `GraphCanvas` would be a second copy of the node-body
    // join, the selection wiring and the empty-state text.
    expect(workspace).not.toContain('@vue-flow/');
    expect(workspace).not.toContain('GraphCanvas.vue');
  });

  it('takes its rows from the shared node-body join, not from a board-only one', () => {
    const board = fileNamed(TASK_BOARD);
    const workspace = fileNamed(WORKSPACE_VIEW);
    const graph = fileNamed('src/views/PlanGraphView.vue');

    // AC3 with teeth. The graph and the workspace both read the **one**
    // composable — which hands every caller the same object — and the board
    // renders what its caller passes it. So "two views of one projection" is a
    // property of the module graph rather than a claim in a comment.
    expect(workspace).toContain('useNodeBodies');
    expect(graph).toContain('useNodeBodies');

    // The board derives nothing: no join, no store, no fold, no second read of
    // the projections. A board that reached for the store could be given a
    // different tick's answer than the graph beside it.
    expect(board).not.toContain('toNodeBody');
    expect(board).not.toContain('useNodeBodies');
    expect(board).not.toContain('useRunStore');
    expect(board).not.toContain('applyEvent');
  });

  it('leaves reduction where it belongs', () => {
    // The repository's own rule, restated over the two files this story adds:
    // no reducer may live outside `ledger/projections/`.
    for (const path of [WORKSPACE_VIEW, TASK_BOARD]) {
      expect(fileNamed(path), `${path} reduces events`).not.toMatch(/case '[a-z]+\.[a-z.]+':/);
    }
  });

  it('adds no second copy of a module it reuses', () => {
    // A crude but total check: no file this epic adds may be a near-duplicate
    // of one it is meant to reuse. Anything named like the originals would be
    // the first symptom.
    const names = readdirSync(join(import.meta.dirname, '../packages/web/src/components/graph'));
    expect(names.filter((name) => /Canvas/.test(name)).toSorted()).toEqual([
      'GraphCanvas.stub.vue',
      'GraphCanvas.test.ts',
      'GraphCanvas.vue',
    ]);
    // And the stub is what the bundle-budget spec swaps in, not a second
    // renderer: it imports nothing from the renderer at all.
    const stub = readFileSync(
      join(import.meta.dirname, '../packages/web/src/components/graph/GraphCanvas.stub.vue'),
      'utf8',
    );
    expect(stub).not.toContain('@vue-flow/');
  });
});
