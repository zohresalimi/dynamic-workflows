/**
 * NF6: a frozen-lockfile install completes with zero compilation, so anyone
 * without a C or C++ toolchain can install DeFlow.
 *
 * This runs a real pnpm against a real registry into a temp copy of the
 * workspace manifests — the same inputs a fresh clone installs from. The temp
 * copy disables pnpm's side-effects cache, so a dependency that needs building
 * has to build here rather than being restored from an earlier build.
 *
 * Verifies: EPIC-01-S2 (scenario 1 and 4), EPIC-01-S3 (scenario 1),
 * EPIC-01-S1 (the "what pnpm install did, observably" symlink half) · AC4
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { workspaceDependencyEdges } from '../support/guards.ts';
import { allManifests, packageDirs, repoRoot, workspaceNames } from '../support/workspace.ts';

const MANIFEST_FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];

/**
 * Not a manifest, but part of what a clone hands the installer: `prepare` runs
 * `lefthook install`, which reads this file to know which hooks to write.
 * Without it the install still succeeds and writes no hooks at all — the silent
 * half of KAR-01.6 AC5, and the reason that criterion is asserted here rather
 * than on the presence of the script.
 */
const HOOK_CONFIG = 'lefthook.yml';

let workdir: string;
let install: { status: number | null; output: string };

function pnpm(args: string[], cwd: string) {
  const result = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', npm_config_update_notifier: 'false' },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

beforeAll(() => {
  // DeFlow-prefixed, so CI's upload-artifact glob over the runner temp
  // directory collects this workdir when a leg fails (KAR-01.6 AC10).
  workdir = mkdtempSync(join(tmpdir(), 'DeFlow-frozen-install-'));
  for (const file of [
    ...MANIFEST_FILES,
    HOOK_CONFIG,
    ...packageDirs().map((dir) => `${dir}/package.json`),
  ]) {
    mkdirSync(dirname(join(workdir, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(workdir, file));
  }
  writeFileSync(join(workdir, '.npmrc'), 'side-effects-cache=false\n');
  // A real `git init`, because a fresh clone is a git repository and this
  // fixture claims to install from the same inputs one does. It stopped being
  // a detail when KAR-01.6 added `"prepare": "lefthook install"`: lefthook
  // exits 128 outside a work tree, and a `prepare` that cannot fail is a
  // `prepare` that cannot tell you the hooks are missing, so the fixture grew
  // the .git it was always implying rather than the script growing a `|| true`.
  spawnSync('git', ['init', '--initial-branch=main'], {
    cwd: workdir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  install = pnpm(['install', '--frozen-lockfile'], workdir);
}, 600_000);

afterAll(() => {
  if (workdir !== undefined && process.env.DeFlow_KEEP_TMP !== '1') {
    rmSync(workdir, { recursive: true, force: true });
  }
});

suite('pnpm install --frozen-lockfile', () => {
  it('completes with exit code 0', () => {
    expect(install.output).toBeDefined();
    expect(install.status).toBe(0);
  });

  // KAR-01.6 AC5, EPIC-01-S1: the hooks have to be there after a clone and an
  // install, with no third step. Asserted on the artefact `git` will actually
  // execute, not on the presence of the "prepare" script that writes it.
  it('leaves working git hooks behind, with no extra step (KAR-01.6 AC5)', () => {
    const hook = join(workdir, '.git/hooks/pre-commit');
    expect(readFileSync(hook, 'utf8')).toContain('lefthook');
    // Installed is not enough: git ignores a hook that is not executable, and
    // does so silently.
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it('never invokes node-gyp', () => {
    const gypLines = install.output.split('\n').filter((line) => /gyp/i.test(line));
    expect(gypLines).toEqual([]);
  });

  it('leaves pnpm-lock.yaml unchanged', () => {
    expect(readFileSync(join(workdir, 'pnpm-lock.yaml'), 'utf8')).toBe(
      readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
    );
  });

  it('resolves better-sqlite3 to a prebuilt binary rather than building it', () => {
    const virtualStore = readdirSync(join(workdir, 'node_modules/.pnpm'));
    const dir = virtualStore.find((entry) => entry.startsWith('better-sqlite3@'));
    expect(dir, 'better-sqlite3 in the virtual store').toBeDefined();
    const pkgRoot = join(workdir, 'node_modules/.pnpm', dir ?? '', 'node_modules/better-sqlite3');
    expect(readdirSync(pkgRoot)).toContain('prebuilds');
    expect(readdirSync(pkgRoot)).not.toContain('build');
  });

  it('resolves the pty to a per-platform optionalDependency with no compilation', () => {
    const virtualStore = readdirSync(join(workdir, 'node_modules/.pnpm'));
    expect(virtualStore.some((entry) => entry.startsWith('@lydell+node-pty@'))).toBe(true);
    expect(
      virtualStore.some((entry) => /^@lydell\+node-pty-[a-z0-9]+-[a-z0-9]+@/.test(entry)),
    ).toBe(true);
  });
});

suite('every workspace dependency is linked, never downloaded', () => {
  const edges = workspaceDependencyEdges(allManifests(), workspaceNames());

  it('declares at least one edge per workspace package that has a consumer', () => {
    expect(edges.length).toBeGreaterThan(0);
  });

  it.each(edges)(
    '$consumerDir/node_modules/$dependency is a symlink into the workspace',
    (edge) => {
      const link = join(workdir, edge.consumerDir, 'node_modules', edge.dependency);
      expect(lstatSync(link).isSymbolicLink(), `${link} is a symlink`).toBe(true);

      // A same-named package downloaded from the registry would land in the
      // virtual store; "workspace:*" must resolve to the local source directory.
      const target = relative(realpathSync(workdir), realpathSync(link));
      expect(target.startsWith('..'), `${edge.dependency} resolves inside the workspace`).toBe(
        false,
      );
      expect(target).not.toContain(`node_modules${'/'}.pnpm`);
    },
  );

  // @DeFlow/web gained its consumer with KAR-15.1: packages/cli imports the one
  // `hc<ApiType>` client module out of packages/web/src/api, so `deflow run` and
  // the browser are two callers of one typed surface rather than two
  // implementations of one protocol (docs/11-api-and-realtime.md §9). Updating
  // this list is the visible diff that says the dependency graph of
  // docs/16-repo-layout.md §4 changed.
  //
  // @DeFlow/gates arrived here with KAR-12.3, as a devDependency of the daemon:
  // the gate contract is enforced by the daemon's handoff loop and its Ajv
  // store, so the specs that prove it run there. The production edge follows
  // when the daemon starts executing gate nodes.
  it('links every workspace package that currently has a consumer', () => {
    const linked = new Set(edges.map((edge) => edge.dependency));
    expect([...linked].sort()).toEqual([
      '@DeFlow/adapters',
      '@DeFlow/core',
      '@DeFlow/daemon',
      '@DeFlow/gates',
      '@DeFlow/ledger',
      '@DeFlow/mock-agent',
      '@DeFlow/testkit',
      '@DeFlow/web',
      'deflow',
    ]);
  });
});

suite('exactly one TypeScript version resolves across the workspace', () => {
  it('reports 6.0.3 and nothing else', () => {
    const listed = pnpm(['ls', 'typescript', '-r', '--depth', '0', '--json'], repoRoot);
    expect(listed.status).toBe(0);
    const projects = JSON.parse(listed.output) as {
      dependencies?: Record<string, { version: string }>;
      devDependencies?: Record<string, { version: string }>;
    }[];
    const versions = new Set(
      projects.flatMap((project) =>
        [project.dependencies?.typescript, project.devDependencies?.typescript]
          .filter((entry) => entry !== undefined)
          .map((entry) => entry.version),
      ),
    );
    expect([...versions]).toEqual(['6.0.3']);
  });
});
