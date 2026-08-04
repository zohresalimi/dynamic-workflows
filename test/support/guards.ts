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
  const consequences = VITE_PROXY_CONSEQUENCES.map(
    ([mode, why]) => `  - ${mode} — ${why}`,
  ).join('\n');

  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      if (!SERVER_PROXY.test(line) && !PROXY_KEY.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message:
          `${file.path} line ${index + 1} configures a proxy. The UI is served by DeFlowd on the ` +
          'same origin (D10, ADR 0011), so there is nothing to proxy to. Vite\'s dev proxy is ' +
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
        'watcher react to writes anywhere under the working directory, so Vite\'s ' +
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
