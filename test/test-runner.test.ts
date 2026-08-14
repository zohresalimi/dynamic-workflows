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

suite('vitest.config.ts — the project slices (AC1)', () => {
  it('declares exactly the slices of docs/14-testing-strategy.md §2', () => {
    const names = projects.map((entry) => (typeof entry === 'string' ? entry : entry.test?.name));
    expect(names).toEqual([
      'unit',
      'integration',
      'e2e',
      // KAR-03.8 filled the slot §2 left for it.
      'crash-fuzz',
      // KAR-19.5 — a sixth slice §2 did not anticipate, and the reason it is a
      // slice rather than more e2e specs is the budget: it is the one test that
      // starts at the operator's command and ends at an executed node, and its
      // own `testTimeout` **is** the 90 s the epic wrote down, so a regression
      // in cold start is a red test rather than a slow afternoon.
      'smoke',
      'packages/web/vitest.config.ts',
    ]);
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

/**
 * The slot EPIC-03 was holding is filled: KAR-03.8 ships the suite, so the
 * assertion flips from "not yet a project" to "a project, with the options
 * that make it one".
 *
 * Serialised and long-running are both requirements rather than preferences.
 * Every iteration owns a data directory and a process group it SIGKILLs, so
 * two files at once is a race by construction, and a slice that inherited the
 * integration timeout would report a wedged run as an infrastructure timeout —
 * which is the one diagnosis EPIC-03-S26 explicitly refuses.
 */
suite('the crash-fuzz slice EPIC-03 filled (AC11)', () => {
  it('is a real project, serialised, with a budget a crash-restart loop fits in', () => {
    const fuzz = sliceNamed('crash-fuzz');
    expect(fuzz.include).toEqual(['packages/*/test/crash-fuzz/**/*.test.ts']);
    expect(fuzz.pool).toBe('forks');
    expect(fuzz.fileParallelism).toBe(false);
    expect(fuzz.maxWorkers).toBe(1);
    expect(fuzz.testTimeout).toBeGreaterThanOrEqual(120_000);
  });

  it('collects nothing the other slices already collect', () => {
    const fuzz = sliceNamed('crash-fuzz').include ?? [];
    for (const other of [sliceNamed('unit'), sliceNamed('integration'), sliceNamed('e2e')]) {
      for (const pattern of other.include ?? []) expect(fuzz).not.toContain(pattern);
    }
  });

  it('collects both halves of the suite: the ledger one and the daemon one', () => {
    // KAR-03.8 wrote the ledger crash/restart harness; KAR-06.9 wrote the
    // orchestrator one. A glob that quietly stopped matching one of them would
    // leave the epic's acceptance gate passing with half the run, so the files
    // are named rather than counted.
    for (const spec of [
      'packages/ledger/test/crash-fuzz/crash-restart.test.ts',
      'packages/daemon/test/crash-fuzz/orchestrator-crash.test.ts',
    ]) {
      expect(exists(spec), `${spec} is missing`).toBe(true);
    }
  });

  it('is the project CI names, so the durability suite is something CI runs', () => {
    // This assertion used to say the opposite — "no workflow references
    // crash-fuzz" — which was right while vitest.config.ts held an empty slot
    // and wrong from KAR-03.8 onward, when it became the thing keeping the
    // suite out of CI. EPIC-06's Definition of Done is that the crash-fuzz
    // suite is green in CI, and this is where the wiring is held.
    //
    // Note what is *not* asserted: that the step executes today. The whole
    // `test` job is held behind `vars.RUN_TESTS_IN_CI` (owner's decision,
    // 2026-08-05), so nothing in the matrix runs until that variable is set —
    // and the point of this test is that when it is set, crash-fuzz comes back
    // on with everything else rather than needing a second, forgotten commit.
    const workflows = walk(
      '.github/workflows',
      (path) => path.endsWith('.yml') || path.endsWith('.yaml'),
    );
    const naming = workflows.filter((workflow) =>
      readText(workflow).includes('pnpm vitest run --project crash-fuzz'),
    );
    expect(naming).toEqual(['.github/workflows/ci.yml']);
  });
});

suite('the scripts the author actually types (AC2, AC3)', () => {
  const scripts = readJson('package.json').scripts ?? {};

  it.each([
    ['test:unit', 'unit'],
    ['test:int', 'integration'],
    ['test:e2e', 'e2e'],
    ['test:fuzz', 'crash-fuzz'],
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
