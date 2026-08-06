/**
 * KAR-07.1 — the `Git` wrapper against real git and a recording shim
 * (docs/09-workspace-and-safety.md §1, §3.3, §10.6; EPIC-07-S1..S4).
 *
 * Real git, hermetically, everywhere a real repository is what is under test
 * — GIT_ENV strips the developer's own ~/.gitconfig, per
 * docs/14-testing-strategy.md §6. The fake `git` shim (test/support/fake-git-bin.ts)
 * is used only for the two things real git cannot prove: that a forbidden
 * shape never spawns anything, and that a specific `git --version` string
 * drives the version floor.
 *
 * Verifies: EPIC-07-S1, EPIC-07-S2, EPIC-07-S3, EPIC-07-S4 · KAR-07.1 test
 * plan rows 4-7
 */
import { GIT_ENV, git, it, makeRepo, tryGit } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  assertGitVersionSupported,
  checkGitVersion,
  Git,
  GitVersionTooOldError,
} from '../../src/index.ts';
import { writeFakeGit } from '../support/fake-git-bin.ts';

suite('S1: exit codes are data, not exceptions (test plan row 4)', () => {
  it('resolves { exitCode: 1 } on a real merge-tree conflict, and never throws', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({
      dir: repo,
      branches: ['DeFlow/r1__a', 'DeFlow/r1__b'],
      conflicts: ['f.txt'],
    });
    const wrapper = new Git(repo, { env: GIT_ENV });

    const result = await wrapper.run([
      'merge-tree',
      '--write-tree',
      '--name-only',
      '-z',
      'DeFlow/r1__a',
      'DeFlow/r1__b',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('resolves { exitCode: 0 } on a clean merge, with no side effects', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo, branches: ['DeFlow/r1__a', 'DeFlow/r1__b'] });
    const wrapper = new Git(repo, { env: GIT_ENV });

    const before = await git(repo, ['status', '--porcelain']);
    const result = await wrapper.run([
      'merge-tree',
      '--write-tree',
      'DeFlow/r1__a',
      'DeFlow/r1__b',
    ]);

    expect(result.exitCode).toBe(0);
    expect(await git(repo, ['status', '--porcelain'])).toBe(before);
  });
});

suite('S1: every call is scoped with -C and gitChildEnv() (argv/env scenario)', () => {
  it('spawns "git -C <cwd> <args...>" and keeps SSH_AUTH_SOCK', async ({ tmp }) => {
    const worktreePath = join(tmp, 'wt');
    await mkdir(worktreePath, { recursive: true });
    const fakeGit = await writeFakeGit(tmp);
    const wrapper = new Git(tmp, {
      env: { ...process.env, PATH: fakeGit.pathEnv, SSH_AUTH_SOCK: '/tmp/agent.sock' },
    });

    await wrapper.run(['status', '--porcelain=v2', '-z'], { cwd: worktreePath });

    const invocations = await fakeGit.invocations();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toBe(`-C ${worktreePath} status --porcelain=v2 -z`);
    expect(invocations[0]?.sshAuthSock).toBe('/tmp/agent.sock');
  });
});

suite('S2: worktree add --force never reaches a git process (test plan row 5)', () => {
  it('throws before any spawn — the fake git shim records nothing', async ({ tmp }) => {
    const fakeGit = await writeFakeGit(tmp);
    const wrapper = new Git(tmp, { env: { ...process.env, PATH: fakeGit.pathEnv } });

    await expect(
      wrapper.run(['worktree', 'add', '--force', join(tmp, 'wt'), 'feature']),
    ).rejects.toThrow('worktree add --force is forbidden');

    expect(await fakeGit.invocations()).toEqual([]);
  });
});

suite('S2: --force is permitted on worktree remove, scoped to add only', () => {
  it('removes a real worktree with --force through the wrapper', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo, branches: ['feature'] });
    const worktreePath = join(tmp, 'wt');
    await git(repo, ['worktree', 'add', worktreePath, 'feature']);

    const wrapper = new Git(repo, { env: GIT_ENV });
    const result = await wrapper.run(['worktree', 'remove', '--force', worktreePath]);

    expect(result.exitCode).toBe(0);
    expect(await git(repo, ['worktree', 'list'])).not.toContain(worktreePath);
  });
});

suite('S3: the corruption --force would have created, demonstrated on raw git', () => {
  it('raw git happily creates two worktrees on one branch, bypassing the wrapper entirely', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo, branches: ['feature'] });
    const wtA = join(tmp, 'wt-a');
    const wtB = join(tmp, 'wt-b');
    await git(repo, ['worktree', 'add', wtA, 'feature']);

    const forced = await tryGit(repo, ['worktree', 'add', '--force', wtB, 'feature']);

    expect(forced.exitCode).toBe(0);
    const list = await git(repo, ['worktree', 'list']);
    expect(list.split('\n').filter((line) => line.includes('[feature]'))).toHaveLength(2);
  });

  it('the same attempt through the wrapper never reaches git', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo, branches: ['feature'] });
    const wtA = join(tmp, 'wt-a');
    const wtB = join(tmp, 'wt-b');
    await git(repo, ['worktree', 'add', wtA, 'feature']);

    const wrapper = new Git(repo, { env: GIT_ENV });
    await expect(wrapper.run(['worktree', 'add', '--force', wtB, 'feature'])).rejects.toThrow(
      'worktree add --force is forbidden',
    );

    const list = await git(repo, ['worktree', 'list']);
    expect(list.split('\n').filter((line) => line.includes('[feature]'))).toHaveLength(1);
  });
});

suite('default branch resolution (§10.6, test plan row 6)', () => {
  it('resolves from origin/HEAD when a remote is configured', async ({ tmp }) => {
    const upstream = join(tmp, 'upstream');
    await makeRepo({ dir: upstream });
    const clone = join(tmp, 'clone');
    await git(tmp, ['clone', upstream, clone]);

    const wrapper = new Git(clone, { env: GIT_ENV });
    expect(await wrapper.resolveDefaultBranch()).toBe('main');
  });

  it('falls back to the HEAD symref when there is no remote at all', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });

    const wrapper = new Git(repo, { env: GIT_ENV });
    expect(await wrapper.resolveDefaultBranch()).toBe('main');
  });

  it('resolves whatever origin/HEAD names, not a hardcoded "main"', async ({ tmp }) => {
    const upstream = join(tmp, 'upstream');
    await makeRepo({ dir: upstream, branches: ['trunk'] });
    const clone = join(tmp, 'clone');
    await git(tmp, ['clone', upstream, clone]);
    await git(clone, ['remote', 'set-head', 'origin', 'trunk']);

    const wrapper = new Git(clone, { env: GIT_ENV });
    expect(await wrapper.resolveDefaultBranch()).toBe('trunk');

    // The refusal set is a property of the resolved branch, not of "main":
    // pushing "trunk" is refused, pushing "main" — an ordinary branch here —
    // is allowed.
    await expect(wrapper.run(['push', 'origin', 'trunk'])).rejects.toThrow('default branch');
    await expect(wrapper.run(['push', 'origin', 'main'])).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it('resolves at most once per repository: the second call is the same in-flight promise', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    const wrapper = new Git(repo, { env: GIT_ENV });

    const first = wrapper.resolveDefaultBranch();
    const second = wrapper.resolveDefaultBranch();

    // Same promise object: the resolution body can only ever have run once,
    // by construction, however many times callers ask.
    expect(second).toBe(first);
    expect(await first).toBe('main');
  });
});

suite('S4: default-branch writes refused across argument shapes (real repo)', () => {
  it('refuses a push to the local default branch before it reaches origin', async ({ tmp }) => {
    const upstream = join(tmp, 'upstream');
    await makeRepo({ dir: upstream });
    const clone = join(tmp, 'clone');
    await git(tmp, ['clone', upstream, clone]);

    const wrapper = new Git(clone, { env: GIT_ENV });
    await expect(wrapper.run(['push', 'origin', 'main'])).rejects.toThrow(
      'default branch "main" is forbidden',
    );
  });

  it('allows a push to a DeFlow integration branch', async ({ tmp }) => {
    const upstream = join(tmp, 'upstream');
    await makeRepo({ dir: upstream });
    const clone = join(tmp, 'clone');
    await git(tmp, ['clone', upstream, clone]);
    await git(clone, ['branch', 'DeFlow/int/r1']);

    const wrapper = new Git(clone, { env: GIT_ENV });
    const result = await wrapper.run(['push', 'origin', 'DeFlow/int/r1']);
    expect(result.exitCode).toBe(0);
  });
});

suite('git version floor (§1.2, test plan row 7)', () => {
  it('a stub git reporting 2.37.1 fails, naming merge-tree --write-tree', async ({ tmp }) => {
    const fakeGit = await writeFakeGit(tmp, { versionOutput: '2.37.1' });

    const check = await checkGitVersion({ ...process.env, PATH: fakeGit.pathEnv }, tmp);

    expect(check.status).toBe('fail');
    expect(check.message).toContain('merge-tree --write-tree');
  });

  it('assertGitVersionSupported throws below the floor', async ({ tmp }) => {
    const fakeGit = await writeFakeGit(tmp, { versionOutput: '2.37.1' });

    await expect(
      assertGitVersionSupported({ ...process.env, PATH: fakeGit.pathEnv }, tmp),
    ).rejects.toBeInstanceOf(GitVersionTooOldError);
  });

  it('2.43 warns and proceeds — assertGitVersionSupported does not throw', async ({ tmp }) => {
    const fakeGit = await writeFakeGit(tmp, { versionOutput: '2.43.0' });

    const check = await assertGitVersionSupported({ ...process.env, PATH: fakeGit.pathEnv }, tmp);

    expect(check.status).toBe('warn');
  });
});
