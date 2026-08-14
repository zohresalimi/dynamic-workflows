/**
 * KAR-18.5 — the real build, run for real, asserted on the bytes it produced.
 *
 * Every claim in this file is one that `pnpm dev` cannot make. Development
 * never touches `dist/`: Vite serves the UI through middleware, Node strips the
 * types off live source, and `@DeFlow/*` resolve to `src/index.ts`. So the
 * three failure modes this story exists to stop — an empty `dist/ui/`, a
 * `@DeFlow/*` specifier that survived into the bundle, and a `bin.mjs` that
 * lost its shebang — are all invisible until someone installs the tarball.
 *
 * The build runs **once**, in `beforeAll`, into the real `packages/cli/dist`.
 * That directory is gitignored and is what AC1 names, and it is also the thing
 * `publint` and `attw --pack` have to be pointed at, so building somewhere else
 * would mean building twice.
 *
 * Verifies: EPIC-18-S37 · EPIC-18-S38 · EPIC-18-S39 · AC1, AC2, AC4, AC6, AC7
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { readJson, repoRoot } from '../../../../test/support/workspace.ts';

const cliDir = join(repoRoot, 'packages/cli');
const distDir = join(cliDir, 'dist');
const bin = (name: string): string => join(cliDir, 'node_modules/.bin', name);

/**
 * The two native modules the tarball asks npm for. Everything else is inlined.
 *
 * `better-sqlite3` cannot be one of them: it locates its own prebuilt binary
 * with `require(path.join(__dirname, '..', 'prebuilds', …))`, so inlining it
 * points that lookup at `packages/cli/prebuilds/`, which does not exist, and
 * the failure arrives when a user opens a ledger rather than when the bundle is
 * built. `@lydell/node-pty` is external for the same reason and `optional` on
 * top of it, so an unsupported platform degrades to no-TTY (docs/16 §2).
 */
const EXTERNAL_NATIVES = ['@lydell/node-pty', 'better-sqlite3'];

/** Every file under a directory, repo-relative, with `/` separators. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The tree, reduced to the part of it that is a claim about packaging.
 *
 * Two things in a real build move for reasons that have nothing to do with this
 * story. Vite's content hashes change with every byte of the application, and
 * the *set* of route chunks changes whenever EPIC-17 adds a view — so a
 * file-for-file snapshot would go red on unrelated frontend work, and a
 * snapshot that goes red for reasons the reader dismisses is a snapshot that
 * gets `-u`'d past a real regression (docs/14-testing-strategy.md §9).
 *
 * What is pinned instead is what the tarball's shape actually promises: the
 * emitted entry files by name, and the kinds of asset under `ui/`. An empty
 * `ui/`, a lost bin, a stray `.cjs` from a dual build or a sourcemap that
 * should not ship all still fail it.
 */
const shapeOf = (paths: readonly string[]): string[] =>
  [
    ...new Set(
      paths.map((path) =>
        path.startsWith('ui/assets/')
          ? `ui/assets/*${path.slice(path.lastIndexOf('.'))}`
          : path.replace(/-[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9]+)$/, '-<hash>$1'),
      ),
    ),
  ].sort();

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd: string): Ran {
  const child = spawnSync(command, [...args], { cwd, encoding: 'utf8', env: process.env });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

/** What a failed child said for itself, folded into the assertion message. */
const said = (command: string, child: Ran): string =>
  `\n${command} exited ${String(child.status)}\n--- stdout\n${child.stdout.trim()}\n--- stderr\n${child.stderr.trim()}`;

/**
 * The import/require specifiers of a built ESM file, off a real parse.
 *
 * A regular expression is not good enough here and the reason is worth
 * recording: a 4 MB bundle carries every doc comment and every string literal
 * of everything it inlined, and this repository's comments are full of prose
 * like `import { type Foo } from '@DeFlow/core'`. A text scan reports those as
 * live imports, which is a test that fails for a reason that is not true.
 */
function specifiersOf(code: string, fileName: string, only?: 'static'): string[] {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  );
  const found = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.add(node.moduleSpecifier.text);
    }
    if (
      only !== 'static' &&
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return [...found].sort();
}

let built: Ran;
let tree: string[];

beforeAll(() => {
  built = run('node', ['packages/cli/scripts/build.ts'], repoRoot);
  expect(built.status, said('the build', built)).toBe(0);
  tree = filesUnder(distDir);
}, 600_000);

suite('the fixed build order (AC1, EPIC-18-S37)', () => {
  it('emits the three bins and the UI as plain files', () => {
    expect(shapeOf(tree)).toMatchSnapshot();
  });

  it('leaves dist/ui populated, which reversing the order would not', () => {
    // The whole scenario: build the web app, copy, *then* bundle. A tsdown run
    // that cleaned dist/ after the copy — or a copy that ran before the web
    // build — produces exactly this directory, empty, and a daemon that starts
    // and serves a blank page.
    const assets = tree.filter((path) => path.startsWith('ui/assets/'));
    expect(tree).toContain('ui/index.html');
    expect(assets.filter((path) => path.endsWith('.js')).length).toBeGreaterThan(0);
    expect(assets.filter((path) => path.endsWith('.css')).length).toBeGreaterThan(0);
  });

  it('ships the UI as files rather than strings inside JavaScript', () => {
    for (const file of tree.filter((path) => path.endsWith('.mjs'))) {
      const code = readFileSync(join(distDir, file), 'utf8');
      expect(code.toLowerCase(), `${file} has the SPA baked into it`).not.toContain('<!doctype');
    }
  });

  it('copies a whole build, so index.html resolves against what is beside it', () => {
    // A truncated or half-stale copy is the same blank page as an empty ui/,
    // and it is the version that survives a file tree assertion. `dist/ui/` is
    // a sibling of the emitted bins, which is what makes the daemon's
    // `new URL('./ui/', import.meta.url)` resolve inside the tarball.
    const html = readFileSync(join(distDir, 'ui/index.html'), 'utf8');
    const referenced = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map(
      (match) => `ui/assets/${match[1] ?? ''}`,
    );
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((asset) => !tree.includes(asset))).toEqual([]);
  });
});

suite('what survives into the bundle (AC2, AC7, EPIC-18-S38)', () => {
  const emitted = (): string[] =>
    tree.filter((path) => path.endsWith('.mjs') && !path.includes('/'));

  const specifiers = (file: string): string[] =>
    specifiersOf(readFileSync(join(distDir, file), 'utf8'), file);

  /** Only what the module graph *evaluates on load* — no `import()` calls. */
  const staticSpecifiers = (file: string): string[] =>
    specifiersOf(readFileSync(join(distDir, file), 'utf8'), file, 'static');

  it('inlines every workspace package', () => {
    for (const file of emitted()) {
      expect(
        specifiers(file).filter((specifier) => specifier.startsWith('@DeFlow/')),
        `${file} still imports a private workspace package; npm answers 404 for those names`,
      ).toEqual([]);
    }
  });

  it('leaves no .ts specifier behind', () => {
    for (const file of emitted()) {
      expect(
        specifiers(file).filter((specifier) => specifier.endsWith('.ts')),
        `${file} imports a .ts file, which is not in the tarball`,
      ).toEqual([]);
    }
  });

  it('externalises the two natives and nothing else', () => {
    for (const file of emitted()) {
      const bare = staticSpecifiers(file).filter(
        (specifier) =>
          !specifier.startsWith('.') &&
          !specifier.startsWith('/') &&
          !specifier.startsWith('node:'),
      );
      // Named rather than counted: a new entry here is a package the tarball
      // now asks npm for, and that is a release decision, not a build detail.
      expect(bare, `${file}'s runtime imports`).toEqual(
        bare.filter((specifier) => EXTERNAL_NATIVES.includes(specifier)),
      );
    }
  });

  it('imports better-sqlite3 rather than inlining it', () => {
    // The other half of the rule above: a native that is *missing* from the
    // output is a ledger that throws on the first query, and the assertion that
    // only names an allowlist would call that a pass.
    expect(emitted().flatMap(specifiers)).toContain('better-sqlite3');
  });

  /**
   * **Amended 2026-08-11 while implementing KAR-18.2.** This test used to
   * assert that the string `vite` appeared in no specifier of any kind. That
   * held only for as long as nothing in the entry graph reached
   * `startHttp` — `deflow init` does not — and `deflow up` does, so the
   * unreachable `import('vite')` inside its `DeFlow_DEV` branch now survives
   * into a chunk.
   *
   * That is the shape `tsdown.config.ts` describes and intends: `vite` is on
   * both `neverBundle` and `onlyImport` precisely so that the specifier is left
   * as an unevaluated `import()` — no bytes, no dependency, and an honest
   * MODULE_NOT_FOUND for anyone who sets `DeFlow_DEV=1` against an installed
   * package, where there is no source tree for Vite to serve anyway. What must
   * never happen is the two things below: Vite on the **static** graph, where
   * it would be loaded on every `deflow up`, and Vite's bytes inlined.
   */
  it('never drags vite in', () => {
    for (const file of emitted()) {
      expect(staticSpecifiers(file), `${file} imports vite on load`).not.toContain('vite');
      // Not only the specifier: Vite arrives with a CJS-interop tree behind it,
      // and `tsx/cjs/api` is the fingerprint of an inlined one.
      expect(readFileSync(join(distDir, file), 'utf8')).not.toContain('tsx/cjs/api');
    }
  });

  it('leaves behind no chunk that no entry point reaches', () => {
    // Every other assertion in this suite is quantified over `emitted()`, so
    // they are only claims about *this* build if `emitted()` is this build's
    // output. Nothing had ever checked that, and it was not: the chunk names
    // are content-hashed, so a rebuild writes new ones beside the old, and
    // `dist/` grew to sixty files and 109 MB of chunks from builds going back
    // days. Two things follow, and the second is the worse one. A `files`
    // entry pointing at `dist` ships all of it. And a rule enforced by reading
    // every file at the root of `dist/` is then being enforced against dead
    // code — an orphan that still imports `@DeFlow/core` fails a build that
    // fixed it, and a rule a live chunk breaks passes as long as some older
    // copy of it does not.
    //
    // Reachability rather than a file list, because the list is hashes: the
    // four entry points are named by the `bin` map and `exports`, and a chunk
    // is legitimate exactly when one of them can reach it.
    const entries = ['bin.mjs', 'mcp.mjs', 'mock-agent.mjs', 'index.mjs'];
    const reachable = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (reachable.has(file)) continue;
      reachable.add(file);
      for (const specifier of specifiers(file)) {
        if (!specifier.startsWith('./')) continue;
        const chunk = specifier.slice(2);
        if (!reachable.has(chunk)) queue.push(chunk);
      }
    }

    expect(
      emitted().filter((file) => !reachable.has(file)),
      'chunks in dist/ that no entry point imports — a stale build the bundler did not clean, ' +
        'which every other assertion in this suite is then quantified over',
    ).toEqual([]);
  });
});

suite('the bins are executable (AC6)', () => {
  it.each(['bin.mjs', 'mcp.mjs', 'mock-agent.mjs'])('%s starts with a shebang', (file) => {
    expect(readFileSync(join(distDir, file), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it.each(['bin.mjs', 'mcp.mjs', 'mock-agent.mjs'])('%s is emitted with the exec bit', (file) => {
    // 0o111 rather than 0o755: what matters is that all three of user, group
    // and other can execute it, whatever the umask did to the read bits.
    expect(statSync(join(distDir, file)).mode & 0o111).toBe(0o111);
  });
});

suite('the release gate (AC4, EPIC-18-S39)', () => {
  let staged: string | undefined;

  afterAll(() => {
    if (staged !== undefined) rmSync(staged, { recursive: true, force: true });
  });

  it('publint passes against the built package', () => {
    const child = run(bin('publint'), [], cliDir);
    expect(child.status, said('publint', child)).toBe(0);
  });

  it('attw --pack reports no masked or unresolvable entry point', () => {
    const child = run(bin('attw'), ['--pack'], cliDir);
    expect(child.status, said('attw --pack', child)).toBe(0);
    // And says what it found, rather than passing silently. Today that is "no
    // types", which is the honest shape of a package whose contract is three
    // executables (tsdown runs with `dts: false`, docs/16 §2). The check earns
    // its place the moment anything is exported *with* types: attw is the only
    // half of this gate that resolves an entry point the way each of the six
    // module modes does, which is where a masked one hides.
    expect(child.stdout).toContain('deflow');
  }, 120_000);

  it('exits non-zero on a deliberately broken exports map', () => {
    // A gate that has never been observed failing is not a gate. The staged
    // copy is the real built package with one field changed: "." now points at
    // a file that is not in it.
    staged = mkdtempSync(join(tmpdir(), 'DeFlow-broken-pkg-'));
    cpSync(distDir, join(staged, 'dist'), { recursive: true });
    const { publishConfig: _dropped, ...manifest } = readJson('packages/cli/package.json');
    writeFileSync(
      join(staged, 'package.json'),
      `${JSON.stringify({ ...manifest, exports: { '.': './dist/nope.js' } }, null, 2)}\n`,
    );

    const publint = run(bin('publint'), [], staged);
    // Asserted on the reason, not only on the exit code: a non-zero from a
    // linter that could not find the package at all would "pass" this test
    // while proving nothing.
    expect(publint.status, said('publint', publint)).not.toBe(0);
    expect(publint.stdout + publint.stderr).toContain('./dist/nope.js');
    expect(publint.stdout + publint.stderr).toContain('does not exist');
  }, 120_000);
});
