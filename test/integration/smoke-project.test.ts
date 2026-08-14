/**
 * KAR-19.5 AC5, AC6, AC7, AC8 / EPIC-19-S36 — **it cannot rot.**
 *
 * The whole failure this epic corrects lived in the gap between *"we should run
 * that"* and *"we ran it"*, so a smoke test behind a flag would reproduce it
 * exactly. Which means the wiring itself has to be asserted: that a `smoke`
 * project exists, that `pnpm test` collects it without an extra flag, that it
 * is serialised because it binds a port and owns a data directory, and that its
 * declared timeout **is** the budget the epic wrote down rather than a larger
 * number somebody reached for on a slow afternoon.
 *
 * The configuration is read as source rather than imported, deliberately.
 * Importing `vitest.config.ts` gives you the object *this* runner already
 * resolved — a tautology — and says nothing about what a bare `pnpm test`
 * collects. Reading the file is what catches a project that was added, then
 * excluded by a glob three lines below.
 *
 * Verifies: EPIC-19-S36 · KAR-19.5 AC5, AC6, AC7, AC8 · test plan #4, #5
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { SMOKE_BUDGET_MS } from '../../e2e/smoke/support/harness.ts';
import type { CiWorkflow } from '../support/guards.ts';
import { readYaml } from '../support/workspace.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const config = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  readonly scripts: Readonly<Record<string, string>>;
};

/** The block of `vitest.config.ts` that declares the `smoke` project. */
function smokeProject(): string {
  const start = config.indexOf("name: 'smoke'");
  expect(start, 'vitest.config.ts declares no project named "smoke"').toBeGreaterThan(-1);
  const end = config.indexOf('},', config.indexOf('maxWorkers', start));
  return config.slice(start, end === -1 ? config.length : end);
}

suite('EPIC-19-S36 — the smoke slice is in pnpm test, serialised, and budgeted', () => {
  it('declares a smoke project over e2e/smoke', () => {
    const project = smokeProject();
    expect(project).toContain("include: ['e2e/smoke/**/*.test.ts']");
  });

  it('is collected by a bare `pnpm test`, with no extra flag', () => {
    // `vitest run` with no `--project` runs every project the config declares,
    // so the assertion is that nothing narrows it: a `--project` on the default
    // script would be exactly the "behind a flag" failure, spelled differently.
    expect(manifest.scripts.test).toBe('vitest run');
    expect(manifest.scripts['test:smoke']).toBe('vitest run --project smoke');
  });

  it('is not also collected by the e2e project, which would run it twice', () => {
    // `e2e/**/*.test.ts` would otherwise swallow `e2e/smoke/`, and the copy
    // running there would carry the e2e slice's 180 s timeout — so the budget
    // below would be asserted in one place and ignored in the other.
    expect(config).toContain("'e2e/smoke/**'");
  });

  it('is serialised, because it binds a port and owns a data directory', () => {
    const project = smokeProject();
    expect(project).toContain('fileParallelism: false');
    expect(project).toContain('maxWorkers: 1');
    expect(project).toContain("pool: 'forks'");
  });

  it('declares the budget the epic wrote down as its own timeout', () => {
    // AC6 — 90 s. Read off the harness constant so the number has one home:
    // the scenario's `it()` timeout and the project's `testTimeout` are the
    // same figure, and a regression in cold start is a red test rather than a
    // slow afternoon somebody eventually raises the number for.
    expect(SMOKE_BUDGET_MS).toBe(90_000);
    expect(smokeProject()).toContain(`testTimeout: ${String(SMOKE_BUDGET_MS / 1000)}_000`);
  });

  it('is run by CI on both platforms and both Node versions (AC5)', () => {
    const workflow = readYaml<CiWorkflow>('.github/workflows/ci.yml');
    const test = workflow.jobs?.test;
    expect(test?.strategy?.matrix?.os).toEqual(['ubuntu-26.04', 'macos-26']);
    expect(test?.strategy?.matrix?.node).toEqual(['24', '26']);
    const runs = (test?.steps ?? []).map((step) => step.run ?? '');
    expect(
      runs.some((run) => run.includes('--project smoke')),
      'the CI test matrix never runs the smoke slice',
    ).toBe(true);
  });

  it('preserves its tmpdir under DeFlow_KEEP_TMP=1 and uploads it in CI (AC7)', () => {
    const harness = readFileSync(join(repoRoot, 'e2e/smoke/support/harness.ts'), 'utf8');
    expect(harness).toContain('DeFlow_KEEP_TMP');

    // The upload half is the step CI already has: the smoke slice runs in the
    // same job as unit and integration, which sets `DeFlow_KEEP_TMP` and pins
    // `TMPDIR` to `runner.temp`, and the failure-only upload globs
    // `DeFlow-*` there. `test/integration/ci-artifact-path.test.ts` holds that
    // glob against a real fixture; what is asserted here is that the smoke
    // tmpdir's prefix is inside it.
    expect(harness).toContain("'DeFlow-smoke-'");
  });
});

/**
 * AC8 — the three deferral markers this epic closes, and the rule they were
 * written under: *"the day a shipped source executes a submitted run, this
 * record has outlived its reason."* That day is this story.
 *
 * A guard rather than a checklist item, because a deferral note that survives
 * its own resolution is worse than none: the next reader believes completion is
 * still impossible and writes around it.
 */
suite('KAR-19.5 AC8 — the deferral markers are gone', () => {
  it('has no test/run-completion-deferral.test.ts', () => {
    expect(existsSync(join(repoRoot, 'test/run-completion-deferral.test.ts'))).toBe(false);
  });

  it('leaves no deferral note in the CLI run fixture or the e2e run spec', () => {
    for (const file of [
      'packages/cli/test/integration/support/run-fixture.ts',
      'e2e/run.test.ts',
    ]) {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      for (const marker of ['stays deferred', 'is deferred', 'tracked on KAR-19.5']) {
        expect(source, `${file} still carries a deferral marker: ${marker}`).not.toContain(marker);
      }
    }
  });

  it('has no orphaned sabotage copy left in the tree', () => {
    // The sabotage table writes `packages/cli/.smoke-sabotage-*` and removes
    // them; one left behind is 6 MB of bundle with a link cut out of it sitting
    // beside the real one, which is a confusing thing to find.
    const stale = readdirSync(join(repoRoot, 'packages/cli')).filter((entry) =>
      entry.startsWith('.smoke-sabotage-'),
    );
    expect(stale).toEqual([]);
  });
});
