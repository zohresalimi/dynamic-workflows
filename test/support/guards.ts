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
  readonly scripts?: Record<string, string>;
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
    const consumerDir =
      manifest.path === 'package.json' ? '.' : manifest.path.replace(/\/package\.json$/, '');
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

/** Fenced-code languages whose contents are commands somebody will paste and run. */
const EXECUTABLE_FENCE_LANGUAGES = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'console',
  'yaml',
  'yml',
  'dockerfile',
]);

/**
 * EPIC-01-S4, KAR-01.6 AC8: `corepack enable` works today on Node 24 and breaks
 * the moment anyone moves to a current Node, which is exactly the "a colleague
 * installs it unaided" scenario.
 *
 * AC8 widens this from the workflows to the whole of `docs/`, which is why the
 * rule is about instructions rather than about the string. Every mention in
 * `docs/` today is a *prohibition* — "Do not use `corepack enable`" — and a
 * grep that fires on those would force the documentation to stop naming the
 * footgun, which is the opposite of the point. So prose may say it; a shell or
 * YAML block, which is what a reader copies, may not.
 */
export function checkNoCorepack(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const prose = file.path.endsWith('.md');
    let fenceLanguage: string | undefined;
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (prose) {
        const fence = /^\s*(?:```+|~~~+)\s*([A-Za-z0-9_+-]*)/.exec(line);
        if (fence !== null) {
          fenceLanguage = fenceLanguage === undefined ? (fence[1] ?? '').toLowerCase() : undefined;
          continue;
        }
        if (fenceLanguage === undefined || !EXECUTABLE_FENCE_LANGUAGES.has(fenceLanguage)) continue;
      }
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
          'specifier like "@/patch.ts" survives into the emitted JavaScript and the published ' +
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
 *
 * ".vue" and ".json" are explicit extensions that Vite and vue-tsc resolve
 * directly, so they satisfy the rule the guard actually enforces: never leave
 * the extension off.
 */
const EXPLICIT_RELATIVE_EXTENSIONS = ['.ts', '.json', '.vue'] as const;

export function checkRelativeImportsHaveTsExtension(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      RELATIVE_IMPORT_SPECIFIER.lastIndex = 0;
      let match: RegExpExecArray | null = RELATIVE_IMPORT_SPECIFIER.exec(line);
      while (match !== null) {
        const specifier = match[1] ?? match[2];
        const explicit =
          specifier !== undefined &&
          EXPLICIT_RELATIVE_EXTENSIONS.some((extension) => specifier.endsWith(extension));
        if (specifier !== undefined && !explicit) {
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

/* -------------------------------------------------------------------------- *
 * KAR-01.3 — the one-command dev loop (D10, ADR 0011)
 * -------------------------------------------------------------------------- */

/**
 * The three documented consequences of proxying SSE through Vite's dev server,
 * each paired with why it is fatal for DeFlow specifically. EPIC-01-S13 asserts
 * that the guard's failure message restates all three, because a bare "no
 * proxies" rule is exactly the kind of rule that gets deleted by whoever next
 * finds the daemon restart slow.
 *
 * Sources: vitejs/vite#12157, vitejs/vite discussion #10851,
 * docs/03-local-development.md §4.3.
 */
export const VITE_PROXY_CONSEQUENCES: readonly (readonly [string, string])[] = [
  [
    'events buffer until the stream ends',
    'the live plan graph would appear frozen for hours and then flood',
  ],
  [
    'the stream dies after some minutes',
    'runs are measured in hours, so the dev loop could not exercise the core use case',
  ],
  [
    'close events do not propagate',
    'leaked subscriptions per reload, and the backpressure path never gets tested',
  ],
];

const PROXY_KEY = /(?:^|[\s{,;([])proxy\s*:/;
const SERVER_PROXY = /server\s*\.\s*proxy/;

/**
 * AC7 / EPIC-01-S13: neither the string "server.proxy" nor a "proxy:" key may
 * appear in any Vite config or package source. The UI is served by the daemon
 * (D10); a proxy reintroduces the entire class of bug ADR 0011 exists to
 * delete.
 *
 * Scope is deliberately code, not prose: docs/03-local-development.md §4.3 and
 * ADR 0011 both quote "server.proxy" in order to forbid it, and a guard that
 * fires on its own justification is a guard that gets deleted.
 */
export function checkNoViteProxy(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  const consequences = VITE_PROXY_CONSEQUENCES.map(([mode, why]) => `  - ${mode} — ${why}`).join(
    '\n',
  );

  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      if (!SERVER_PROXY.test(line) && !PROXY_KEY.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message:
          `${file.path} line ${index + 1} configures a proxy. The UI is served by DeFlowd on the ` +
          "same origin (D10, ADR 0011), so there is nothing to proxy to. Vite's dev proxy is " +
          'documented-bad at SSE and all three failure modes land on the transport the whole UI ' +
          `depends on:\n${consequences}\n` +
          'The reverse-proxy settings in the API contract (timeout: 0, proxyTimeout: 0, ' +
          'X-Accel-Buffering: no, Cache-Control: no-cache, no-transform, no compression ' +
          'middleware) exist for anyone who later puts a reverse proxy in front of DeFlowd, not ' +
          'for the dev loop.',
      });
    }
  }
  return violations;
}

const DYNAMIC_VITE_IMPORT = /\bimport\s*\(\s*['"]vite['"]\s*\)/;
const STATIC_VITE_IMPORT = /(?:from\s*['"]vite['"]|require\(\s*['"]vite['"]\s*\))/;
const DEV_FLAG_GUARD = /DeFlow_DEV\s*===\s*['"]1['"]/;

/**
 * AC8: `vite` is imported dynamically, and only under the DeFlow_DEV === '1'
 * branch. Vite is a devDependency; a static import would drag it into the one
 * published tarball, where it is both dead weight and a runtime resolution
 * failure.
 */
export function checkViteImportIsDynamic(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    let dynamicImports = 0;
    for (const [index, line] of file.text.split('\n').entries()) {
      if (DYNAMIC_VITE_IMPORT.test(line)) {
        dynamicImports += 1;
        continue;
      }
      if (STATIC_VITE_IMPORT.test(line)) {
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} line ${index + 1} imports "vite" statically. Vite is a devDependency ` +
            'and must be reachable only through await import("vite") inside the ' +
            'DeFlow_DEV === "1" branch, so it can never enter the published bundle.',
        });
      }
    }
    if (dynamicImports > 0 && !DEV_FLAG_GUARD.test(file.text)) {
      violations.push({
        where: file.path,
        message:
          `${file.path} imports "vite" dynamically but contains no DeFlow_DEV === "1" guard. ` +
          'The dynamic import is only half the protection: without the env branch the published ' +
          'package still tries to resolve vite at runtime.',
      });
    }
  }
  return violations;
}

/**
 * AC5: pino-pretty is a dev-only pipe ("pnpm dev | pino-pretty"), never a
 * runtime transport. `transport: { target: 'pino-pretty' }` spawns a worker
 * thread inside DeFlowd, couples log formatting to the daemon and makes
 * production logs unparseable ndjson — see docs/13-observability-and-telemetry.md §1.
 */
export function checkPinoPrettyIsNotARuntimeTransport(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      if (!line.includes('pino-pretty')) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message:
          `${file.path} line ${index + 1} names "pino-pretty" in runtime source. pino-pretty is ` +
          'a dev-only pipe — "pnpm dev | pino-pretty" — and must never be wired as a pino ' +
          'transport: that spawns a worker thread inside DeFlowd and makes production logs ' +
          'unparseable ndjson.',
      });
    }
  }
  return violations;
}

const STATE_PRESERVING_RELOADERS = [
  'nodemon',
  'tsx watch',
  'vite-node',
  'node-dev',
  '--hot',
  'webpack-dev-server',
];

const WATCH_PATH_FLAG = /--watch-path=(\S+)/g;

/**
 * AC1, AC3, AC4, AC5 and EPIC-01-S9 scenario 2, read off the root scripts block.
 *
 * The restart is the test (F4.2), so the dev script must run under
 * `node --watch` and must not be "fixed" into a reloader that preserves process
 * state. And it must not watch packages/web: the watch path and the Vite root
 * would overlap, so one .vue save would produce a daemon restart *and* an HMR
 * update, the SSE stream would drop, and the loop would be unusable while a run
 * is going (AC4, EPIC-01-S12).
 */
export function checkDevLoopScripts(root: PackageJson): Violation[] {
  const violations: Violation[] = [];
  const scripts = root.scripts ?? {};
  const dev = scripts.dev;

  if (dev === undefined) {
    return [{ where: 'package.json', message: 'the root package.json declares no "dev" script.' }];
  }

  if (!dev.includes('node --watch')) {
    violations.push({
      where: 'package.json',
      message:
        `scripts.dev is "${dev}" and does not run "node --watch". Every save must kill and ` +
        'restart DeFlowd: that is free, continuous, adversarial testing of F4.2 crash-resume, ' +
        'which is the single property most competing tools lack.',
    });
  }

  for (const reloader of STATE_PRESERVING_RELOADERS) {
    if (dev.includes(reloader)) {
      violations.push({
        where: 'package.json',
        message:
          `scripts.dev uses "${reloader}", which preserves process state across a save. Do not ` +
          '"fix" the restart with a hot-reload scheme — the restart is the test ' +
          '(docs/03-local-development.md §5).',
      });
    }
  }

  if (!dev.includes('DeFlow_DEV=1')) {
    violations.push({
      where: 'package.json',
      message:
        'scripts.dev does not set DeFlow_DEV=1, so the daemon would serve the production static ' +
        'branch and Vite would never be mounted.',
    });
  }

  WATCH_PATH_FLAG.lastIndex = 0;
  const watched: string[] = [];
  let match: RegExpExecArray | null = WATCH_PATH_FLAG.exec(dev);
  while (match !== null) {
    if (match[1] !== undefined) watched.push(match[1]);
    match = WATCH_PATH_FLAG.exec(dev);
  }

  if (watched.length === 0) {
    violations.push({
      where: 'package.json',
      message:
        'scripts.dev passes no --watch-path, so node watches only the files it loaded and a save ' +
        'in a package the daemon has not imported yet would be silently ignored.',
    });
  }

  const overlapping = watched.filter(
    (path) => path === 'packages' || path === 'packages/' || path.startsWith('packages/web'),
  );
  if (overlapping.length > 0) {
    violations.push({
      where: 'package.json',
      message:
        `scripts.dev watches ${overlapping.join(', ')}, which covers packages/web. The watch path ` +
        'and the Vite root would overlap, so one .vue save produces a daemon restart *and* an HMR ' +
        'update: the SSE stream drops and the loop becomes unusable while a run is going (AC4, ' +
        'EPIC-01-S12). List the daemon-side packages explicitly instead.',
    });
  }

  const envFile = /--env-file(?:-if-exists)?=(\S+)/.exec(dev);
  if (envFile?.[1] !== undefined && !envFile[1].startsWith('/')) {
    violations.push({
      where: 'package.json',
      message:
        `scripts.dev passes "--env-file...=${envFile[1]}", a relative path. Verified 2026-08-04 on ` +
        'Node 24.18.0: a relative env-file path combined with --watch/--watch-path makes the ' +
        "watcher react to writes anywhere under the working directory, so Vite's " +
        'node_modules/.vite/deps_temp_* churn restarts the daemon about twice a second, forever. ' +
        'The daemon loads .env in-process instead (packages/daemon/src/env.ts).',
    });
  }

  const pretty = scripts['dev:pretty'];
  if (pretty === undefined || !/\|\s*pino-pretty/.test(pretty)) {
    violations.push({
      where: 'package.json',
      message:
        `scripts["dev:pretty"] must pipe into pino-pretty ("pnpm dev | pino-pretty"), not wire it ` +
        'as a runtime transport. It is currently ' +
        (pretty === undefined ? 'missing.' : `"${pretty}".`),
    });
  }

  return violations;
}

/** Render violations into an assertion message that names every offender. */
export function describe(violations: readonly Violation[]): string {
  return violations.map((v) => `- ${v.where}: ${v.message}`).join('\n');
}

/* -------------------------------------------------------------------------- *
 * KAR-01.4 — the testing rules.
 *
 * Two notes on how these are written, because both are load-bearing.
 *
 * First, they are rules about *code*, so they run over the source with
 * whole-line comments blanked out. Without that, a file whose doc comment
 * explains why fake timers deadlock would be the rule's own first violation,
 * and the only way to document a rule would be to stop naming the thing it
 * bans.
 *
 * Second, `test/testing-hygiene.test.ts` points them at the whole TypeScript
 * tree, this file included. Each pattern below is built so it cannot match its
 * own source text — the escapes in `\bdefine` and `vi\.use` are what keep this
 * file out of its own results, and they must stay.
 * -------------------------------------------------------------------------- */

/**
 * The source with whole-line comments blanked out. Line *count* is preserved,
 * so line numbers computed from the result still refer to the real file.
 */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

export const VITEST_WORKSPACE_MESSAGE =
  'vitest.workspace.ts and defineWorkspace were REMOVED in Vitest 4, so any tutorial showing ' +
  'them is pre-3.2. The failure is not a clean error: the configuration is simply ignored and ' +
  'the run looks plausible over the wrong set of files. Use one root vitest.config.ts with ' +
  'test.projects.';

const WORKSPACE_FILE_NAME = /(^|\/)vitest\.workspace\.[cm]?ts$/;
const WORKSPACE_BUILDER_CALL = /\bdefineWorkspace\s*\(/;
const WORKSPACE_BUILDER_IMPORT = /import\s*(?:type\s*)?\{[^}]*\bdefineWorkspace\b[^}]*\}/;

/** AC1, EPIC-01-S18. */
export function checkNoVitestWorkspace(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (WORKSPACE_FILE_NAME.test(file.path)) {
      violations.push({ where: file.path, message: VITEST_WORKSPACE_MESSAGE });
      continue;
    }
    const code = codeOnly(file.text);
    if (WORKSPACE_BUILDER_CALL.test(code) || WORKSPACE_BUILDER_IMPORT.test(code)) {
      violations.push({ where: file.path, message: VITEST_WORKSPACE_MESSAGE });
    }
  }
  return violations;
}

/**
 * Files permitted to fake timers. Empty, and every addition is a decision: the
 * hard rule is that no test may fake timers while a child process is alive,
 * because @sinonjs/fake-timers freezes the event loop's timers, the child's real
 * I/O never arrives, and the spec deadlocks for the full slice timeout — passing
 * locally and hanging in CI.
 */
export const FAKE_TIMER_ALLOWLIST: readonly string[] = [];

const FAKE_TIMERS_CALL = /\bvi\.useFakeTimers\s*\(/;
const SCOPED_FAKE_TIMERS = /\bvi\.useFakeTimers\s*\(\s*\{[^}]*\btoFake\b/;

/** AC9, EPIC-01-S16. */
export function checkNoFakeTimers(
  files: readonly SourceFile[],
  allowlist: readonly string[],
): Violation[] {
  const permitted = new Set(allowlist);
  const violations: Violation[] = [];

  for (const file of files) {
    const code = codeOnly(file.text);
    if (!FAKE_TIMERS_CALL.test(code)) continue;

    if (!permitted.has(file.path)) {
      violations.push({
        where: file.path,
        message:
          'fakes timers, and is not on the allowlist. Time enters through the Clock port ' +
          '(now, sleep, setTimer) so a six-hour gate is exercised in microseconds; faking the ' +
          "event loop's timers instead freezes them, so a live child process's real I/O never " +
          'arrives and the spec deadlocks for the full slice timeout.',
      });
      continue;
    }

    if (!SCOPED_FAKE_TIMERS.test(code)) {
      violations.push({
        where: file.path,
        message:
          'is allowlisted to fake timers but does not scope toFake. Pass ' +
          "toFake: ['setTimeout', 'setInterval', 'Date'] so nextTick and queueMicrotask stay real.",
      });
    }
  }

  return violations;
}

const INTEGRATION_SPEC = /^packages\/[^/]+\/test\/integration\//;
const IN_MEMORY_DSN = /:memory:/;

/** AC10, EPIC-01-S19. */
export function checkNoInMemoryDatabases(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!INTEGRATION_SPEC.test(file.path)) continue;
    if (!IN_MEMORY_DSN.test(codeOnly(file.text))) continue;
    violations.push({
      where: file.path,
      message:
        'opens an in-memory database in an integration spec. It cannot exercise WAL, it cannot ' +
        'be reopened after a simulated crash, and it hides fsync and ordering bugs — which is to ' +
        'say it cannot test F4.2, the entire durability thesis. Open a file inside the tmpdir ' +
        'instead. An in-memory database is permitted only in a pure projection unit test.',
    });
  }
  return violations;
}

/** The identifier every git invocation in the testkit must pass as its env. */
export const HERMETIC_GIT_ENV = 'GIT_ENV';

const GIT_INVOCATION = /\b(execa|execaSync|spawn|spawnSync|execFile|execFileSync)\(\s*['"]git['"]/g;

/** The argument list of the call whose opening paren is at `open`, quotes and nesting respected. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const character = text[i] ?? '';
    if (quote !== '') {
      if (character === '\\') i += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/**
 * AC5, EPIC-01-S15. Without an isolated environment the developer's own
 * ~/.gitconfig (init.defaultBranch, commit.gpgsign, aliases, core.hooksPath)
 * silently changes test outcomes — the classic "passes locally, fails in CI"
 * and its equally confusing inverse.
 */
export function checkGitInvocationsAreHermetic(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const code = codeOnly(file.text);
    GIT_INVOCATION.lastIndex = 0;
    let match: RegExpExecArray | null = GIT_INVOCATION.exec(code);
    while (match !== null) {
      const open = code.indexOf('(', match.index);
      const args = callArguments(code, open);
      if (!/\benv\s*:/.test(args) || !args.includes(HERMETIC_GIT_ENV)) {
        const line = code.slice(0, match.index).split('\n').length;
        violations.push({
          where: `${file.path}:${line}`,
          message:
            `invokes git without passing ${HERMETIC_GIT_ENV}. Every git invocation in the testkit ` +
            'must pass the isolated environment — GIT_CONFIG_GLOBAL=/dev/null, ' +
            'GIT_CONFIG_SYSTEM=/dev/null and an explicit author/committer identity — or the ' +
            "developer's own global config decides what the test proves.",
        });
      }
      match = GIT_INVOCATION.exec(code);
    }
  }

  return violations;
}

const UNSUPPORTED_GIT_LIBRARIES = ['isomorphic-git', 'simple-git'] as const;

/** EPIC-01-S15 scenario 4. */
export function checkNoUnsupportedGitLibrary(manifests: readonly Manifest[]): Violation[] {
  const violations: Violation[] = [];
  for (const manifest of manifests) {
    for (const [name] of allDependencies(manifest.json)) {
      if (!(UNSUPPORTED_GIT_LIBRARIES as readonly string[]).includes(name)) continue;
      violations.push({
        where: manifest.path,
        message:
          `depends on "${name}". Neither library has any worktree support at all — ` +
          "isomorphic-git@1.40.0's full export list was enumerated at runtime and contains no " +
          'worktree function, and simple-git@3.36.0 has no worktree API either (verified ' +
          '2026-08-02) — and worktrees are F5.1. Shell out to the real git binary.',
      });
    }
  }
  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-01.5 — the lint and format pipeline: one owner per concern.
 * -------------------------------------------------------------------------- */

export interface BiomeConfig {
  readonly linter?: { readonly enabled?: boolean };
  readonly html?: {
    readonly experimentalFullSupportEnabled?: boolean;
    readonly formatter?: { readonly enabled?: boolean };
  };
}

/**
 * AC1, EPIC-01-S22 scenario 1: biome.json declares the ownership split rather
 * than relying on anyone trusting it. Biome's .vue support is off by default
 * and silently no-ops without the html block (EPIC-01-S22 scenario 3), and
 * "linter.enabled" must be false or oxlint and Biome's linter fight over the
 * same files (EPIC-01-S22 scenario 4).
 */
export function checkBiomeOwnershipSplit(config: BiomeConfig): Violation[] {
  const violations: Violation[] = [];

  if (config.linter?.enabled !== false) {
    violations.push({
      where: 'biome.json',
      message:
        '"linter.enabled" must be false. oxlint is the linter for the Node packages; running ' +
        "Biome's linter alongside it over the same globs gives duplicate diagnostics and " +
        'autofixes that fight each other across runs.',
    });
  }
  if (config.html?.experimentalFullSupportEnabled !== true) {
    violations.push({
      where: 'biome.json',
      message:
        '"html.experimentalFullSupportEnabled" must be true. Without it "biome check" silently ' +
        'no-ops on every .vue file in packages/web — a green run and zero formatting.',
    });
  }
  if (config.html?.formatter?.enabled !== true) {
    violations.push({
      where: 'biome.json',
      message:
        '"html.formatter.enabled" must be true, or .vue files are parsed but the formatter never ' +
        'runs over them.',
    });
  }

  return violations;
}

/** AC2, AC3: the six type-aware rules a floating promise in a three-hour run needs. */
export const REQUIRED_TYPE_AWARE_RULES = [
  'typescript/no-floating-promises',
  'typescript/no-misused-promises',
  'typescript/await-thenable',
  'typescript/require-await',
  'typescript/no-unnecessary-condition',
  'typescript/no-unsafe-argument',
] as const;

/** AC2: the plugins the type-aware correctness rules and import hygiene need. */
export const REQUIRED_OXLINT_PLUGINS = ['typescript', 'unicorn', 'promise', 'import'] as const;

export interface OxlintConfig {
  readonly plugins?: readonly string[];
  readonly categories?: Record<string, string>;
  readonly rules?: Record<string, string>;
}

/**
 * AC2, EPIC-01-S20 background: the plugins, categories and the six rules a
 * floating promise in a three-hour run needs are turned on as errors, not
 * left to a preset that could silently downgrade or drop one of them.
 */
export function checkOxlintConfig(config: OxlintConfig): Violation[] {
  const violations: Violation[] = [];
  const plugins = config.plugins ?? [];

  for (const plugin of REQUIRED_OXLINT_PLUGINS) {
    if (!plugins.includes(plugin)) {
      violations.push({
        where: '.oxlintrc.json',
        message: `"plugins" is missing "${plugin}".`,
      });
    }
  }

  if (config.categories?.correctness !== 'error') {
    violations.push({
      where: '.oxlintrc.json',
      message: `"categories.correctness" must be "error", found ${JSON.stringify(config.categories?.correctness)}.`,
    });
  }
  if (config.categories?.suspicious !== 'warn') {
    violations.push({
      where: '.oxlintrc.json',
      message: `"categories.suspicious" must be "warn", found ${JSON.stringify(config.categories?.suspicious)}.`,
    });
  }

  for (const rule of REQUIRED_TYPE_AWARE_RULES) {
    if (config.rules?.[rule] !== 'error') {
      violations.push({
        where: '.oxlintrc.json',
        message:
          `"rules[\\"${rule}\\"]" must be "error", found ${JSON.stringify(config.rules?.[rule])}. ` +
          'A dropped rule here is a silently smaller correctness net than the design records.',
      });
    }
  }

  return violations;
}

/**
 * AC3, AC4: exactly one script formats and exactly one lints, and "lint" must
 * never carry "--write" — a lint job that rewrites files on every CI run
 * hides the very drift it exists to catch.
 */
export function checkLintFormatScripts(root: PackageJson): Violation[] {
  const violations: Violation[] = [];
  const scripts = root.scripts ?? {};
  const lint = scripts.lint;
  const format = scripts.format;

  if (lint === undefined || !lint.includes('oxlint') || !lint.includes('--type-aware')) {
    violations.push({
      where: 'package.json',
      message: `scripts.lint must run "oxlint --type-aware", found ${JSON.stringify(lint)}.`,
    });
  }
  if (lint === undefined || !/biome\s+check(?!\s+--write)/.test(lint)) {
    violations.push({
      where: 'package.json',
      message: `scripts.lint must also run "biome check ." (checking, not writing), found ${JSON.stringify(lint)}.`,
    });
  }
  if (format === undefined || !/biome\s+check\s+--write/.test(format)) {
    violations.push({
      where: 'package.json',
      message: `scripts.format must run "biome check --write .", found ${JSON.stringify(format)}.`,
    });
  }

  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-01.6 — git hooks and CI. Two files nobody reads until they misbehave.
 * -------------------------------------------------------------------------- */

export interface LefthookJob {
  readonly name?: string;
  readonly glob?: string;
  readonly run?: string;
  readonly stage_fixed?: boolean;
}

export interface LefthookHook {
  readonly parallel?: boolean;
  readonly jobs?: readonly LefthookJob[];
}

export interface LefthookConfig {
  readonly 'pre-commit'?: LefthookHook;
  readonly 'pre-push'?: LefthookHook;
}

/** KAR-00.6's artefact: the note that decides whether `.vue` may be auto-staged. */
export const VUE_SPIKE_NOTE = 'docs/spikes/S7-biome-vue.md';

export type VueStageFixedVerdict = 'safe' | 'not-safe' | 'unrecorded';

/**
 * AC2: `stage_fixed: true` reaches `.vue` only on a "safe" verdict from
 * KAR-00.6. "The note does not exist yet" and "the note says not safe" are the
 * same answer for the hook — no auto-staging — but they are different states of
 * the plan, so they are different values here.
 */
export function readVueStageFixedVerdict(noteText: string | undefined): VueStageFixedVerdict {
  if (noteText === undefined) return 'unrecorded';
  const match = /verdict[^\n]*?:\s*\**\s*(not safe|not-safe|unsafe|safe)/i.exec(noteText);
  if (match === null) return 'unrecorded';
  return /^safe$/i.test(match[1] ?? '') ? 'safe' : 'not-safe';
}

/** The extensions the format job must cover regardless of the `.vue` verdict. */
const FORMAT_EXTENSIONS = ['ts', 'json', 'jsonc', 'css', 'html'] as const;

/** Anything in this list in a pre-commit job is the two-second budget being spent. */
const PRE_COMMIT_FORBIDDEN = [
  ['--type-aware', 'type-aware linting needs a full type graph, whose cost is the repository'],
  ['pnpm lint', '"pnpm lint" is the type-aware pass over everything, wearing a shorter name'],
  ['typecheck', '"pnpm typecheck" builds every project and belongs on pre-push'],
  ['vitest', 'running specs at commit time is the pre-push job, not the pre-commit one'],
] as const;

/**
 * AC1 names `typecheck` and `unit`. `lint` is here because AC4 wants a floating
 * promise rejected before the code reaches a branch, and every one of the six
 * correctness rules that catches one is type-aware — which AC1 keeps out of
 * pre-commit. Pre-push is where those two criteria meet.
 */
const EXPECTED_PRE_PUSH_JOBS = [
  ['typecheck', 'pnpm typecheck'],
  ['lint', 'pnpm lint'],
  ['unit', 'pnpm vitest run --project unit'],
] as const;

/**
 * AC1, AC2, EPIC-01-S21 scenarios 3 and 4: the hook's whole value is that it is
 * fast enough never to be bypassed, so what it does *not* do is as much of the
 * contract as what it does.
 */
export function checkLefthookConfig(
  config: LefthookConfig,
  context: { readonly text: string; readonly verdict: VueStageFixedVerdict },
): Violation[] {
  const violations: Violation[] = [];
  const where = 'lefthook.yml';
  const preCommit = config['pre-commit'];
  const prePush = config['pre-push'];

  if (preCommit?.parallel !== true) {
    violations.push({
      where,
      message:
        '"pre-commit.parallel" must be true. Serialising the format and lint jobs roughly doubles ' +
        'the hook and there is no ordering between them to preserve — they read the same staged ' +
        'files and touch different concerns.',
    });
  }

  const jobs = preCommit?.jobs ?? [];
  const format = jobs.find((job) => job.name === 'format');
  const lint = jobs.find((job) => job.name === 'lint');

  if (format === undefined) {
    violations.push({ where, message: 'pre-commit has no job named "format".' });
  } else {
    if (!/biome\s+check\s+--write/.test(format.run ?? '')) {
      violations.push({
        where,
        message: `the "format" job must run "biome check --write", found ${JSON.stringify(format.run)}.`,
      });
    }
    if (!(format.run ?? '').includes('--no-errors-on-unmatched')) {
      violations.push({
        where,
        message:
          'the "format" job must pass "--no-errors-on-unmatched". Without it a commit whose ' +
          'staged files Biome does not handle fails the hook for no reason.',
      });
    }
    if (!(format.run ?? '').includes('{staged_files}')) {
      violations.push({
        where,
        message:
          'the "format" job must run over "{staged_files}". Formatting the whole repository at ' +
          'commit time is both slow and a way to commit changes nobody asked for.',
      });
    }
    if (format.stage_fixed !== true) {
      violations.push({
        where,
        message:
          '"stage_fixed: true" is missing from the "format" job. Without it the rewrite lands in ' +
          'the working tree but not the index, so the commit carries the unformatted bytes and ' +
          'CI\'s "biome ci ." fails on a commit that passed its own hook.',
      });
    }
    const glob = format.glob ?? '';
    for (const extension of FORMAT_EXTENSIONS) {
      if (!new RegExp(`[{,.]${extension}[},]`).test(glob)) {
        violations.push({
          where,
          message: `the "format" glob does not cover .${extension}, found ${JSON.stringify(glob)}.`,
        });
      }
    }
    const formatsVue = glob.includes('vue');
    if (formatsVue && context.verdict !== 'safe') {
      violations.push({
        where,
        message:
          'the "format" glob includes .vue, but ' +
          (context.verdict === 'unrecorded'
            ? `${VUE_SPIKE_NOTE} does not exist or records no verdict`
            : `${VUE_SPIKE_NOTE} records "not safe"`) +
          '. A "stage_fixed: true" hook auto-stages whatever Biome writes to an SFC, so the ' +
          'rewrite is in the commit before anyone reads it — which is why KAR-00.6 exists and ' +
          'why the gate is this way round.',
      });
    }
    if (!formatsVue && context.verdict === 'safe') {
      violations.push({
        where,
        message:
          `${VUE_SPIKE_NOTE} now records a "safe" verdict, so .vue belongs in the "format" glob. ` +
          'Leaving it out means .vue formatting is a manual step that will silently stop happening.',
      });
    }
    if (!formatsVue && !context.text.includes(VUE_SPIKE_NOTE)) {
      violations.push({
        where,
        message:
          `.vue is excluded from the "format" glob, so the reason must be a comment naming ` +
          `${VUE_SPIKE_NOTE} — an unexplained exclusion reads as an oversight and gets "fixed".`,
      });
    }
  }

  if (lint === undefined) {
    violations.push({ where, message: 'pre-commit has no job named "lint".' });
  } else {
    if (!(lint.run ?? '').includes('oxlint')) {
      violations.push({
        where,
        message: `the "lint" job must run oxlint, found ${JSON.stringify(lint.run)}.`,
      });
    }
    if (!(lint.run ?? '').includes('{staged_files}')) {
      violations.push({
        where,
        message: 'the "lint" job must run over "{staged_files}".',
      });
    }
    if (!(lint.run ?? '').includes('--no-error-on-unmatched-pattern')) {
      violations.push({
        where,
        message:
          'the "lint" job must pass "--no-error-on-unmatched-pattern". .oxlintrc.json ignores ' +
          'every test/ directory, and oxlint exits 1 with "No files found to lint" when its ' +
          'ignore patterns eat the whole argument list — so without the flag a test-only commit ' +
          'fails a hook it has no business failing, and you learn to reach for "--no-verify".',
      });
    }
    if (lint.glob !== '*.ts') {
      violations.push({
        where,
        message:
          `the "lint" glob must be "*.ts", found ${JSON.stringify(lint.glob)}. oxlint sees ` +
          'only the <script> block of an SFC, so pointing it at .vue buys a partial lint and the ' +
          'illusion of coverage.',
      });
    }
  }

  for (const job of jobs) {
    for (const [needle, why] of PRE_COMMIT_FORBIDDEN) {
      if ((job.run ?? '').includes(needle)) {
        violations.push({
          where,
          message:
            `the pre-commit job "${job.name}" runs "${needle}": ${why}. Keep pre-commit under ` +
            'about two seconds — the moment you type "--no-verify" the hooks stop existing, and ' +
            'you have paid the setup cost for nothing.',
        });
      }
    }
  }

  const pushJobs = prePush?.jobs ?? [];
  for (const [name, command] of EXPECTED_PRE_PUSH_JOBS) {
    const job = pushJobs.find((candidate) => candidate.name === name);
    if (job === undefined) {
      violations.push({
        where,
        message:
          `pre-push has no job named "${name}". What pre-commit refuses on budget grounds has to ` +
          'land somewhere before the branch does, or the budget is just a smaller net.',
      });
      continue;
    }
    if (!(job.run ?? '').includes(command)) {
      violations.push({
        where,
        message: `the pre-push "${name}" job must run "${command}", found ${JSON.stringify(job.run)}.`,
      });
    }
  }

  return violations;
}

/**
 * AC5, EPIC-01-S1: hooks that need a documented extra step after cloning are
 * hooks that are missing on every machine but the one they were written on.
 */
export function checkPrepareInstallsHooks(root: PackageJson): Violation[] {
  const violations: Violation[] = [];
  const prepare = root.scripts?.prepare;

  if (prepare === undefined || !/lefthook\s+install/.test(prepare)) {
    violations.push({
      where: 'package.json',
      message:
        `scripts.prepare must run "lefthook install", found ${JSON.stringify(prepare)}. pnpm runs ` +
        '"prepare" after every install, which is what makes the hooks appear on a fresh clone ' +
        'with no extra step in the README that nobody performs.',
    });
  }
  if (root.devDependencies?.lefthook !== 'catalog:') {
    violations.push({
      where: 'package.json',
      message: `devDependencies.lefthook must be "catalog:", found ${JSON.stringify(root.devDependencies?.lefthook)}.`,
    });
  }

  return violations;
}

/** The `${{ runner.temp }}` expression the test job pins TMPDIR to. */
export const RUNNER_TEMP_EXPRESSION = '${{ runner.temp }}';

/** AC6: verified against the marketplace on 2026-08-04 — see docs/CONTRIBUTING.md. */
export const PINNED_ACTIONS: Readonly<Record<string, string>> = {
  'actions/checkout': 'v5',
  'pnpm/action-setup': 'v6',
  'actions/setup-node': 'v6',
  'actions/upload-artifact': 'v4',
};

/** AC9, EPIC-01-S23: Node 24 is the Active LTS floor (D2); Node 26 is Current. */
export const EXPECTED_TEST_MATRIX = {
  os: ['ubuntu-26.04', 'macos-26'],
  node: ['24', '26'],
} as const;

export interface WorkflowStep {
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
}

export interface WorkflowJob {
  readonly 'runs-on'?: string;
  readonly env?: Record<string, string>;
  readonly strategy?: {
    readonly 'fail-fast'?: boolean;
    readonly matrix?: Record<string, readonly string[]>;
  };
  readonly steps?: readonly WorkflowStep[];
}

export interface CiWorkflow {
  readonly name?: string;
  readonly on?: unknown;
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: boolean };
  readonly jobs?: Record<string, WorkflowJob>;
}

/** Expands a `${{ matrix.x }}` template over a matrix, the way GitHub would. */
export function expandMatrixTemplate(
  template: string,
  matrix: { readonly [key: string]: readonly string[] },
): string[] {
  let expanded = [template];
  for (const [key, values] of Object.entries(matrix)) {
    const expression = new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, 'g');
    expanded = expanded.flatMap((candidate) =>
      values.map((value) => candidate.replace(expression, value)),
    );
  }
  return expanded;
}

const runsOf = (job: WorkflowJob | undefined): string =>
  (job?.steps ?? []).map((step) => step.run ?? '').join('\n');

/**
 * The contexts GitHub evaluates in a job *header* — `env`, `runs-on`, `if`,
 * `strategy`, `timeout-minutes`, `container`. Everything a step can see and a
 * job header cannot (`runner`, `steps`, `job`, `env` itself) is absent by
 * design: those values do not exist until a runner has been assigned, which
 * happens after the header has been evaluated.
 *
 * https://docs.github.com/actions/reference/workflows-and-actions/contexts
 */
export const JOB_LEVEL_CONTEXTS = [
  'github',
  'needs',
  'strategy',
  'matrix',
  'vars',
  'secrets',
  'inputs',
] as const;

/**
 * Every `${{ … }}` expression in a value, however deeply nested, each tagged
 * with the dotted key path it was found at — a job header can carry a dozen
 * environment variables, and "one of them is wrong" is not a fixable report.
 */
function expressionsIn(value: unknown, path: string): { path: string; expression: string }[] {
  if (typeof value === 'string') {
    return [...value.matchAll(/\$\{\{([^}]*)\}\}/g)].map((match) => ({
      path,
      expression: match[1] ?? '',
    }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => expressionsIn(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) =>
      expressionsIn(nested, `${path}.${key}`),
    );
  }
  return [];
}

/**
 * AC12. A job header that names a step-only context does not produce a red job
 * — it produces a run with **zero jobs**, because GitHub rejects the workflow
 * file before it schedules anything ("Unrecognized named-value"). That is the
 * one failure mode every other guard in this file is blind to: they parse the
 * YAML, and the YAML is perfectly valid. Measured, on the first push of this
 * workflow: `env: TMPDIR: ${{ runner.temp }}` at job level, run 30913790575,
 * failed in six seconds with nothing to look at. AC12 wants a green run's wall
 * clock, and a workflow that cannot start can never produce one.
 */
export function checkJobLevelContexts(workflow: CiWorkflow, where: string): Violation[] {
  const violations: Violation[] = [];
  const allowed = new Set<string>(JOB_LEVEL_CONTEXTS);

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const [field, value] of Object.entries(job)) {
      if (field === 'steps') {
        continue; // Steps run on a runner, so `runner.*` and `steps.*` are legal there.
      }
      for (const { path, expression } of expressionsIn(value, field)) {
        for (const [, context] of expression.matchAll(/\b([a-zA-Z_][\w-]*)\s*\./g)) {
          if (context === undefined || allowed.has(context)) {
            continue;
          }
          violations.push({
            where,
            message:
              `job "${jobName}" uses "\${{ ${expression.trim()} }}" in "${path}", but ` +
              `"${context}" is not one of the contexts a job header may name ` +
              `(${JOB_LEVEL_CONTEXTS.join(', ')}). GitHub rejects the whole file at parse time, ` +
              'so the run finishes in seconds with zero jobs and no logs — not one red job. Move ' +
              'the value onto the step that needs it, where the runner contexts exist.',
          });
        }
      }
    }
  }

  return violations;
}

/** AC12's budget, in seconds. Ten minutes is the point a push loop stops being one. */
export const CI_RUNTIME_BUDGET_SECONDS = 600;

/**
 * AC12, second half: "measured **and recorded**".
 *
 * The number is GitHub-hosted runner wall clock, so no assertion can produce it
 * from a laptop — the measurements table in docs/CONTRIBUTING.md is the record,
 * and this is what keeps that record honest. It fails three ways: a row that
 * never got a number (the state the story shipped in, and the state it would
 * quietly return to), a number with no run behind it (unciteable, therefore
 * uncheckable), and a number that is over budget (recorded, and ignored).
 */
export function checkRecordedCiRuntime(contributing: string): Violation[] {
  const where = 'docs/CONTRIBUTING.md';
  const row = contributing
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes('Full CI run'));
  if (row === undefined) {
    return [
      {
        where,
        message:
          'the measurements table has no "Full CI run on a green commit" row. AC12 asks for that ' +
          'number to be measured and recorded, and this table is where it is recorded.',
      },
    ];
  }

  const measured = row.split('|').at(-2) ?? '';
  const duration = /(?:(\d+)\s*min\s*)?(\d+)\s*s\b/.exec(measured);
  if (duration === null) {
    return [
      {
        where,
        message:
          `the "Full CI run" row records no duration (${measured.trim()}). AC12 is not met by a ` +
          'placeholder: the run has to happen on hosted runners and the wall clock has to land ' +
          'here.',
      },
    ];
  }
  if (!/run\s*\d{6,}|actions\/runs\/\d+/.test(measured)) {
    return [
      {
        where,
        message:
          'the "Full CI run" row records a duration but names no run. A number nobody can look ' +
          'up is a claim, not a measurement — cite the workflow run id it came from.',
      },
    ];
  }

  const seconds = Number(duration[1] ?? 0) * 60 + Number(duration[2]);
  if (seconds >= CI_RUNTIME_BUDGET_SECONDS) {
    return [
      {
        where,
        message:
          `the recorded CI wall clock is ${seconds} s, at or over AC12's ` +
          `${CI_RUNTIME_BUDGET_SECONDS} s budget. Recording a number that breaks the budget is ` +
          'not satisfying the criterion; the fix is almost certainly caching rather than the ' +
          'test slices.',
      },
    ];
  }

  return [];
}

/**
 * AC12. `pnpm exec <bin>` resolves against `node_modules/.bin` of the package it
 * runs in, and that directory is a *cache*: on a machine where a dependency was
 * once installed at the root, its shim survives every later manifest change. So
 * a workflow step can run for months on the author's laptop and fail on the
 * first clean `--frozen-lockfile` install with "Command not found" — which is
 * the only kind of machine CI ever is. Measured: run 30914294996, `browser-e2e`,
 * `pnpm exec playwright` against a root manifest that has never declared
 * playwright (it belongs to packages/web).
 *
 * The rule is deliberately narrow: the binary must be *declared* by the
 * manifest the command runs in. Mapping a binary name to the package that
 * provides it is not decidable from manifests alone, so a name that matches no
 * declared dependency anywhere is reported as unresolvable rather than guessed
 * at.
 */
export function checkWorkflowExecutablesAreDeclared(
  workflow: CiWorkflow,
  where: string,
  manifests: readonly Manifest[],
): Violation[] {
  const violations: Violation[] = [];
  const declaredBy = (manifest: Manifest | undefined): Set<string> =>
    new Set(DEPENDENCY_BLOCKS.flatMap((block) => Object.keys(manifest?.json[block] ?? {})));
  const root = manifests.find((manifest) => manifest.path === 'package.json');

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      for (const line of (step.run ?? '').split('\n')) {
        const match = /^\s*pnpm\s+(?:--filter\s+(\S+)\s+)?exec\s+(\S+)/.exec(line);
        if (match === null) {
          continue;
        }
        const [, filter, binary = ''] = match;
        const target =
          filter === undefined ? root : manifests.find((manifest) => manifest.json.name === filter);
        if (declaredBy(target).has(binary)) {
          continue;
        }
        const provider = manifests.find((manifest) => declaredBy(manifest).has(binary));
        violations.push({
          where,
          message:
            `job "${jobName}" runs "pnpm ${filter === undefined ? '' : `--filter ${filter} `}` +
            `exec ${binary}", but ${filter ?? 'the workspace root'} does not declare ` +
            `"${binary}" — ` +
            (provider === undefined
              ? 'and no package in the workspace declares it either, so this step cannot resolve ' +
                'on any machine that installed from the lockfile.'
              : `${provider.json.name ?? provider.path} does. Run it as ` +
                `"pnpm --filter ${provider.json.name ?? provider.path} exec ${binary} …". ` +
                'A stale shim in the root node_modules/.bin hides this locally: it resolves on ' +
                'the machine that wrote the step and fails on the first clean install.'),
        });
      }
    }
  }

  return violations;
}

/**
 * AC6, AC9, AC10, EPIC-01-S23: the workflow is the one file in this repository
 * that only ever executes on machines you do not have, so every property worth
 * having is asserted here rather than discovered from a red build.
 */
export function checkCiWorkflow(workflow: CiWorkflow, where: string): Violation[] {
  const violations: Violation[] = [];
  const jobs = workflow.jobs ?? {};

  if (workflow.concurrency?.group !== 'ci-${{ github.ref }}') {
    violations.push({
      where,
      message: `concurrency.group must be "ci-\${{ github.ref }}", found ${JSON.stringify(workflow.concurrency?.group)}.`,
    });
  }
  if (workflow.concurrency?.['cancel-in-progress'] !== true) {
    violations.push({
      where,
      message:
        'concurrency.cancel-in-progress must be true, or a fast follow-up push queues behind a run ' +
        'whose result nobody will read.',
    });
  }

  for (const name of ['check', 'test', 'browser-e2e']) {
    if (jobs[name] === undefined) violations.push({ where, message: `job "${name}" is missing.` });
  }

  // Every action is pinned to the tag that was checked against the marketplace.
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses === undefined) continue;
      const [action, tag] = step.uses.split('@');
      const expected = PINNED_ACTIONS[action ?? ''];
      if (expected === undefined) {
        violations.push({
          where,
          message: `job "${jobName}" uses "${step.uses}", which is not in the pinned set.`,
        });
        continue;
      }
      if (tag !== expected) {
        violations.push({
          where,
          message: `job "${jobName}" uses "${step.uses}"; the verified pin is "${action}@${expected}".`,
        });
      }
    }
  }

  // setup-node: the Node the toolchain floor names, and pnpm's store cached.
  for (const [jobName, job] of Object.entries(jobs)) {
    const setup = (job.steps ?? []).find((step) => step.uses?.startsWith('actions/setup-node'));
    if (setup === undefined) {
      violations.push({ where, message: `job "${jobName}" never sets up Node.` });
      continue;
    }
    if (setup.with?.cache !== 'pnpm') {
      violations.push({
        where,
        message: `job "${jobName}" must set "cache: pnpm" on actions/setup-node.`,
      });
    }
    const nodeVersion = String(setup.with?.['node-version'] ?? '');
    const expectedVersion = jobName === 'test' ? '${{ matrix.node }}' : '24';
    if (nodeVersion !== expectedVersion) {
      violations.push({
        where,
        message: `job "${jobName}" must set "node-version: ${expectedVersion}", found ${JSON.stringify(nodeVersion)}.`,
      });
    }
  }

  const check = jobs.check;
  if (check !== undefined) {
    if (check['runs-on'] !== 'ubuntu-26.04') {
      violations.push({
        where,
        message: `job "check" must run on ubuntu-26.04, found ${JSON.stringify(check['runs-on'])}.`,
      });
    }
    for (const command of ['pnpm biome ci .', 'pnpm oxlint --type-aware', 'pnpm typecheck']) {
      if (!runsOf(check).includes(command)) {
        violations.push({ where, message: `job "check" must run "${command}".` });
      }
    }
  }

  const test = jobs.test;
  if (test !== undefined) {
    if (test.strategy?.['fail-fast'] !== false) {
      violations.push({
        where,
        message:
          'the test matrix must set "fail-fast: false". With it on, the first failing leg cancels ' +
          'the other three, so a macOS-only bug and a repo-wide bug look identical.',
      });
    }
    for (const [key, expected] of Object.entries(EXPECTED_TEST_MATRIX)) {
      const actual = (test.strategy?.matrix?.[key] ?? []).map(String);
      if (JSON.stringify(actual) !== JSON.stringify([...expected])) {
        violations.push({
          where,
          message: `the test matrix "${key}" must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`,
        });
      }
    }
    if (test['runs-on'] !== '${{ matrix.os }}') {
      violations.push({
        where,
        message: `job "test" must run on "\${{ matrix.os }}", found ${JSON.stringify(test['runs-on'])}.`,
      });
    }
    if (!runsOf(test).includes('pnpm vitest run --project unit --project integration')) {
      violations.push({
        where,
        message: 'job "test" must run "pnpm vitest run --project unit --project integration".',
      });
    }
    // Both of these are asserted on the *step*, not the job. `runner.temp` is
    // not a context a job header may name (checkJobLevelContexts), so demanding
    // them one level up is demanding a workflow GitHub refuses to run at all.
    const vitest = (test.steps ?? []).find((step) => step.run?.startsWith('pnpm vitest run'));
    if (vitest?.env?.DeFlow_KEEP_TMP !== '1') {
      violations.push({
        where,
        message:
          'the vitest step in job "test" must set DeFlow_KEEP_TMP: "1". Without it the fixture ' +
          'deletes its tmpdir on the way out and the upload step has nothing to collect.',
      });
    }
    if (vitest?.env?.TMPDIR !== RUNNER_TEMP_EXPRESSION) {
      violations.push({
        where,
        message:
          `the vitest step in job "test" must set TMPDIR: "${RUNNER_TEMP_EXPRESSION}". ` +
          'os.tmpdir() is /tmp on the Linux runners and /var/folders/…/T on the macOS ones, so a ' +
          'fixed /tmp upload path matches nothing on exactly the two legs whose failures you ' +
          'cannot reproduce locally.',
      });
    }
    const upload = (test.steps ?? []).find((step) => step.uses?.includes('upload-artifact'));
    if (upload === undefined) {
      violations.push({ where, message: 'job "test" never uploads the tmpdir artefact.' });
    } else {
      if (upload.if !== 'failure()') {
        violations.push({
          where,
          message: `the upload step must be "if: failure()", found ${JSON.stringify(upload.if)}.`,
        });
      }
      const name = upload.with?.name ?? '';
      const names = expandMatrixTemplate(name, EXPECTED_TEST_MATRIX);
      if (new Set(names).size !== 4) {
        violations.push({
          where,
          message:
            `the artefact name ${JSON.stringify(name)} expands to ${new Set(names).size} distinct ` +
            'names across the four legs. Two legs uploading under one name is one leg losing its ' +
            'evidence, and it is the failing leg you will want.',
        });
      }
    }
  }

  const browser = jobs['browser-e2e'];
  if (browser !== undefined) {
    if (browser['runs-on'] !== 'ubuntu-26.04') {
      violations.push({
        where,
        message:
          `job "browser-e2e" must run on ubuntu-26.04 only, found ${JSON.stringify(browser['runs-on'])} — ` +
          'a browser job on the macOS legs triples macOS minutes for no extra signal.',
      });
    }
    for (const command of [
      // Filtered to the package that declares playwright — see
      // checkWorkflowExecutablesAreDeclared for why the root form cannot work.
      'pnpm --filter @DeFlow/web exec playwright install --with-deps chromium',
      'pnpm vitest run --project web --project e2e',
    ]) {
      if (!runsOf(browser).includes(command)) {
        violations.push({ where, message: `job "browser-e2e" must run "${command}".` });
      }
    }
  }

  return violations;
}

/**
 * AC7, EPIC-01-S24 scenario 4. The cheapest control in the epic: an unpinned
 * runner image is an operating-system and architecture change that lands under
 * you without a commit.
 */
export function checkRunnerImagesArePinned(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      const match = /([A-Za-z0-9_.-]+-latest)/.exec(line);
      if (match === null) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message:
          `${file.path} line ${index + 1} names "${match[1]}". Pin the image: "macos-latest" ` +
          'migrated to macOS 26 on Apple Silicon between 8 and 15 June 2026, and an implicit ' +
          'architecture change shifts native module prebuilds, node-pty behaviour and filesystem ' +
          'case-sensitivity all at once. Use ubuntu-26.04 and macos-26.',
      });
    }
  }
  return violations;
}

/**
 * AC11, EPIC-01-S23 last scenario. The strategy document's example workflow
 * includes a crash-fuzz step, and copying it produces a red build on the first
 * commit because the project has nothing to run until EPIC-03 adds it.
 */
export function checkNoCrashFuzzProject(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      if (!/--project\s+crash-fuzz/.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message:
          `${file.path} line ${index + 1} references "--project crash-fuzz", which does not exist ` +
          'yet — vitest.config.ts holds a deliberately empty slot for it. EPIC-03 adds the project ' +
          'and this step together; until then this is a red build on every commit.',
      });
    }
  }
  return violations;
}

/**
 * AC10, EPIC-01-S24 scenario 2: the CI artefact glob is only worth as much as
 * the directories it matches, and on the Linux legs it is case-sensitive. A
 * spec whose tmpdir is named anything else uploads nothing when it fails —
 * silently, because `upload-artifact` treats an empty match as a warning rather
 * than an error. The one thing worse than no evidence is believing you have it.
 *
 * Only literal prefixes are judged: a `mkdtemp` whose prefix is a variable is
 * the shared fixture, or something this guard has no way to evaluate.
 */
export function checkTempDirPrefixes(
  files: readonly SourceFile[],
  requiredPrefix: string,
): Violation[] {
  const violations: Violation[] = [];
  const call = /mkdtemp(?:Sync)?\s*\(\s*join\s*\(\s*tmpdir\(\)\s*,\s*(['"`])([^'"`]*)\1/g;

  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      call.lastIndex = 0;
      let match = call.exec(line);
      while (match !== null) {
        const prefix = match[2] ?? '';
        if (!prefix.startsWith(requiredPrefix)) {
          violations.push({
            where: `${file.path}:${index + 1}`,
            message:
              `${file.path} line ${index + 1} creates a temp directory named "${prefix}…". It must ` +
              `start with "${requiredPrefix}", which is what CI's upload-artifact step globs for ` +
              'after a failing matrix leg — and the glob is case-sensitive on the Linux runners. ' +
              'A directory outside it is a failure you cannot post-mortem from a platform you do ' +
              'not own, and upload-artifact will only warn that it matched nothing.',
          });
        }
        match = call.exec(line);
      }
    }
  }

  return violations;
}
