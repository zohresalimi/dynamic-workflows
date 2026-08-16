/**
 * KAR-21.5 AC8 — `deflow run --attach` on a run that is **already over** exits.
 *
 * ## Why this is its own file, and why it was written after the rest of KAR-21.5
 *
 * `run.ts` already knows this case exists. `watch()` carries the comment *"a
 * run that was already over before the hydrate finished never emits another
 * event, so the verdict has to be asked for once more here"*, and asks for it —
 * so the **exit code** was right all along. What nothing asserted was the other
 * half of concluding: that the command then *stops*.
 *
 * It did not. The stream `followRun` opens is closed by the command that opened
 * it, through the `following` binding that `onFollowing` assigns — and when the
 * verdict is reached during the hydrate, the close runs **first**, on a
 * `following` that is still `null`, and the connection that arrives a
 * microtask later is never closed by anyone. An open socket keeps the runtime's
 * loop alive, `bin.ts` sets `process.exitCode` rather than forcing an exit
 * (deliberately — so stdout drains), and the command sits there with its
 * verdict printed, forever.
 *
 * Found through KAR-21.5's own pty ladder, which is the honest reason this file
 * exists. `session-degrade-pty.test.ts` appends `run.completed` the moment the
 * CLI's first line reaches the terminal, and on an unloaded machine the CLI's
 * hydrate has already finished by then, so the event arrives over the stream
 * and everything is fine. On a loaded one the append lands *inside* the
 * hydrate — and the spec hung to its full timeout, on a different rung each
 * time. Diagnosed as a race between the harness and the command; it was neither.
 * It is a leak that the harness's timing merely selects for, and
 * `deflow run --attach` on any finished run reproduces it every time with no
 * load at all — which is what this file does.
 *
 * ## What is asserted
 *
 * Both terminal verdicts reachable at hydrate time, because the defect is about
 * *reaching a verdict during the hydrate* rather than about any one outcome: a
 * completed run (exit 0), and a run parked at the F1.3 gate under `--no-wait`
 * (exit 4). A fix that special-cased `run.completed` would leave the second one
 * hanging.
 *
 * Asserted from **outside** the process, with pipes rather than a pty, because
 * the claim is "this process ended" and no assertion made inside it can say so.
 * The budget is generous — this is not a performance claim, it is the
 * difference between finishing and never finishing.
 *
 * Verifies: EPIC-21-S44 · AC8
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { appendEvents } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { type RunProcess, sleep, spawnRun } from './support/cli-process.ts';
import { framedRun } from './support/run-fixture.ts';

const RUN_ID = RunIdSchema.parse('run_20260816T101500Z_0e0e0e');

/**
 * How long the command is given to start, hydrate and stop.
 *
 * Not a performance bound. It is long enough that a machine deep in swap still
 * makes it — the same machine this defect was found on took roughly three
 * seconds for the whole command — and short enough to fail inside the slice's
 * 30 s timeout, so the red is this file's sentence rather than a bare
 * "test timed out" that says nothing about which claim broke.
 */
const EXIT_BUDGET_MS = 20_000;

let tmp = '';
let booted: Booted | undefined;
let watching: RunProcess | undefined;

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  // The whole point of this file is a command that does not stop on its own, so
  // teardown must not assume it did.
  watching?.child.kill('SIGKILL');
  watching = undefined;
  await booted?.shutdown();
  booted = undefined;
  await removeTempDir(tmp);
});

/** A daemon in this process and a run parked at the F1.3 gate, before the CLI
 * has been started at all. */
async function concludedRun(options: { readonly completed: boolean }): Promise<{
  dataDir: string;
  cwd: string;
}> {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  booted = await boot({ dataDir, port: 0, dev: false });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  framedRun(RUN_ID, { db: booted.db, epoch: booted.epoch, ts: Date.now(), cwd: repo.dir });

  if (options.completed) {
    appendEvents(
      booted.db as never,
      [
        {
          runId: RUN_ID,
          ts: Date.now(),
          kind: 'run.completed',
          v: 1,
          epoch: booted.epoch,
          payload: { outcome: 'succeeded', criteriaSatisfied: [] },
        },
      ] as never,
    );
  }

  return { dataDir, cwd: repo.dir };
}

/** The exit, or `null` if the command was still running when the budget ran
 * out — which is the failure this file is about, reported as itself. */
async function exitWithin(run: RunProcess): Promise<{ code: number | null } | null> {
  return await Promise.race([run.exited, sleep(EXIT_BUDGET_MS).then(() => null)]);
}

suite('EPIC-21-S44 — the run is already over when the command attaches (AC8)', () => {
  for (const scenario of [
    { what: 'a completed run', completed: true, args: [], code: RUN_EXIT_CODES.completed },
    {
      what: 'a run at the F1.3 gate under --no-wait',
      completed: false,
      args: ['--no-wait'],
      code: RUN_EXIT_CODES.awaitingHuman,
    },
  ] as const) {
    it(`prints the verdict for ${scenario.what} and then exits`, async () => {
      const { dataDir, cwd } = await concludedRun({ completed: scenario.completed });

      watching = spawnRun({ dataDir, cwd, args: [...scenario.args, '--attach', RUN_ID] });

      const exit = await exitWithin(watching);

      expect(
        exit,
        `deflow run --attach reached its verdict and never exited within ${String(
          EXIT_BUDGET_MS,
        )} ms. Its transcript was:\n${watching.stdout()}\n${watching.stderr()}`,
      ).not.toBeNull();
      expect(exit?.code).toBe(scenario.code);
      // And it exited because it concluded, not because it fell over on the way
      // — a command that never reached the run would also have "exited".
      expect(watching.stdout()).toContain(`run ${RUN_ID}`);
    });
  }
});
