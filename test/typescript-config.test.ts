/**
 * KAR-01.2 — TypeScript configuration and the erasable-syntax constraint.
 *
 * The base config's seventeen options are individually load-bearing (AC1), the
 * two structural bans (no `paths`, no extensionless relative import) are cheap
 * guard tests written before the first temptation (AC6, AC8), and the escape
 * hatch that Node 26.0.0 removed must never reappear (EPIC-01-S7 scenario 3).
 *
 * Verifies: EPIC-01-S6 (base-config scenario), EPIC-01-S7 (scenario 3),
 * EPIC-01-S8 (paths-alias half) · AC1, AC6, AC8
 */
import { describe as suite, expect, it } from 'vitest';
import {
  checkNoPathsAlias,
  checkNoTransformTypesFlag,
  checkRelativeImportsHaveTsExtension,
  describe as render,
} from './support/guards.ts';
import {
  exists,
  packageDirs,
  packageProductionSources,
  parseJsonc,
  readText,
  readTsconfig,
  tsconfigFiles,
  walk,
} from './support/workspace.ts';

/** docs/16-repo-layout.md §5, AC1 of KAR-01.2 — verbatim, and exactly these keys. */
const EXPECTED_BASE_COMPILER_OPTIONS = {
  target: 'es2024',
  lib: ['es2024'],
  module: 'nodenext',
  moduleResolution: 'nodenext',
  moduleDetection: 'force',
  verbatimModuleSyntax: true,
  isolatedModules: true,
  erasableSyntaxOnly: true,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  noEmit: true,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  skipLibCheck: true,
  types: ['node'],
};

suite('tsconfig.base.json', () => {
  it('sets exactly the seventeen specified compiler options', () => {
    const parsed = JSON.parse(readText('tsconfig.base.json')) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(parsed.compilerOptions).toEqual(EXPECTED_BASE_COMPILER_OPTIONS);
  });
});

suite('tsconfig.json — the root solution file (AC2)', () => {
  it('contains only "references", one per workspace package', () => {
    const parsed = JSON.parse(readText('tsconfig.json')) as {
      references?: { path: string }[];
      files?: unknown[];
    };
    expect(Object.keys(parsed).sort()).toEqual(['files', 'references']);
    expect(parsed.files).toEqual([]);
    expect((parsed.references ?? []).map((r) => r.path).sort()).toEqual([...packageDirs()].sort());
  });
});

suite('every package tsconfig extends the base config', () => {
  it.each(packageDirs())('%s/tsconfig.json extends ../../tsconfig.base.json', (dir) => {
    expect(exists(`${dir}/tsconfig.json`)).toBe(true);
    const parsed = parseJsonc<{ extends?: string }>(readText(`${dir}/tsconfig.json`));
    const depth = dir.split('/').length;
    expect(parsed.extends).toBe(`${'../'.repeat(depth)}tsconfig.base.json`);
  });
});

suite('no tsconfig ever declares a paths alias (AC6)', () => {
  it('tsconfig.base.json and every package tsconfig are clean', () => {
    expect(render(checkNoPathsAlias(tsconfigFiles()))).toBe('');
  });
});

suite('every relative import under packages/*/src ends in .ts (AC8)', () => {
  it('no extensionless relative import exists', () => {
    const sources = packageProductionSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkRelativeImportsHaveTsExtension(sources))).toBe('');
  });
});

suite('there is no flag that would make banned syntax run (EPIC-01-S7 scenario 3)', () => {
  const manifestSources = [
    'package.json',
    ...packageDirs().map((dir) => `${dir}/package.json`),
  ].map((path) => ({ path, text: readText(path) }));
  const otherTargets = [
    ...walk('.github/workflows', (path) => path.endsWith('.yml') || path.endsWith('.yaml')),
    ...(exists('docs/03-local-development.md') ? ['docs/03-local-development.md'] : []),
  ].map((path) => ({ path, text: readText(path) }));

  it('no script, workflow or doc passes "--experimental-transform-types"', () => {
    expect(render(checkNoTransformTypesFlag([...manifestSources, ...otherTargets]))).toBe('');
  });
});
