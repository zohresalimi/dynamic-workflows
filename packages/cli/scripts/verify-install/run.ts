#!/usr/bin/env node
/**
 * `pnpm verify:install` — KAR-18.6 AC1–AC4, AC6, AC7.
 *
 * The exact procedure docs/03-local-development.md §10 fixes: `pnpm build`,
 * `pnpm pack:check`, `cd packages/cli && pnpm pack`, `mktemp -d`, `git init -b
 * main demo`, `npx <tgz> init`, `npx <tgz> up`, then the assertions that
 * distinguish "the UI shipped" from "the daemon serves a blank page" —
 * because `pnpm build` producing a green local run proves nothing about the
 * tarball.
 *
 * Every step below is a real subprocess against the real packed bytes; the
 * functions it calls are `./lib.ts`'s, shared with
 * `e2e/install-verification.test.ts` and
 * `packages/cli/test/integration/verify-install-bin.test.ts` so the script and
 * its own test suite cannot silently drift apart.
 *
 * **AC2's honest limit.** AC2 asks for "a scripted multi-node run completes
 * through `npx <tgz> run` and exits 0", *because* that would prove "the
 * inlined daemon, the inlined mock agent and the shipped UI are all present in
 * one artefact". The completion half is not reachable in this repository —
 * nothing executes a submitted run past intake (`packages/daemon/src/boot.ts`
 * starts no ticker; `POST /api/runs` stops at `task.submitted` by design,
 * KAR-10.1), which is EPIC-06/EPIC-10/EPIC-11 wiring this epic does not own
 * and which `e2e/run.test.ts` and the epic file both already carry as a
 * recorded deferral. Faking an exit 0 here is the one thing the working
 * agreement forbids outright.
 *
 * So the reason AC2 gives is asserted directly, and in two steps rather than
 * one: the installed daemon **spawns the installed mock agent and drives real
 * ACP turns against it** (`initialize` into a regenerated capability matrix,
 * then the F3.4 battery, a turn per assertion), and a run submitted through
 * the installed `DeFlow run` reaches the installed daemon. Both are stated as
 * what they are, never folded into a "run completed" that did not happen.
 */
import process from 'node:process';
import {
  assertInstalledAgentDrivesTurns,
  assertNoNodeGyp,
  assertUiShipped,
  type CliInstall,
  type CliProcess,
  checkBinExecutable,
  cleanupPackedTarball,
  cleanupSystemToolsDir,
  findInstalledMockAgent,
  makeCleanRoom,
  packGoodTarball,
  runInstalled,
  settleCleanRoom,
  shimMockAgent,
  spawnInstalled,
  stopRecordedDaemon,
  waitForUrl,
} from './lib.ts';

interface StepResult {
  readonly label: string;
  readonly ok: boolean;
  readonly note?: string;
}

const results: StepResult[] = [];

function report(label: string, ok: boolean, note?: string): void {
  results.push({ label, ok, ...(note === undefined ? {} : { note }) });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`[${mark}] ${label}${note !== undefined ? ` — ${note}` : ''}\n`);
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn();
    report(label, true);
    return value;
  } catch (error) {
    report(label, false, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function main(): Promise<number> {
  process.stdout.write('verify:install — the real tarball, installed into an empty directory\n\n');

  const good = packGoodTarball();
  report('build, pack:check, pnpm pack', true, good.tgz);

  for (const bin of ['bin.mjs', 'mcp.mjs', 'mock-agent.mjs']) {
    const path = `${good.distDir}/${bin}`;
    const defects = checkBinExecutable(path);
    report(`${bin} is executable and self-describing`, defects.length === 0, defects.join('; '));
  }

  const install: CliInstall = await makeCleanRoom();
  let up: CliProcess | undefined;

  try {
    await step('npx <tgz> init, with no node-gyp in the install log (AC4)', async () => {
      const initResult = await runInstalled({
        tgz: good.tgz,
        bin: 'DeFlow',
        argv: ['init'],
        install,
      });
      if (initResult.status !== 0)
        throw new Error(`exited ${String(initResult.status)}:\n${initResult.stderr}`);
      assertNoNodeGyp(initResult.stdout + initResult.stderr);
    });

    const started = spawnInstalled({
      tgz: good.tgz,
      bin: 'DeFlow',
      argv: ['up', '--no-open'],
      install,
    });
    up = started;
    const url = await step('npx <tgz> up', () => waitForUrl(started));

    if (url !== undefined) {
      const baseUrl = new URL(url).origin;
      await step('GET /api/health, GET / and a real /assets/*.js (AC1)', () =>
        assertUiShipped(baseUrl),
      );

      const binDir = `${install.dataDir}-agentbin`;
      await step(
        'AC2 — the installed daemon drives ACP turns against the installed mock agent',
        async () => {
          const mockAgent = await findInstalledMockAgent(install.npmCacheDir);
          await shimMockAgent(binDir, mockAgent);
          const turns = await assertInstalledAgentDrivesTurns({ tgz: good.tgz, install, binDir });
          process.stdout.write(
            `       ${String(turns.passed)} passed, ${String(turns.failed)} failed, ` +
              `${String(turns.skipped)} skipped against ${turns.binary}\n`,
          );
        },
      );

      await step('AC2 — task.submitted reaches the installed daemon', async () => {
        const run = spawnInstalled({
          tgz: good.tgz,
          bin: 'DeFlow',
          argv: ['run', 'add a health endpoint'],
          install,
          binDirs: [binDir],
        });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !run.stdout().includes('submitted')) {
          if (run.child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const submitted = run.stdout().includes('submitted');
        await run.stop();
        if (!submitted)
          throw new Error(`no task.submitted seen:\n${run.stdout()}\n${run.stderr()}`);
      });
    }

    await step('npx <tgz> doctor (AC3)', async () => {
      const doctor = await runInstalled({
        tgz: good.tgz,
        bin: 'DeFlow',
        argv: ['doctor', '--skip-conformance'],
        install,
      });
      if (doctor.status !== 0)
        throw new Error(`exited ${String(doctor.status)}:\n${doctor.stderr}`);
      assertNoNodeGyp(doctor.stdout + doctor.stderr);
    });
  } finally {
    if (up !== undefined) await up.stop();
    // By pid, because stopping the npx child is not the same as stopping the
    // daemon it started — see `stopRecordedDaemon`. A gate that leaves a
    // daemon holding a port, a `flock` and the ledger behind has not finished,
    // and on Linux it does not even exit.
    const outcome = await stopRecordedDaemon(install.dataDir);
    if (outcome === 'killed' || outcome === 'refused') {
      report(`the clean room's daemon had to be ${outcome}`, outcome === 'killed');
    }
  }

  // AC7 — "removed on success and preserved under DeFlow_KEEP_TMP=1 on
  // failure, with the directory uploaded by actions/upload-artifact in CI".
  // The CI job sets the variable on the step (it cannot know in advance which
  // runs will fail) and uploads `if: failure()`, so this conjunction is what
  // makes a green release run clean up after itself while a red one still has
  // an installed tarball and an npm cache left to look at.
  const failed = results.filter((result) => !result.ok);
  const kept = await settleCleanRoom(install.room, { failed: failed.length > 0 });
  cleanupPackedTarball(good);
  cleanupSystemToolsDir();
  if (kept) process.stdout.write(`\nclean room kept at ${install.room} (DeFlow_KEEP_TMP is set)\n`);

  process.stdout.write(
    `\n${String(results.length - failed.length)}/${String(results.length)} steps passed\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
