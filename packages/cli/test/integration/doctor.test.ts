/**
 * KAR-18.4 — `DeFlow doctor`: the environment and capability probe.
 *
 * Integration rather than unit for almost everything here, because almost
 * every one of these checks is a claim about a *machine*: a git that actually
 * executes `merge-tree --write-tree`, a binary that actually resolves on a
 * `PATH`, a directory that actually refuses a write, a file-backed SQLite that
 * actually reports its own tokenizer. A doctor whose checks were satisfiable
 * from a mocked module would be exactly the thing it exists to prevent — a
 * green report about a machine nobody looked at.
 *
 * Verifies: EPIC-18-S26, EPIC-18-S27, EPIC-18-S28, EPIC-18-S29, EPIC-18-S30,
 * EPIC-18-S31, EPIC-18-S32, EPIC-18-S33, EPIC-18-S34, EPIC-18-S35,
 * EPIC-18-S36 · AC1-AC11 · test plan #2-#5, #7-#11
 */
import { openLedger, recordProviderCapabilities, recordTokenSample } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  DOCTOR_EX_FAIL,
  DOCTOR_SECTION_IDS,
  type DoctorReport,
  type DoctorSectionId,
} from '../../src/doctor/report.ts';
import { type DoctorOptions, type DoctorResult, runDoctor } from '../../src/doctor/run.ts';
import {
  doctorEnv,
  fakeBin,
  resolveOnHostPath,
  writeAuthPromptingAgent,
  writeGitShim,
  writeMockAgentShim,
} from './support/doctor-fixture.ts';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/** The check ids of one section, so a spec can assert against ids not prose. */
function section(report: DoctorReport, id: DoctorSectionId) {
  const found = report.sections.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id} section in the report`);
  return found;
}

/** Every reason in one section, joined — what a human would read there. */
const detailsOf = (report: DoctorReport, id: DoctorSectionId): string =>
  section(report, id)
    .checks.map((check) => check.detail)
    .join('\n');

/** A repository with a `.DeFlow/` already in it, as `DeFlow init` leaves one. */
async function workspace(name = 'repo'): Promise<string> {
  const repo = await makeRepo({ dir: join(tmp, name) });
  await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });
  return repo.dir;
}

/** The battery spawns a process per assertion per adapter; the specs that are
 * not about conformance say so rather than paying for it. */
const base = (overrides: DoctorOptions): DoctorOptions => ({
  clock: new TestClock(1_755_000_000_000),
  conformance: false,
  ...overrides,
});

suite('doctor on a fully provisioned machine (EPIC-18-S26)', () => {
  it('prints all eight categories, exercises merge-tree, and exits 0', async () => {
    const cwd = await workspace();
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await writeMockAgentShim(binDir, { name: 'claude-agent-acp', version: '0.64.1' });
    await fakeBin(binDir, 'bwrap');
    await fakeBin(binDir, 'socat');

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
        capabilityFixtureDir: join(tmp, 'capabilities'),
        // The one spec that pays for the F3.4 battery: "all eight categories"
        // is not a claim worth making with the expensive one turned off.
        conformance: true,
      }),
    );

    // AC1 — all eight, every check with one of the three verdicts and a reason,
    // and no section empty or omitted.
    expect(result.report.sections.map((entry) => entry.id)).toEqual([...DOCTOR_SECTION_IDS]);
    for (const entry of result.report.sections) {
      expect(result.stdout).toContain(entry.title);
      expect(entry.checks.length).toBeGreaterThan(0);
      for (const check of entry.checks) {
        expect(['ok', 'warn', 'fail']).toContain(check.status);
        expect(check.detail.trim()).not.toBe('');
      }
    }

    // The git half of EPIC-18-S28's second scenario: executed, not inferred.
    expect(detailsOf(result.report, 'git')).toContain('merge-tree --write-tree');
    expect(detailsOf(result.report, 'git')).toMatch(/executed/);
    expect(section(result.report, 'git').status).toBe('ok');

    // The Agents section: absolute resolved path, --version output, sha256.
    const agents = detailsOf(result.report, 'agents');
    expect(agents).toContain(join(binDir, 'claude-agent-acp'));
    expect(agents).toContain('0.64.1');
    const sha = createHash('sha256')
      .update(readFileSync(join(binDir, 'claude-agent-acp')))
      .digest('hex');
    expect(agents).toContain(sha.slice(0, 12));

    // Category 6 actually ran against the installed binary, and says how many
    // assertions it could stage — a skip is a result, never a pass.
    const conformance = section(result.report, 'conformance');
    expect(conformance.checks.map((check) => check.id)).toContain('conformance.claude');
    expect(detailsOf(result.report, 'conformance')).toMatch(/\d+ passed, \d+ failed, \d+ skipped/);

    expect(result.report.status).not.toBe('fail');
    expect(result.exitCode).toBe(0);
  });
});

suite('doctor with no agent CLI at all (EPIC-18-S27)', () => {
  it('degrades with instructions instead of a stack trace', async () => {
    const cwd = await workspace();
    const dataDir = join(tmp, 'data');

    const result = await runDoctor(
      base({ cwd, env: doctorEnv({ dataDir, realGit: true }), conformance: true }),
    );

    const agents = detailsOf(result.report, 'agents');
    expect(agents).toContain('0 installed');
    // AC2 — the concrete install hint per supported vendor.
    for (const pkg of [
      '@agentclientprotocol/claude-agent-acp',
      '@agentclientprotocol/codex-acp',
      'opencode-ai',
      '@github/copilot',
      '@google/gemini-cli',
    ]) {
      expect(agents).toContain(`npm install -g ${pkg}`);
    }
    expect(agents).toContain('DeFlow replay');
    expect(agents).toContain('mock agent');

    expect(detailsOf(result.report, 'capabilities')).toContain('no matrix');
    // "skipped", never "passed": a green doctor on a machine where nothing was
    // tested is how a broken adapter reaches a three-hour run.
    expect(detailsOf(result.report, 'conformance')).toContain('skipped');
    expect(detailsOf(result.report, 'conformance')).toContain('no adapter installed');
    expect(section(result.report, 'conformance').status).not.toBe('ok');

    // The sandbox section still reports what the platform could honour.
    expect(detailsOf(result.report, 'sandboxing')).toContain('read');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toMatch(/\bat .*:\d+:\d+/);
  });
});

suite('the git version gate (EPIC-18-S28)', () => {
  const rows = [
    { version: '2.37.0', status: 'fail', mechanism: 'merge-tree --write-tree', code: 5 },
    { version: '2.38.0', status: 'warn', mechanism: 'worktree list --porcelain -z', code: 0 },
    { version: '2.44.1', status: 'warn', mechanism: 'worktree list --porcelain -z', code: 0 },
    { version: '2.45.0', status: 'ok', mechanism: 'merge-tree --write-tree', code: 0 },
  ] as const;

  for (const row of rows) {
    it(`reports ${row.status} for git ${row.version} and exits ${row.code}`, async () => {
      const realGit = resolveOnHostPath('git');
      expect(realGit).not.toBeNull();

      const cwd = await workspace(`repo-${row.version}`);
      const dataDir = join(tmp, `data-${row.version}`);
      const binDir = join(tmp, `bin-${row.version}`);
      await writeGitShim(binDir, { version: row.version, realGit: realGit as string });

      const result = await runDoctor(base({ cwd, env: doctorEnv({ dataDir, binDirs: [binDir] }) }));

      const git = section(result.report, 'git');
      expect(git.checks.find((check) => check.id === 'git.version')?.status).toBe(row.status);
      expect(detailsOf(result.report, 'git')).toContain(row.mechanism);
      expect(result.exitCode).toBe(row.code);
    });
  }

  it('does not trust the version string on its own', async () => {
    const cwd = await workspace('merge-tree-repo');
    const dataDir = join(tmp, 'mt-data');

    const result = await runDoctor(base({ cwd, env: doctorEnv({ dataDir, realGit: true }) }));

    const exercised = section(result.report, 'git').checks.find(
      (check) => check.id === 'git.merge-tree',
    );
    expect(exercised?.status).toBe('ok');
    expect(exercised?.detail).toContain('executed');
    // Both halves: a clean merge is exit 0 and a conflicting one is exit 1.
    expect(exercised?.data?.clean).toBe(0);
    expect(exercised?.data?.conflicting).toBe(1);
  });
});

suite('Linux sandbox prerequisites (EPIC-18-S29)', () => {
  const rows = [
    {
      bwrap: true,
      socat: true,
      userns: '0',
      levels: 'read, worktree, worktree+net, full',
      status: 'ok',
    },
    { bwrap: false, socat: true, userns: '0', levels: 'read', status: 'warn' },
    { bwrap: true, socat: false, userns: '0', levels: 'read', status: 'warn' },
    { bwrap: true, socat: true, userns: '1', levels: 'read', status: 'warn' },
  ] as const;

  for (const row of rows) {
    it(`honours ${row.levels} with bwrap=${row.bwrap} socat=${row.socat} userns=${row.userns}`, async () => {
      const cwd = await workspace(`sandbox-${row.bwrap}-${row.socat}-${row.userns}`);
      const dataDir = join(tmp, `sandbox-data-${row.bwrap}-${row.socat}-${row.userns}`);
      const binDir = join(tmp, `sandbox-bin-${row.bwrap}-${row.socat}-${row.userns}`);
      await mkdir(binDir, { recursive: true });
      if (row.bwrap) await fakeBin(binDir, 'bwrap');
      if (row.socat) await fakeBin(binDir, 'socat');

      const result = await runDoctor(
        base({
          cwd,
          env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
          platform: 'linux',
          readSysctl: () => row.userns,
        }),
      );

      const sandbox = section(result.report, 'sandboxing');
      const levels = sandbox.checks.find((check) => check.id === 'sandboxing.levels');
      expect(levels?.status).toBe(row.status);
      expect(levels?.data?.honourable).toEqual(row.levels.split(', '));
      expect(levels?.detail).toContain(row.levels);
    });
  }

  it('names the fix and states the fail-closed policy', async () => {
    const cwd = await workspace('sandbox-fix');
    const dataDir = join(tmp, 'sandbox-fix-data');
    const binDir = join(tmp, 'sandbox-fix-bin');
    await fakeBin(binDir, 'socat');

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
        platform: 'linux',
        readSysctl: () => '1',
      }),
    );

    const detail = detailsOf(result.report, 'sandboxing');
    expect(detail).toContain('sudo apt install bubblewrap socat');
    expect(detail).toContain('/etc/apparmor.d/bwrap');
    expect(detail).toContain('sandbox.failIfUnavailable: true');
    expect(detail).toContain('allowUnsandboxedCommands: false');
    expect(detail).toContain('unsandboxed');
    expect(result.exitCode).toBe(0);
  });
});

suite('auth shadowing (EPIC-18-S30)', () => {
  it('names the variable, the provider it shadows and the effective mode', async () => {
    const cwd = await workspace('auth');
    const dataDir = join(tmp, 'auth-data');

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({
          dataDir,
          realGit: true,
          extra: { ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' },
        }),
      }),
    );

    const auth = section(result.report, 'auth');
    expect(auth.status).toBe('warn');
    const detail = detailsOf(result.report, 'auth');
    expect(detail).toContain('ANTHROPIC_API_KEY');
    expect(detail).toContain('claude');
    expect(detail).toContain('subscription');
    expect(detail).toContain('provider.auth_shadow_stripped');
    // Never the value, in either rendering.
    expect(result.stdout).not.toContain('sk-test-not-a-real-key');
    expect(result.exitCode).toBe(0);
  });

  it('says so plainly when nothing shadows anything', async () => {
    const cwd = await workspace('auth-clean');
    const dataDir = join(tmp, 'auth-clean-data');

    const result = await runDoctor(base({ cwd, env: doctorEnv({ dataDir, realGit: true }) }));

    expect(section(result.report, 'auth').status).toBe('ok');
    expect(detailsOf(result.report, 'auth')).toContain('no shadowing variable');
  });

  it('prints the login command a vendor reported, and never runs it', async () => {
    const cwd = await workspace('auth-login');
    const dataDir = join(tmp, 'auth-login-data');
    const binDir = join(tmp, 'auth-login-bin');
    const log = join(tmp, 'auth-login-invocations.jsonl');
    await writeAuthPromptingAgent(binDir, { name: 'copilot', version: '1.0.77', log });

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
        capabilityFixtureDir: join(tmp, 'auth-login-fixtures'),
      }),
    );

    const detail = detailsOf(result.report, 'auth');
    expect(detail).toContain('copilot auth login');
    expect(detail).toMatch(/never executes it|prints it/);
    expect(section(result.report, 'auth').status).toBe('warn');

    // AR-1's runtime half: doctor asked the binary its version and handshook
    // it once. It never invoked the login command the agent handed back.
    const invocations = (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.filter((argv) => argv.includes('auth') || argv.includes('login'))).toEqual(
      [],
    );
    expect(result.exitCode).toBe(0);
  });
});

suite('the capability matrix is regenerated (EPIC-18-S31)', () => {
  it('records what the probed profile actually advertised, never a constant', async () => {
    const cwd = await workspace('caps');
    const dataDir = join(tmp, 'caps-data');
    const binDir = join(tmp, 'caps-bin');
    const fixtures = join(tmp, 'caps-fixtures');
    await writeMockAgentShim(binDir, { name: 'gemini', profile: 'gemini', version: '0.53.1' });

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
        capabilityFixtureDir: fixtures,
      }),
    );

    const gemini = section(result.report, 'capabilities').checks.find(
      (check) => check.id === 'capabilities.gemini',
    );
    expect(gemini).toBeDefined();
    expect(gemini?.data?.matrix).toMatchObject({ resume: false, fork: false, list: false });
    // The resume strategy DeFlow would actually use for that adapter.
    expect(gemini?.detail).toContain('ResumeByReplay');

    // AC6 — the fixture file, rewritten with a probe timestamp.
    const written = await readdir(fixtures);
    expect(written).toContain('gemini@0.53.1.json');
    const fixture = JSON.parse(await readFile(join(fixtures, 'gemini@0.53.1.json'), 'utf8')) as {
      probedAt: string;
      capabilityMatrix: Record<string, unknown>;
    };
    expect(Date.parse(fixture.probedAt)).toBe(1_755_000_000_000);
    expect(fixture.capabilityMatrix.resume).toBe(false);
  });

  it('reports a diff against the recorded baseline, naming the adapter and the field', async () => {
    const cwd = await workspace('caps-diff');
    const dataDir = join(tmp, 'caps-diff-data');
    const binDir = join(tmp, 'caps-diff-bin');
    const fixtures = join(tmp, 'caps-diff-fixtures');
    await writeMockAgentShim(binDir, { name: 'gemini', profile: 'claude', version: '0.53.1' });

    // The baseline: what the last probe of this adapter recorded.
    await mkdir(fixtures, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(fixtures, 'gemini@0.52.0.json'),
      `${JSON.stringify(
        {
          agent: 'gemini',
          version: '0.52.0',
          probedAt: '2026-08-02T00:00:00.000Z',
          capabilityMatrix: { resume: false, fork: false, list: false },
        },
        null,
        2,
      )}\n`,
    );

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
        capabilityFixtureDir: fixtures,
      }),
    );

    const detail = detailsOf(result.report, 'capabilities');
    expect(detail).toContain('gemini');
    expect(detail).toContain('resume');
    expect(detail).toMatch(/false\s*→\s*true|false -> true/);
    expect(section(result.report, 'capabilities').status).toBe('warn');
    expect(result.exitCode).toBe(0);
  });
});

suite('binary drift since the last recorded probe (EPIC-18-S32)', () => {
  const recordedSha = 'a'.repeat(64);

  async function stage(options: {
    readonly dir: string;
    readonly recordedVersion: string;
    readonly recordedSha: string;
    readonly installedVersion: string;
  }): Promise<DoctorResult> {
    const cwd = await workspace(`drift-${options.dir}`);
    const dataDir = join(tmp, `drift-data-${options.dir}`);
    const binDir = join(tmp, `drift-bin-${options.dir}`);
    const binary = await writeMockAgentShim(binDir, {
      name: 'claude-agent-acp',
      version: options.installedVersion,
    });

    await mkdir(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    try {
      recordProviderCapabilities(db, {
        provider: 'claude',
        version: options.recordedVersion,
        binarySha256: options.recordedSha,
        binaryPath: binary,
        capsJson: '{"agentCapabilities":{}}',
        probedAt: 1_754_000_000_000,
      });
    } finally {
      db.close();
    }

    return runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
        capabilityFixtureDir: join(tmp, `drift-fixtures-${options.dir}`),
      }),
    );
  }

  it('is quiet when nothing moved', async () => {
    const cwd = await workspace('drift-none');
    const dataDir = join(tmp, 'drift-none-data');
    const binDir = join(tmp, 'drift-none-bin');
    const binary = await writeMockAgentShim(binDir, {
      name: 'claude-agent-acp',
      version: '0.64.1',
    });
    const sha = createHash('sha256').update(readFileSync(binary)).digest('hex');

    await mkdir(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    try {
      recordProviderCapabilities(db, {
        provider: 'claude',
        version: '0.64.1',
        binarySha256: sha,
        binaryPath: binary,
        capsJson: '{"agentCapabilities":{}}',
        probedAt: 1_754_000_000_000,
      });
    } finally {
      db.close();
    }

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
        capabilityFixtureDir: join(tmp, 'drift-none-fixtures'),
      }),
    );

    const drift = section(result.report, 'agents').checks.find(
      (check) => check.id === 'agents.claude.drift',
    );
    expect(drift?.status).toBe('ok');
  });

  it('warns on a version bump, naming both values', async () => {
    const result = await stage({
      dir: 'version',
      recordedVersion: '0.64.1',
      recordedSha,
      installedVersion: '0.65.0',
    });

    const drift = section(result.report, 'agents').checks.find(
      (check) => check.id === 'agents.claude.drift',
    );
    expect(drift?.status).toBe('warn');
    expect(drift?.detail).toContain('0.64.1');
    expect(drift?.detail).toContain('0.65.0');
    expect(drift?.detail).toContain('pnpm test:record');
    expect(result.exitCode).toBe(0);
  });

  it('warns on a rebuilt binary at an unchanged version, naming both hashes', async () => {
    const result = await stage({
      dir: 'sha',
      recordedVersion: '0.64.1',
      recordedSha,
      installedVersion: '0.64.1',
    });

    const drift = section(result.report, 'agents').checks.find(
      (check) => check.id === 'agents.claude.drift',
    );
    expect(drift?.status).toBe('warn');
    expect(drift?.detail).toContain(recordedSha.slice(0, 12));
    expect(drift?.detail).toContain('pnpm test:record');
  });
});

suite('an unwritable state directory (EPIC-18-S33)', () => {
  it.skipIf(process.getuid?.() === 0)(
    'fails with the absolute path and the errno for the global state dir',
    async () => {
      const cwd = await workspace('ro-global');
      const readOnlyParent = join(tmp, 'ro-parent');
      await mkdir(readOnlyParent, { recursive: true });
      const dataDir = join(readOnlyParent, 'DeFlow');
      await mkdir(dataDir, { recursive: true });
      await chmod(dataDir, 0o500);

      try {
        const result = await runDoctor(base({ cwd, env: doctorEnv({ dataDir, realGit: true }) }));

        const check = section(result.report, 'runtime').checks.find(
          (entry) => entry.id === 'runtime.state-dir',
        );
        expect(check?.status).toBe('fail');
        expect(check?.detail).toContain(dataDir);
        expect(check?.detail).toContain('EACCES');
        expect(result.exitCode).toBe(DOCTOR_EX_FAIL);
      } finally {
        await chmod(dataDir, 0o700);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'fails with the absolute path and the errno for the repo-local .DeFlow/',
    async () => {
      const cwd = await workspace('ro-local');
      const dataDir = join(tmp, 'ro-local-data');
      const local = join(cwd, '.DeFlow');
      await chmod(local, 0o500);

      try {
        const result = await runDoctor(base({ cwd, env: doctorEnv({ dataDir, realGit: true }) }));

        const check = section(result.report, 'runtime').checks.find(
          (entry) => entry.id === 'runtime.workspace-dir',
        );
        expect(check?.status).toBe('fail');
        expect(check?.detail).toContain(local);
        expect(check?.detail).toContain('EACCES');
        expect(result.exitCode).toBe(DOCTOR_EX_FAIL);
      } finally {
        await chmod(local, 0o700);
      }
    },
  );
});

suite('the memory layer (EPIC-18-S34)', () => {
  it('reports FTS5, the exact tokenizer, the seeds and every calibrated row', async () => {
    const cwd = await workspace('memory');
    const dataDir = join(tmp, 'memory-data');
    await mkdir(dataDir, { recursive: true });

    const db = openLedger(dataDir);
    try {
      for (let index = 0; index < 3; index += 1) {
        recordTokenSample(db, {
          provider: 'anthropic',
          model: 'opus-x',
          family: 'anthropic',
          estimated: 1000,
          actual: 1300,
          now: 1_755_000_000_000,
        });
      }
      for (let index = 0; index < 24; index += 1) {
        recordTokenSample(db, {
          provider: 'anthropic',
          model: 'opus-y',
          family: 'anthropic',
          estimated: 1000,
          actual: 1150,
          now: 1_755_000_000_000,
        });
      }
    } finally {
      db.close();
    }

    const result = await runDoctor(base({ cwd, env: doctorEnv({ dataDir, realGit: true }) }));

    const memory = detailsOf(result.report, 'memory');
    expect(memory).toContain("unicode61 remove_diacritics 2 tokenchars '_-.'");
    expect(memory).toMatch(/FTS5.*available/i);
    // AC9 — below n = 5 the seed is what is applied, and it says so by name.
    expect(memory).toContain('anthropic 1.2');
    expect(memory).toContain('openai 1.0');
    expect(memory).toContain('default 1.05');
    expect(memory).toContain('anthropic/opus-x: 1.2 (seed, n=3)');
    expect(memory).toMatch(/anthropic\/opus-y: 1\.\d+ \(learned, n=24\)/);
    // The secretlint rule count, stated rather than omitted.
    expect(memory).toMatch(/secretlint/i);
    expect(result.exitCode).toBe(0);
  });
});

suite('@lydell/node-pty did not load (EPIC-18-S35)', () => {
  it('warns, states the degradation, and still exits 0', async () => {
    const cwd = await workspace('pty');
    const dataDir = join(tmp, 'pty-data');

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, realGit: true }),
        loadPty: async () => null,
      }),
    );

    const pty = section(result.report, 'memory').checks.find((check) => check.id === 'memory.pty');
    expect(pty?.status).toBe('warn');
    expect(pty?.detail).toContain('terminal/*');
    expect(pty?.detail).toContain('no-TTY');
    expect(pty?.detail).toContain('not advertised');
    expect(result.exitCode).toBe(0);
  });

  it('is ok when the module loads', async () => {
    const cwd = await workspace('pty-ok');
    const dataDir = join(tmp, 'pty-ok-data');

    const result = await runDoctor(
      base({
        cwd,
        env: doctorEnv({ dataDir, realGit: true }),
        loadPty: async () => ({ spawn: () => undefined }),
      }),
    );

    expect(
      section(result.report, 'memory').checks.find((check) => check.id === 'memory.pty')?.status,
    ).toBe('ok');
  });
});

suite('--json and the exit-code contract (EPIC-18-S36)', () => {
  it('emits one document with the same statuses and the same exit code', async () => {
    const cwd = await workspace('json');
    const dataDir = join(tmp, 'json-data');
    const env = doctorEnv({ dataDir, realGit: true });
    const clock = new TestClock(1_755_000_000_000);

    const text = await runDoctor({ cwd, env, clock, conformance: false });
    const json = await runDoctor({ cwd, env, clock, conformance: false, json: true });

    expect(json.exitCode).toBe(text.exitCode);

    const parsed = JSON.parse(json.stdout) as {
      exitCode: number;
      sections: { id: string; checks: { id: string; status: string }[] }[];
    };
    expect(parsed.exitCode).toBe(json.exitCode);

    for (const entry of text.report.sections) {
      const rendered = parsed.sections.find((candidate) => candidate.id === entry.id);
      expect(rendered).toBeDefined();
      for (const check of entry.checks) {
        expect(rendered?.checks.find((candidate) => candidate.id === check.id)?.status).toBe(
          check.status,
        );
      }
    }
  });

  it('exits 5 through both renderings when anything fails', async () => {
    const realGit = resolveOnHostPath('git');
    const cwd = await workspace('json-fail');
    const dataDir = join(tmp, 'json-fail-data');
    const binDir = join(tmp, 'json-fail-bin');
    await writeGitShim(binDir, { version: '2.30.0', realGit: realGit as string });
    const env = doctorEnv({ dataDir, binDirs: [binDir] });
    const clock = new TestClock(1_755_000_000_000);

    const text = await runDoctor({ cwd, env, clock, conformance: false });
    const json = await runDoctor({ cwd, env, clock, conformance: false, json: true });

    expect(text.exitCode).toBe(DOCTOR_EX_FAIL);
    expect(json.exitCode).toBe(DOCTOR_EX_FAIL);
    expect((JSON.parse(json.stdout) as { exitCode: number }).exitCode).toBe(DOCTOR_EX_FAIL);
  });
});
