/**
 * KAR-01.3 — the one-command dev loop, asserted against this repository.
 *
 * These are the mechanical halves of the story: the proxy ban (AC7), the
 * dynamic-vite ban (AC8), the pino-pretty pipe (AC5), the shape of the dev
 * scripts themselves (AC1, AC3, AC4) and the two documentation claims the flow
 * file asserts rather than implies (EPIC-01-S9 scenario 2, EPIC-01-S11
 * scenario 2).
 *
 * Verifies: EPIC-01-S13 (unit), EPIC-01-S9 (scenario 2), EPIC-01-S11 (scenario 2)
 */
import { describe as suite, expect, it } from 'vitest';
import {
  checkDevLoopScripts,
  checkNoViteProxy,
  checkPinoPrettyIsNotARuntimeTransport,
  checkViteImportIsDynamic,
  describe as render,
} from './support/guards.ts';
import {
  allWorkspaceSources,
  exists,
  packageProductionSources,
  readJson,
  readSources,
  readText,
} from './support/workspace.ts';

suite('no Vite proxy exists anywhere in the code (AC7, EPIC-01-S13)', () => {
  it('no package source and no Vite/Vitest config configures a proxy', () => {
    const sources = [
      ...allWorkspaceSources(),
      ...readSources(['vitest.config.ts'].filter((path) => exists(path))),
    ];
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkNoViteProxy(sources))).toBe('');
  });

  it('at least one Vite config exists to be checked', () => {
    // A guard over an empty file set passes vacuously, which is worse than no
    // guard: it reports green while protecting nothing.
    expect(exists('packages/web/vite.config.ts')).toBe(true);
  });
});

suite('vite is imported dynamically, under the dev branch only (AC8)', () => {
  it('no source under packages/*/src imports vite statically', () => {
    const sources = packageProductionSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkViteImportIsDynamic(sources))).toBe('');
  });

  it('the daemon does import vite dynamically, so the guard has something to guard', () => {
    const server = readText('packages/daemon/src/http/server.ts');
    expect(server).toMatch(/await import\(\s*['"]vite['"]\s*\)/);
    expect(server).toMatch(/DeFlow_DEV\s*===\s*['"]1['"]/);
  });

  it('vite is a devDependency of the daemon and never a runtime dependency', () => {
    const daemon = readJson('packages/daemon/package.json');
    expect(daemon.dependencies?.vite).toBeUndefined();
    expect(daemon.devDependencies?.vite).toBe('catalog:');
  });
});

suite('pino-pretty is a pipe, never a runtime transport (AC5)', () => {
  it('no runtime source names pino-pretty', () => {
    expect(render(checkPinoPrettyIsNotARuntimeTransport(packageProductionSources()))).toBe('');
  });

  it('pino-pretty is a root devDependency, not a dependency of the daemon', () => {
    expect(readJson('package.json').devDependencies?.['pino-pretty']).toBe('catalog:');
    const daemon = readJson('packages/daemon/package.json');
    expect(daemon.dependencies?.['pino-pretty']).toBeUndefined();
  });
});

suite('the root dev scripts (AC1, AC3, AC4, AC5, EPIC-01-S9 scenario 2)', () => {
  it('run node --watch, exclude packages/web, and pipe dev:pretty', () => {
    expect(render(checkDevLoopScripts(readJson('package.json')))).toBe('');
  });

  it('watch every daemon-side package, so a save anywhere in the engine restarts it', () => {
    const dev = readJson('package.json').scripts?.dev ?? '';
    for (const pkg of ['core', 'ledger', 'adapters', 'daemon', 'cli', 'mock-agent']) {
      expect(dev, `packages/${pkg} must be watched`).toContain(`--watch-path=packages/${pkg}`);
    }
    expect(dev).not.toContain('--watch-path=packages/web');
  });

  it('runs the daemon entry point directly, with no build step', () => {
    expect(readJson('package.json').scripts?.dev).toContain('packages/daemon/src/main.ts');
  });
});

suite('docs/CONTRIBUTING.md records why the loop is shaped this way', () => {
  const contributing = () => readText('docs/CONTRIBUTING.md');

  it('opens with the four commands (EPIC-01-S1)', () => {
    expect(contributing()).toContain('git clone && pnpm install && pnpm dev');
  });

  it('states that the restart is the test, not an annoyance (EPIC-01-S9 scenario 2)', () => {
    expect(contributing()).toContain('the restart is the test');
    expect(contributing()).toContain('F4.2');
  });

  it('states that deleting ledger.db destroys the evidence (EPIC-01-S11 scenario 2)', () => {
    const text = contributing();
    expect(text).toContain('the ledger is the source of truth');
    expect(text).toMatch(/deleting\s+`?ledger\.db`?/i);
    expect(text).toContain('destroys the evidence');
  });

  it('records the measured cold start against the NF3 budget (AC10)', () => {
    expect(contributing()).toMatch(/cold start[\s\S]{0,400}?\d+(\.\d+)?\s?(ms|s)\b/i);
  });
});
