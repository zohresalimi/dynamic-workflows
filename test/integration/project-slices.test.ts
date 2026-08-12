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

/**
 * SGR escape sequences, removed before anything reads the summary.
 *
 * Whether the nested runner colours its output is a property of the machine, not
 * of the run: vitest turns colour off when std-env reports an AI agent
 * (`CLAUDECODE` in the environment) and leaves it on otherwise, and tinyrainbow
 * enables it for any process with `CI` in its environment — which this helper
 * sets deliberately. So `'Test Files  1 passed'` is present as plain text on an
 * agent's laptop and split by `\x1b[2m…` on a GitHub runner and in a colleague's
 * terminal. Measured: run 30914294996 failed all four legs on exactly this,
 * having passed locally. Asserting on the escaped form instead would just move
 * the machine-dependence; the summary line is what the assertion is about.
 */
const ANSI = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, 'g');

const runVitestArgv = (argv: readonly string[]): Promise<Run> =>
  new Promise((resolve) => {
    const started = Date.now();
    execFile(
      VITEST,
      [...argv],
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
          output: `${stdout}\n${stderr}`.replaceAll(ANSI, ''),
          ms: Date.now() - started,
        });
      },
    );
  });

const runVitest = (args: readonly string[]): Promise<Run> => runVitestArgv(['run', ...args]);

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
  // A canary, not a benchmark. The red condition is structural — a unit spec
  // that spawns a child, boots a server, sleeps or reaches for the network —
  // and a bare wall-clock ceiling cannot see it from here. This spec lives in
  // the integration slice, so the nested run it times competes with a hundred
  // forked workers, several of them driving real subprocesses: the identical
  // run costs about 5 s on an idle machine and about 23 s beside its own
  // suite. A flat 10 s ceiling was therefore measuring how busy the box was,
  // and went red for that and nothing else (EPIC-05's two timing budgets went
  // the same way, and were fixed the same way).
  //
  // So it is measured against a control on the same machine, seconds apart:
  // `vitest list --project unit` resolves the same config, starts the same
  // pool, and transforms, imports and collects the same files — every cost the
  // run has except executing the test bodies, which is exactly the part under
  // test. Load moves both halves together and cancels; a spec that started
  // spawning or sleeping moves only the run.
  //
  // The run is timed first and the control second on purpose: the control then
  // reads a warm module cache, which shrinks it and tightens the ceiling.
  //
  // Measured 2026-08-06, 8 cores, 168 unit files: idle, a 4.9 s run against a
  // 4.6 s control — a ratio of 1.05. Beside a live integration slice, 22.8 s
  // against 16.4 s — 1.39. Under twelve CPU hogs, 10.0 s against 7.3 s — 1.38.
  // One unit spec made to sleep 15 s — the regression this exists to catch —
  // took a 19.7 s run against a 3.8 s control, and the assertion went red.
  //
  // The 10 s floor is the original ceiling, kept intact: on an idle machine
  // 2.5x the control lands just under it, so nothing about this budget got
  // looser where the loosening would have mattered.
  //
  // The spec timeout covers two nested runs of the whole unit slice, and the
  // point of the spec is that both are slow when the box is loaded — the
  // integration slice's default 30 s would be the old flat budget by the back
  // door.
  //
  // Re-measured 2026-08-12 on the EPIC-18 gate, because the slice this ceiling
  // was sized against has doubled: 168 unit files then, 353 now, after EPIC-15
  // through EPIC-18. Idle at four workers the run leg costs 32.2 s and the
  // control leg 26.5 s — 58.7 s of nested work before the outer slice is even
  // considered, against 9.5 s when 120 s was chosen. Beside eight CPU hogs the
  // legs cost 42.0 s and 33.5 s. Beside a live full suite the pair went past
  // 120 s twice on this gate, which is the whole failure: the spec never
  // reached its assertion.
  //
  // 600 s is ~10x the idle pair, and it loosens nothing that is asserted. The
  // budget itself is the ratio below and it has not moved — measured 1.22 idle
  // and 1.25 under eight hogs against the same 2.5x ceiling, so the regression
  // this exists to catch (a unit spec that starts sleeping or spawning, which
  // moves only the run leg) is caught exactly as before.
  // Both nested legs are capped at four workers rather than taking the whole
  // box. This spec starts a full unit slice from inside a slice that is already
  // running seven forked workers of its own, on eight cores, and then does it a
  // second time for the control — it is the single largest load spike in the
  // suite, and most of that spike is self-inflicted.
  //
  // The cap costs the assertion nothing, because the assertion is a ratio and
  // the cap applies to both halves of it: measured 2026-08-07, 1.12 idle and
  // 1.13 under twelve CPU hogs at four workers, against 1.05 and 1.15 at eight
  // — all far inside the 2.5x ceiling. A unit spec that started sleeping or
  // spawning still moves only the run leg, which is the regression this exists
  // to catch.
  //
  // What the cap is *not* is a proven fix for the flake that motivated it: this
  // spec has twice had a nested runner exit 1 outright during a full-suite run
  // — once on the run leg, once on the control — and that failure has never
  // reproduced in isolation, including under a 4.5 GB memory hog and twelve CPU
  // hogs. Both legs now carry the nested runner's own output into the assertion
  // message, so the next occurrence says what happened instead of "expected 1
  // to be +0".
  const NESTED_WORKERS = ['--maxWorkers', '4'];

  it('runs the whole slice in a small multiple of the cost of collecting it', async () => {
    const run = await runVitest(['--project', 'unit', ...NESTED_WORKERS]);
    // A bare `expect(code).toBe(0)` reports "expected 1 to be +0" and nothing
    // else: the nested runner's own failure output is inside `run.output`,
    // where no reporter will ever look. Carry it into the message.
    expect(run.code, `nested run output:\n${run.output}`).toBe(0);

    const control = await runVitestArgv(['list', '--project', 'unit', ...NESTED_WORKERS]);
    expect(
      control.code,
      `the control must actually collect the slice; output:\n${control.output}`,
    ).toBe(0);

    expect(run.ms, `control (collect-only) for the same slice was ${control.ms} ms`).toBeLessThan(
      Math.max(10_000, control.ms * 2.5),
    );
  }, 600_000);
});
