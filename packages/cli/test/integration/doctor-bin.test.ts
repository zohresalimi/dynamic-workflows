/**
 * KAR-18.4 — `DeFlow doctor` through the real binary.
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
 * drains) is exercised exactly as `npx DeFlow doctor` exercises it.
 *
 * Verifies: EPIC-18-S36 · AC10, AC11
 */
import { makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { doctorEnv, resolveOnHostPath, writeGitShim } from './support/doctor-fixture.ts';

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

suite('DeFlow doctor through the binary', () => {
  it('prints the report and exits 0 on a healthy machine', async () => {
    const cwd = await workspace('bin-ok');
    const env = doctorEnv({ dataDir: join(tmp, 'bin-ok-data'), realGit: true });

    const ran = await runBin(['doctor', '--skip-conformance'], { cwd, env });

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('DeFlow doctor');
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

  it('advertises doctor in its usage', async () => {
    const cwd = await workspace('bin-help');
    const env = doctorEnv({ dataDir: join(tmp, 'bin-help-data'), realGit: true });

    const ran = await runBin(['--help'], { cwd, env });

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('doctor');
    expect(ran.stdout).toContain('--json');
  }, 60_000);
});
