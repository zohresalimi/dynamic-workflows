/**
 * KAR-18.4 — `deflow doctor` through the real binary.
 *
 * `doctor.test.ts` next door drives `runDoctor` directly, because that is
 * where the checks live. What only a spawned process can settle is the half
 * this file covers: that the argv parser reaches the command at all, that
 * `--json` selects the machine document, and — the one that matters most —
 * that **the exit code survives the trip to the shell**. AC10's whole claim is
 * that CI consumes the exit code, and an exit code that is computed correctly
 * and then dropped by the bin is indistinguishable from one that was never
 * computed.
 *
 * A real subprocess, so `process.exitCode` (set rather than forced, so stdout
 * drains) is exercised exactly as `npx deflowai doctor` exercises it.
 *
 * Verifies: EPIC-18-S36 · AC10, AC11
 */
import { makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  doctorEnv,
  fakeBin,
  resolveOnHostPath,
  writeFakeNpm,
  writeGitShim,
  writeMockAgentShim,
} from './support/doctor-fixture.ts';

/** The file `dist/bin.mjs` is built from, and the one `npx` runs. */
const CLI_BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runBin(args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<Ran>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: out.join(''), stderr: err.join('') }));
  });
}

async function workspace(name: string): Promise<string> {
  const repo = await makeRepo({ dir: join(tmp, name) });
  await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });
  return repo.dir;
}

suite('deflow doctor through the binary', () => {
  it('prints the report and exits 0 on a healthy machine', async () => {
    const cwd = await workspace('bin-ok');
    const env = doctorEnv({ dataDir: join(tmp, 'bin-ok-data'), realGit: true });

    const ran = await runBin(['doctor', '--skip-conformance'], { cwd, env });

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('deflow doctor');
    for (const title of ['Runtime', 'git', 'Sandboxing', 'Agents', 'Capabilities']) {
      expect(ran.stdout).toContain(title);
    }
    expect(ran.stderr).not.toMatch(/\bat .*:\d+:\d+/);
  }, 60_000);

  it('emits one JSON document under --json and carries exit 5 out to the shell', async () => {
    const realGit = resolveOnHostPath('git');
    const cwd = await workspace('bin-fail');
    const binDir = join(tmp, 'bin-fail-bin');
    await writeGitShim(binDir, { version: '2.30.0', realGit: realGit as string });
    const env = doctorEnv({ dataDir: join(tmp, 'bin-fail-data'), binDirs: [binDir] });

    const ran = await runBin(['doctor', '--json', '--skip-conformance'], { cwd, env });

    expect(ran.code).toBe(5);
    const parsed = JSON.parse(ran.stdout) as { exitCode: number; status: string };
    expect(parsed.exitCode).toBe(5);
    expect(parsed.status).toBe('fail');
  }, 60_000);

  it('refuses an option it does not know, rather than ignoring it', async () => {
    const cwd = await workspace('bin-usage');
    const env = doctorEnv({ dataDir: join(tmp, 'bin-usage-data'), realGit: true });

    const ran = await runBin(['doctor', '--nope'], { cwd, env });

    expect(ran.code).toBe(64);
    expect(ran.stderr).toContain('--nope');
  }, 60_000);

  /**
   * KAR-18.8 EPIC-18-S53 — `--json --fix` with **stdin closed**.
   *
   * `doctor-adapter-install.test.ts` drives the same flags through `runDoctor`
   * with an injected prompt port, which settles what the code decides. What
   * only a spawned process settles is what happens to a process whose stdin is
   * `'ignore'`: the failure this guards against is not a wrong answer, it is a
   * CI job that hangs until the runner's timeout with no output explaining
   * why, and no in-process spec can go red on it.
   */
  it('never reads stdin under --json --fix, even with stdin closed', async () => {
    const cwd = await workspace('bin-fix');
    const binDir = join(tmp, 'bin-fix-bin');
    const npmLog = join(tmp, 'bin-fix-npm.jsonl');
    const staging = join(tmp, 'bin-fix-staging');
    await fakeBin(binDir, 'claude');
    await writeFakeNpm(binDir, {
      log: npmLog,
      installs: {
        [join(binDir, 'claude-agent-acp')]: await writeMockAgentShim(staging, {
          name: 'claude-agent-acp',
          version: '0.64.1',
        }),
      },
    });
    const env = doctorEnv({ dataDir: join(tmp, 'bin-fix-data'), binDirs: [binDir], realGit: true });

    const ran = await runBin(['doctor', '--json', '--fix', '--skip-conformance'], { cwd, env });

    expect(ran.code).toBe(0);
    const parsed = JSON.parse(ran.stdout) as {
      exitCode: number;
      sections: { checks: { id: string; status: string; data?: Record<string, unknown> }[] }[];
    };
    const checks = parsed.sections.flatMap((entry) => entry.checks);
    const install = checks.find((entry) => entry.id === 'agents.claude.install');
    expect(install?.status).toBe('ok');
    expect(install?.data?.command).toBe('npm install -g @agentclientprotocol/claude-agent-acp');
    expect(checks.find((entry) => entry.id === 'agents.claude')?.data?.state).toBe('installed');

    expect(JSON.parse(await readFile(npmLog, 'utf8'))).toEqual([
      'install',
      '-g',
      '@agentclientprotocol/claude-agent-acp',
    ]);
    // No ANSI escape anywhere in the machine document.
    expect(ran.stdout).not.toMatch(/\[/);
    expect(parsed.exitCode).toBe(0);
  }, 120_000);

  it('advertises doctor in its usage', async () => {
    const cwd = await workspace('bin-help');
    const env = doctorEnv({ dataDir: join(tmp, 'bin-help-data'), realGit: true });

    const ran = await runBin(['--help'], { cwd, env });

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('doctor');
    expect(ran.stdout).toContain('--json');
  }, 60_000);
});
