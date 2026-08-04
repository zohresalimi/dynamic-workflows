/**
 * KAR-02.8 AC2 — `schemas:check` is a CI job, and deliberately not a hook.
 *
 * Where the check runs is part of its specification, not an implementation
 * detail. It loads the whole domain package and regenerates seven documents;
 * docs/14-testing-strategy.md §14.1 keeps pre-commit under about two seconds,
 * and a hook slower than that is a hook people learn to `--no-verify` past —
 * at which point the check is theatre and the pre-commit budget has been spent
 * for nothing. So: in the `check` job, next to `biome ci` and `typecheck`, and
 * nowhere in lefthook.yml.
 *
 * Verifies: EPIC-02-S24 · AC2
 */
import { expect, it, describe as suite } from 'vitest';
import { readJson, readText, readYaml } from './support/workspace.ts';

interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly { readonly run?: string }[] }>;
}

const ci = () => readYaml('.github/workflows/ci.yml') as Workflow;

suite('the scripts exist and point at the emitter (AC1, AC2)', () => {
  it('package.json declares schemas:emit and schemas:check', () => {
    const scripts = readJson('package.json').scripts ?? {};
    expect(scripts['schemas:emit']).toBe('node packages/core/scripts/emit-schemas.ts');
    expect(scripts['schemas:check']).toBe('node packages/core/scripts/check-schemas.ts');
  });
});

suite('the drift check runs in CI (AC2)', () => {
  it('the check job runs pnpm schemas:check', () => {
    const runs = (ci().jobs.check?.steps ?? []).map((step) => step.run ?? '');
    expect(runs).toContain('pnpm schemas:check');
  });

  it('it runs in the fast single-platform job, not the four-leg matrix', () => {
    const testRuns = (ci().jobs.test?.steps ?? []).map((step) => step.run ?? '');
    expect(testRuns.some((run) => run.includes('schemas:check'))).toBe(false);
  });
});

suite('the formatter does not own the generated files (AC2)', () => {
  it('biome.json excludes schemas/, so "pnpm format" cannot break "pnpm schemas:check"', () => {
    // Two formatters over one file is a loop: the emitter writes
    // JSON.stringify's shape, Biome collapses short arrays onto one line, and
    // the next check reports drift in files nobody edited. The emitter owns
    // its output; Biome owns everything a human types.
    const includes = (readJson('biome.json').files?.includes ?? []) as string[];
    expect(includes).toContain('!schemas/**');
  });
});

suite('the drift check is not a git hook (AC2)', () => {
  it('lefthook.yml never mentions schemas:check', () => {
    expect(readText('lefthook.yml')).not.toContain('schemas:check');
  });
});
