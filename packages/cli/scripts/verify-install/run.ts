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
 * **AC2's honest limit.** This step submits a run through the installed
 * `DeFlow run` and waits for `task.submitted` — proof that the inlined
 * daemon, the inlined mock agent and the shipped UI are one artefact. It does
 * not wait for the run to *complete*: no code path in this repository ever
 * executes a submitted run past intake (`packages/daemon/src/boot.ts` starts
 * no ticker; see the identical, already-recorded limit in
 * `e2e/run.test.ts`'s 2026-08-11 amendment, KAR-18.3). That is
 * EPIC-06/EPIC-10/EPIC-11 wiring this epic explicitly does not own — "AC2 —
 * task.submitted" is reported as its own line below rather than folded into a
 * false "run completed".
 */
import process from 'node:process';
import {
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
  removeCleanRoom,
  runInstalled,
  shimMockAgent,
  spawnInstalled,
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

      await step('AC2 — task.submitted reaches the installed daemon', async () => {
        const binDir = `${install.dataDir}-agentbin`;
        const mockAgent = await findInstalledMockAgent(install.npmCacheDir);
        await shimMockAgent(binDir, mockAgent);
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
  }

  // AC7 — the same rule every tmpdir fixture in this repository follows
  // (docs/03 §11): removed unless DeFlow_KEEP_TMP is set, regardless of
  // outcome. CI sets it unconditionally on the job and uploads the directory
  // only `if: failure()`, so a green run still cleans up after itself.
  const kept = !(await removeCleanRoom(install.room));
  cleanupPackedTarball(good);
  cleanupSystemToolsDir();
  const failed = results.filter((result) => !result.ok);
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
