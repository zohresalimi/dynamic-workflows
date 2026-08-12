/**
 * KAR-18.1 — `DeFlow init`: workspace bootstrap.
 *
 * Verifies: EPIC-18-S1, EPIC-18-S2, EPIC-18-S3, EPIC-18-S4, EPIC-18-S5,
 * EPIC-18-S6 · AC1-AC6, test plan #2-6
 */
import { openLedger, readProviderCapabilities } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runInit } from '../../src/init.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/** A base env with no agent CLI on `PATH` — every provider reports absent —
 * and its own private data directory, so specs never touch `~/.DeFlow`. */
function baseEnv(dataDir: string, extraPathDir?: string): NodeJS.ProcessEnv {
  const path =
    extraPathDir === undefined
      ? (process.env.PATH ?? '')
      : `${extraPathDir}${delimiter}${process.env.PATH ?? ''}`;
  return { ...process.env, PATH: path, DeFlow_DATA_DIR: dataDir };
}

suite('DeFlow init — happy path (EPIC-18-S1)', () => {
  it('bootstraps a clean repository and leaves it otherwise clean', async () => {
    const repo = await makeRepo({
      dir: join(tmp, 'repo'),
      files: { '.gitignore': 'node_modules/\n' },
    });
    const dataDir = join(tmp, 'data');
    const clock = new TestClock(1_755_000_000_000);

    const result = await runInit({ cwd: repo.dir, env: baseEnv(dataDir), clock });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    for (const relativePath of [
      '.DeFlow/config.yaml',
      '.DeFlow/gates/',
      '.DeFlow/templates/',
      '.DeFlow/memory/',
      '.DeFlow/.worktreeinclude',
    ]) {
      expect(result.stdout).toContain(relativePath);
      expect(result.stdout).toContain('created');
    }

    expect(readFileSync(join(repo.dir, '.DeFlow/config.yaml'), 'utf8')).toBe('{}\n');
    expect((await readdir(join(repo.dir, '.DeFlow/gates'))).length).toBe(0);
    expect((await readdir(join(repo.dir, '.DeFlow/templates'))).length).toBe(0);
    expect((await readdir(join(repo.dir, '.DeFlow/memory'))).length).toBe(0);

    const schema = JSON.parse(
      readFileSync(join(repo.dir, '.DeFlow/schemas/config.schema.json'), 'utf8'),
    ) as { $schema: string };
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');

    const gitignore = readFileSync(join(repo.dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.DeFlow/daemon.json');
    expect(gitignore).toContain('.DeFlow/wt/');
    expect(gitignore).toContain('.DeFlow/runs/');

    expect(result.stdout).toContain(dataDir);

    const status = await repo.tryGit('status', '--porcelain');
    const changed = status.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(3));
    expect(changed.sort()).toEqual(['.DeFlow/', '.gitignore']);
  });
});

suite('DeFlow init — idempotent (EPIC-18-S2)', () => {
  it('never clobbers an edited config.yaml, and reports it as kept (edited)', async () => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const dataDir = join(tmp, 'data');
    const clock = new TestClock(1_755_000_000_000);

    await runInit({ cwd: repo.dir, env: baseEnv(dataDir), clock });
    await repo.git('add', '-A');
    await repo.git('commit', '-m', 'DeFlow test fixture: after first init');

    await writeFile(join(repo.dir, '.DeFlow/config.yaml'), 'budget:\n  run:\n    costUsd: 25.00\n');
    await mkdir(join(repo.dir, '.DeFlow/gates'), { recursive: true });
    await writeFile(join(repo.dir, '.DeFlow/gates/typecheck.yaml'), 'command: pnpm typecheck\n');
    await repo.git('add', '-A');
    await repo.git('commit', '-m', 'DeFlow test fixture: operator edits');

    const second = await runInit({ cwd: repo.dir, env: baseEnv(dataDir), clock });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('config.yaml');
    expect(second.stdout).toContain('kept (edited)');
    expect(readFileSync(join(repo.dir, '.DeFlow/config.yaml'), 'utf8')).toBe(
      'budget:\n  run:\n    costUsd: 25.00\n',
    );
    expect(readFileSync(join(repo.dir, '.DeFlow/gates/typecheck.yaml'), 'utf8')).toBe(
      'command: pnpm typecheck\n',
    );

    const diff = await repo.tryGit('diff', '--stat');
    expect(diff.stdout.trim()).toBe('');
  });
});

suite('DeFlow init — outside a git working tree (EPIC-18-S3)', () => {
  it('refuses with exit 5 and writes nothing', async () => {
    const plain = join(tmp, 'not-a-repo');
    await mkdir(plain, { recursive: true });
    const dataDir = join(tmp, 'data');

    const result = await runInit({ cwd: plain, env: baseEnv(dataDir), clock: new TestClock(0) });

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain(
      "DeFlow init: not inside a git working tree (run 'git init' first)",
    );
    await expect(readdir(plain)).resolves.toEqual([]);
  });
});

suite('DeFlow init — .gitignore is a fixpoint (EPIC-18-S4)', () => {
  it('appends the three entries exactly once, and git actually ignores the token file', async () => {
    const repo = await makeRepo({
      dir: join(tmp, 'repo'),
      files: { '.gitignore': 'node_modules/' },
    });
    const dataDir = join(tmp, 'data');
    const clock = new TestClock(1_755_000_000_000);

    await runInit({ cwd: repo.dir, env: baseEnv(dataDir), clock });
    await runInit({ cwd: repo.dir, env: baseEnv(dataDir), clock });

    const gitignore = readFileSync(join(repo.dir, '.gitignore'), 'utf8');
    for (const entry of ['.DeFlow/daemon.json', '.DeFlow/wt/', '.DeFlow/runs/']) {
      expect(gitignore.split('\n').filter((line) => line === entry)).toHaveLength(1);
    }

    const ignored = await repo.tryGit('check-ignore', '-q', '.DeFlow/daemon.json');
    expect(ignored.exitCode).toBe(0);
  });
});

suite('DeFlow init — unwritable global state directory (EPIC-18-S5)', () => {
  it.skipIf(process.getuid?.() === 0)(
    'names the path and the errno, and leaves no partial directory',
    async () => {
      const repo = await makeRepo({ dir: join(tmp, 'repo') });
      const readOnlyParent = join(tmp, 'ro-data');
      await mkdir(readOnlyParent, { recursive: true });
      await chmod(readOnlyParent, 0o500);

      try {
        const dataDir = join(readOnlyParent, 'DeFlow');
        const result = await runInit({
          cwd: repo.dir,
          env: baseEnv(dataDir),
          clock: new TestClock(0),
        });

        expect(result.exitCode).toBe(5);
        expect(result.stderr).toContain(dataDir);
        expect(result.stderr).toContain('EACCES');
        await expect(readdir(readOnlyParent)).resolves.toEqual([]);
      } finally {
        await chmod(readOnlyParent, 0o700);
      }
    },
  );
});

suite('DeFlow init — provider detection writes only to the global cache (EPIC-18-S6)', () => {
  it('detects an installed agent, probes it, and never writes it into the committed config', async () => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });
    await symlink(MOCK_AGENT_BIN, join(binDir, 'claude-agent-acp'));

    const result = await runInit({
      cwd: repo.dir,
      env: baseEnv(dataDir, binDir),
      clock: new TestClock(1_755_000_000_000),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claude');
    expect(result.stdout).toMatch(/claude-agent-acp|resolved to/);

    const configText = readFileSync(join(repo.dir, '.DeFlow/config.yaml'), 'utf8');
    expect(configText).not.toContain('claude-agent-acp');
    expect(configText).not.toContain(binDir);

    const db = openLedger(dataDir);
    try {
      const rows = readProviderCapabilities(db, 'claude');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.binaryPath).toBe(join(binDir, 'claude-agent-acp'));
    } finally {
      db.close();
    }
  });
});
