/**
 * KAR-16.6 AC1 — `GraphCanvas.vue` is the only file in `packages/web/src` that
 * imports `@vue-flow/core`, and a lint rule fails the build on any other
 * importer.
 *
 * Verifies: EPIC-16-S35 (scenario 1) · AC1
 *
 * Vue Flow is the single largest third-party risk in the frontend (A3-1,
 * **High**): last npm release 2026-01-28, effectively one maintainer, an
 * unreleased `next-release` branch, no announced v2 and no Vue 3.6 statement.
 * The facade is what turns that from a rewrite into a one-file swap — and a
 * facade is only a facade while nothing reaches past it, which is a property
 * nobody can hold in their head across nine views.
 *
 * The rule is a **grep with an exemption list**, not an ESLint rule, and that
 * is a deliberate choice rather than a shortcut: oxlint sees only the
 * `<script>` block of an SFC (docs/CONTRIBUTING.md), and every consumer at
 * risk here *is* an SFC. A `no-restricted-imports` entry pointed at
 * `packages/web/**` would be inert against exactly the files it is meant to
 * cover, and inert-but-configured is worse than absent.
 *
 * The test plan's red is *"the rule matches only the default export"*. So the
 * fixtures below are every spelling that reaches Vue Flow — a named import, a
 * type-only import, a side-effect import, a re-export, a dynamic `import()`,
 * a subpath, and the style block's `@import` of its stylesheet — and each one
 * is asserted to be caught by file name.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  CASCADE_OWNER,
  FACADE,
  graphFacadeViolations,
  RENDERER_STYLESHEET,
  webSourceFiles,
} from '../packages/web/scripts/check-graph-facade.ts';

/** A source file as the rule sees it: a repo-relative path and its text. */
const file = (path: string, text: string) => ({ path, text });

suite('AC1 — every way of reaching Vue Flow is caught', () => {
  it.each([
    ['a default import', "import VueFlow from '@vue-flow/core';"],
    ['a named import', "import { VueFlow, useVueFlow } from '@vue-flow/core';"],
    ['a type-only import', "import type { GraphNode } from '@vue-flow/core';"],
    ['an inline type import', "import { type Node, VueFlow } from '@vue-flow/core';"],
    ['a side-effect import', "import '@vue-flow/core/dist/style.css';"],
    ['a re-export', "export { VueFlow } from '@vue-flow/core';"],
    ['a star re-export', "export * from '@vue-flow/core';"],
    ['a dynamic import', "const flow = await import('@vue-flow/core');"],
    ['a subpath import', "import { Background } from '@vue-flow/core/background';"],
    ['a require', "const flow = require('@vue-flow/core');"],
    ['a double-quoted import', 'import { VueFlow } from "@vue-flow/core";'],
    ['a CSS @import', "@import '@vue-flow/core/dist/style.css';"],
  ])('refuses %s from a view', (_what, line) => {
    const violations = graphFacadeViolations([file('src/views/PlanGraphView.vue', line)]);

    expect(violations).toHaveLength(1);
    // Naming the file is half the rule: a build that fails with "something
    // imports Vue Flow" sends you grepping for what the rule already knows.
    expect(violations[0]?.where).toBe('src/views/PlanGraphView.vue');
    expect(violations[0]?.message).toContain(FACADE);
  });

  it('allows the facade itself, which is the point of having one', () => {
    expect(
      graphFacadeViolations([
        file(FACADE, "import { VueFlow, type NodeProps } from '@vue-flow/core';"),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['the minimap', "import { MiniMap } from '@vue-flow/minimap';"],
    ['the controls', "import { Controls } from '@vue-flow/controls';"],
    ["the minimap's stylesheet", "import '@vue-flow/minimap/dist/style.css';"],
  ])('refuses %s too, because the scope is the boundary and not the package', (_what, line) => {
    // KAR-17.1 AC9 brought two addons into the facade — a minimap and zoom
    // controls — and both reach the renderer's store through `useVueFlow`. A
    // rule that guarded only `@vue-flow/core` would leave a view able to import
    // `@vue-flow/minimap`, hold the same store, and make the swap this facade
    // exists to protect a two-file change again. The boundary is the scope.
    const violations = graphFacadeViolations([file('src/views/PlanGraphView.vue', line)]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('src/views/PlanGraphView.vue');
    expect(violations[0]?.message).toContain(FACADE);
  });

  it('says nothing about a file that never mentions it', () => {
    expect(
      graphFacadeViolations([file('src/views/PlanGraphView.vue', "import { ref } from 'vue';")]),
    ).toEqual([]);
  });

  it('does not fire on the words in a comment about the facade', () => {
    // `PlanGraphView.vue` explains *why* it goes through the facade. Matching
    // the prose would force the explanation to be deleted, which is backwards.
    const prose = [
      '/**',
      ' * Renders through GraphCanvas rather than @vue-flow/core directly:',
      ' * the facade is the one-file swap AC1 is about.',
      ' */',
      "import GraphCanvas from '../components/graph/GraphCanvas.vue';",
    ].join('\n');

    expect(graphFacadeViolations([file('src/views/PlanGraphView.vue', prose)])).toEqual([]);
  });

  it('allows the one stylesheet line the cascade owner holds, and nothing else in it', () => {
    // The renderer's own sheet is `@import`ed from `src/styles/theme.css`
    // rather than from the facade, because two rules below it override it —
    // the reduced-motion block and the node border colour — and an override
    // only wins at equal specificity if it comes later in the cascade, which a
    // component-level import order does not guarantee (KAR-16.1). That is one
    // line in one stylesheet, it is named here so a swap knows to delete it,
    // and it buys no general licence:
    expect(
      graphFacadeViolations([file(CASCADE_OWNER, `@import "${RENDERER_STYLESHEET}";`)]),
    ).toEqual([]);

    const violations = graphFacadeViolations([
      file(CASCADE_OWNER, "@import '@vue-flow/core/dist/theme-default.css';"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe(CASCADE_OWNER);
  });

  it('reports every offender rather than the first', () => {
    const violations = graphFacadeViolations([
      file('src/views/PlanGraphView.vue', "import { VueFlow } from '@vue-flow/core';"),
      file('src/components/MiniMap.vue', "import { useVueFlow } from '@vue-flow/core';"),
    ]);

    expect(violations.map((violation) => violation.where)).toEqual([
      'src/views/PlanGraphView.vue',
      'src/components/MiniMap.vue',
    ]);
  });
});

suite('AC1 — the rule, run over the real tree', () => {
  const sources = webSourceFiles();

  it('scans a real set of files, so a clean result is not an empty one', () => {
    expect(sources.length).toBeGreaterThan(30);
    // The control: the facade is in the scanned set and it *does* import Vue
    // Flow, so the scan is looking at the right text.
    const facade = sources.find((source) => source.path === FACADE);
    expect(facade?.text ?? '').toContain('@vue-flow/core');
  });

  it('finds exactly one importer, and it is the facade', () => {
    const importers = sources
      .filter((source) => source.text.includes('@vue-flow/core'))
      .map((source) => source.path)
      .filter((path) => graphFacadeViolations(sources.filter((s) => s.path === path)).length > 0);

    expect(importers).toEqual([]);
    expect(graphFacadeViolations(sources)).toEqual([]);
  });
});
