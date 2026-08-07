/**
 * KAR-08.7 AC3, AC5 — EPIC-08-S30: a completion-time scope violation, over a
 * real git repository.
 *
 * `changedPaths` is the one function in ../../src/services/scope-diff.ts that
 * touches a filesystem, and what only a real `git status` proves is the thing
 * the unit suite cannot: that an untracked file, a modified tracked file and
 * a renamed one all come back as paths this module can compare against a
 * declared scope, from the exact byte layout git actually writes.
 *
 * Hermetic: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, and
 * a forced identity (`@DeFlow/testkit`'s `GIT_ENV`), so a developer's own
 * global config cannot change what this suite proves.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5, AC6
 */
import { NodeIdSchema } from '@DeFlow/core';
import { GIT_ENV, makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { changedPaths, outOfScopePaths, scopeWarningOf } from '../../src/services/scope-diff.ts';

const NODE = NodeIdSchema.parse('implement');

let dir = '';

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(dir);
});

suite('changedPaths — the real shapes git status --porcelain=v2 -z reports', () => {
  it('finds an untracked file, individually rather than collapsed to its new directory', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r1'), files: { 'src/a.ts': 'export {};\n' } });
    await mkdir(join(repo.dir, 'docs'), { recursive: true });
    await writeFile(join(repo.dir, 'docs', 'readme.md'), '# notes\n');

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual(['docs/readme.md']);
  });

  it('finds a modified tracked file', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r2'), files: { 'src/a.ts': 'export {};\n' } });
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual(['src/a.ts']);
  });

  it('finds both sides of a rename', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r3'), files: { 'src/a.ts': 'export {};\n' } });
    await rename(join(repo.dir, 'src', 'a.ts'), join(repo.dir, 'src', 'b.ts'));
    await repo.git('add', '-A');

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('is empty for a clean worktree', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r4'), files: { 'src/a.ts': 'export {};\n' } });

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual([]);
  });
});

suite('EPIC-08-S30 — a completion-time violation is recorded as a warning', () => {
  it('flags the write that landed outside the declared scope, and only that one', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r5'), files: { 'src/a.ts': 'export {};\n' } });
    await mkdir(join(repo.dir, 'docs'), { recursive: true });
    await writeFile(join(repo.dir, 'docs', 'readme.md'), '# notes\n');
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    const paths = await changedPaths(repo.dir, { env: GIT_ENV });
    const warning = scopeWarningOf(NODE, 0, repo.dir, ['src/**'], paths);

    expect(warning).toEqual({
      node: NODE,
      attempt: 0,
      declared: ['src/**'],
      paths: ['docs/readme.md'],
    });
  });

  it('is null when every change stayed in scope', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r6'), files: { 'src/a.ts': 'export {};\n' } });
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    const paths = await changedPaths(repo.dir, { env: GIT_ENV });

    expect(scopeWarningOf(NODE, 0, repo.dir, ['src/**'], paths)).toBeNull();
  });

  it('normalizes git’s own relative paths the same way as request-time enforcement (AC6)', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r7'), files: { 'src/a.ts': 'export {};\n' } });
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    const paths = await changedPaths(repo.dir, { env: GIT_ENV });

    expect(outOfScopePaths(repo.dir, ['src/**'], paths)).toEqual([]);
  });
});
