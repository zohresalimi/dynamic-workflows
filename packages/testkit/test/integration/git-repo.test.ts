/**
 * KAR-01.4 AC5 — makeRepo() against the real git binary, hermetically.
 *
 * Every test here runs with a *poisoned* global git config exported into
 * process.env: init.defaultBranch=trunk, commit.gpgsign=true and a user
 * identity that is not ours. That is the "developer's ~/.gitconfig" of
 * EPIC-01-S15, made explicit — if makeRepo inherited any of it the branch would
 * be "trunk", the commit would demand a signing key, and the same suite would
 * pass unchanged on a CI box with no ~/.gitconfig at all.
 *
 * Verifies: EPIC-01-S15 · AC5
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe as suite, expect } from 'vitest';
import { it, makeRepo } from '../../src/index.ts';

const POISON = [
  '[init]',
  '\tdefaultBranch = trunk',
  '[commit]',
  '\tgpgsign = true',
  '[user]',
  '\tname = Someone Else',
  '\temail = someone@else.invalid',
  '[core]',
  '\thooksPath = /nonexistent/hooks',
  '',
].join('\n');

const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'DeFlow-poison-'));
  const config = join(dir, 'gitconfig');
  await writeFile(config, POISON);
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    saved[key] = process.env[key];
    process.env[key] = config;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

suite('makeRepo', () => {
  it('initialises on main whatever the ambient config says (EPIC-01-S15)', async ({ tmp }) => {
    const repo = await makeRepo({ dir: tmp });
    expect(await repo.currentBranch()).toBe('main');
  });

  it('commits without a signing key and with our own identity', async ({ tmp }) => {
    const repo = await makeRepo({ dir: tmp, files: { 'README.md': 'hello\n' } });
    expect(await repo.git('log', '-1', '--format=%an <%ae>')).toBe('t <t@x>');
    expect(await repo.git('log', '-1', '--format=%cn <%ce>')).toBe('t <t@x>');
    expect(await repo.git('log', '-1', '--format=%G?')).toBe('N');
    expect(await repo.git('show', '-s', '--format=%s')).toContain('DeFlow test fixture');
  });

  it('writes the requested files into the initial commit', async ({ tmp }) => {
    const repo = await makeRepo({
      dir: tmp,
      files: { 'src/a.ts': 'export const a = 1;\n', 'docs/b.md': '# b\n' },
    });
    expect(await repo.git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('docs/b.md\nsrc/a.ts');
    expect(await repo.git('status', '--porcelain')).toBe('');
  });

  it('creates every requested branch off main', async ({ tmp }) => {
    const repo = await makeRepo({ dir: tmp, branches: ['feature-a', 'feature-b'] });
    expect(await repo.branches()).toEqual(['feature-a', 'feature-b', 'main']);
    expect(await repo.currentBranch()).toBe('main');
  });

  it('makes the named conflict paths genuinely conflict between branches', async ({ tmp }) => {
    const repo = await makeRepo({
      dir: tmp,
      files: { 'shared.txt': 'base\n' },
      branches: ['left', 'right'],
      conflicts: ['shared.txt'],
    });

    const clean = await repo.tryGit('merge-tree', '--write-tree', 'main', 'left');
    expect(clean.exitCode).toBe(0);

    const conflicted = await repo.tryGit('merge-tree', '--write-tree', 'left', 'right');
    expect(conflicted.exitCode).toBe(1);
  });

  it('is isolated from the ambient hooksPath, so no ambient hook can run', async ({ tmp }) => {
    const repo = await makeRepo({ dir: tmp });
    const hooksPath = await repo.tryGit('config', '--get', 'core.hooksPath');
    expect(hooksPath.exitCode).toBe(1); // git exits 1 for "no such key"
    expect(hooksPath.stdout).toBe('');
  });
});
