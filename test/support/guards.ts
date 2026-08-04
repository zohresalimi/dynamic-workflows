/**
 * Pure guard functions for the workspace structure rules of KAR-01.1.
 *
 * They are pure so the guards themselves can be unit-tested against fixtures
 * (a violating input must produce a violation, a clean input must not) instead
 * of only ever being exercised by the repository as it happens to look today.
 *
 * Rules, from docs/16-repo-layout.md §4:
 *   R1  @DeFlow/core depends on nothing in the workspace, and on nothing that
 *       can perform I/O.
 *   R2  Nothing depends on @DeFlow/daemon except packages/cli.
 */

export interface Violation {
  /** Repo-relative file the violation lives in. */
  readonly where: string;
  /** Human-readable explanation, including why the rule exists. */
  readonly message: string;
}

export interface Manifest {
  /** Repo-relative path of the package.json. */
  readonly path: string;
  /** Parsed package.json. */
  readonly json: PackageJson;
}

export interface PackageJson {
  readonly name?: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly engines?: Record<string, string>;
  readonly packageManager?: string;
  readonly exports?: unknown;
  readonly publishConfig?: { readonly exports?: unknown };
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

export interface SourceFile {
  /** Repo-relative path. */
  readonly path: string;
  readonly text: string;
}

export const DEPENDENCY_BLOCKS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type DependencyBlock = (typeof DEPENDENCY_BLOCKS)[number];

function entriesOf(json: PackageJson, block: DependencyBlock): [string, string][] {
  const record = json[block];
  return record ? Object.entries(record) : [];
}

/** Every dependency block of a manifest, flattened. */
export function allDependencies(json: PackageJson): [string, string][] {
  return DEPENDENCY_BLOCKS.flatMap((block) => entriesOf(json, block));
}

export interface WorkspaceEdge {
  /** Repo-relative directory of the consuming package; "." for the root manifest. */
  readonly consumerDir: string;
  /** Name of the workspace package it depends on. */
  readonly dependency: string;
}

/**
 * Every consumer -> workspace-package edge declared across the manifests, in
 * declaration order. EPIC-01-S1 asserts these resolve to symlinks back into the
 * workspace after a real install: `workspace:*` must link the local package,
 * never download a same-named one from the registry.
 */
export function workspaceDependencyEdges(
  manifests: readonly Manifest[],
  workspaceNames: readonly string[],
): WorkspaceEdge[] {
  const workspace = new Set(workspaceNames);
  return manifests.flatMap((manifest) => {
    const consumerDir = manifest.path === 'package.json' ? '.' : manifest.path.replace(/\/package\.json$/, '');
    return allDependencies(manifest.json)
      .filter(([name]) => workspace.has(name))
      .map(([dependency]) => ({ consumerDir, dependency }));
  });
}

/**
 * AC3 / EPIC-01-S2: workspace packages are consumed with `workspace:*`, shared
 * third-party packages with `catalog:`. A literal semver string anywhere in a
 * dependency block means nine packages can now drift.
 */
export function checkDependencyValues(
  manifests: readonly Manifest[],
  workspaceNames: readonly string[],
): Violation[] {
  const workspace = new Set(workspaceNames);
  const violations: Violation[] = [];

  for (const manifest of manifests) {
    for (const block of DEPENDENCY_BLOCKS) {
      for (const [name, value] of entriesOf(manifest.json, block)) {
        if (workspace.has(name)) {
          if (value !== 'workspace:*') {
            violations.push({
              where: manifest.path,
              message:
                `${block}["${name}"] is "${value}" but "${name}" is a workspace package, ` +
                'so it must be consumed as "workspace:*".',
            });
          }
          continue;
        }
        if (value !== 'catalog:') {
          violations.push({
            where: manifest.path,
            message:
              `${block}["${name}"] is "${value}"; every shared third-party dependency must be ` +
              '"catalog:" so its version is pinned once in pnpm-workspace.yaml and nine packages ' +
              'cannot drift.',
          });
        }
      }
    }
  }

  return violations;
}

/**
 * AC2 / EPIC-01-S2: two catalog entries must be pinned exact, without a range
 * operator.
 */
export const EXACT_PINNED_CATALOG_ENTRIES: Readonly<Record<string, string>> = {
  '@agentclientprotocol/sdk': '1.3.0',
  tsdown: '0.22.14',
  '@biomejs/biome': '2.5.6',
};

export function checkExactCatalogPins(catalog: Record<string, string>): Violation[] {
  const violations: Violation[] = [];
  for (const [name, expected] of Object.entries(EXACT_PINNED_CATALOG_ENTRIES)) {
    const actual = catalog[name];
    if (actual === undefined) {
      violations.push({
        where: 'pnpm-workspace.yaml',
        message: `catalog is missing "${name}", which must be pinned exact at ${expected}.`,
      });
      continue;
    }
    if (/^[\^~><=]/.test(actual)) {
      violations.push({
        where: 'pnpm-workspace.yaml',
        message:
          `catalog["${name}"] is "${actual}"; it must be pinned exact, without a range operator. ` +
          '@agentclientprotocol/sdk went 0.4.5 -> 1.3.0 and changed both npm scope and GitHub org ' +
          'inside about ten months, tsdown is still 0.x, and a Biome patch bump that reflows the ' +
          'repository turns the next commit into an unreviewable diff.',
      });
      continue;
    }
    if (actual !== expected) {
      violations.push({
        where: 'pnpm-workspace.yaml',
        message: `catalog["${name}"] is "${actual}", expected exactly "${expected}".`,
      });
    }
  }
  return violations;
}

/**
 * R1, first half. AC7 / EPIC-01-S5: @DeFlow/core's runtime dependency list is
 * exactly ["zod"].
 */
export function checkCorePurity(coreJson: PackageJson): Violation[] {
  const deps = Object.keys(coreJson.dependencies ?? {});
  const extra = deps.filter((name) => name !== 'zod');
  const violations: Violation[] = [];

  if (extra.length > 0) {
    violations.push({
      where: 'packages/core/package.json',
      message:
        `@DeFlow/core must depend on nothing but zod, but it depends on ${extra.join(', ')}. ` +
        'R1 is what makes the deterministic core structural rather than aspirational: time, ' +
        'randomness and ids enter through ports declared in @DeFlow/core and implemented in ' +
        '@DeFlow/daemon or @DeFlow/testkit, never through a dependency of core itself.',
    });
  }
  if (!deps.includes('zod')) {
    violations.push({
      where: 'packages/core/package.json',
      message: '@DeFlow/core must declare zod as its single runtime dependency.',
    });
  }

  return violations;
}

/**
 * R1, second half. AC7 / EPIC-01-S5: no file under packages/core/src imports a
 * node: builtin — a builtin import is I/O capability arriving without a
 * package.json change.
 */
export function checkNoNodeBuiltinImports(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (/from\s+['"]node:/.test(line) || /require\(\s*['"]node:/.test(line)) {
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} imports a node: builtin. @DeFlow/core performs no I/O; time, randomness ` +
            'and ids enter through ports declared in core and implemented in daemon or testkit.',
        });
      }
    }
  }
  return violations;
}

/** R2. AC8 / EPIC-01-S5: only packages/cli may depend on @DeFlow/daemon. */
export function checkDaemonIsLeaf(manifests: readonly Manifest[]): Violation[] {
  const violations: Violation[] = [];
  for (const manifest of manifests) {
    if (manifest.path === 'packages/cli/package.json') continue;
    const dependsOnDaemon = allDependencies(manifest.json).some(
      ([name]) => name === '@DeFlow/daemon',
    );
    if (dependsOnDaemon) {
      violations.push({
        where: manifest.path,
        message:
          `${manifest.path} depends on @DeFlow/daemon, but only packages/cli may. R2 keeps the ` +
          'daemon a leaf: if another package needs something from it, that something belongs in ' +
          '@DeFlow/core if it is pure, or is a port that daemon implements and injects if it is not.',
      });
    }
  }
  return violations;
}

/**
 * AC9 / EPIC-01-S5: @DeFlow/mock-agent has zero workspace dependencies, so it
 * stays an independent oracle.
 */
export function checkMockAgentIsIndependent(
  mockAgent: Manifest,
  workspaceNames: readonly string[],
): Violation[] {
  const workspace = new Set(workspaceNames);
  const offenders = allDependencies(mockAgent.json)
    .map(([name]) => name)
    .filter((name) => workspace.has(name));

  if (offenders.length === 0) return [];

  return [
    {
      where: mockAgent.path,
      message:
        `@DeFlow/mock-agent depends on ${offenders.join(', ')}, but it must have zero workspace ` +
        'dependencies. From docs/16-repo-layout.md §1: if it depended on core, a bug in the domain ' +
        'model could be mirrored on both sides of the wire and cancel itself out. It is an ' +
        'independent implementation of the agent side of the same published schema, which is what ' +
        'makes it a useful oracle.',
    },
  ];
}

/**
 * EPIC-01-S3: upstream `node-pty` must never appear. Its install script is
 * "node scripts/prebuild.js || node-gyp rebuild", so on a machine with no
 * compiler the install fails outright. `@lydell/node-pty` uses npm-native
 * per-platform optionalDependencies and never compiles.
 */
export function checkNoBareNodePty(manifests: readonly Manifest[]): Violation[] {
  const violations: Violation[] = [];
  for (const manifest of manifests) {
    for (const [name] of allDependencies(manifest.json)) {
      if (name === 'node-pty') {
        violations.push({
          where: manifest.path,
          message:
            `${manifest.path} depends on the bare "node-pty" package. Its install script falls ` +
            'back to "node-gyp rebuild", which fails outright on a machine with no compiler and ' +
            'breaks NF6. Use "@lydell/node-pty" as an optionalDependency instead: it resolves to ' +
            'per-platform prebuilt packages with zero compilation, and an unsupported platform ' +
            'degrades to a no-TTY spawn rather than failing the install.',
        });
      }
    }
  }
  return violations;
}

const DEEP_IMPORT_SPECIFIER =
  /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * EPIC-01-S8: cross-package imports use the package root and nothing else.
 * A deep import works in development, because the deep path genuinely exists in
 * the workspace, and fails only once someone installs the tarball.
 */
export function checkNoDeepWorkspaceImports(
  files: readonly SourceFile[],
  workspaceNames: readonly string[],
): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      DEEP_IMPORT_SPECIFIER.lastIndex = 0;
      let match: RegExpExecArray | null = DEEP_IMPORT_SPECIFIER.exec(line);
      while (match !== null) {
        const specifier = match[1] ?? match[2];
        if (specifier !== undefined) {
          const offended = workspaceNames.find(
            (name) => specifier.startsWith(`${name}/`) && specifier !== name,
          );
          if (offended !== undefined) {
            violations.push({
              where: `${file.path}:${index + 1}`,
              message:
                `${file.path} imports "${specifier}"; import "${offended}" instead. The deep path ` +
                'does not exist in the tarball, because publishConfig swaps exports "." to ' +
                './dist/index.js, so this works in development and fails at runtime for anyone who ' +
                'installs the package. Deep imports also turn every internal file into public API.',
            });
          }
        }
        match = DEEP_IMPORT_SPECIFIER.exec(line);
      }
    }
  }

  return violations;
}

/**
 * EPIC-01-S4: `corepack enable` works today on Node 24 and breaks the moment
 * anyone moves to a current Node, which is exactly the "a colleague installs it
 * unaided" scenario.
 */
export function checkNoCorepack(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (/corepack\s+enable/.test(line)) {
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} line ${index + 1} runs "corepack enable". Corepack was removed from ` +
            'Node 25+ distributions by TSC vote in March 2025 and is bundled only through Node 24, ' +
            'so this works today and reports "corepack: command not found" on any current Node. ' +
            'Install pnpm with "npm i -g pnpm@11" or pnpm/action-setup@v6; the packageManager ' +
            'field is still read by pnpm as a version assertion.',
        });
      }
    }
  }
  return violations;
}

export interface TsconfigFile {
  /** Repo-relative path of the tsconfig.json. */
  readonly path: string;
  readonly json: { readonly compilerOptions?: { readonly paths?: unknown } };
}

/**
 * AC6 / EPIC-01-S8: no tsconfig, anywhere, ever declares "paths". D4's
 * rewriteRelativeImportExtensions does not rewrite through a paths alias
 * (microsoft/TypeScript#61991), so an aliased specifier survives into the
 * emitted JavaScript and the published bundle fails at runtime with a
 * module-not-found — a failure invisible in development, because in
 * development the .ts file genuinely exists.
 */
export function checkNoPathsAlias(tsconfigs: readonly TsconfigFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const tsconfig of tsconfigs) {
    if (tsconfig.json.compilerOptions?.paths !== undefined) {
      violations.push({
        where: tsconfig.path,
        message:
          `${tsconfig.path} declares "compilerOptions.paths". rewriteRelativeImportExtensions ` +
          'does not rewrite through a paths alias (microsoft/TypeScript#61991), so an aliased ' +
          "specifier like \"@/patch.ts\" survives into the emitted JavaScript and the published " +
          'bundle fails at runtime with a module-not-found. It works in development only because ' +
          'the .ts file genuinely exists there. See docs/16-repo-layout.md §6.',
      });
    }
  }
  return violations;
}

const RELATIVE_IMPORT_SPECIFIER =
  /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]|require\(\s*['"](\.[^'"]*)['"]\s*\)/g;

/**
 * AC8 / EPIC-01-S8: every relative import under packages/*\/src carries an
 * explicit .ts extension. allowImportingTsExtensions + rewriteRelativeImportExtensions
 * rewrite ".ts" to ".js" on emit while "node src/main.ts" runs the source
 * directly; an extensionless relative specifier is rejected outright by
 * "nodenext" resolution.
 */
export function checkRelativeImportsHaveTsExtension(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      RELATIVE_IMPORT_SPECIFIER.lastIndex = 0;
      let match: RegExpExecArray | null = RELATIVE_IMPORT_SPECIFIER.exec(line);
      while (match !== null) {
        const specifier = match[1] ?? match[2];
        if (specifier !== undefined && !specifier.endsWith('.ts') && !specifier.endsWith('.json')) {
          violations.push({
            where: `${file.path}:${index + 1}`,
            message:
              `${file.path} imports "${specifier}" with no ".ts" extension. "nodenext" module ` +
              'resolution rejects an extensionless relative specifier, and ' +
              'rewriteRelativeImportExtensions only rewrites specifiers that already end in ".ts" ' +
              'to ".js" on emit — add the explicit ".ts" suffix.',
          });
        }
        match = RELATIVE_IMPORT_SPECIFIER.exec(line);
      }
    }
  }
  return violations;
}

/**
 * EPIC-01-S7 scenario 3: there is no flag that would make banned syntax run.
 * "--experimental-transform-types" was removed in Node 26.0.0; if it still
 * appears anywhere it is either dead configuration or someone reaching for an
 * escape hatch that no longer exists.
 */
export function checkNoTransformTypesFlag(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.includes('--experimental-transform-types')) {
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} line ${index + 1} passes "--experimental-transform-types". The flag was ` +
            'removed in Node 26.0.0 and there is no replacement — erasableSyntaxOnly is permanent ' +
            '(D4), not a preference that a flag can work around.',
        });
      }
    }
  }
  return violations;
}

/** Render violations into an assertion message that names every offender. */
export function describe(violations: readonly Violation[]): string {
  return violations.map((v) => `- ${v.where}: ${v.message}`).join('\n');
}
