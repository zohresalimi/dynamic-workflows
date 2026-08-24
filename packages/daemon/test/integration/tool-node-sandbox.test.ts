/**
 * KAR-23.9 — the confinement itself, against the real wrapper.
 *
 * `./tool-node.test.ts` proves DeFlow **invokes** `@anthropic-ai/sandbox-runtime`
 * correctly: the flag order, the settings document, the run line as one argv
 * element. Its wrapper is a stub, so it proves nothing whatever about whether
 * the operating system confines anything — and a security claim tested only
 * against a fake is a security claim nobody has tested.
 *
 * So this file spawns the **pinned** wrapper, with the document
 * `sandboxedCommand` really produces at `worktree`, and asks the three
 * questions the ladder is a promise about:
 *
 *  - a write inside the worktree lands;
 *  - a write outside it does not;
 *  - `~/.ssh` cannot be read.
 *
 * Skipped — loudly, with the reason in the title — where the wrapper cannot be
 * resolved at all, because a suite that silently passes on a machine with no
 * sandbox is worse than one that says it did not run.
 *
 * Verifies: KAR-23.9 · docs/09-workspace-and-safety.md §9 · EPIC-08-S21
 */

import { resolveSandboxRuntime, sandboxedCommand } from '@DeFlow/adapters';
import { it } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { expect, describe as suite } from 'vitest';

/** Where the wrapper is, or `null`. Resolved once, at collection time, because
 * it decides whether this file has anything to say. */
const WRAPPER = resolveSandboxRuntime([]);

/** The Linux prerequisites are real prerequisites here: without bwrap and socat
 * `sandboxedCommand` refuses, which is the right behaviour and not a claim this
 * file can make an assertion out of. */
const ENFORCEABLE =
  WRAPPER !== null &&
  (process.platform !== 'linux' ||
    ['/usr/bin/bwrap', '/usr/bin/socat'].every((path) => existsSync(path)));

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One `run` line, wrapped exactly as `toolNodePerformer` wraps one. */
async function wrapped(tmp: string, run: string): Promise<Ran> {
  const worktree = join(tmp, 'wt');
  const configDir = join(tmp, 'sandbox');
  await mkdir(worktree, { recursive: true });
  await mkdir(configDir, { recursive: true });

  const plan = sandboxedCommand({
    command: '/bin/sh',
    args: ['-c', run],
    permission: 'worktree',
    worktree,
    platform: process.platform,
    roots: [],
    configDir,
  });
  if (plan.runtimeConfig === null) throw new Error('worktree level produced no policy document');
  await writeFile(
    plan.runtimeConfig.path,
    `${JSON.stringify(plan.runtimeConfig.document, null, 2)}\n`,
    'utf8',
  );

  return await new Promise<Ran>((resolve, reject) => {
    const child = spawn(plan.command, [...plan.argv], {
      cwd: worktree,
      // Enough to run `/bin/sh` and — because the pinned wrapper's shebang is
      // `#!/usr/bin/env node` — to find node. Production gets the same from the
      // login `PATH` `buildChildEnv` installs; deliberately not the whole of
      // the operator's environment.
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: homedir() },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

suite.skipIf(!ENFORCEABLE)(
  'KAR-23.9 — the real wrapper enforces the level a tool node declared',
  () => {
    it('lets the script write inside its own worktree', async ({ tmp }) => {
      const ran = await wrapped(tmp, 'printf hello > inside.txt && cat inside.txt');
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toContain('hello');
      expect(existsSync(join(tmp, 'wt', 'inside.txt'))).toBe(true);
    });

    it('refuses a write outside the worktree', async ({ tmp }) => {
      const outside = join(tmp, 'escaped.txt');
      const ran = await wrapped(tmp, `printf escaped > ${outside}`);
      expect(ran.code).not.toBe(0);
      expect(existsSync(outside)).toBe(false);
    });

    it('refuses to read the credential paths the policy denies', async ({ tmp }) => {
      const ran = await wrapped(tmp, 'cat ~/.ssh/config');
      // Either the sandbox denied it or the file does not exist on this
      // machine; what must never happen is a zero exit with contents on stdout.
      expect(ran.code).not.toBe(0);
      expect(ran.stdout).toBe('');
    });
  },
);

suite.skipIf(ENFORCEABLE)(
  'KAR-23.9 — SKIPPED: no sandbox-runtime wrapper is resolvable on this machine',
  () => {
    it('says so rather than passing silently', () => {
      expect(WRAPPER, 'a machine with no wrapper refuses every tool node').toBeNull();
    });
  },
);
