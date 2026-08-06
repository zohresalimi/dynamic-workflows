/**
 * KAR-07.4 — dirty-worktree salvage on removal, against real git
 * (docs/09-workspace-and-safety.md §4.4; EPIC-07-S17, EPIC-07-S18).
 *
 * The ordering **is** the story: capture, commit, and only then force. A
 * `--force` that runs before the salvage commit is durable destroys work an
 * agent just did and leaves the run with no record that it ever existed, which
 * is the one thing F5.1's worktree isolation exists to make impossible. So
 * these specs assert the *sequence*, not just the end state — and the crash
 * spec is what proves the sequence is real rather than incidental: a real child
 * process, SIGKILLed between the ledger append and the commit, whose worktree
 * must still be there, still dirty, and never forced.
 *
 * Real git throughout, hermetically (`GIT_ENV`), for the reason
 * ./worktree-lifecycle.test.ts records: neither `isomorphic-git` nor
 * `simple-git` has a worktree API at all, so there is nothing to mock even if
 * mocking were allowed.
 *
 * Verifies: EPIC-07-S17, EPIC-07-S18 · AC1–AC6
 */
import type { Db } from '@DeFlow/core';
import { openLedger, readRange } from '@DeFlow/ledger';
import {
  GIT_ENV,
  git,
  it,
  makeRepo,
  startCrashable,
  TestClock,
  tryGit,
  waitFor,
} from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { nodeBranch, salvageBranch } from '../../src/git/branch-name.ts';
import { Git } from '../../src/git/git.ts';
import { worktreePathFor } from '../../src/git/worktree-args.ts';
import { WorkspaceManager } from '../../src/git/worktree-manager.ts';
import { SALVAGE_COMMIT_SUBJECT } from '../../src/git/worktree-salvage.ts';

const RUN = 'run_20260806T090000Z_5c1d2e';
const EPOCH = 7;
const CRASH_WORKER = fileURLToPath(new URL('./support/salvage-then-hang.ts', import.meta.url));

/** The four commands EPIC-07-S17 pins, and nothing else — the tip read, the
 * unlock and the porcelain list are lifecycle plumbing KAR-07.2 already owns. */
const salvageShaped = (argv: readonly string[]): boolean =>
  argv[0] === 'status' ||
  argv[0] === 'add' ||
  argv[0] === 'commit' ||
  (argv[0] === 'worktree' && argv[1] === 'remove');

interface Scene {
  readonly root: string;
  readonly repo: string;
  readonly manager: WorkspaceManager;
  readonly calls: string[][];
  readonly db: Db;
  salvageCalls(): string[][];
  wt(nodeId: string): string;
  /** Provisions, then forgets the provisioning invocations. */
  provisionWrite(nodeId: string): Promise<string>;
  provisionRead(nodeId: string): Promise<string>;
  close(): void;
}

async function scene(tmp: string): Promise<Scene> {
  const root = await realpath(tmp);
  const repo = join(root, 'repo');
  await makeRepo({
    dir: repo,
    files: {
      'README.md': '# fixture\n',
      'src/a.ts': 'export const a = 1;\n',
      '.gitignore': 'node_modules/\ndist/\n',
    },
  });

  const wrapped = new Git(repo, { env: GIT_ENV });
  const calls: string[][] = [];
  const db = openLedger(root);
  const manager = new WorkspaceManager({
    git: {
      run: (args, opts) => {
        calls.push([...args]);
        return wrapped.run(args, opts);
      },
    },
    db,
    clock: new TestClock(1_754_400_000_000),
    epoch: EPOCH,
  });

  const wt = (nodeId: string): string => worktreePathFor(repo, RUN, nodeId);

  return {
    root,
    repo,
    manager,
    calls,
    db,
    wt,
    salvageCalls: () => calls.filter(salvageShaped),
    provisionWrite: async (nodeId) => {
      const path = wt(nodeId);
      await manager.provision({
        mode: 'write',
        runId: RUN,
        nodeId,
        branch: nodeBranch('r1', nodeId),
        path,
        baseRef: 'main',
      });
      calls.length = 0;
      return path;
    },
    provisionRead: async (nodeId) => {
      const path = wt(nodeId);
      await manager.provision({ mode: 'read', runId: RUN, nodeId, path, baseRef: 'main' });
      calls.length = 0;
      return path;
    },
    close: () => {
      db.close();
    },
  };
}

const kinds = (db: Db): string[] => readRange(db, RUN, 0, 200).events.map((event) => event.kind);

const payloadOf = (db: Db, kind: string): Record<string, unknown> => {
  const found = readRange(db, RUN, 0, 200).events.findLast((event) => event.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} event was appended`);
  return found.payload as Record<string, unknown>;
};

/** What an agent leaves behind: one modified tracked file, one untracked file. */
async function dirtyIt(path: string): Promise<void> {
  await writeFile(join(path, 'src', 'a.ts'), 'export const a = 2; // the agent changed this\n');
  await writeFile(join(path, 'src', 'new.ts'), 'export const brandNew = true;\n');
}

/** A worktree, dirty, locked exactly as `provision` would have left it — built
 * with raw git so the crash specs can hand it to a child process. */
async function seedDirtyWorktree(repo: string, nodeId: string): Promise<string> {
  const path = worktreePathFor(repo, RUN, nodeId);
  await git(repo, [
    'worktree',
    'add',
    '--lock',
    '--reason',
    `DeFlow run=${RUN} node=${nodeId}`,
    '-b',
    nodeBranch('r1', nodeId),
    path,
    'main',
  ]);
  await dirtyIt(path);
  return path;
}

suite('EPIC-07-S17: plain removal refuses, with the verified message', () => {
  it('raw "git worktree remove" exits non-zero and says the tree is not clean', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);
      // The lock refuses first and says something else entirely; the string
      // under test here is the *dirtiness* one.
      await git(s.repo, ['worktree', 'unlock', path]);

      const raw = await tryGit(s.repo, ['worktree', 'remove', path]);

      expect(raw.exitCode).not.toBe(0);
      expect(raw.stderr).toContain(
        'contains modified or untracked files, use --force to delete it',
      );
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S17: the salvage sequence, in order', () => {
  it('emits dirty_on_remove, then wip_salvaged, then worktree_removed', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      expect(kinds(s.db).filter((kind) => kind.startsWith('workspace.'))).toEqual([
        'workspace.worktree_created',
        'workspace.dirty_on_remove',
        'workspace.wip_salvaged',
        'workspace.worktree_removed',
      ]);
    } finally {
      s.close();
    }
  });

  it('the git invocations are status, add, commit, remove --force — in that order', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      expect(s.salvageCalls()).toEqual([
        ['status', '--porcelain=v2', '-z'],
        ['add', '-A'],
        ['commit', '-m', SALVAGE_COMMIT_SUBJECT],
        ['worktree', 'remove', '--force', path],
      ]);
    } finally {
      s.close();
    }
  });

  it('dirty_on_remove carries the parsed porcelain entries for both files', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      expect(payloadOf(s.db, 'workspace.dirty_on_remove')).toEqual({
        node: 'n1',
        path,
        entries: [
          { kind: 'changed', xy: '.M', path: 'src/a.ts', origPath: null },
          { kind: 'untracked', xy: null, path: 'src/new.ts', origPath: null },
        ],
      });
    } finally {
      s.close();
    }
  });

  it('the capture is appended before the salvage commit exists', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      const events = readRange(s.db, RUN, 0, 200).events;
      const captured = events.findIndex((event) => event.kind === 'workspace.dirty_on_remove');
      const salvaged = events.findIndex((event) => event.kind === 'workspace.wip_salvaged');
      expect(captured).toBeGreaterThanOrEqual(0);
      expect(captured).toBeLessThan(salvaged);
    } finally {
      s.close();
    }
  });

  it('wip_salvaged carries the commit oid and the branch it landed on', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);

      const removed = await s.manager.remove({
        runId: RUN,
        nodeId: 'n1',
        path,
        branch: nodeBranch('r1', 'n1'),
      });

      const oid = await git(s.repo, ['rev-parse', 'DeFlow/r1__n1']);
      expect(payloadOf(s.db, 'workspace.wip_salvaged')).toEqual({
        node: 'n1',
        path,
        branch: 'DeFlow/r1__n1',
        detached: false,
        oid,
        files: 2,
      });
      expect(removed.salvage?.oid).toBe(oid);
      expect(removed.tipOid).toBe(oid);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S17: the work is recoverable from the branch alone', () => {
  it('git show of the salvage commit contains the agent’s uncommitted bytes', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      // The worktree is gone; the branch is all that is left.
      await expect(stat(path)).rejects.toThrow();
      expect(await git(s.repo, ['log', '--format=%s', 'DeFlow/r1__n1'])).toContain(
        SALVAGE_COMMIT_SUBJECT,
      );
      const shown = await git(s.repo, ['show', 'DeFlow/r1__n1']);
      expect(shown).toContain('the agent changed this');
      expect(shown).toContain('export const brandNew = true;');
    } finally {
      s.close();
    }
  });

  it('the untracked file a blind --force would have destroyed is in the commit’s tree', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await dirtyIt(path);

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      expect(await git(s.repo, ['cat-file', '-p', 'DeFlow/r1__n1:src/new.ts'])).toBe(
        'export const brandNew = true;',
      );
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S17: a dirty detached read worktree has no branch to commit to', () => {
  it('salvages to DeFlow/salvage/<runId>__<nodeId> rather than forcing blind', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionRead('n2');
      await writeFile(join(path, 'src', 'read-node-left-this.ts'), 'export const x = 1;\n');

      const removed = await s.manager.remove({
        runId: RUN,
        nodeId: 'n2',
        path,
        salvageBranch: salvageBranch('r1', 'n2'),
      });

      expect(removed.salvage?.branch).toBe('DeFlow/salvage/r1__n2');
      expect(await git(s.repo, ['log', '--format=%s', 'DeFlow/salvage/r1__n2'])).toContain(
        SALVAGE_COMMIT_SUBJECT,
      );
      expect(
        await git(s.repo, ['cat-file', '-p', 'DeFlow/salvage/r1__n2:src/read-node-left-this.ts']),
      ).toBe('export const x = 1;');
      expect(payloadOf(s.db, 'workspace.wip_salvaged')).toMatchObject({
        branch: 'DeFlow/salvage/r1__n2',
        detached: true,
      });
      expect(existsSync(path)).toBe(false);
    } finally {
      s.close();
    }
  });

  it('a clean detached read worktree creates no salvage branch at all', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionRead('n3');

      await s.manager.remove({ runId: RUN, nodeId: 'n3', path });

      expect(await git(s.repo, ['branch', '--list', 'DeFlow/salvage/*'])).toBe('');
      expect(kinds(s.db)).not.toContain('workspace.wip_salvaged');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S18: gitignored files do not block removal', () => {
  it('a worktree whose only untracked content is gitignored removes plainly, exit 0', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await mkdir(join(path, 'node_modules'), { recursive: true });
      await mkdir(join(path, 'dist'), { recursive: true });
      await Promise.all(
        Array.from({ length: 500 }, (_, index) =>
          writeFile(join(path, 'node_modules', `pkg-${index}.js`), 'module.exports = {};\n'),
        ),
      );
      await writeFile(join(path, 'dist', 'bundle.js'), 'console.log(1);\n');

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      expect(s.salvageCalls()).toEqual([
        ['status', '--porcelain=v2', '-z'],
        ['worktree', 'remove', path],
      ]);
      expect(s.calls.flat()).not.toContain('--force');
      expect(s.calls.flat()).not.toContain('-f');
      expect(kinds(s.db)).not.toContain('workspace.dirty_on_remove');
      expect(kinds(s.db)).not.toContain('workspace.wip_salvaged');
      expect(existsSync(path)).toBe(false);
    } finally {
      s.close();
    }
  });

  it('mixed content still salvages, and the commit does not contain node_modules', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('n1');
      await mkdir(join(path, 'node_modules'), { recursive: true });
      await writeFile(join(path, 'node_modules', 'pkg.js'), 'module.exports = {};\n');
      await writeFile(join(path, 'src', 'a.ts'), 'export const a = 3; // tracked, modified\n');

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      const files = await git(s.repo, ['ls-tree', '-r', '--name-only', 'DeFlow/r1__n1']);
      expect(files).toContain('src/a.ts');
      expect(files).not.toContain('node_modules');
      expect(await git(s.repo, ['show', 'DeFlow/r1__n1'])).toContain('tracked, modified');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S17: a crash between capture and commit leaves the worktree intact', () => {
  it('SIGKILL after dirty_on_remove: still there, still dirty, never forced', async ({ tmp }) => {
    const root = await realpath(tmp);
    const repo = join(root, 'repo');
    await makeRepo({
      dir: repo,
      files: { 'README.md': '# fixture\n', 'src/a.ts': 'export const a = 1;\n' },
    });
    const path = await seedDirtyWorktree(repo, 'n1');
    const branch = nodeBranch('r1', 'n1');

    const readyFile = join(root, 'about-to-commit');
    const child = startCrashable({
      script: CRASH_WORKER,
      args: [root, repo, path, RUN, 'n1', branch, readyFile],
      env: { ...process.env, ...GIT_ENV },
    });
    try {
      await waitFor(() => existsSync(readyFile), {
        describe: `the salvage worker to reach the commit (stderr: ${child.stderr()})`,
      });
      await child.sigkill();

      // Nothing after the capture happened, and the daemon that would have
      // forced is gone.
      expect((await stat(path)).isDirectory()).toBe(true);
      expect(await git(path, ['status', '--porcelain=v2', '-z'])).not.toBe('');
      expect(await readFile(join(path, 'src', 'new.ts'), 'utf8')).toBe(
        'export const brandNew = true;\n',
      );
      expect(await git(repo, ['log', '--format=%s', branch])).not.toContain(SALVAGE_COMMIT_SUBJECT);

      const db = openLedger(root);
      try {
        const persisted = readRange(db, RUN, 0, 200).events.map((event) => event.kind);
        expect(persisted).toContain('workspace.dirty_on_remove');
        expect(persisted).not.toContain('workspace.wip_salvaged');
        expect(persisted).not.toContain('workspace.worktree_removed');
      } finally {
        db.close();
      }
    } finally {
      await child.sigkill();
    }
  });

  it('on restart the sequence starts again from the status capture, and completes', async ({
    tmp,
  }) => {
    const root = await realpath(tmp);
    const repo = join(root, 'repo');
    await makeRepo({
      dir: repo,
      files: { 'README.md': '# fixture\n', 'src/a.ts': 'export const a = 1;\n' },
    });
    const path = await seedDirtyWorktree(repo, 'n1');
    const branch = nodeBranch('r1', 'n1');

    const readyFile = join(root, 'about-to-commit');
    const child = startCrashable({
      script: CRASH_WORKER,
      args: [root, repo, path, RUN, 'n1', branch, readyFile],
      env: { ...process.env, ...GIT_ENV },
    });
    await waitFor(() => existsSync(readyFile), {
      describe: `the salvage worker to reach the commit (stderr: ${child.stderr()})`,
    });
    await child.sigkill();

    // A new daemon life, over the same ledger and the same repository.
    const db = openLedger(root);
    const calls: string[][] = [];
    const wrapped = new Git(repo, { env: GIT_ENV });
    const manager = new WorkspaceManager({
      git: {
        run: (args, opts) => {
          calls.push([...args]);
          return wrapped.run(args, opts);
        },
      },
      db,
      clock: new TestClock(1_754_400_100_000),
      epoch: EPOCH + 1,
    });
    try {
      await manager.remove({ runId: RUN, nodeId: 'n1', path, branch });

      expect(calls.filter(salvageShaped)[0]).toEqual(['status', '--porcelain=v2', '-z']);
      const persisted = readRange(db, RUN, 0, 200).events.map((event) => event.kind);
      // Two captures: the crashed life's, and this one's. Both really happened.
      expect(persisted.filter((kind) => kind === 'workspace.dirty_on_remove')).toHaveLength(2);
      expect(persisted).toContain('workspace.wip_salvaged');
      expect(await git(repo, ['log', '--format=%s', branch])).toContain(SALVAGE_COMMIT_SUBJECT);
      expect(existsSync(path)).toBe(false);
    } finally {
      db.close();
    }
  });
});
