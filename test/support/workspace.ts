/**
 * Reads the real workspace off disk so the guards in ./guards.ts can be applied
 * to it. Nothing here asserts; it only loads.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Manifest, PackageJson, SourceFile, TsconfigFile } from './guards.ts';

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
    readSources(walk(dir, (path) => (path.endsWith('.ts') || path.endsWith('.vue')) && !isTestFile(path))),
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
