/**
 * KAR-25.1 AC6, EPIC-25-S05 — "Workspace" is renamed, not partially renamed.
 *
 * Verifies: EPIC-25-S05
 *
 * Modelled on `./one-terminal-facade.test.ts`: the enforcing script is
 * `packages/web/scripts/check-workspace-word.ts`, run by `pnpm lint`; this is
 * the same rule at the level that fails a suite, plus the two other clauses
 * the scenario states — the route's new name exists, the old one does not, and
 * a rename that missed a reference is a type error rather than a silent dead
 * row.
 */
import { expect, it, describe as suite } from 'vitest';
import { stripComments, webSourceFiles } from '../packages/web/scripts/check-graph-facade.ts';
import { workspaceWordViolations } from '../packages/web/scripts/check-workspace-word.ts';

const sources = webSourceFiles();

/**
 * `../packages/web/src/router/index.ts`'s own text, read rather than
 * imported: importing it pulls in `PlanGraphView.vue` and `RunListView.vue`
 * as real ES modules, which the `unit` project's plain Node environment has
 * no `.vue` transform for (`@vitejs/plugin-vue` is only wired into the `web`
 * project's browser config). A router file this guard cares about only as
 * text is exactly the case `webSourceFiles()` already exists for.
 */
const routerSource = stripComments(
  sources.find((file) => file.path === 'src/router/index.ts')?.text ?? '',
);

suite('EPIC-25-S05 — the word, gone from everywhere a person can read it', () => {
  it('has sources to check, so a passing rule is not a rule over nothing', () => {
    expect(sources.length).toBeGreaterThan(30);
  });

  it('finds no violation in the real tree', () => {
    const violations = workspaceWordViolations(sources);
    expect(violations.map((one) => one.where)).toEqual([]);
  });

  it('would catch a heading that said the word, so the rule above is not vacuous', () => {
    const planted = workspaceWordViolations([
      ...sources,
      {
        path: 'src/views/SneakyView.vue',
        text: '<template>\n  <h1>Workspace</h1>\n</template>\n',
      },
    ]);

    expect(planted.map((one) => one.where)).toEqual(['src/views/SneakyView.vue']);
  });

  it('does not fire on internal identifiers or class names the word boundary already excludes', () => {
    const planted = workspaceWordViolations([
      {
        path: 'src/views/FineView.vue',
        text: [
          "<script setup lang='ts'>",
          'interface WorkspaceApi { readonly noop: true }',
          '</script>',
          '<template>',
          '  <div class="workspace__head" data-workspace-empty>fine</div>',
          '</template>',
        ].join('\n'),
      },
    ]);

    expect(planted).toEqual([]);
  });
});

suite('EPIC-25-S05 — the route rename is complete', () => {
  it('names the route "project-workflows" and not "project-workspace"', () => {
    expect(routerSource.length).toBeGreaterThan(0);
    expect(routerSource).toContain("name: 'project-workflows'");
    expect(routerSource).not.toContain("name: 'project-workspace'");
  });

  it('has no file left named after the old screen', () => {
    expect(sources.some((file) => file.path.endsWith('ProjectWorkspaceView.vue'))).toBe(false);
    expect(sources.some((file) => file.path.endsWith('ProjectWorkflowsView.vue'))).toBe(true);
  });
});
