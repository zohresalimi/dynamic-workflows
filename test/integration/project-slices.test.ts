/**
 * KAR-01.4 — the slices resolve and run, checked by actually running them.
 *
 * A `--project` filter that matches nothing looks exactly like a green run, so
 * asserting on the config object alone cannot tell you a slice is executing.
 * These specs shell out to the real runner over the real root config.
 *
 * Verifies: EPIC-01-S14 · AC1, AC2
 */
import { execFile } from 'node:child_process';
import { expect, it, describe as suite } from 'vitest';
import { repoRoot } from '../support/workspace.ts';

const VITEST = 'node_modules/.bin/vitest';

interface Run {
  readonly code: number;
  readonly output: string;
  readonly ms: number;
}

const runVitest = (args: readonly string[]): Promise<Run> =>
  new Promise((resolve) => {
    const started = Date.now();
    execFile(
      VITEST,
      ['run', ...args],
      {
        cwd: repoRoot,
        maxBuffer: 32 * 1024 * 1024,
        // A nested runner must not inherit the outer one's reporter wiring.
        env: { ...process.env, VITEST: undefined, CI: '1' },
      },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1),
          output: `${stdout}\n${stderr}`,
          ms: Date.now() - started,
        });
      },
    );
  });

suite('each slice resolves and runs (EPIC-01-S14)', () => {
  it('runs a unit spec under --project unit', async () => {
    const run = await runVitest(['--project', 'unit', 'packages/testkit/src/tmp']);
    expect(run.output).toContain('Test Files  1 passed');
    expect(run.code).toBe(0);
  });

  it('runs an integration spec under --project integration', async () => {
    const run = await runVitest([
      '--project',
      'integration',
      'packages/testkit/test/integration/sqlite-durability',
    ]);
    expect(run.output).toContain('Test Files  1 passed');
    expect(run.code).toBe(0);
  });

  it('refuses a mistyped project name instead of exiting 0 having run nothing', async () => {
    const run = await runVitest(['--project', 'unti']);
    expect(run.output).toContain('No projects matched the filter "unti"');
    expect(run.code).not.toBe(0);
  });
});

suite('the unit slice stays fast enough to run on every save (AC2)', () => {
  // A canary, not a benchmark: the slice takes about a second, and the ceiling
  // is set an order of magnitude above that so it fires only when something
  // structural changes — a unit spec that spawns a child, boots a server or
  // reaches for the network — rather than when a CI runner is busy.
  it('runs the whole slice well inside ten seconds', async () => {
    const run = await runVitest(['--project', 'unit']);
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(10_000);
  });
});
