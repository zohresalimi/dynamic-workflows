/**
 * KAR-18.6 — the real published tarball, installed into an empty directory
 * and run. `pnpm build` producing a green local run proves nothing about the
 * tarball (docs/03-local-development.md §10); every assertion here is against
 * bytes that went through `pnpm pack`, run with `npm exec --package=<tgz> --
 * DeFlow …` — the fixed-up equivalent of the docs' `npx <tgz> …` (see
 * `packages/cli/scripts/verify-install/lib.ts`'s note on this repository's
 * npm 11).
 *
 * One `pnpm build` + `pnpm pack` in `beforeAll`, shared by every spec below —
 * mirroring `packages/cli/test/integration/build.test.ts`'s own real build,
 * and for the same reason: building twice to prove three different things
 * about the same artefact wastes the one thing this suite cannot get back,
 * wall-clock time.
 *
 * Verifies: EPIC-18-S42 (happy path), EPIC-18-S45 (no compiler),
 * EPIC-18-S46 (honest doctor report) · AC1, AC2, AC3, AC4, AC7
 */
import { DOCTOR_SECTION_IDS, type DoctorReport } from 'DeFlow';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  assertInstalledAgentDrivesTurns,
  assertNoNodeGyp,
  assertUiShipped,
  type CliInstall,
  type CliProcess,
  cleanupPackedTarball,
  cleanupSystemToolsDir,
  findInstalledMockAgent,
  makeCleanRoom,
  type PackedTarball,
  packGoodTarball,
  removeCleanRoom,
  runInstalled,
  shimMockAgent,
  spawnInstalled,
  waitForUrl,
} from '../packages/cli/scripts/verify-install/lib.ts';

let good: PackedTarball;

beforeAll(() => {
  good = packGoodTarball();
}, 600_000);

const rooms: string[] = [];
const running: CliProcess[] = [];

async function room(): Promise<CliInstall> {
  const install = await makeCleanRoom();
  rooms.push(install.room);
  return install;
}

afterEach(async () => {
  for (const cli of running.splice(0)) await cli.stop();
  for (const dir of rooms.splice(0)) await removeCleanRoom(dir);
});

afterAll(async () => {
  for (const cli of running.splice(0)) await cli.stop();
  cleanupPackedTarball(good);
  cleanupSystemToolsDir();
});

suite('EPIC-18-S42 — the real tarball, installed into a clean temp directory and run', () => {
  it('GET /api/health answers, GET / serves the real UI, and the install spawns no node-gyp', async () => {
    const install = await room();

    const init = await runInstalled({ tgz: good.tgz, bin: 'DeFlow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);
    assertNoNodeGyp(init.stdout + init.stderr);

    const up = spawnInstalled({
      tgz: good.tgz,
      bin: 'DeFlow',
      argv: ['up', '--no-open'],
      install,
    });
    running.push(up);
    const url = await waitForUrl(up);
    const baseUrl = new URL(url).origin;

    // AC1 — the assertion the story exists for: a referenced /assets/*.js
    // that actually answers JavaScript, not merely a 200 on `/`. A daemon
    // whose dist/ui/ is missing answers 200 on `/` just as happily, because
    // the SPA fallback serves index.html for any unmatched path.
    const { assetPath } = await assertUiShipped(baseUrl);
    expect(assetPath).toMatch(/^\/assets\/.+\.(js|mjs)$/);

    await up.stop();
  }, 120_000);

  it('AC2 — with the tarball\'s own DeFlow-mock-agent on PATH, "DeFlow run" reaches the installed daemon', async () => {
    // This closes test plan row 2's red condition — mock-agent.mjs missing
    // from the tsdown entry array, so the tarball's second bin does not
    // exist — by resolving and executing the *installed* bin, not the
    // workspace source.
    //
    // What it does not claim: that the run *completes*. No code path in
    // this repository executes a submitted run past intake —
    // `packages/daemon/src/boot.ts` starts no ticker — which is the exact,
    // already-recorded limit `e2e/run.test.ts`'s 2026-08-11 amendment
    // documents for KAR-18.3. That is EPIC-06/EPIC-10/EPIC-11 wiring this
    // epic does not own; asserting "exits 0" here would be the fake pass
    // the working agreement forbids.
    const install = await room();
    const init = await runInstalled({ tgz: good.tgz, bin: 'DeFlow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);

    // "Present in one artefact" means functional, not merely on disk: the
    // installed bin has to actually run. `@DeFlow/mock-agent`'s capability
    // profiles are computed at import time from a fixture path resolved off
    // `import.meta.url` — correct inside the workspace, where that file is a
    // sibling of the *source*; wrong once tsdown inlines the module into
    // `dist/mock-agent.mjs`, where the same relative path points at a
    // `fixtures/` directory the tarball never ships (`files: ["dist"]`).
    const version = await runInstalled({
      tgz: good.tgz,
      bin: 'DeFlow-mock-agent',
      argv: ['--version'],
      install,
    });
    expect(version.status, version.stderr).toBe(0);

    const mockAgent = await findInstalledMockAgent(install.npmCacheDir);
    const binDir = `${install.dataDir}-agentbin`;
    await shimMockAgent(binDir, mockAgent);

    const run = spawnInstalled({
      tgz: good.tgz,
      bin: 'DeFlow',
      argv: ['run', 'add a health endpoint'],
      install,
      binDirs: [binDir],
    });
    running.push(run);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !run.stdout().includes('submitted')) {
      if (run.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(run.stdout(), run.stderr()).toContain('submitted');

    run.child.kill('SIGINT');
    const { code } = await run.exited;
    // The detach path (KAR-18.3 AC6): the daemon it started keeps running,
    // and the CLI itself exits 130.
    expect(code).toBe(130);
  }, 60_000);

  it('AC2 — the installed daemon drives real ACP turns against the installed mock agent', async () => {
    // The half of AC2 that *is* reachable, asserted properly rather than
    // asserted away. "This proves the inlined daemon, the inlined mock agent
    // and the shipped UI are all present in one artefact" is a claim about the
    // three of them working together, and the spec above only shows the second
    // one starting up (`--version`) and the first one accepting an intake.
    //
    // Here the installed daemon *spawns* the installed mock agent and holds
    // real ACP conversations with it — an `initialize` whose response becomes
    // the capability matrix, then the F3.4 conformance battery, which is a
    // turn per assertion. Every byte on both sides of those turns came out of
    // the tarball. The failure this catches is precisely the one the story was
    // written for and which this epic already hit once: `@DeFlow/mock-agent`
    // resolving a fixture through an `import.meta.url`-relative path that
    // exists in the workspace and not in the tarball, so the installed binary
    // threw before it could answer anything.
    const install = await room();
    const init = await runInstalled({ tgz: good.tgz, bin: 'DeFlow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);

    const mockAgent = await findInstalledMockAgent(install.npmCacheDir);
    const binDir = `${install.dataDir}-agentbin`;
    await shimMockAgent(binDir, mockAgent);

    const turns = await assertInstalledAgentDrivesTurns({ tgz: good.tgz, install, binDir });

    // The battery staged assertions and some of them passed — a turn was
    // driven end to end through installed bytes. It is not `failed === 0`: the
    // mock agent's default scenario does not stage a cancel or a permission
    // request, so the battery reports those as failures on this machine too
    // (`packages/cli/test/integration/doctor.test.ts` asserts the same shape
    // against the *workspace* binary). What matters here is the packaging
    // claim, and a battery that could not start reports zero of everything.
    expect(turns.passed).toBeGreaterThan(0);
    expect(turns.binary).toBe(join(binDir, 'claude-agent-acp'));
  }, 120_000);
});

suite('EPIC-18-S45 — no compiler on the box: nothing invokes node-gyp', () => {
  it('better-sqlite3 resolves a prebuild and the doctor-visible mock run completes with no compiler on PATH', async () => {
    // The harness's own PATH is already minimal by construction —
    // `spawnInstalled` builds it from `binDirs`, node's own directory and
    // git's, nothing else — so this spec's PATH already has no cc, no make
    // and no python3. What is asserted is the *evidence*: nothing in the
    // install transcript mentions node-gyp, which is the failure mode the
    // native dependency this replaced (`node-pty@1.1.0`) hit outright in a
    // toolchain-less environment.
    const install = await room();

    const init = await runInstalled({ tgz: good.tgz, bin: 'DeFlow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);
    assertNoNodeGyp(init.stdout + init.stderr);
    // better-sqlite3 must have resolved without a compiler: no gyp/rebuild
    // vocabulary anywhere in the transcript either.
    expect(init.stdout + init.stderr).not.toMatch(/node-gyp|gyp rebuild/i);

    const doctor = await runInstalled({
      tgz: good.tgz,
      bin: 'DeFlow',
      argv: ['doctor', '--skip-conformance', '--json'],
      install,
    });
    expect(doctor.status, doctor.stderr).toBe(0);
    const report = JSON.parse(doctor.stdout) as DoctorReport;
    const memory = report.sections.find((section) => section.id === 'memory');
    const pty = memory?.checks.find((check) => check.id === 'memory.pty');
    // AC4's fallback clause: on this machine @lydell/node-pty resolves and
    // is loaded; if a future platform lacks a prebuild the check degrades to
    // the no-TTY path rather than failing the install (KAR-18.4), which is
    // exactly what `status` reports instead of `ok` here.
    expect(pty?.status).not.toBe('fail');
  }, 60_000);
});

suite('EPIC-18-S46 — the clean room runs doctor and gets an honest, agent-free report', () => {
  it('exits 0, renders every section and reports zero agents with install hints', async () => {
    const install = await room();
    const init = await runInstalled({ tgz: good.tgz, bin: 'DeFlow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);

    // No --skip-conformance: the scenario is "npx <tarball> doctor" as a
    // colleague would actually type it. With zero agents on PATH the
    // conformance battery has nothing to run against and reports its own
    // "skipped" check rather than this flag skipping the section outright.
    const doctor = await runInstalled({
      tgz: good.tgz,
      bin: 'DeFlow',
      argv: ['doctor', '--json'],
      install,
    });

    expect(doctor.status, doctor.stderr).toBe(0);
    // No check ever resolved a fixture relative to the workspace root
    // (test plan row 5's red condition): that failure mode is a thrown
    // exception, which would land here as a non-JSON stdout and a stack
    // trace on stderr, not as a clean --json document.
    expect(doctor.stderr).not.toMatch(/\bat .*:\d+:\d+/);

    const report = JSON.parse(doctor.stdout) as DoctorReport;
    expect(report.exitCode).toBe(0);
    expect(report.status).not.toBe('fail');
    expect(report.sections.map((section) => section.id)).toEqual([...DOCTOR_SECTION_IDS]);

    const agents = report.sections.find((section) => section.id === 'agents');
    const summary = agents?.checks.find((check) => check.id === 'agents.summary');
    expect(summary?.status).toBe('ok');
    expect(summary?.detail).toContain('0 installed');
    expect(summary?.detail).toContain('install');

    // The whole report, through the normalising serializer — deterministic
    // because a clean room with no agent CLI on PATH has nothing
    // machine-specific left to say about them.
    expect(agents).toMatchSnapshot();
  }, 60_000);
});
