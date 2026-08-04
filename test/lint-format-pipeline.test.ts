/**
 * KAR-01.5 — the lint and format pipeline's static shape, applied to the real
 * repository: biome.json's ownership split, .oxlintrc.json's plugins and
 * type-aware rules, and the "lint"/"format" scripts that wire them up.
 *
 * The real subprocess behaviour (a floating promise actually firing, a
 * misformatted .vue file actually changing) lives in
 * test/integration/lint-format-pipeline.test.ts — this file only checks that
 * the configuration says what it must say.
 *
 * Verifies: EPIC-01-S22 · AC1, AC2, AC3, AC4, AC7, AC8; test plan #1, #5, #6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkBiomeOwnershipSplit,
  checkExactCatalogPins,
  checkLintFormatScripts,
  checkOxlintConfig,
  type OxlintConfig,
  describe as render,
} from './support/guards.ts';
import { readJson, readText, readWorkspaceYaml } from './support/workspace.ts';

suite('biome.json (AC1, EPIC-01-S22 scenario 1)', () => {
  it('declares the ownership split: oxlint lints, Biome formats, .vue is opted in', () => {
    expect(render(checkBiomeOwnershipSplit(readJson('biome.json')))).toBe('');
  });
});

suite('.oxlintrc.json (AC2, EPIC-01-S20 background)', () => {
  it('enables the required plugins, categories and type-aware rules', () => {
    // .oxlintrc.json carries explanatory comments, which JSON.parse cannot
    // read — strip whole-line comments the same way test/support/workspace.ts
    // does for tsconfig.json, rather than teaching this one file JSONC.
    const withoutComments = readText('.oxlintrc.json')
      .split('\n')
      .map((line) => (/^\s*\/\//.test(line) ? '' : line))
      .join('\n');
    expect(render(checkOxlintConfig(JSON.parse(withoutComments) as OxlintConfig))).toBe('');
  });
});

suite('package.json scripts (AC3, AC4)', () => {
  it('"lint" runs oxlint --type-aware and biome check; "format" runs biome check --write', () => {
    expect(render(checkLintFormatScripts(readJson('package.json')))).toBe('');
  });
});

suite('@biomejs/biome is pinned exact (AC8, test plan #6)', () => {
  it('the catalog entry carries no ^ or ~', () => {
    const catalog = readWorkspaceYaml().catalog ?? {};
    expect(render(checkExactCatalogPins(catalog))).toBe('');
  });
});

suite(
  'the accepted gap is documented rather than forgotten (AC7, EPIC-01-S22 last scenario)',
  () => {
    const contributing = () => readText('docs/CONTRIBUTING.md');

    it('records that oxlint lints only the <script> block of a .vue file', () => {
      expect(contributing()).toMatch(/oxlint[\s\S]{0,80}<script>[^a-zA-Z]*block/);
    });

    it('records that template rules need ESLint, and that this is deliberately out of M1', () => {
      const text = contributing();
      expect(text).toContain('vue/no-unused-components');
      expect(text).toMatch(/eslint-plugin-vue/);
      expect(text).toMatch(/deferred to M2|not enforced at M1/);
    });
  },
);
