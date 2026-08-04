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
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe as suite, expect, it } from 'vitest';
import { workspaceDependencyEdges } from '../support/guards.ts';
import { allManifests, packageDirs, repoRoot, workspaceNames } from '../support/workspace.ts';

const MANIFEST_FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];

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
  workdir = mkdtempSync(join(tmpdir(), 'deflow-frozen-install-'));
  for (const file of [...MANIFEST_FILES, ...packageDirs().map((dir) => `${dir}/package.json`)]) {
    mkdirSync(dirname(join(workdir, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(workdir, file));
  }
  writeFileSync(join(workdir, '.npmrc'), 'side-effects-cache=false\n');
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
    expect(virtualStore.some((entry) => /^@lydell\+node-pty-[a-z0-9]+-[a-z0-9]+@/.test(entry))).toBe(true);
  });
});

suite('every workspace dependency is linked, never downloaded', () => {
  const edges = workspaceDependencyEdges(allManifests(), workspaceNames());

  it('declares at least one edge per workspace package that has a consumer', () => {
    expect(edges.length).toBeGreaterThan(0);
  });

  it.each(edges)('$consumerDir/node_modules/$dependency is a symlink into the workspace', (edge) => {
    const link = join(workdir, edge.consumerDir, 'node_modules', edge.dependency);
    expect(lstatSync(link).isSymbolicLink(), `${link} is a symlink`).toBe(true);

    // A same-named package downloaded from the registry would land in the
    // virtual store; "workspace:*" must resolve to the local source directory.
    const target = relative(realpathSync(workdir), realpathSync(link));
    expect(target.startsWith('..'), `${edge.dependency} resolves inside the workspace`).toBe(false);
    expect(target).not.toContain(`node_modules${'/'}.pnpm`);
  });

  // @DeFlow/web has no consumer yet: packages/cli gains it with KAR-01.3, when
  // the cli starts shipping the built UI. Updating this list is the visible diff
  // that says the dependency graph of docs/16-repo-layout.md §4 changed.
  it('links every workspace package that currently has a consumer', () => {
    const linked = new Set(edges.map((edge) => edge.dependency));
    expect([...linked].sort()).toEqual([
      '@DeFlow/adapters',
      '@DeFlow/core',
      '@DeFlow/daemon',
      '@DeFlow/ledger',
      '@DeFlow/mock-agent',
      '@DeFlow/testkit',
      'DeFlow',
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
