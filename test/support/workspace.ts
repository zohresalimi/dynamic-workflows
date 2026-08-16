/**
 * Reads the real workspace off disk so the guards in ./guards.ts can be applied
 * to it. Nothing here asserts; it only loads.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Manifest, PackageJson, SourceFile, TsconfigFile } from './guards.ts';
import { FILTER_SAMPLE_FILES } from './guards.ts';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function readText(repoRelativePath: string): string {
  return readFileSync(join(repoRoot, repoRelativePath), 'utf8');
}

export function exists(repoRelativePath: string): boolean {
  try {
    statSync(join(repoRoot, repoRelativePath));
    return true;
  } catch {
    return false;
  }
}

export function readJson(repoRelativePath: string): PackageJson {
  return JSON.parse(readText(repoRelativePath)) as PackageJson;
}

export interface WorkspaceYaml {
  readonly packages?: string[];
  readonly catalog?: Record<string, string>;
}

export function readWorkspaceYaml(): WorkspaceYaml {
  return parseYaml(readText('pnpm-workspace.yaml')) as WorkspaceYaml;
}

/** Any YAML file in the repository, parsed. Used for lefthook.yml and the workflows. */
export function readYaml<T>(repoRelativePath: string): T {
  return parseYaml(readText(repoRelativePath)) as T;
}

/** Every GitHub Actions workflow file, repo-relative. */
export function workflowFiles(): string[] {
  return walk('.github/workflows', (path) => path.endsWith('.yml') || path.endsWith('.yaml'));
}

/**
 * Every tracked text file from which a `pnpm --filter` could actually be run
 * (KAR-20.5 AC4) — sources, manifests, workflows, shell scripts and the
 * user-facing documentation that tells a reader to type one.
 *
 * Tracked rather than walked, because that is exactly the set which reaches a
 * CI runner. Two exclusions, both deliberate:
 *
 *   * `docs/delivery/` — the authored plan quotes the broken command as
 *     history. EPIC-20's own story for this defect names `pnpm --filter deflow`
 *     twice while explaining it, and a guard that forbade that would forbid
 *     writing the story down.
 *   * `FILTER_SAMPLE_FILES` — the two specs that write a filter down in order
 *     to be about filters. See the constant for which and why.
 */
export function filterCommandFiles(): string[] {
  const extensions = ['.ts', '.json', '.yml', '.yaml', '.sh', '.md'];
  const samples = new Set(FILTER_SAMPLE_FILES);
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(
      (path) =>
        path !== '' &&
        !path.startsWith('docs/delivery/') &&
        !samples.has(path) &&
        extensions.some((extension) => path.endsWith(extension)),
    )
    .sort();
}

/** Every file under docs/, which AC8's corepack grep has to cover in full. */
export function docFiles(): string[] {
  return walk('docs', (path) => path.endsWith('.md'));
}

/** The directories pnpm treats as workspace packages, repo-relative. */
export function packageDirs(): string[] {
  const dirs: string[] = [];
  const packagesDir = join(repoRoot, 'packages');
  if (exists('packages')) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && exists(join('packages', entry.name, 'package.json'))) {
        dirs.push(`packages/${entry.name}`);
      }
    }
  }
  if (exists('e2e/package.json')) dirs.push('e2e');
  return dirs.sort();
}

/** Every workspace package manifest, excluding the root manifest. */
export function packageManifests(): Manifest[] {
  return packageDirs().map((dir) => {
    const path = `${dir}/package.json`;
    return { path, json: readJson(path) };
  });
}

/** Every manifest pnpm installs from, including the root one. */
export function allManifests(): Manifest[] {
  return [{ path: 'package.json', json: readJson('package.json') }, ...packageManifests()];
}

export function workspaceNames(): string[] {
  return packageManifests()
    .map((manifest) => manifest.json.name)
    .filter((name): name is string => typeof name === 'string');
}

export function manifestFor(dir: string): Manifest {
  const path = `${dir}/package.json`;
  return { path, json: readJson(path) };
}

/** Recursively collect files under a repo-relative directory. */
export function walk(repoRelativeDir: string, predicate: (path: string) => boolean): string[] {
  if (!exists(repoRelativeDir)) return [];
  const out: string[] = [];
  const stack = [join(repoRoot, repoRelativeDir)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      const repoRelative = relative(repoRoot, full);
      if (predicate(repoRelative)) out.push(repoRelative);
    }
  }
  return out.sort();
}

export function readSources(paths: readonly string[]): SourceFile[] {
  return paths.map((path) => ({ path, text: readText(path) }));
}

/** The directories that hold hand-written TypeScript, plus the root config files. */
const TYPESCRIPT_ROOTS = ['packages', 'e2e', 'test'] as const;

/**
 * Every TypeScript file in the repository, tests and configs included.
 *
 * This is the input to the KAR-01.4 hygiene guards, which are rules about test
 * code, so — unlike `allWorkspaceSources()` — it deliberately does not filter
 * test files out. `docs/` is excluded: it is full of prose showing the very
 * shapes those guards ban.
 */
export function repoTypeScriptFiles(): string[] {
  const isTypeScript = (path: string): boolean => path.endsWith('.ts');
  const rootConfigs = readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isTypeScript(entry.name))
    .map((entry) => entry.name);
  return [...rootConfigs, ...TYPESCRIPT_ROOTS.flatMap((dir) => walk(dir, isTypeScript))].sort();
}

const isTestFile = (path: string): boolean =>
  path.endsWith('.test.ts') || path.includes('/test/') || path.includes('/__snapshots__/');

/** Non-test TypeScript sources of one package. */
export function productionSources(packageDir: string): SourceFile[] {
  return readSources(
    walk(`${packageDir}/src`, (path) => path.endsWith('.ts') && !isTestFile(path)),
  );
}

/** Non-test sources of every workspace package, plus e2e specs. */
export function allWorkspaceSources(): SourceFile[] {
  return packageDirs().flatMap((dir) =>
    readSources(
      walk(dir, (path) => (path.endsWith('.ts') || path.endsWith('.vue')) && !isTestFile(path)),
    ),
  );
}

/** Non-test sources under packages/*\/src only — AC8's scope for KAR-01.2. */
export function packageProductionSources(): SourceFile[] {
  return packageDirs()
    .filter((dir) => dir.startsWith('packages/'))
    .flatMap((dir) => productionSources(dir));
}

/**
 * tsconfig.json is JSONC — TypeScript's own `tsc --init` output is full of
 * comments — so a reader that only speaks strict JSON cannot read the files it
 * is meant to guard.
 */
export function parseJsonc<T>(text: string): T {
  const withoutComments = text
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
  return JSON.parse(withoutComments) as T;
}

export function readTsconfig(repoRelativePath: string): TsconfigFile['json'] {
  return parseJsonc<TsconfigFile['json']>(readText(repoRelativePath));
}

/** tsconfig.base.json plus every package's own tsconfig.json that exists. */
export function tsconfigFiles(): TsconfigFile[] {
  const files: TsconfigFile[] = [
    { path: 'tsconfig.base.json', json: readTsconfig('tsconfig.base.json') },
  ];
  for (const dir of packageDirs()) {
    const path = `${dir}/tsconfig.json`;
    if (exists(path)) files.push({ path, json: readTsconfig(path) });
  }
  return files;
}
