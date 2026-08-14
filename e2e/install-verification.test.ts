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
 * EPIC-18-S46 (honest doctor report), EPIC-20-S2 (the three lowercase bins) ·
 * KAR-18.6 AC1, AC2, AC3, AC4, AC7 · KAR-20.1 AC1
 *
 * EPIC-20-S2 lives here rather than in the integration slice its flow file
 * first declared, and the reason is the same one KAR-18.6 records: the clean
 * room *is* an e2e fixture. It costs a `pnpm build` and a `pnpm pack`, and
 * KAR-18.6's own scenarios (EPIC-18-S42, S45, S46) are declared `e2e` for
 * exactly that. Standing a second one up in the integration project to run
 * three `--version` calls would add minutes to every save and prove nothing
 * the tarball in this file's `beforeAll` does not already carry. The flow file
 * was corrected to say `e2e`.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { DOCTOR_SECTION_IDS, type DoctorReport } from 'deflow';
import { afterAll, afterEach, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  assertInstalledAgentDrivesTurns,
  assertNoNodeGyp,
  assertUiShipped,
  type CliInstall,
  type CliProcess,
  cleanupPackedTarball,
  cleanupSystemToolsDir,
  cliDir,
  findInstalledMockAgent,
  INSTALLED_BINS,
  makeCleanRoom,
  type PackedTarball,
  packGoodTarball,
  removeCleanRoom,
  resolveInstalledBin,
  resolveOnCleanRoomPath,
  runInstalled,
  shimMockAgent,
  spawnInstalled,
  stopRecordedDaemon,
  waitForUrl,
} from '../packages/cli/scripts/verify-install/lib.ts';

let good: PackedTarball;

beforeAll(() => {
  good = packGoodTarball();
}, 600_000);

const rooms: string[] = [];
const running: CliProcess[] = [];

interface DaemonFile {
  readonly pid: number;
}

/** Whether a pid still exists — signal 0 is the question, not an instruction. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The values in an installed agent's row that are properties of *this* build
 * and *this* run rather than of the report: the bundle's digest (whole and
 * abbreviated), the npx cache directory npm names after the tarball's contents,
 * and the instant the binary was probed.
 *
 * Replaced before snapshotting rather than left in, because a committed
 * snapshot that changes on every commit — and again on every re-run — stops
 * being read, at which point `-u` becomes a reflex and the snapshot happily
 * records a regression (docs/14-testing-strategy.md §9). Each is asserted for
 * shape at the call site, so removing them here costs no coverage.
 */
function stable<T>(value: T): T {
  const text = JSON.stringify(value)
    .replaceAll(/\b[0-9a-f]{64}\b/g, '<sha256>')
    .replaceAll(/sha256 [0-9a-f]{12}\b/g, 'sha256 <sha256>')
    .replaceAll(/_npx\\?\/[0-9a-f]{8,}/g, '_npx/<cache>');
  return JSON.parse(text, (key, entry: unknown) => (key === 'probedAt' ? '<ts>' : entry)) as T;
}

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

    const init = await runInstalled({ tgz: good.tgz, bin: 'deflow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);
    assertNoNodeGyp(init.stdout + init.stderr);

    const up = spawnInstalled({
      tgz: good.tgz,
      bin: 'deflow',
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

  it('AC2 — with the tarball\'s own deflow-mock-agent on PATH, "deflow run" reaches the installed daemon', async () => {
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
    const init = await runInstalled({ tgz: good.tgz, bin: 'deflow', argv: ['init'], install });
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
      bin: 'deflow-mock-agent',
      argv: ['--version'],
      install,
    });
    expect(version.status, version.stderr).toBe(0);

    const mockAgent = await findInstalledMockAgent(install.npmCacheDir);
    const binDir = `${install.dataDir}-agentbin`;
    await shimMockAgent(binDir, mockAgent);

    const run = spawnInstalled({
      tgz: good.tgz,
      bin: 'deflow',
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

  it('leaves no daemon behind and releases its pipes, so the release gate can exit', async () => {
    // Measured on this job's first real CI dispatch (run 31547004082,
    // ubuntu-26.04): `pnpm verify:install` printed "10/10 steps passed" forty
    // seconds in and then **never exited** — cancelled twenty-two minutes
    // later, with three orphan processes reported by the runner (npx, sh,
    // node). Every assertion had passed; the script simply could not end.
    //
    // The mechanism is the one thing a spawned CLI can do to its parent that
    // no assertion about its exit code notices: `stop()` waits for the *npx*
    // child, and on Linux that child is reached through an `sh -c` wrapper
    // that does not forward SIGINT to the daemon underneath it. The daemon
    // survives, holding the write end of the pipes this process is reading, so
    // the streams never end and the event loop never empties. macOS forwards
    // the signal and hides all of it.
    //
    // So both halves are asserted here, and neither is platform-specific: the
    // daemon named in `daemon.json` is gone, and the pipes are released
    // whatever happened to it.
    const install = await room();
    const init = await runInstalled({ tgz: good.tgz, bin: 'deflow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);

    const up = spawnInstalled({ tgz: good.tgz, bin: 'deflow', argv: ['up', '--no-open'], install });
    await waitForUrl(up);

    const daemon = JSON.parse(
      readFileSync(join(install.dataDir, 'daemon.json'), 'utf8'),
    ) as DaemonFile;
    // Exactly the verifier's own teardown, in the same order.
    await up.stop();
    expect(await stopRecordedDaemon(install.dataDir)).toMatch(/^(absent|stopped|killed)$/);

    expect(alive(daemon.pid), `daemon pid ${String(daemon.pid)} outlived the verifier`).toBe(false);
    // A pipe nobody closed is the whole of the twenty-two minutes.
    expect(up.child.stdout?.destroyed, 'stdout was left open').toBe(true);
    expect(up.child.stderr?.destroyed, 'stderr was left open').toBe(true);
  }, 120_000);

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
    const init = await runInstalled({ tgz: good.tgz, bin: 'deflow', argv: ['init'], install });
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

    const init = await runInstalled({ tgz: good.tgz, bin: 'deflow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);
    assertNoNodeGyp(init.stdout + init.stderr);
    // better-sqlite3 must have resolved without a compiler: no gyp/rebuild
    // vocabulary anywhere in the transcript either.
    expect(init.stdout + init.stderr).not.toMatch(/node-gyp|gyp rebuild/i);

    const doctor = await runInstalled({
      tgz: good.tgz,
      bin: 'deflow',
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

suite('EPIC-18-S46 — the clean room runs doctor and gets an honest, vendor-free report', () => {
  it('exits 0, renders every section and reports only the bundled agent', async () => {
    const install = await room();
    const init = await runInstalled({ tgz: good.tgz, bin: 'deflow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);

    // No --skip-conformance: the scenario is "npx <tarball> doctor" as a
    // colleague would actually type it. With no *vendor* CLI on PATH the
    // battery has only the bundled agent to run against, which since
    // KAR-19.7 is a real answer rather than a "skipped" check.
    const doctor = await runInstalled({
      tgz: good.tgz,
      bin: 'deflow',
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
    // KAR-19.7 AC8, and this line is the acceptance of it: a clean room is no
    // longer agent-free, because `deflow-mock-agent` came out of the same
    // tarball as the `DeFlow` the operator just ran. Reporting "0 installed"
    // here would be the words not fitting the machine — the operator can see
    // the binary, and a run against it needs no vendor CLI at all.
    expect(summary?.detail).toContain('1 installed: mock');
    expect(summary?.detail).toContain('install');

    // …and nothing offers to fetch it from npm. Every other line may.
    const bundled = agents?.checks.find((check) => check.id === 'agents.mock');
    expect(bundled?.detail ?? '', 'the bundled agent must not be sold from npm').not.toContain(
      'npm install -g',
    );
    // Asserted rather than snapshotted, because these two are what `stable`
    // below removes: the digest changes with every commit that touches the
    // bundle, and the probe time changes with every run.
    expect((bundled?.data as { sha256?: string })?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((bundled?.data as { probedAt?: number })?.probedAt).toBeGreaterThan(0);

    // The whole section, through the normalising serializer. The clean room
    // used to have nothing machine-specific to say about agents because it had
    // none; since KAR-19.7 it has the bundled one, whose row carries a digest
    // and a probe time — so those are replaced here rather than committed,
    // which is what keeps this snapshot from producing a diff on every run.
    expect(stable(agents)).toMatchSnapshot();
  }, 60_000);
});

suite(
  'EPIC-20-S2 — all three bins are lowercase, and all three resolve from a clean-room install',
  () => {
    it('resolves and runs deflow, deflow-mcp and deflow-mock-agent, each from inside the room', async () => {
      // KAR-20.1's own red condition, which nothing else in the repository can
      // see: a `bin` key renamed without its target shipping. Inside the
      // monorepo every one of these names is a workspace path that resolves
      // whatever the manifest says; only an install of the packed bytes asks the
      // question npm will ask.
      //
      // `deflow-mcp` is why this spec exists. It is the one bin no other spec
      // ever spawned from a tarball — `deflow` is exercised by init/up/doctor
      // above and `deflow-mock-agent` by AC2's `--version` — so a build that
      // dropped `mcp.mjs` from tsdown's entry array, or a `bin` key still
      // pointing at the pre-rename path, shipped green.
      const install = await room();

      const manifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
        readonly name: string;
        readonly version: string;
        readonly bin: Readonly<Record<string, string>>;
      };
      // The three the scenario names are the three the package declares — not a
      // list this spec keeps in its own head and forgets to extend.
      expect(Object.keys(manifest.bin)).toEqual([...INSTALLED_BINS]);

      // Given "no DeFlow on PATH beforehand", observed rather than assumed. If
      // the room's PATH already offered one of these names, every resolution
      // below could find the author's own install and the spec would pass on a
      // machine where the tarball ships nothing at all.
      for (const bin of INSTALLED_BINS) {
        expect([bin, resolveOnCleanRoomPath(bin)]).toEqual([bin, '']);
      }

      // When "deflow --version", "deflow-mcp --help" and "deflow-mock-agent
      // --version" are each spawned — then each exits 0.
      const version = await runInstalled({
        tgz: good.tgz,
        bin: 'deflow',
        argv: ['--version'],
        install,
      });
      expect(version.status, version.stderr).toBe(0);
      // And prints the version in packages/cli/package.json — read from the
      // manifest this tarball was packed from, so a `dist/bin.mjs` that resolved
      // some *other* package.json (the workspace root's, say) is a failure here
      // rather than a plausible-looking number.
      expect(version.stdout.trim()).toBe(manifest.version);

      const help = await runInstalled({
        tgz: good.tgz,
        bin: 'deflow-mcp',
        argv: ['--help'],
        install,
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('deflow-mcp');
      // It really is the shim, and not some other binary that happened to
      // answer: the two arguments DeFlowd spawns it with are in its usage.
      expect(help.stdout).toContain('--socket');
      expect(help.stdout).toContain('--run');

      const agent = await runInstalled({
        tgz: good.tgz,
        bin: 'deflow-mock-agent',
        argv: ['--version'],
        install,
      });
      expect(agent.status, agent.stderr).toBe(0);
      expect(agent.stdout.trim()).not.toBe('');

      // And each resolved path is inside the clean room's own install prefix.
      // Through `realpath` on both sides because macOS's tmpdir is a symlink
      // (/var → /private/var) and npm prints the resolved side of it, so a plain
      // prefix comparison is red on one platform and green on the other.
      const roomPrefix = realpathSync(install.room);
      for (const bin of INSTALLED_BINS) {
        const resolved = resolveInstalledBin({ tgz: good.tgz, bin, install });
        expect([bin, resolved]).not.toEqual([bin, '']);
        expect([bin, realpathSync(resolved).startsWith(roomPrefix)]).toEqual([bin, true]);
      }
    }, 180_000);
  },
);
