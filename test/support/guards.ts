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
  // KAR-17.6 — the diff and review surface. Pre-1.0, and a caret here is how a
  // minor bump silently changes the surface an operator reviews a run on
  // (docs/12-frontend-architecture.md §6.7). `@git-diff-view/shiki` is
  // deliberately **not** installed; see `packages/web/src/lib/highlighter.ts`.
  '@git-diff-view/core': '0.1.7',
  '@git-diff-view/vue': '0.1.7',
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

/**
 * KAR-03.4 AC2 / EPIC-03-S11 scenario 3: `reduce()` has no read path to the
 * data plane.
 *
 * The control-plane / data-plane split is the reason DeFlow ships no snapshot
 * table, and the reason the F4.7 progress watermark is meaningful for free. It
 * survives only if the reducer *cannot* read `io_chunk` — not if it merely does
 * not today. So no file under `packages/core/src` may import `@DeFlow/ledger`
 * or a driver, and none may name the table: `reduce`'s input type is `Event`,
 * and a `Db` handle is not in scope inside @DeFlow/core at all.
 */
export function checkNoDataPlaneReachFromCore(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      const reaches =
        /['"]@DeFlow\/ledger['"]/.test(line) ||
        /['"]better-sqlite3['"]/.test(line) ||
        /\bio_chunk\b/.test(line);
      if (!reaches) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message:
          `${file.path} reaches for the data plane. @DeFlow/core folds an Event into RunState and ` +
          'holds no database: agent stdout lives in io_chunk and never touches the reducer, which ' +
          'is what keeps replay in milliseconds beside a 500,000-row data plane and what makes ' +
          'the progress watermark meaningful without a line of code written to make it so. ' +
          'Read io_chunk from @DeFlow/ledger or @DeFlow/daemon instead.',
      });
    }
  }
  return violations;
}

/**
 * KAR-03.4 AC5 / EPIC-03-S13 scenario 3: no `SELECT` over `event` or `io_chunk`
 * in `packages/ledger/src` without a `LIMIT`.
 *
 * better-sqlite3 is **fully synchronous**. One unbounded scan on the write
 * connection does not make one endpoint slow — it stops the event loop, and
 * every in-flight SSE stream and HTTP request in the daemon waits behind it.
 * The symptom is "the UI froze", which is about as far from "someone dropped a
 * LIMIT" as a symptom gets.
 *
 * Aggregate projections are exempt, and the reason is the same one that makes
 * the rule worth having: `count(*)`, `max(seq)` and `min(seq) … GROUP BY
 * run_id` return one row — one per run at worst — rather than one row per
 * event, so the result set cannot grow with the ledger and no cursor is left
 * open over it. What is banned is a read whose *size* is the ledger's size.
 */
export const SQL_AGGREGATE_PROJECTION = /\b(count|max|min|sum|avg|total)\s*\(/i;

/**
 * A read of **one** row by its primary key — `WHERE seq = ?` on `event`, whose
 * `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`.
 *
 * Exempt from both rules here for the same reason the aggregates are, and it is
 * worth stating rather than pattern-matching on faith: the result set is one
 * row by the schema's own uniqueness, so its size cannot grow with the ledger,
 * it holds no cursor and it hands nobody a `seq` to resume from. A `LIMIT 1`
 * bolted on would be decoration, and requiring `seq > ?` of it would be
 * requiring a *window* of a lookup that is asking about one specific event —
 * KAR-13.2's approval queue asks exactly that, once per queue row, to put an
 * age on it.
 */
export const SQL_PRIMARY_KEY_LOOKUP = /\bWHERE\s+seq\s*=\s*\?/i;

export function checkLedgerReadsAreBounded(files: readonly SourceFile[]): Violation[] {
  // SQL in this package lives in string or template literals, one statement each.
  const literals = /`[^`]*`|'(?:[^'\\\n]|\\.)*'/g;
  const violations: Violation[] = [];

  for (const file of files) {
    for (const literal of file.text.match(literals) ?? []) {
      const reads = /\bSELECT\b/i.test(literal) && /\bFROM\s+(event|io_chunk)\b/i.test(literal);
      if (!reads) continue;
      if (
        /\bLIMIT\b/i.test(literal) ||
        SQL_AGGREGATE_PROJECTION.test(literal) ||
        SQL_PRIMARY_KEY_LOOKUP.test(literal)
      ) {
        continue;
      }
      violations.push({
        where: file.path,
        message:
          `${file.path} reads ${/io_chunk/.test(literal) ? 'io_chunk' : 'event'} without a LIMIT: ` +
          `${literal.replace(/\s+/g, ' ').slice(0, 120)}. better-sqlite3 is fully synchronous, so ` +
          'an unbounded read on the write connection stalls every in-flight SSE stream and HTTP ' +
          'request in the daemon rather than making one query slow. Drain in bounded windows ' +
          '(src/drain.ts) — and never with a lazy iterate() cursor, which pins the WAL open.',
      });
    }
  }
  return violations;
}

/**
 * KAR-02.9 AC6 / EPIC-02-S8: `ohash` appears nowhere in `packages/core/src`.
 * `ohash`'s stable key-ordering behaviour is confirmed, but its README
 * promises only "best efforts" at stable serialisation — acceptable for
 * "did this object change since last render" in `@DeFlow/web`, wrong for a
 * value that is a primary key of the `plan` table and an identity across
 * daemon versions. `canonicalJson` (./packages/core/src/canonical-json.ts)
 * is the encoder core owns instead.
 */
export function checkNoOhashImport(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (/from\s+['"]ohash['"]/.test(line) || /require\(\s*['"]ohash['"]/.test(line)) {
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} imports "ohash". ohash's README promises only "best efforts" at ` +
            'stable serialisation, which is wrong for planHash/specHash/contentHash — values that ' +
            'are primary keys and identities across daemon versions. Use canonicalJson instead ' +
            '(packages/core/src/canonical-json.ts); ohash stays fine for change detection in ' +
            '@DeFlow/web.',
        });
      }
    }
  }
  return violations;
}

/**
 * R2. AC8 / EPIC-01-S5: only packages/cli may depend on @DeFlow/daemon.
 *
 * One exception, added by KAR-15.1 and narrower than it looks: `packages/web`
 * may carry the daemon as a **devDependency**, because
 * docs/11-api-and-realtime.md §9 makes `import type { ApiType } from
 * '@DeFlow/daemon'` the entire client contract — that import is what makes a
 * renamed daemon field break the UI build in the same commit. It is erased at
 * compile time, so no daemon code can reach the browser bundle, which is the
 * coupling R2 exists to prevent. A *runtime* dependency is still a violation,
 * and `checkWebImportsDaemonTypesOnly` is what stops the type-only import
 * quietly becoming a value one.
 */
export function checkDaemonIsLeaf(manifests: readonly Manifest[]): Violation[] {
  const violations: Violation[] = [];
  for (const manifest of manifests) {
    if (manifest.path === 'packages/cli/package.json') continue;

    const isWeb = manifest.path === 'packages/web/package.json';
    const blocks = isWeb
      ? (['dependencies', 'optionalDependencies', 'peerDependencies'] as const)
      : DEPENDENCY_BLOCKS;
    const dependsOnDaemon = blocks
      .flatMap((block) => entriesOf(manifest.json, block))
      .some(([name]) => name === '@DeFlow/daemon');

    if (dependsOnDaemon) {
      violations.push({
        where: manifest.path,
        message: isWeb
          ? `${manifest.path} depends on @DeFlow/daemon at runtime. The UI may only carry it as a ` +
            'type-only devDependency (docs/11-api-and-realtime.md §9): the contract is ' +
            '`import type { ApiType }`, and anything more puts daemon code in the browser bundle.'
          : `${manifest.path} depends on @DeFlow/daemon, but only packages/cli may. R2 keeps the ` +
            'daemon a leaf: if another package needs something from it, that something belongs in ' +
            '@DeFlow/core if it is pure, or is a port that daemon implements and injects if it is not.',
      });
    }
  }
  return violations;
}

/**
 * KAR-15.1 — the UI's import of the daemon is type-only, and stays type-only.
 *
 * The whole typed-client design rests on `packages/web` seeing the daemon's
 * route types (docs/11-api-and-realtime.md §9). It rests just as hard on that
 * being the *only* thing it sees: a value import would pull the Hono app, the
 * ledger and `better-sqlite3` into a Vite build, which fails loudly if you are
 * lucky and ships a second copy of the daemon's constants if you are not.
 */
export function checkWebImportsDaemonTypesOnly(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!file.path.startsWith('packages/web/')) continue;
    for (const [index, line] of file.text.split('\n').entries()) {
      if (!/from\s+['"]@DeFlow\/daemon(\/[^'"]*)?['"]/.test(line)) continue;
      if (/^\s*import\s+type\s/.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message:
          `${file.path}:${index + 1} imports @DeFlow/daemon as a value. The UI's dependency on ` +
          'the daemon is the route types and nothing else — write `import type`, so the import ' +
          'is erased and no daemon code can reach the browser bundle (R2, docs/11 §9).',
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
                "installs the package. index.ts is the package's contract: every package's " +
                'exports map exposes "." and nothing else, so deep imports also turn every ' +
                'internal file into public API.',
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
 * ".vue", ".json" and ".css" are explicit extensions that Vite and vue-tsc
 * resolve directly, so they satisfy the rule the guard actually enforces: never
 * leave the extension off. ".css" arrives with KAR-16.1 — `main.ts` imports the
 * one stylesheet for its side effect, which is how Tailwind 4 and the state
 * palette reach the page at all.
 */
const EXPLICIT_RELATIVE_EXTENSIONS = ['.ts', '.json', '.vue', '.css'] as const;

export function checkRelativeImportsHaveTsExtension(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      RELATIVE_IMPORT_SPECIFIER.lastIndex = 0;
      let match: RegExpExecArray | null = RELATIVE_IMPORT_SPECIFIER.exec(line);
      while (match !== null) {
        const specifier = match[1] ?? match[2];
        // Vite's resource queries — `?worker`, `?raw`, `?url` — come *after*
        // the extension, so `./elk.worker.ts?worker` (KAR-16.6 AC5) carries an
        // explicit `.ts` and still fails an `endsWith`. The rule is about the
        // extension being written down, not about it being the last character.
        const path = specifier?.split('?')[0];
        const explicit =
          path !== undefined &&
          EXPLICIT_RELATIVE_EXTENSIONS.some((extension) => path.endsWith(extension));
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
 * includes a `--project crash-fuzz` step, and copying it while vitest.config.ts
 * still held an empty slot for that project produced a red build on every
 * commit. The original guard therefore banned that one literal string.
 *
 * That ban expired the moment KAR-03.8 filled the slot, and it then did real
 * damage: it stood between the crash-fuzz suite and the CI job EPIC-06's
 * Definition of Done requires it to run in. What the ban was protecting is kept
 * here in the form that does not go stale — a workflow may name any vitest
 * project the runner config actually declares, and no others. Pass the declared
 * names in; do not restate them here, or this guard becomes the second place
 * the project list lives.
 */
export function checkWorkflowProjectsExist(
  files: readonly SourceFile[],
  declaredProjects: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  const known = new Set(declaredProjects);
  const named = /--project[=\s]+([A-Za-z0-9_./-]+)/g;

  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      // Only lines that actually invoke the runner. Prose about the flag is not
      // a step — but a *commented-out* vitest command still is, one keystroke
      // from being live, so the filter is the word "vitest" rather than "run:".
      if (!line.includes('vitest')) continue;
      named.lastIndex = 0;
      let match = named.exec(line);
      while (match !== null) {
        const project = match[1] ?? '';
        if (!known.has(project)) {
          violations.push({
            where: `${file.path}:${index + 1}`,
            message:
              `${file.path} line ${index + 1} runs "--project ${project}", which vitest.config.ts ` +
              `does not declare. The projects that exist are ${[...known].join(', ')}. A step ` +
              'naming a project that is only a slot is a red build on every commit, and the ' +
              'failure reads as a test failure rather than as a configuration one.',
          });
        }
        match = named.exec(line);
      }
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

/* -------------------------------------------------------------------------- *
 * KAR-04.1 — the mock agent is an independent oracle.
 * -------------------------------------------------------------------------- */

/** Any import or require specifier on a line, however it is spelled. */
const IMPORT_SPECIFIER =
  /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersIn(text: string): { line: number; specifier: string }[] {
  const found: { line: number; specifier: string }[] = [];
  for (const [index, line] of codeOnly(text).split('\n').entries()) {
    IMPORT_SPECIFIER.lastIndex = 0;
    let match = IMPORT_SPECIFIER.exec(line);
    while (match !== null) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined) found.push({ line: index + 1, specifier });
      match = IMPORT_SPECIFIER.exec(line);
    }
  }
  return found;
}

export const MOCK_AGENT_INDEPENDENCE_MESSAGE =
  'packages/mock-agent must import nothing from the workspace. If it imported @DeFlow/core, a bug ' +
  'in the domain model would be mirrored on both sides of the wire and cancel itself out — the ' +
  'mock would agree with the daemon about something they were both wrong about. It is an ' +
  'independent implementation of the agent side of the same published schema, and that is the ' +
  'only reason it is worth anything as an oracle (docs/07-provider-adapter-layer.md §13, ' +
  'docs/16-repo-layout.md R1).';

/**
 * EPIC-04-S21 scenario 1: no source under packages/mock-agent imports a
 * `@DeFlow/*` package. The manifest half of the same rule is
 * `checkMockAgentIsIndependent`; both are needed, because an import that the
 * manifest does not declare still resolves inside a pnpm workspace.
 */
export function checkNoWorkspaceImports(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const { line, specifier } of specifiersIn(file.text)) {
      if (specifier.startsWith('@DeFlow/')) {
        violations.push({
          where: `${file.path}:${line}`,
          message: `${file.path} imports "${specifier}". ${MOCK_AGENT_INDEPENDENCE_MESSAGE}`,
        });
      }
    }
  }
  return violations;
}

/**
 * The three deprecated renames of the ACP packages. All of them are what any
 * cached knowledge older than late 2025 names, and all three still install —
 * which is what makes this worth a guard rather than a comment.
 */
export const DEPRECATED_ACP_PACKAGES = [
  '@zed-industries/agent-client-protocol',
  '@zed-industries/claude-code-acp',
  '@zed-industries/codex-acp',
] as const;

/**
 * EPIC-04-S21 scenario 2: the deprecated packages are unreachable, in source
 * and in every manifest. The SDK went 0.4.5 -> 1.3.0 and changed npm scope *and*
 * GitHub org inside about ten months; a stray old name resolves to a real
 * package that speaks an older protocol, so the failure is a subtle wire
 * mismatch rather than a missing module.
 */
export function checkNoDeprecatedAcpPackages(
  files: readonly SourceFile[],
  manifests: readonly Manifest[],
): Violation[] {
  const violations: Violation[] = [];
  const deprecated: readonly string[] = DEPRECATED_ACP_PACKAGES;

  for (const file of files) {
    for (const { line, specifier } of specifiersIn(file.text)) {
      const offended = deprecated.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (offended !== undefined) {
        violations.push({
          where: `${file.path}:${line}`,
          message:
            `${file.path} imports "${specifier}", a deprecated rename. The supported package is ` +
            '@agentclientprotocol/sdk, pinned exactly at 1.3.0 in the catalog.',
        });
      }
    }
  }

  for (const manifest of manifests) {
    for (const block of DEPENDENCY_BLOCKS) {
      for (const [name] of entriesOf(manifest.json, block)) {
        if (deprecated.includes(name)) {
          violations.push({
            where: manifest.path,
            message:
              `${manifest.path} declares "${name}" in ${block}. The supported package is ` +
              '@agentclientprotocol/sdk, pinned exactly at 1.3.0 in the catalog.',
          });
        }
      }
    }
  }

  return violations;
}

/** Who and where the machine running the check is, for the recording scan. */
export interface RecordingIdentity {
  /** Home directory of whoever is running the check. */
  readonly home: string;
  /** Their login name. */
  readonly username: string;
  /** The platform temporary directory. */
  readonly tmpdir: string;
}

/**
 * `recordings/` is committed to a public repository, and every file in it is a
 * transcript of a real session on somebody's laptop. None of what this guard
 * looks for is a credential — which is exactly why it survives review.
 *
 * The scan reads through base64: a raw transport capture stores its frames as
 * `b64` chunks, so a plain grep over the file finds nothing and means nothing.
 *
 * The redactor in `packages/mock-agent/src/redaction.ts` is what keeps these
 * out, in the two paths that write recordings. This guard is the backstop that
 * says one of them was bypassed.
 */
export function checkRecordingsAreScrubbed(
  files: readonly SourceFile[],
  identity: RecordingIdentity,
): Violation[] {
  const violations: Violation[] = [];
  const why = 'recordings/ is public; packages/mock-agent/src/redaction.ts is what removes it';

  for (const file of files) {
    const text = `${file.text}\n${decodedFrames(file.text)}`;
    const report = (message: string) => {
      violations.push({ where: file.path, message: `${file.path} ${message}. ${why}.` });
    };

    const home = /\/(?:Users|home)\/[^/\s"'\\]+/.exec(text)?.[0];
    if (home !== undefined) report(`carries the home-directory path "${home}"`);
    if (identity.home.length > 1 && text.includes(identity.home)) {
      report(`carries this machine's home directory "${identity.home}"`);
    }
    // Two characters is a substring, not a name; anything shorter would make
    // the rule fire on unrelated text and be turned off within the week.
    if (identity.username.length >= 3 && text.includes(identity.username)) {
      report(`names the user "${identity.username}"`);
    }
    if (identity.tmpdir.length > 1 && text.includes(identity.tmpdir)) {
      report(`carries this machine's temporary directory "${identity.tmpdir}"`);
    }
    const temp = /(?:\/private)?\/var\/folders\/[^/\s"'\\]+\/[^/\s"'\\]+\/T/.exec(text)?.[0];
    if (temp !== undefined) report(`carries the capture temporary directory "${temp}"`);
    const commands = /"availableCommands"\s*:\s*\[\s*[^\s\]]/.exec(text);
    if (commands !== null) {
      report('lists availableCommands entries, which enumerate the recording machine’s commands');
    }
  }

  return violations;
}

/** Every base64 chunk in an ndjson recording, decoded, so the scan can read it. */
function decodedFrames(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"b64"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const b64 = (parsed as { b64?: unknown }).b64;
    if (typeof b64 === 'string') out.push(Buffer.from(b64, 'base64').toString('utf8'));
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- *
 * KAR-05.6 — the MCP SDK is imported through two deep subpaths, or not at all.
 * -------------------------------------------------------------------------- */

/**
 * The only two specifiers of `@modelcontextprotocol/sdk` this workspace may
 * name (docs/07-provider-adapter-layer.md §7.3).
 *
 * The SDK is not lightweight: its dependencies include `express`, `hono`,
 * `cors`, `jose`, `eventsource`, `pkce-challenge` and `express-rate-limit`.
 * For a stdio-only server that is all dead weight, and a root import *loads*
 * it — which is the difference between an install cost and a startup cost that
 * `npx DeFlow up` pays every time (NF6).
 */
export const ALLOWED_MCP_SDK_SUBPATHS = ['server/mcp.js', 'server/stdio.js'] as const;

/** The package whose reach this guard bounds, spelled once. */
export const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';

/**
 * EPIC-05-S22, scenarios 3 and 4: no root-package import anywhere, no
 * subpath outside the allowlist, and in particular no `sse.js` on either side
 * — legacy HTTP+SSE is deprecated as of the 2026-07-28 MCP spec and still
 * ships in 1.30.0, so it is reachable, plausible and wrong.
 */
export function checkMcpSdkImports(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  const allowed: readonly string[] = ALLOWED_MCP_SDK_SUBPATHS;
  const allowedList = allowed.map((subpath) => `${MCP_SDK_PACKAGE}/${subpath}`).join(' and ');

  for (const file of files) {
    for (const { line, specifier } of specifiersIn(file.text)) {
      if (specifier !== MCP_SDK_PACKAGE && !specifier.startsWith(`${MCP_SDK_PACKAGE}/`)) continue;
      if (specifier === MCP_SDK_PACKAGE) {
        violations.push({
          where: `${file.path}:${line}`,
          message:
            `${file.path} imports "${specifier}" at the package root, which loads express, hono, ` +
            `cors, jose and eventsource into a stdio-only server. Import ${allowedList} instead ` +
            '(docs/07-provider-adapter-layer.md §7.3).',
        });
        continue;
      }
      const subpath = specifier.slice(MCP_SDK_PACKAGE.length + 1);
      if (allowed.includes(subpath)) continue;
      const sse = subpath.endsWith('sse.js')
        ? ' Legacy HTTP+SSE is deprecated as of the 2026-07-28 MCP spec and must not be built on.'
        : '';
      violations.push({
        where: `${file.path}:${line}`,
        message:
          `${file.path} imports "${specifier}". The MCP host is stdio-only and may name ${allowedList} ` +
          `and nothing else.${sse}`,
      });
    }
  }

  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-06.1 — the deterministic core reads no clock, timer or random source.
 *
 * `decide(state, now)` takes the instant as a parameter. The corollary,
 * docs/05-durable-execution.md §4 states it as a hard rule, is that nothing
 * under packages/core/src may read one for itself: a `Date.now()` in the
 * scheduler makes two calls with the same `(state, now)` disagree, and it does
 * so intermittently, in a run nobody can reproduce.
 *
 * Each identifier is named individually rather than being covered by a
 * category, because the message that has to appear in front of the person
 * typing it is different every time — `setTimeout` is a durability bug (a
 * 30-day gate fires after 1 ms, verified 2026-08-02), `Math.random` is a
 * replay bug, `Date.now` is both.
 *
 * The patterns are *built* from the object and member names rather than
 * written out, so this file can never be its own first violation.
 * -------------------------------------------------------------------------- */

export interface BannedNondeterminism {
  /** How a reader names it: `Date.now`, `setTimeout`. */
  readonly identifier: string;
  /** The object a member read goes through, or `null` for a bare global. */
  readonly object: string | null;
  /** The member or global name itself. */
  readonly member: string;
  /** What goes wrong when it is used, in one line. */
  readonly why: string;
}

export const BANNED_NONDETERMINISM: readonly BannedNondeterminism[] = [
  {
    identifier: 'Date.now',
    object: 'Date',
    member: 'now',
    why: 'the instant arrives as decide()’s `now` parameter and inside event payloads; a clock read makes replay disagree with the live run',
  },
  {
    identifier: 'setTimeout',
    object: null,
    member: 'setTimeout',
    why: 'a wait is a node_wake row, never a timer — Node fires a delay above 2^31-1 ms after 1 ms, and no timer survives a restart',
  },
  {
    identifier: 'setInterval',
    object: null,
    member: 'setInterval',
    why: 'the ~1 Hz ticker belongs to the daemon; core returns commands and holds no loop',
  },
  {
    identifier: 'setImmediate',
    object: null,
    member: 'setImmediate',
    why: 'scheduling work on the event loop is the imperative shell’s job; core is synchronous and total',
  },
  {
    identifier: 'Math.random',
    object: 'Math',
    member: 'random',
    why: 'jitter and ids come from a seeded generator injected as a port, so a failing run can be replayed exactly',
  },
  {
    identifier: 'process.hrtime',
    object: 'process',
    member: 'hrtime',
    why: 'a monotonic clock is still a clock, and `process` is not in scope in a package that performs no I/O',
  },
  {
    identifier: 'performance.now',
    object: 'performance',
    member: 'now',
    why: 'measuring elapsed time inside the pure core is a clock read wearing a different name',
  },
];

/** `Date\.now\s*\(` and friends, assembled so the literal never appears here. */
function nondeterminismPattern(banned: BannedNondeterminism): RegExp {
  const prefix = banned.object === null ? '(?<![.\\w])' : `\\b${banned.object}\\.`;
  return new RegExp(`${prefix}${banned.member}\\s*\\(`);
}

/**
 * AC1 / EPIC-06-S2 scenario 3: no file under `packages/core/src` reads a
 * clock, a timer or a random number. Runs over the source with whole-line
 * comments blanked out, so a doc comment explaining why `Date.now()` is banned
 * is not the rule's own first violation.
 */
export function checkNoNondeterminism(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = codeOnly(file.text).split('\n');
    for (const [index, line] of lines.entries()) {
      for (const banned of BANNED_NONDETERMINISM) {
        if (!nondeterminismPattern(banned).test(line)) continue;
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} reads ${banned.identifier}. @DeFlow/core is deterministic: ` +
            `${banned.why}. Time enters through the Clock port (packages/core/src/clock.ts), ` +
            'implemented by SystemClock in @DeFlow/daemon and TestClock in @DeFlow/testkit.',
        });
      }
    }
  }
  return violations;
}

/**
 * The other half of the same rule: the linter refuses it in the editor, at the
 * moment it is typed, and it names each identifier explicitly so the message
 * the author sees is about the bug they are about to write.
 *
 * Checked against the raw text of `.oxlintrc.json` rather than a parse,
 * because that file is JSONC — it carries the comments that explain each
 * restriction, and dropping them to satisfy a parser would remove the reason
 * the rule exists from the only place anyone reads it.
 */
export function checkNondeterminismIsLinted(config: string): Violation[] {
  const violations: Violation[] = [];
  for (const banned of BANNED_NONDETERMINISM) {
    const named =
      banned.object === null
        ? new RegExp(`"name"\\s*:\\s*"${banned.member}"`).test(config)
        : new RegExp(
            `\\{[^{}]*"object"\\s*:\\s*"${banned.object}"[^{}]*"property"\\s*:\\s*"${banned.member}"[^{}]*\\}`,
          ).test(config);
    if (named) continue;
    violations.push({
      where: '.oxlintrc.json',
      message:
        `.oxlintrc.json does not restrict ${banned.identifier} under packages/core/src. ` +
        `${banned.why}. A test-time scan catches it after it is written; the lint rule catches ` +
        'it as it is typed, which is the only one of the two that arrives before the commit.',
    });
  }
  return violations;
}

/* ── KAR-06.6 AC1 — one timer in the orchestrator, and it is a hint ─────────
 *
 * @DeFlow/core may not name a timer at all (see BANNED_NONDETERMINISM above).
 * The daemon is the imperative shell and therefore has to own exactly one, so
 * the rule here is not "none" but "one, named, and everywhere else a
 * `node_wake` row".
 *
 * The allowlisted file is the `Clock` port's implementation rather than the
 * ticker, which is the shape the whole design rests on: the ticker asks the
 * port to sleep and never names a global, so the ticker's sleep hint, the
 * shutdown hard-exit and every future grace window are one `setTimeout` in one
 * file whose entire job is to be that one.
 *
 * Why it matters more here than anywhere else: **verified 2026-08-02**, Node
 * fires `setTimeout(2**31)` after ~1 ms instead of clamping, so a 30-day human
 * gate written as a timer fires instantly and nothing in the logs says
 * "durability failure". Below that ceiling timers still do not fire during
 * laptop sleep and do not survive a restart.
 * -------------------------------------------------------------------------- */

/** The globals a wait must never be written with. */
export const TIMER_GLOBALS = ['setTimeout', 'setInterval'] as const;

/**
 * The only production sources allowed to name one, repo-relative. Exported so
 * the spec asserts the list rather than trusting it, and so the lint config
 * and the scan cannot drift apart.
 */
export const TIMER_ALLOWLIST: readonly string[] = ['packages/daemon/src/clock.ts'];

/** `setTimeout(` and friends, assembled so this file never trips its own rule. */
const timerPattern = (global: string): RegExp => new RegExp(`(?<![.\\w])${global}\\s*\\(`);

/**
 * AC1. Every production source of a package that names a timer global, except
 * the allowlisted ones. Comment-only lines are blanked first, so the prose
 * explaining why the rule exists is not the rule's own first violation.
 */
export function checkNoTimerWaits(
  files: readonly SourceFile[],
  allowed: readonly string[] = TIMER_ALLOWLIST,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (allowed.includes(file.path)) continue;
    const lines = codeOnly(file.text).split('\n');
    for (const [index, line] of lines.entries()) {
      for (const global of TIMER_GLOBALS) {
        if (!timerPattern(global).test(line)) continue;
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} calls ${global}. A wait is a node_wake row, never a timer ` +
            '(docs/05-durable-execution.md §10.1): Node fires a delay above 2^31-1 ms after ' +
            '1 ms rather than clamping — verified 2026-08-02 — and no timer fires during ' +
            `laptop sleep or survives a restart. Sleep through the Clock port instead; ${allowed.join(
              ', ',
            )} is the one file allowed to implement it.`,
        });
      }
    }
  }
  return violations;
}

/**
 * The other half of the same rule: oxlint refuses a second call site in the
 * editor, at the moment it is typed, and the allowlisted path is named in the
 * config so the exemption is a decision somebody wrote down rather than a file
 * that happened to be skipped.
 *
 * Checked against the raw text of `.oxlintrc.json` rather than a parse,
 * because that file is JSONC — the comments carry the reasons, and dropping
 * them to satisfy a parser would delete the explanation from the only place
 * anyone reads it.
 */
export function checkTimerAllowlistIsLinted(config: string): Violation[] {
  const violations: Violation[] = [];

  const restricts = (global: string): boolean =>
    new RegExp(`"name"\\s*:\\s*"${global}"`).test(config);

  for (const global of TIMER_GLOBALS) {
    if (restricts(global)) continue;
    violations.push({
      where: '.oxlintrc.json',
      message:
        `.oxlintrc.json does not restrict ${global}. A wait written as a timer is a durability ` +
        'bug that is invisible in the logs, so the linter has to refuse it as it is typed — a ' +
        'test-time scan only catches it once it is already written.',
    });
  }

  if (!/"files"\s*:\s*\[\s*"packages\/daemon\/src\/\*\*\/\*\.ts"\s*\]/.test(config)) {
    violations.push({
      where: '.oxlintrc.json',
      message:
        'no override covers packages/daemon/src/**/*.ts, so the timer restriction reaches the ' +
        'orchestrator’s shell only by accident. The scheduling half of DeFlow is @DeFlow/core ' +
        'plus this package, and core is already covered by its own override.',
    });
  }

  for (const allowed of TIMER_ALLOWLIST) {
    if (config.includes(`"${allowed}"`)) continue;
    violations.push({
      where: '.oxlintrc.json',
      message:
        `${allowed} is the one call site the scan allows, but the lint config never names it. ` +
        'An exemption that exists in a test file and not in the rule is an exemption nobody ' +
        'editing that file will ever see.',
    });
  }

  return violations;
}

/**
 * KAR-06.5 AC1 — the scheduler reads `class` and nothing else.
 *
 * `class` is assigned when a `NodeFailure` is *constructed*, by the code that
 * knows which situation it is in: `provider.unavailable` is transient for a
 * rate-limited vendor and permanent for a binary the user uninstalled mid-run.
 * The moment the scheduler re-derives a decision from `reason`, that context is
 * gone and the two cases become one — silently, and only in production.
 *
 * So no `NodeFailureReason` string literal may appear in a scheduling module.
 * Comparing `entry.when === failure.reason` is fine and is what
 * `retry.onFailure` is for: that is data flowing from the plan, not a branch
 * compiled into the scheduler.
 *
 * The one module allowed to name reasons is the classifier — that is what
 * `classifierPaths` is, and it is a parameter rather than a constant so the
 * test states which file it is exempting where a reader will see it.
 */
export function checkSchedulerBranchesOnClassOnly(
  files: readonly SourceFile[],
  reasons: readonly string[],
  classifierPaths: readonly string[],
): Violation[] {
  const exempt = new Set(classifierPaths);
  const violations: Violation[] = [];

  for (const file of files) {
    if (exempt.has(file.path)) continue;
    const code = codeOnly(file.text);
    for (const [index, line] of code.split('\n').entries()) {
      for (const reason of reasons) {
        if (!line.includes(`'${reason}'`) && !line.includes(`"${reason}"`)) continue;
        violations.push({
          where: `${file.path}:${index + 1}`,
          message:
            `${file.path} names the NodeFailureReason "${reason}" as a literal. The scheduler ` +
            'reads `class` and nothing else: the same reason is transient or permanent depending ' +
            'on context, so classification happens where the failure is constructed ' +
            `(${classifierPaths.join(', ')}) and never at the point a decision is taken.`,
        });
      }
    }
  }

  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-08.6 — one kill site, and nothing that looks like a shortcut to it.
 *
 * The kill switch is the most safety-critical code in the daemon and the
 * easiest to "simplify" in review, because every wrong version is one character
 * or one option away from the right one:
 *
 *  - `process.kill(pid, …)` instead of `process.kill(-pid, …)` kills the agent
 *    and leaves every grandchild running, reparented to init, still holding the
 *    worktree open. Measured, 2026-08-02.
 *  - `child.kill()` / `subprocess.kill()` is execa's own documented non-answer:
 *    it *"only sends a signal to that subprocess, not to any process it might
 *    have spawned itself"*.
 *  - `forceKillAfterDelay` does not fire when an explicit signal is passed —
 *    which DeFlow always passes — and `cleanup` kills on parent exit, which is
 *    precisely what `detached: true` exists to prevent.
 *
 * None of the three fails loudly. All three produce a kill switch that reports
 * success while agents keep editing a worktree nobody is supervising, so the
 * rule is structural: exactly one call site, in `killTree`, and no execa option
 * whose documented behaviour contradicts its name anywhere near an agent.
 * -------------------------------------------------------------------------- */

/** The one file allowed to deliver a signal. */
export const KILL_SEAM = 'packages/adapters/src/kill-tree.ts';

/** `process.kill(…)`, whatever the `node:process` binding is called. */
const PROCESS_KILL = /\b\w*[Pp]rocess\s*\.\s*kill\s*\(/;

/** `child.kill()`, `subprocess.kill()`, `agentProcess.kill()`. */
const HANDLE_KILL = /\b(?:child|subprocess|proc|agent|shim|spawned)\w*\s*\.\s*kill\s*\(/i;

export const ONE_KILL_SITE_MESSAGE =
  `every signal in DeFlow goes through killTree() in ${KILL_SEAM}, which negates the pid so the ` +
  'signal reaches the whole process group. A second kill site is how the positive-pid form gets ' +
  'reintroduced: it kills the agent, leaves its grandchildren running with ppid 1, and reports ' +
  'success (KAR-08.6 AC1, docs/09-workspace-and-safety.md §11).';

/**
 * Every line in `files` that delivers a signal, outside the seam.
 *
 * Whole-line comments are stripped first, because the rule has to be *named* in
 * prose — in this file, in `kill-tree.ts`, and in half the specs that exercise
 * it — and a guard that could not survive being documented would force the
 * documentation out.
 */
export function checkOneKillSite(
  files: readonly SourceFile[],
  seam: string = KILL_SEAM,
): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    if (file.path === seam) continue;
    for (const [index, line] of codeOnly(file.text).split('\n').entries()) {
      if (!PROCESS_KILL.test(line) && !HANDLE_KILL.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message: `${file.path} line ${index + 1} signals a process directly. ${ONE_KILL_SITE_MESSAGE}`,
      });
    }
  }

  return violations;
}

/** The execa options documented to behave contrary to their names. */
const EXECA_TREE_OPTIONS = /\b(?:forceKillAfterDelay|killDescendants)\b/;
const EXECA_CLEANUP_OPTION = /\bcleanup\s*:/;
const EXECA_IMPORT = /from\s*['"]execa['"]/;

export const EXECA_KILL_MESSAGE =
  "execa's kill(), forceKillAfterDelay and cleanup are all documented to do something other " +
  'than what their names suggest for a detached group: kill() signals only the direct ' +
  'subprocess, forceKillAfterDelay does not fire when an explicit signal is passed, and cleanup ' +
  'kills the child when the parent exits — the one thing detached: true exists to prevent. The ' +
  'most safety-critical code in the daemon does not depend on any of them (KAR-08.6 AC8).';

/**
 * No runtime source reaches for execa's process-tree options.
 *
 * `cleanup:` is only a violation in a file that actually imports execa — it is
 * an ordinary word, and banning it everywhere would ban naming a cleanup step.
 */
export function checkNoExecaKillOptions(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const code = codeOnly(file.text);
    const usesExeca = EXECA_IMPORT.test(code);
    for (const [index, line] of code.split('\n').entries()) {
      const offends =
        EXECA_TREE_OPTIONS.test(line) || (usesExeca && EXECA_CLEANUP_OPTION.test(line));
      if (!offends) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message: `${file.path} line ${index + 1} uses an execa process-tree option. ${EXECA_KILL_MESSAGE}`,
      });
    }
  }

  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-09.3 AC1 — the `pinned` flag has exactly one producer.
 * -------------------------------------------------------------------------- */

export const PINNED_FLAG_MESSAGE =
  'sets Segment.pinned to true. The pinned set is exactly the five content types in ' +
  'docs/08-context-and-memory.md §4.1, and a sixth one added anywhere else is invisible ' +
  'afterwards: it is never compacted, always rendered first, and hash-checked before every ' +
  'dispatch. Build it through buildPinnedSegments() in packages/core/src/pinned-set.ts.';

/** `pinned: true`, however it is spaced. */
const PINNED_TRUE = /\bpinned\s*:\s*true\b/;

/**
 * AC1 asks for a type-level constraint rather than a review convention, and
 * `contextSegment` is that: its `kind` cannot name a `pinned.*` kind and it has
 * no `pinned` parameter. This scan covers what a type cannot — a module that
 * builds a `Segment` object literal by hand.
 */
export function checkPinnedFlagHasOneProducer(
  files: readonly SourceFile[],
  allowed: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (allowed.includes(file.path)) continue;
    for (const [index, line] of codeOnly(file.text).split('\n').entries()) {
      if (!PINNED_TRUE.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message: `${file.path} line ${index + 1} ${PINNED_FLAG_MESSAGE}`,
      });
    }
  }
  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-09.8 — the blackboard is a projection, and only one module writes it.
 * -------------------------------------------------------------------------- */

export const FACT_WRITE_MESSAGE =
  'writes the `fact` or `fact_edges` tables directly. Those tables are a materialised view of ' +
  'the `fact.written` / `fact.read` / `fact.invalidated` events and nothing else ' +
  '(docs/04-domain-model.md §5.1): if the blackboard ever becomes independently mutable, NF9 ' +
  '(replay determinism) and NF10 (auditability) are both gone. Append the event and let the ' +
  'projection in packages/ledger/src/blackboard.ts apply it. This guard exists because the ' +
  'change that breaks the rule arrives disguised as a fan-out performance optimisation and ' +
  'looks reasonable in review.';

/** `INSERT INTO fact`, `UPDATE fact SET`, `DELETE FROM fact_edges`, however spaced. */
const FACT_TABLE_WRITE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:fact|fact_edges)\b/i;

/**
 * AC3. Every write to the blackboard tables outside the projection module.
 *
 * `allowed` is the projection module itself — one path, and the rule is that
 * the list stays one path long.
 */
export function checkFactWritesAreProjectionOnly(
  files: readonly SourceFile[],
  allowed: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (allowed.includes(file.path)) continue;
    for (const [index, line] of codeOnly(file.text).split('\n').entries()) {
      if (!FACT_TABLE_WRITE.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message: `${file.path} line ${index + 1} ${FACT_WRITE_MESSAGE}`,
      });
    }
  }
  return violations;
}

export const FACT_CACHE_MESSAGE =
  'holds facts in a module-level mutable collection. A cache that survives a tick is a second ' +
  'home for the blackboard, and the two disagree the first time a fact is invalidated ' +
  '(EPIC-09-S42). Read the projection through @DeFlow/ledger on each use — it is an indexed ' +
  'SQLite read of a table holding tens of rows, not a network call.';

/**
 * EPIC-09-S42 scenario 2, second half: no module-level mutable fact collection
 * anywhere in the workspace.
 *
 * Module level specifically — a `Map` built inside a function lives and dies
 * with the call, and it is the one that outlives the tick that can drift.
 * Matched at column zero, which is what "module level" looks like in a file
 * this repository's formatter has touched.
 */
const MODULE_LEVEL_FACT_COLLECTION =
  /^(?:const|let|var)\s+\w*[fF]act\w*\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/;

export function checkNoFactCache(
  files: readonly SourceFile[],
  allowed: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (allowed.includes(file.path)) continue;
    for (const [index, line] of codeOnly(file.text).split('\n').entries()) {
      if (!MODULE_LEVEL_FACT_COLLECTION.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message: `${file.path} line ${index + 1} ${FACT_CACHE_MESSAGE}`,
      });
    }
  }
  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-09.2 AC5 / EPIC-09-S28 — the demotion path cannot reach a provider.
 * -------------------------------------------------------------------------- */

export const DEMOTION_IMPORT_MESSAGE =
  'imports something outside @DeFlow/core. The packet builder and its demotion ladder must be ' +
  'unable to summarise: "offload, don\'t summarise" (docs/08-context-and-memory.md §5.2) is ' +
  'only a rule while it is enforced by a review, and a structural property once the module ' +
  'cannot reach a provider, an adapter or a process at all. Selection and ordering happen ' +
  'here; tokenising is the Tokenizer port, fetching is the blackboard and the CAS, and ' +
  'summarising is the explicit continuation path in a different module. If a change makes ' +
  'buildPacket need a network call, the change is wrong.';

/** The only bare specifiers a pure `@DeFlow/core` module may name. */
const DEMOTION_ALLOWED_BARE_IMPORTS: readonly string[] = ['zod'];

/**
 * EPIC-09-S28's third scenario, as a property rather than a promise: *"the
 * demotion module has no dependency on any provider or adapter type"*.
 *
 * Enforced by allowlist rather than by a denylist of vendor names, because a
 * denylist is one `import { spawn }` away from being wrong and nobody notices
 * until a packet build starts costing quota.
 */
export function checkDemotionIsProviderFree(
  files: readonly SourceFile[],
  modules: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!modules.includes(file.path)) continue;
    for (const [index, line] of codeOnly(file.text).split('\n').entries()) {
      DEEP_IMPORT_SPECIFIER.lastIndex = 0;
      let match: RegExpExecArray | null = DEEP_IMPORT_SPECIFIER.exec(line);
      while (match !== null) {
        const specifier = match[1] ?? match[2] ?? '';
        const pure =
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          DEMOTION_ALLOWED_BARE_IMPORTS.includes(specifier);
        if (!pure) {
          violations.push({
            where: `${file.path}:${index + 1}`,
            message: `${file.path} line ${index + 1} ${DEMOTION_IMPORT_MESSAGE} Found: "${specifier}".`,
          });
        }
        match = DEEP_IMPORT_SPECIFIER.exec(line);
      }
    }
  }
  return violations;
}

/* -------------------------------------------------------------------------- *
 * KAR-15.2 AC9 / EPIC-15-S13 — the token never travels in a query string.
 * -------------------------------------------------------------------------- */

export const TOKEN_IN_URL_MESSAGE =
  'puts a credential in a URL. A token in a query string ends up in shell history, terminal ' +
  'scrollback, browser history, the "Referer" header of any outbound link, and any access log ' +
  'anyone ever adds — unacceptable for a long-lived token that authorises spawning processes ' +
  "on the user's machine (docs/11-api-and-realtime.md §8.1, docs/15-security-model.md §3.2). " +
  'Send it as "Authorization: Bearer <token>" instead; that is why the SSE client is ' +
  'eventsource-client rather than native EventSource, which cannot set a header. The one ' +
  'credential-carrying URL this project has is the first-run handoff, and it uses the ' +
  'fragment — "#token=" — which is never sent to the server at all.';

/**
 * A query parameter whose name says it carries a credential.
 *
 * Anchored on `?` or `&` so the **fragment** form is untouched: `#token=` is
 * the handoff AC7 specifies, and a guard that banned the substring `token=`
 * outright would ban the correct implementation along with the wrong one.
 */
const CREDENTIAL_QUERY_PARAM = /[?&](?:t|token|access_token|auth|api_key|apikey)=/i;

/** `url.searchParams.set('token', …)`, the same mistake spelled as an API call. */
const CREDENTIAL_SEARCH_PARAM =
  /searchParams\.(?:set|append)\(\s*['"`](?:t|token|access_token|auth|api_key|apikey)['"`]/i;

export function checkNoTokenInUrl(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const [index, line] of codeOnly(file.text).split('\n').entries()) {
      if (!CREDENTIAL_QUERY_PARAM.test(line) && !CREDENTIAL_SEARCH_PARAM.test(line)) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message: `${file.path} line ${index + 1} ${TOKEN_IN_URL_MESSAGE}`,
      });
    }
  }
  return violations;
}

/*
 * KAR-16.1 — the three claims about the UI that are properties of the
 * repository rather than of a running page, and therefore cannot be asserted
 * in a browser spec: a focus ring that is never removed, a build config
 * written for Rolldown, and a state palette with exactly one definition.
 */

/** `focus:outline-none`, the Tailwind utility AC7 bans by name. */
const FOCUS_OUTLINE_UTILITY = /focus(-visible)?:outline-none/;

/**
 * `outline: none` inside a rule whose selector mentions focus — the CSS
 * spelling of the same thing.
 *
 * Matched over the selector *and* its block rather than line by line, because
 * the two halves are never on the same line in formatted CSS.
 */
const FOCUS_OUTLINE_RULE = /(:focus(-visible|-within)?[^{}]*)\{[^}]*outline\s*:\s*(none|0)\b/;

export const FOCUS_RING_MESSAGE =
  'a visible :focus-visible ring is the floor under the whole keyboard map (KAR-16.1 AC7, ' +
  'docs/12-frontend-architecture.md §9.4). Removing it is a one-token edit that looks tidy in ' +
  'a diff and leaves a keyboard user with no idea where they are.';

/**
 * AC7 — `focus:outline-none` appears nowhere, in any spelling.
 *
 * Both forms are checked because banning only the Tailwind utility would leave
 * the plain-CSS version, and this repository writes plain CSS for exactly the
 * surfaces where the ring matters most.
 */
export function checkNoFocusOutlineNone(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    // Comments are stripped: this rule is named in the prose of the very files
    // that implement it correctly, and a guard that cannot tell an explanation
    // from a declaration bans its own documentation.
    const code = codeOnly(file.text);
    if (FOCUS_OUTLINE_UTILITY.test(code)) {
      violations.push({
        where: file.path,
        message: `${file.path} contains "focus:outline-none": ${FOCUS_RING_MESSAGE}`,
      });
      continue;
    }
    if (FOCUS_OUTLINE_RULE.test(code)) {
      violations.push({
        where: file.path,
        message: `${file.path} sets "outline: none" on a focus state: ${FOCUS_RING_MESSAGE}`,
      });
    }
  }
  return violations;
}

/**
 * AC10 — the build config is written for Rolldown.
 *
 * Vite 8 auto-converts `build.rollupOptions`, so the wrong name *works*, which
 * is exactly why it needs a guard: the cost is paid later, debugging a shim
 * rather than the bundler (docs/12-frontend-architecture.md §2.2). The new
 * name is also required to be present, because a config with neither is a
 * config where the bundle budget has no output configuration at all.
 */
export function checkRolldownBuildOptions(config: SourceFile): Violation[] {
  const violations: Violation[] = [];
  const code = codeOnly(config.text);

  if (/\brollupOptions\b/.test(code)) {
    violations.push({
      where: config.path,
      message:
        `${config.path} uses "build.rollupOptions". Vite 8 auto-converts it, so this works and ` +
        'then costs you an afternoon debugging a compat shim instead of the bundler. Write ' +
        '"build.rolldownOptions".',
    });
  }
  if (!/\brolldownOptions\b/.test(code)) {
    violations.push({
      where: config.path,
      message:
        `${config.path} declares no "build.rolldownOptions". AC9's initial-chunk budget is ` +
        'enforced against a build whose output configuration is stated, not inferred.',
    });
  }
  return violations;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa` — a colour written into a component. */
const HEX_COLOUR = /#[0-9a-f]{3}(?:[0-9a-f]{1}|[0-9a-f]{3}|[0-9a-f]{5})?\b/i;

/**
 * A Tailwind colour utility on one of the hues the state palette owns.
 *
 * Scoped to those hues rather than to every colour utility, because a neutral
 * surface class is not a state and banning it would be a rule about styling
 * rather than about the palette.
 */
const TAILWIND_STATE_COLOUR =
  /\b(?:text|bg|border|fill|stroke|ring|outline)-(?:red|orange|amber|yellow|lime|green|emerald|teal|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

/** The two files that are allowed to know what colour a state is. */
const PALETTE_FILES = [
  'packages/web/src/styles/theme.css',
  'packages/web/src/lib/state-palette.ts',
];

export const STATE_PALETTE_MESSAGE =
  'the entire node-state palette is CSS custom properties, not Tailwind classes and not hex ' +
  '(docs/12-frontend-architecture.md §9.1). Seven views read the same "--state-*" variables, so ' +
  'both themes work because you redefine seven values — a second definition anywhere makes dark ' +
  'mode an audit of nine views instead.';

/**
 * EPIC-16-S3, scenario 2 — no component hardcodes a state colour.
 *
 * The palette files themselves are exempt: they are where the seven values are
 * defined, and a guard that also banned them would ban the correct
 * implementation along with the wrong one.
 */
export function checkStateColoursComeFromThePalette(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (PALETTE_FILES.includes(file.path)) continue;

    const code = codeOnly(file.text);
    if (HEX_COLOUR.test(code)) {
      violations.push({
        where: file.path,
        message: `${file.path} writes a hex colour: ${STATE_PALETTE_MESSAGE}`,
      });
      continue;
    }
    if (TAILWIND_STATE_COLOUR.test(code)) {
      violations.push({
        where: file.path,
        message: `${file.path} uses a Tailwind colour utility: ${STATE_PALETTE_MESSAGE}`,
      });
    }
  }
  return violations;
}

export const QUERY_BOUNDARY_MESSAGE =
  'the state split is one sentence and it is load-bearing (KAR-16.4 AC10, ' +
  'docs/12-frontend-architecture.md §3.4): if the answer changes because an event was appended ' +
  'it is a projection, and if it changes because a file on disk changed it is a query. Run ' +
  'state behind a fetch cache is two sources of truth that disagree for exactly as long as the ' +
  'stale window — which is the interval an operator spends looking at a node that finished.';

/**
 * The API paths `@pinia/colada` is allowed to own.
 *
 * Kept here as well as in `packages/web/src/api/queries.ts` on purpose: a rule
 * whose allowlist lives only in the file it polices is a rule that widens
 * itself. `test/ui-foundation.test.ts` asserts the two agree, so sanctioning a
 * fourth endpoint is a two-file edit somebody has to mean.
 */
export const SANCTIONED_QUERY_PATHS: readonly string[] = [
  '/api/runs',
  '/api/providers',
  '/api/config',
  '/api/artifacts/:sha',
];

/** `useQuery`, `defineQuery` and the option builders they take. */
const COLADA_ENTRY_POINTS = /\b(?:useQuery|useInfiniteQuery|defineQuery|defineQueryOptions)\s*\(/;

/**
 * The reads whose answer changes because an event was appended.
 *
 * Spelled as URL fragments rather than as key names because that is what a
 * violation actually looks like: somebody writes `useQuery({ key: ['events', id],
 * query: () => client.runs[':id'].events.$get(...) })` because the run list
 * next to it is a query and the symmetry is inviting.
 */
const LEDGER_DERIVED_READS: readonly (readonly [RegExp, string])[] = [
  [/\/events\b|\.events\.\$get/, 'the event log — the stream already carries it'],
  [/\/snapshot\b|\.snapshot\.\$get/, 'a snapshot at a seq — that is the scrubber, not a cache'],
  [/\/plans\b|\.plans\./, 'the plan rail and diffs — a replan appends events'],
  [/\/gates\b|\.gates\.\$get/, 'gate verdicts — every one of them is an event'],
  [/\/criteria\b|\.criteria\./, 'the criteria board — a projection over gate events'],
  [/\/findings\b|\.findings\./, 'findings — appended as gates evaluate'],
  [/\/facts\b|\.facts\./, 'the blackboard — fact.written is an event'],
  [/\/nodes\/|\.nodes\[/, 'node detail — every field of it moves with the run'],
];

/**
 * KAR-16.4 AC10 — run state must not be put behind the fetch cache.
 *
 * The scan is per **statement block** rather than per file: `../api/queries.ts`
 * legitimately names every sanctioned path, and a whole-file grep would either
 * have to exempt it — losing the rule where it matters most — or flag it. So a
 * violation is a Colada entry point with a ledger-derived read *inside the same
 * call*, which is exactly the shape of the mistake.
 */
export function checkQueryProjectionBoundary(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const code = codeOnly(file.text);
    for (const call of coladaCalls(code)) {
      for (const [pattern, why] of LEDGER_DERIVED_READS) {
        if (!pattern.test(call.text)) continue;
        violations.push({
          where: `${file.path}:${call.line}`,
          message:
            `${file.path} puts ${why} behind a @pinia/colada query. ${QUERY_BOUNDARY_MESSAGE} ` +
            `The sanctioned query paths are ${SANCTIONED_QUERY_PATHS.join(', ')}.`,
        });
        break;
      }
    }
  }

  return violations;
}

/** Each Colada call in `code`, as its text and the line it starts on. */
function coladaCalls(code: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  const lines = code.split('\n');

  for (const [index, line] of lines.entries()) {
    if (!COLADA_ENTRY_POINTS.test(line)) continue;
    // The call plus the block it opens, bounded: an option object spanning
    // more than a dozen lines is not what this rule is looking for, and reading
    // to a matching brace would need a parser to be right about strings.
    found.push({ text: lines.slice(index, index + 12).join('\n'), line: index + 1 });
  }

  return found;
}

export const CREDENTIAL_READ_MESSAGE =
  'reads a provider credential. AR-1 is that DeFlow never touches a vendor credential and never ' +
  'captures the output of an auth command: the vendor CLI is already logged in, its own ' +
  'credential store is its business, and every key DeFlow can see is a key DeFlow can leak into ' +
  'a log line, an event payload or a bug report. "DeFlow up" is where the shortcut gets taken — ' +
  'forwarding ANTHROPIC_API_KEY into the daemon environment "so agents inherit it", or reading ' +
  '~/.claude/.credentials.json to print a nicer status line — and every runtime test in this ' +
  'repository would still pass afterwards. Where a provider needs a login, print the command ' +
  'for the operator to run themselves (packages/adapters/src/provider-availability.ts).';

/**
 * A read of an environment variable whose name says it carries a credential.
 *
 * The families are the ones docs/15-security-model.md names: a vendor API key,
 * anything ending `_TOKEN`, and the two credential *files* the ACP-mode CLIs
 * keep. `DeFlow_RUN_TOKEN` and the daemon's own bearer token are deliberately
 * not in it — they are secrets DeFlow *mints*, which is the opposite of the
 * class this rule is about — so the pattern requires a vendor-shaped prefix.
 */
const CREDENTIAL_ENV_READ =
  /\b(?:process\.)?env(?:\.|\[\s*['"`])(?:[A-Z][A-Z0-9]*_)?(?:API_KEY|APIKEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|CREDENTIALS?)\b/;

/** The same variables named as a literal, which is how an allowlist entry or
 * an object key spells them. */
const CREDENTIAL_ENV_LITERAL =
  /['"`](?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|COPILOT|GITHUB|CURSOR|OPENCODE|XAI|MISTRAL)_(?:API_KEY|TOKEN)['"`]/;

/** A vendor credential *file*: the two directories the CLIs keep them in. */
const CREDENTIAL_FILE_READ = /['"`/$][.]?(?:claude|codex)[/'"`].{0,40}(?:credential|auth|token)/i;

/** A bare `X_API_KEY` / `X_TOKEN` identifier being read out of an env-ish bag. */
const CREDENTIAL_PROPERTY_READ =
  /\b(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|COPILOT|GITHUB|CURSOR|OPENCODE|XAI|MISTRAL)_(?:API_KEY|TOKEN)\b/;

/**
 * AR-1 (KAR-18.2 AC9) — no module `DeFlow up` is assembled from may read a
 * vendor credential, from the environment or from disk.
 *
 * Comments are stripped first: this rule's own explanation, and every doc
 * comment that says "DeFlow never reads ~/.claude", would otherwise be the
 * first thing it flagged.
 */
export function checkNoCredentialReads(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const [index, line] of codeOnly(file.text).split('\n').entries()) {
      const offends =
        CREDENTIAL_ENV_READ.test(line) ||
        CREDENTIAL_ENV_LITERAL.test(line) ||
        CREDENTIAL_FILE_READ.test(line) ||
        CREDENTIAL_PROPERTY_READ.test(line);
      if (!offends) continue;
      violations.push({
        where: `${file.path}:${index + 1}`,
        message: `${file.path} line ${index + 1} ${CREDENTIAL_READ_MESSAGE}`,
      });
    }
  }
  return violations;
}
