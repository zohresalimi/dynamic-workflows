/**
 * KAR-07.5 — the three layers that make a fresh worktree *work*, against real
 * git and a real package manager on a real PATH
 * (docs/09-workspace-and-safety.md §5; EPIC-07-S19 … EPIC-07-S22).
 *
 * Nothing here is mocked. The `.worktreeinclude` matching is real
 * `git ls-files`, so gitignore syntax — anchoring, `!` negation, last-match
 * wins — is git's own implementation rather than a second one that agrees on
 * the cases someone thought of. The setup command goes through a real
 * `/bin/sh -c`, finding a real executable named `pnpm` on a temp PATH
 * (./support/fake-pm.ts), so argv splitting, stream framing and exit codes are
 * all exercised rather than asserted about a plan.
 *
 * `realpath` on the temp directory up front, for the same reason
 * ./worktree-lifecycle.test.ts does it: on macOS `/var` is a symlink to
 * `/private/var`, and comparing an unresolved path against git's output
 * reports a mismatch for the same directory.
 *
 * Verifies: EPIC-07-S19, EPIC-07-S20, EPIC-07-S21, EPIC-07-S22 · AC1–AC7
 */
import type { Db } from '@DeFlow/core';
import { openLedger, readIoChunks, readRange } from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { nodeBranch } from '../../src/git/branch-name.ts';
import { Git } from '../../src/git/git.ts';
import { worktreePathFor } from '../../src/git/worktree-args.ts';
import { type WorkspaceGit, WorkspaceManager } from '../../src/git/worktree-manager.ts';
import { estimateFanOutDisk, measureRepoDisk } from '../../src/workspace/disk-estimate.ts';
import { AmbiguousLockfileError } from '../../src/workspace/package-manager.ts';
import {
  type WorkspaceConfig,
  WorkspaceProvisioner,
  WorkspaceSetupFailed,
} from '../../src/workspace/provisioner.ts';
import { probeReflink } from '../../src/workspace/reflink.ts';

const RUN = 'run_20260806T090000Z_5c1d2e';
/** The ref-name-safe short id branches are composed from — `BRANCH_SAFE`
 * refuses the `T`/`Z` of a RunId, which is KAR-07.3's whole point. */
const REF_RUN = 'r1';
const EPOCH = 11;
const FAKE_PM = fileURLToPath(new URL('./support/fake-pm.ts', import.meta.url));

const GITIGNORE = '.env\n.env.local\n.env.production\nsecrets/\nnode_modules/\n';

/**
 * The S19 background's `.worktreeinclude`, with the negation made
 * load-bearing: `.env.production` is matched by an earlier line *and* is
 * gitignored, so the only thing keeping it out of the worktree is `!`.
 */
const WORKTREE_INCLUDE =
  '.env\n.env.production\nconfig/secrets.json\nlocal-notes.txt\n!.env.production\n';

interface SceneOptions {
  readonly config?: WorkspaceConfig;
  /** Extra files written and committed on `main`. */
  readonly tracked?: Readonly<Record<string, string>>;
  /** Files written but never added — the gitignored config S19 is about. */
  readonly untracked?: Readonly<Record<string, string>>;
  readonly worktreeInclude?: string | null;
  /** `DeFlow_PM_EXIT` / `DeFlow_PM_STDERR` for the fake package manager. */
  readonly pmExit?: number;
  readonly pmStderr?: string;
  readonly reflink?: (dir: string) => Promise<boolean>;
}

interface Scene {
  readonly root: string;
  readonly repo: string;
  readonly db: Db;
  readonly manager: WorkspaceManager;
  readonly provisioner: WorkspaceProvisioner;
  /** The recording wrapper the provisioner itself was given. */
  readonly git: WorkspaceGit;
  readonly gitCalls: string[][];
  /** One entry per fake package manager invocation, oldest first. */
  pmInvocations(): Promise<{ argv: string[]; cwd: string }[]>;
  wt(nodeId: string): string;
  write(path: string, contents: string, mode?: number): Promise<void>;
  close(): void;
}

async function scene(tmp: string, options: SceneOptions = {}): Promise<Scene> {
  const root = await realpath(tmp);
  const repo = join(root, 'repo');
  await makeRepo({
    dir: repo,
    files: {
      'README.md': '# fixture\n',
      '.gitignore': GITIGNORE,
      'config/secrets.json': '{"tracked":true}\n',
      ...options.tracked,
    },
  });

  if (options.worktreeInclude !== null) {
    await writeFile(join(repo, '.worktreeinclude'), options.worktreeInclude ?? WORKTREE_INCLUDE);
  }
  for (const [path, contents] of Object.entries(options.untracked ?? {})) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), contents);
  }

  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  for (const name of ['pnpm', 'npm', 'yarn']) await symlink(FAKE_PM, join(binDir, name));
  const pmLog = join(root, 'pm.log');

  const wrapped = new Git(repo, { env: GIT_ENV });
  const gitCalls: string[][] = [];
  const git = {
    run: (args: readonly string[], opts?: { readonly cwd?: string }) => {
      gitCalls.push([...args]);
      return wrapped.run(args, opts);
    },
  };

  const db = openLedger(root);
  const ports = { git, db, clock: new TestClock(1_754_400_000_000), epoch: EPOCH };
  const manager = new WorkspaceManager(ports);
  const provisioner = new WorkspaceProvisioner({
    ...ports,
    manager,
    repoRoot: repo,
    config: options.config ?? {},
    markerDir: join(root, 'markers'),
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      DeFlow_PM_LOG: pmLog,
      DeFlow_PM_EXIT: String(options.pmExit ?? 0),
      DeFlow_PM_STDERR: options.pmStderr ?? '',
    },
    ...(options.reflink === undefined ? {} : { probeReflink: options.reflink }),
  });

  return {
    root,
    repo,
    db,
    manager,
    provisioner,
    git,
    gitCalls,
    pmInvocations: async () => {
      const text = await readFile(pmLog, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
    },
    wt: (nodeId) => worktreePathFor(repo, RUN, nodeId),
    write: async (path, contents, mode) => {
      await writeFile(join(repo, path), contents);
      if (mode !== undefined) await chmod(join(repo, path), mode);
    },
    close: () => {
      db.close();
    },
  };
}

const provision = (s: Scene, nodeId: string) =>
  s.provisioner.provision({
    mode: 'write',
    runId: RUN,
    nodeId,
    attempt: 1,
    branch: nodeBranch(REF_RUN, nodeId),
    path: s.wt(nodeId),
    baseRef: 'main',
  });

const events = (db: Db): { kind: string; payload: Record<string, unknown> }[] =>
  readRange(db, RUN, 0, 500).events.map((event) => ({
    kind: event.kind,
    payload: event.payload as Record<string, unknown>,
  }));

const exists = async (path: string): Promise<boolean> =>
  await stat(path).then(
    () => true,
    () => false,
  );

// ── EPIC-07-S19 ──────────────────────────────────────────────────────────────

suite('EPIC-07-S19: .worktreeinclude copies gitignored config, and only that (AC1)', () => {
  const untracked = {
    '.env': 'SECRET=1\n',
    '.env.local': 'LOCAL=1\n',
    '.env.production': 'PROD=1\n',
    'local-notes.txt': 'not a secret\n',
    'node_modules/left-pad/index.js': 'module.exports = 1\n',
  };

  const table = [
    { file: '.env', copied: true, why: 'matches a pattern and is gitignored' },
    { file: '.env.local', copied: false, why: 'gitignored but matches no pattern' },
    { file: 'config/secrets.json', copied: false, why: 'matches a pattern but is tracked' },
    { file: '.env.production', copied: false, why: 'excluded by the "!" negation' },
    {
      // The row that catches a matcher checking only the pattern half: this
      // one really does match `.worktreeinclude`, and git does not ignore it.
      file: 'local-notes.txt',
      copied: false,
      why: 'matches a pattern but is not gitignored',
    },
    {
      file: 'node_modules/left-pad/index.js',
      copied: false,
      why: 'not a .worktreeinclude pattern',
    },
  ] as const;

  for (const { file, copied, why } of table) {
    it(`${file} is ${copied ? 'copied' : 'absent'} — ${why}`, async ({ tmp }) => {
      const s = await scene(tmp, { untracked });
      try {
        const result = await provision(s, 'n1');
        // `config/secrets.json` is tracked, so git checks it out into the
        // worktree on its own — the assertion has to be about what *this*
        // layer copied, not about what happens to be on disk.
        expect(result.environment.copied.includes(file)).toBe(copied);
      } finally {
        s.close();
      }
    });
  }

  it('preserves mode, so a 0600 secret does not widen in the worktree (AC2)', async ({ tmp }) => {
    const s = await scene(tmp, { untracked });
    try {
      await s.write('.env', 'SECRET=1\n', 0o600);

      await provision(s, 'n1');

      const source = await stat(join(s.repo, '.env'));
      const copy = await stat(join(s.wt('n1'), '.env'));
      expect(copy.mode & 0o777).toBe(0o600);
      expect(copy.mode & 0o777).toBe(source.mode & 0o777);
    } finally {
      s.close();
    }
  });

  it('names the path in a workspace.included_file event, and never the contents', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { untracked });
    try {
      await s.write('.env', 'SECRET=hunter2\n', 0o600);

      await provision(s, 'n1');

      const copied = events(s.db).filter((event) => event.kind === 'workspace.included_file');
      expect(copied).toEqual([{ kind: 'workspace.included_file', payload: expect.anything() }]);
      expect(copied[0]?.payload).toEqual({ node: 'n1', path: '.env', mode: '0600' });
      expect(JSON.stringify(events(s.db))).not.toContain('hunter2');
    } finally {
      s.close();
    }
  });

  it('copies nothing and emits nothing when the repository has no .worktreeinclude', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { untracked, worktreeInclude: null });
    try {
      const result = await provision(s, 'n1');

      expect(result.environment.copied).toEqual([]);
      expect(events(s.db).map((event) => event.kind)).not.toContain('workspace.included_file');
      expect(await exists(join(s.wt('n1'), '.env'))).toBe(false);
    } finally {
      s.close();
    }
  });

  it('copies the repository’s own config, not a sibling worktree’s copy of it', async ({ tmp }) => {
    // The worktrees live under `<repo>/.DeFlow/wt/`, inside the repository, so
    // a second provisioning walks a tree that already contains the first
    // worktree's `.env`. Copying that one would propagate whatever the first
    // agent wrote into every later node.
    const s = await scene(tmp, { untracked });
    try {
      await provision(s, 'n1');
      await writeFile(join(s.wt('n1'), '.env'), 'AGENT_EDITED=1\n');

      const second = await provision(s, 'n2');

      expect(second.environment.copied).toEqual(['.env']);
      expect(await readFile(join(s.wt('n2'), '.env'), 'utf8')).toBe('SECRET=1\n');
    } finally {
      s.close();
    }
  });
});

// ── EPIC-07-S20 ──────────────────────────────────────────────────────────────

suite('EPIC-07-S20: the manager is detected from the lockfile (AC3)', () => {
  const cases = [
    { lockfile: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
    { lockfile: 'package-lock.json', command: 'npm ci' },
    { lockfile: 'yarn.lock', command: 'yarn install --immutable' },
  ] as const;

  for (const { lockfile, command } of cases) {
    it(`${lockfile} → ${command}`, async ({ tmp }) => {
      const s = await scene(tmp, { tracked: { [lockfile]: 'lock\n' } });
      try {
        const result = await provision(s, 'n1');

        expect(result.environment.setupCommand).toBe(command);
        const [invocation] = await s.pmInvocations();
        expect(invocation?.argv).toEqual(command.split(' ').slice(1));
        expect(invocation?.cwd).toBe(s.wt('n1'));
      } finally {
        s.close();
      }
    });
  }

  it('two lockfiles is a typed error naming both, and no install is run', async ({ tmp }) => {
    const s = await scene(tmp, {
      tracked: { 'pnpm-lock.yaml': 'a\n', 'package-lock.json': 'b\n' },
    });
    try {
      const failure = await provision(s, 'n1').catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AmbiguousLockfileError);
      expect((failure as AmbiguousLockfileError).lockfiles).toEqual([
        'pnpm-lock.yaml',
        'package-lock.json',
      ]);
      expect(await s.pmInvocations()).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('gives three worktrees three real node_modules directories, and no symlink', async ({
    tmp,
  }) => {
    // No `setupCacheKey`, so setup runs for each of the three — the caching in
    // EPIC-07-S21 is opt-in, and this scenario is about what provisioning
    // leaves on disk rather than about how often it runs.
    const s = await scene(tmp, {
      tracked: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' },
      config: { setup: 'pnpm install --frozen-lockfile', setupCacheKey: [] },
    });
    try {
      for (const nodeId of ['n1', 'n2', 'n3']) await provision(s, nodeId);

      for (const nodeId of ['n1', 'n2', 'n3']) {
        const modules = join(s.wt(nodeId), 'node_modules');
        const info = await stat(modules);
        expect(info.isDirectory(), `${nodeId} node_modules is a directory`).toBe(true);
        expect(info.isSymbolicLink()).toBe(false);
      }
      expect((await s.pmInvocations()).length).toBe(3);
    } finally {
      s.close();
    }
  });
});

// ── EPIC-07-S21 ──────────────────────────────────────────────────────────────

const CACHED: WorkspaceConfig = {
  setup: 'pnpm install --frozen-lockfile',
  setupCacheKey: ['pnpm-lock.yaml'],
};

suite('EPIC-07-S21: setup runs once and is cached on the lockfile hash (AC4, AC5)', () => {
  const withLock = { tracked: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, config: CACHED };

  it('runs setup once and streams its output to the ledger as io_chunk', async ({ tmp }) => {
    const s = await scene(tmp, withLock);
    try {
      const result = await provision(s, 'n1');

      expect((await s.pmInvocations()).length).toBe(1);
      const { chunks } = readIoChunks(s.db, { runId: RUN, nodeId: 'n1', attempt: 1 }, 0, 100);
      const stdout = chunks
        .filter((chunk) => chunk.stream === 'stdout')
        .map((chunk) => Buffer.from(chunk.data).toString('utf8'))
        .join('');
      expect(stdout).toContain('fake package manager: install --frozen-lockfile');
      expect(result.environment.cacheKey).toMatch(/^sha256-[0-9a-f]{64}$/);
    } finally {
      s.close();
    }
  });

  it('writes a success marker keyed on the sha256 of the setupCacheKey files', async ({ tmp }) => {
    const s = await scene(tmp, withLock);
    try {
      const result = await provision(s, 'n1');

      const markers = await readdir(join(s.root, 'markers'));
      expect(markers).toEqual([result.environment.cacheKey?.slice('sha256-'.length)]);
    } finally {
      s.close();
    }
  });

  it('skips setup entirely for a second worktree on an unchanged lockfile', async ({ tmp }) => {
    const s = await scene(tmp, withLock);
    try {
      const first = await provision(s, 'n1');
      const second = await provision(s, 'n2');

      expect((await s.pmInvocations()).length).toBe(1);
      expect(second.environment.cacheHit).toBe(true);
      expect(first.environment.cacheHit).toBe(false);

      const hits = events(s.db).filter((event) => event.kind === 'workspace.setup_cache_hit');
      expect(hits.length).toBe(1);
      expect(hits[0]?.payload).toEqual({
        node: 'n2',
        key: first.environment.cacheKey,
        files: ['pnpm-lock.yaml'],
      });
    } finally {
      s.close();
    }
  });

  it('re-runs setup once the lockfile changes, under a different key', async ({ tmp }) => {
    const s = await scene(tmp, withLock);
    try {
      const first = await provision(s, 'n1');
      await provision(s, 'n2');

      await s.write('pnpm-lock.yaml', 'lockfileVersion: 9\n# changed\n');
      const third = await provision(s, 'n3');

      expect((await s.pmInvocations()).length).toBe(2);
      expect(third.environment.cacheHit).toBe(false);
      expect(third.environment.cacheKey).not.toBe(first.environment.cacheKey);
    } finally {
      s.close();
    }
  });

  it('is a hit again when the lockfile changes back — the key is content', async ({ tmp }) => {
    const s = await scene(tmp, withLock);
    try {
      const first = await provision(s, 'n1');
      await s.write('pnpm-lock.yaml', 'lockfileVersion: 9\n# changed\n');
      await provision(s, 'n2');
      await s.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');

      const third = await provision(s, 'n3');

      expect(third.environment.cacheHit).toBe(true);
      expect(third.environment.cacheKey).toBe(first.environment.cacheKey);
      expect((await s.pmInvocations()).length).toBe(2);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S21: a failing setup fails provisioning before any agent is spawned (AC4)', () => {
  const failing = {
    tracked: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' },
    config: CACHED,
    pmExit: 1,
    pmStderr: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"',
  };

  it('throws a typed error carrying the exit code and the stderr tail', async ({ tmp }) => {
    const s = await scene(tmp, failing);
    try {
      const failure = await provision(s, 'n1').catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(WorkspaceSetupFailed);
      const typed = failure as WorkspaceSetupFailed;
      expect(typed.exitCode).toBe(1);
      expect(typed.stderrTail).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
      expect(typed.command).toBe('pnpm install --frozen-lockfile');
    } finally {
      s.close();
    }
  });

  it('spawns no agent: the caller’s continuation is never reached', async ({ tmp }) => {
    const s = await scene(tmp, failing);
    let spawned = 0;
    try {
      await provision(s, 'n1').then(
        () => {
          spawned += 1;
        },
        () => {},
      );

      expect(spawned).toBe(0);
    } finally {
      s.close();
    }
  });

  it('removes the worktree by the ordinary clean-removal path — no force anywhere', async ({
    tmp,
  }) => {
    const s = await scene(tmp, failing);
    try {
      await provision(s, 'n1').catch(() => undefined);

      expect(await exists(s.wt('n1'))).toBe(false);
      expect(events(s.db).map((event) => event.kind)).toContain('workspace.worktree_removed');
      const forced = s.gitCalls.filter((argv) => argv.includes('-f') || argv.includes('--force'));
      expect(forced).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('writes no success marker, so the next worktree tries again', async ({ tmp }) => {
    const s = await scene(tmp, failing);
    try {
      await provision(s, 'n1').catch(() => undefined);
      await provision(s, 'n2').catch(() => undefined);

      expect(await readdir(join(s.root, 'markers')).catch(() => [])).toEqual([]);
      expect((await s.pmInvocations()).length).toBe(2);
    } finally {
      s.close();
    }
  });

  it('streams the failing command’s stderr to the ledger before it gives up', async ({ tmp }) => {
    const s = await scene(tmp, failing);
    try {
      await provision(s, 'n1').catch(() => undefined);

      const { chunks } = readIoChunks(s.db, { runId: RUN, nodeId: 'n1', attempt: 1 }, 0, 100);
      const stderr = chunks
        .filter((chunk) => chunk.stream === 'stderr')
        .map((chunk) => Buffer.from(chunk.data).toString('utf8'))
        .join('');
      expect(stderr).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    } finally {
      s.close();
    }
  });
});

// ── AC7: the reflink probe ───────────────────────────────────────────────────

suite('KAR-07.5 AC7: the reflink fast path is opportunistic only', () => {
  it('probes by cloning a real one-byte file, and leaves nothing behind', async ({ tmp }) => {
    const dir = join(tmp, 'probe');
    await mkdir(dir, { recursive: true });

    const supported = await probeReflink(dir);

    expect(typeof supported).toBe('boolean');
    expect(await readdir(dir)).toEqual([]);
  });

  it('answers false rather than throwing when the directory cannot be written', async ({ tmp }) => {
    expect(await probeReflink(join(tmp, 'does-not-exist'))).toBe(false);
  });

  it('clones node_modules only after the probe succeeded', async ({ tmp }) => {
    const probed: string[] = [];
    const s = await scene(tmp, {
      tracked: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' },
      config: CACHED,
      reflink: async (dir) => {
        probed.push(dir);
        return true;
      },
    });
    try {
      await mkdir(join(s.repo, 'node_modules', 'left-pad'), { recursive: true });
      await writeFile(join(s.repo, 'node_modules', 'left-pad', 'index.js'), 'x\n');

      const result = await provision(s, 'n1');

      expect(probed).toEqual([s.wt('n1')]);
      expect(result.environment.reflinkSupported).toBe(true);
      expect(result.environment.plan.map((step) => step.kind)).toContain('clone');
      expect(await readFile(join(s.wt('n1'), 'node_modules/left-pad/index.js'), 'utf8')).toBe(
        'x\n',
      );
    } finally {
      s.close();
    }
  });

  it('falls through to the package manager when the probe fails, with nothing surfaced', async ({
    tmp,
  }) => {
    // This is ext4. The probe says no, and the user must not learn about it:
    // there is no reflink event kind, no warning, and no failure.
    const s = await scene(tmp, {
      tracked: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' },
      config: CACHED,
      reflink: async () => false,
    });
    try {
      await mkdir(join(s.repo, 'node_modules'), { recursive: true });

      const result = await provision(s, 'n1');

      expect(result.environment.reflinkSupported).toBe(false);
      expect(result.environment.plan.map((step) => step.kind)).toEqual(['run']);
      expect((await s.pmInvocations()).length).toBe(1);
      expect(await exists(join(s.wt('n1'), 'node_modules'))).toBe(true);
      expect(JSON.stringify(events(s.db))).not.toContain('reflink');
    } finally {
      s.close();
    }
  });

  it('does not probe at all when there is no node_modules to clone', async ({ tmp }) => {
    const probed: string[] = [];
    const s = await scene(tmp, {
      tracked: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' },
      config: CACHED,
      reflink: async (dir) => {
        probed.push(dir);
        return true;
      },
    });
    try {
      await provision(s, 'n1');

      expect(probed).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── EPIC-07-S22 ──────────────────────────────────────────────────────────────

suite('EPIC-07-S22: the disk estimate shown before a fan-out is authorized', () => {
  it('measures the tracked working tree and node_modules separately', async ({ tmp }) => {
    const s = await scene(tmp, { tracked: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' } });
    try {
      await mkdir(join(s.repo, 'node_modules', 'left-pad'), { recursive: true });
      await writeFile(join(s.repo, 'node_modules', 'left-pad', 'index.js'), 'y'.repeat(4096));

      const measured = await measureRepoDisk(s.git, s.repo);

      expect(measured.trackedBytes).toBeGreaterThan(0);
      expect(measured.nodeModulesBytes).toBeGreaterThanOrEqual(4096);
      // The .env-shaped untracked files are not tracked, so they are not in
      // the term that gets multiplied by N.
      expect(measured.manager).toBe('pnpm');
    } finally {
      s.close();
    }
  });

  it('the object store is shared, so .git is not multiplied by the fan-out', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const before = await directorySize(join(s.repo, '.git'));

      for (let n = 1; n <= 8; n += 1) await provision(s, `n${n}`);

      const growth = (await directorySize(join(s.repo, '.git'))) - before;
      expect(growth).toBeLessThan(100 * 1024);

      const estimate = estimateFanOutDisk({ nodes: 8, trackedBytes: 1024, manager: null });
      expect(estimate.terms.map((term) => term.label)).not.toContain('.git');
    } finally {
      s.close();
    }
  });
});

/** Recursive apparent size, the same thing `measureRepoDisk` reports. */
async function directorySize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}
