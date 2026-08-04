/**
 * KAR-01.4 — the root runner configuration itself.
 *
 * The four slices are read out of the real `vitest.config.ts` rather than
 * described a second time in prose, because the failure this guards against is
 * a slice whose pool or timeout quietly drifts from what
 * docs/14-testing-strategy.md §2 says it is — `pool: 'threads'` on a slice that
 * spawns children does not fail, it just poisons unrelated specs later.
 *
 * Verifies: EPIC-01-S14 (configuration half), EPIC-01-S17 (ordering guard),
 * EPIC-01-S18 (supported-shape half) · AC1, AC2, AC3, AC8, AC11
 */
import { expect, it, describe as suite } from 'vitest';
import webConfig from '../packages/web/vitest.config.ts';
import rootConfig from '../vitest.config.ts';
import { exists, readJson, readText, walk } from './support/workspace.ts';

interface SliceTestOptions {
  readonly name?: string;
  readonly environment?: string;
  readonly include?: readonly string[];
  readonly testTimeout?: number;
  readonly pool?: string;
  readonly poolOptions?: unknown;
  readonly maxWorkers?: number;
  readonly fileParallelism?: boolean;
  readonly browser?: {
    readonly enabled?: boolean;
    readonly headless?: boolean;
    readonly provider?: unknown;
    readonly instances?: readonly { readonly browser?: string }[];
  };
}

interface Slice {
  readonly extends?: boolean;
  readonly test?: SliceTestOptions;
}

type ProjectEntry = Slice | string;

const root = rootConfig as {
  test?: { setupFiles?: readonly string[]; projects?: readonly ProjectEntry[] };
};
const projects = root.test?.projects ?? [];

const inlineSlices = projects.filter((entry): entry is Slice => typeof entry !== 'string');
const sliceNamed = (name: string): SliceTestOptions => {
  const slice = inlineSlices.find((entry) => entry.test?.name === name);
  if (slice?.test === undefined) throw new Error(`no project named "${name}" in vitest.config.ts`);
  return slice.test;
};

suite('vitest.config.ts — the four project slices (AC1)', () => {
  it('declares exactly the four slices of docs/14-testing-strategy.md §2', () => {
    const names = projects.map((entry) => (typeof entry === 'string' ? entry : entry.test?.name));
    expect(names).toEqual(['unit', 'integration', 'e2e', 'packages/web/vitest.config.ts']);
  });

  it('inherits the root test options into every inline slice', () => {
    for (const slice of inlineSlices) {
      expect(slice.extends, `project "${slice.test?.name}" must set extends: true`).toBe(true);
    }
  });

  it('collects the unit slice from the package sources, on threads', () => {
    const unit = sliceNamed('unit');
    expect(unit.include).toContain('packages/*/src/**/*.test.ts');
    expect(unit.environment).toBe('node');
    // Stated, not inherited: Vitest 4's default pool is 'forks', so leaving
    // this out would silently fork a process per file for a slice that spawns
    // nothing and is supposed to finish in about a second (AC2).
    expect(unit.pool).toBe('threads');
    expect(unit.testTimeout).toBeUndefined();
  });

  it('gives the integration slice 30 s and a forked pool (AC3)', () => {
    const integration = sliceNamed('integration');
    expect(integration.include).toContain('packages/*/test/integration/**/*.test.ts');
    expect(integration.testTimeout).toBe(30_000);
    expect(integration.pool).toBe('forks');
  });

  it('gives the e2e slice 180 s, a forked pool, one worker and no file parallelism (AC3)', () => {
    const e2e = sliceNamed('e2e');
    expect(e2e.include).toEqual(['e2e/**/*.test.ts']);
    expect(e2e.testTimeout).toBe(180_000);
    expect(e2e.pool).toBe('forks');
    expect(e2e.fileParallelism).toBe(false);
    expect(e2e.maxWorkers).toBe(1);
  });

  it('never reaches for poolOptions, which Vitest 4 removed along with the workspace file', () => {
    for (const slice of inlineSlices) {
      expect(slice.test?.poolOptions, `project "${slice.test?.name}"`).toBeUndefined();
    }
    // It is ignored rather than rejected, so a config carrying it looks fine and
    // quietly runs e2e specs in parallel against one shared data directory.
    expect(readText('vitest.config.ts')).not.toMatch(/poolOptions\s*:/);
  });

  it('records why e2e is serialised, next to the option', () => {
    const text = readText('vitest.config.ts');
    expect(text).toMatch(/bind ports and mutate a shared data directory/);
  });

  it('configures the web slice from packages/web/vitest.config.ts, in a real browser', () => {
    const web = (webConfig as { test?: SliceTestOptions }).test;
    expect(web?.name).toBe('web');
    expect(web?.browser?.enabled).toBe(true);
    expect(web?.browser?.headless).toBe(true);
    expect(web?.browser?.provider).toBeDefined();
    expect(web?.browser?.instances?.map((instance) => instance.browser)).toEqual(['chromium']);
  });
});

suite('the snapshot serializer is registered by the shared setup file (AC8)', () => {
  it('lists ./test/setup.ts first in the root setupFiles', () => {
    expect(root.test?.setupFiles?.[0]).toBe('./test/setup.ts');
  });

  it('registers the serializer as the first thing the setup file does (EPIC-01-S17)', () => {
    const statements = readText('test/setup.ts')
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line !== '' && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'),
      );
    const firstCall = statements.findIndex((line) => line.includes('('));
    const registration = statements.findIndex((line) => line.includes('addSnapshotSerializer'));
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(registration).toBe(firstCall);
  });
});

suite('the crash-fuzz slot EPIC-03 fills (AC11)', () => {
  it('is documented in the config but not yet a project', () => {
    const names = inlineSlices.map((slice) => slice.test?.name);
    expect(names).not.toContain('crash-fuzz');
    const text = readText('vitest.config.ts');
    expect(text).toMatch(/crash-fuzz/);
    expect(text).toMatch(/EPIC-03/);
  });

  it('is referenced by no CI workflow until EPIC-03 adds it', () => {
    const workflows = walk(
      '.github/workflows',
      (path) => path.endsWith('.yml') || path.endsWith('.yaml'),
    );
    for (const workflow of workflows) {
      expect(readText(workflow), `${workflow} references the crash-fuzz project`).not.toMatch(
        /crash-fuzz/,
      );
    }
  });
});

suite('the scripts the author actually types (AC2, AC3)', () => {
  const scripts = readJson('package.json').scripts ?? {};

  it.each([
    ['test:unit', 'unit'],
    ['test:int', 'integration'],
    ['test:e2e', 'e2e'],
  ])('%s runs only the %s slice', (script, project) => {
    expect(scripts[script]).toBe(`vitest run --project ${project}`);
  });
});

suite('vitest.workspace.ts never appears (AC1, EPIC-01-S18)', () => {
  it('does not exist at the repo root', () => {
    for (const extension of ['ts', 'mts', 'js', 'mjs']) {
      expect(exists(`vitest.workspace.${extension}`)).toBe(false);
    }
  });
});
