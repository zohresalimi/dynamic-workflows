/**
 * KAR-18.5 — the manifest and the config half of "one publishable tarball".
 *
 * The expensive half of this story is the real build, and it lives next door in
 * `test/integration/build.test.ts`. What is here is everything that can be
 * decided by reading files: the published manifest's shape, the fixed build
 * order, the `pack:check` gate's wiring, and the two guards whose whole purpose
 * is that the mistake they catch is **green in development** and fatal in the
 * tarball.
 *
 * Verifies: EPIC-18-S38 (the manifest half) · EPIC-18-S40 (the guard scenario)
 * · EPIC-18-S41 · AC2, AC3, AC4, AC5, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkNoDeepWorkspaceImports,
  checkNoPathsAlias,
  describe as render,
} from '../../../test/support/guards.ts';
import {
  exists,
  packageProductionSources,
  readJson,
  readText,
  readWorkspaceYaml,
  readYaml,
  tsconfigFiles,
} from '../../../test/support/workspace.ts';

const cli = readJson('packages/cli/package.json');
const root = readJson('package.json');

/**
 * The two native modules, and the reason the list is two rather than the one
 * the story's AC2 first said.
 *
 * `better-sqlite3` resolves its own binary at runtime with
 * `require(path.join(__dirname, '..', 'prebuilds', `${platform}-${arch}.node`))`
 * — a path computed from the *module's* location. Inlined into `dist/bin.mjs`
 * that becomes `packages/cli/prebuilds/…`, which is nowhere, and the failure
 * arrives when a user opens a ledger rather than when the bundle is built. It
 * therefore stays external and a real `dependency`, which is also what
 * docs/16-repo-layout.md §2 assumes when it measures `npm i better-sqlite3` at
 * one second with zero compilation: you only pay that if the tarball asks npm
 * for it.
 *
 * `@lydell/node-pty` is external for the same reason and `optional` for a
 * different one — an unsupported platform must degrade to no-TTY rather than
 * fail the install (docs/16 §2, KAR-18.4).
 */
const EXTERNAL_NATIVES = ['better-sqlite3', '@lydell/node-pty'];

suite('the published manifest (AC3)', () => {
  it('ships dist and nothing else', () => {
    expect(cli.files).toEqual(['dist']);
  });

  it('is ESM-only, with no dual CJS build', () => {
    expect(cli.type).toBe('module');
    // `main`, `module` and a `require` condition are the three ways a dual
    // build announces itself. attw's masked-entry-point report is what catches
    // the subtle version of this; these three catch the blunt one.
    expect(cli.main).toBeUndefined();
    expect((cli as { module?: unknown }).module).toBeUndefined();
    expect(JSON.stringify(cli.publishConfig?.exports ?? {})).not.toContain('require');
  });

  it('requires Node 24 or newer', () => {
    expect(cli.engines?.node).toBe('>=24');
  });

  it('declares the four bins, all under dist/', () => {
    expect(cli.bin).toEqual({
      deflow: './dist/bin.mjs',
      dfl: './dist/bin.mjs',
      'deflow-mcp': './dist/mcp.mjs',
      'deflow-mock-agent': './dist/mock-agent.mjs',
    });
  });

  /**
   * KAR-20.1 AC1, EPIC-20-S1 — `name` is not cosmetic, and as of 2026-08-15 it
   * is not the command either.
   *
   * npm has refused new package names containing capital letters since 2017, so
   * `DeFlow` was never publishable. `deflow` is publishable and *taken* — an
   * unrelated Redis-backed job-flow library at 0.6.4 — and `npx <name>`
   * resolves a **package**, so the install route had to move to a name the
   * registry will actually give us. A `bin` key does not have to match its
   * package, which is why the command a person types did not have to move with
   * it.
   */
  it('is named something npm will give us, and every bin key is lowercase', () => {
    expect(cli.name).toBe('deflowai');
    const keys = Object.keys(cli.bin ?? {});
    expect(keys).toEqual(keys.map((key) => key.toLowerCase()));
    expect(cli.name).toBe(cli.name?.toLowerCase());
  });

  it('keeps the command and its short alias pointing at one entry script', () => {
    // Two `bin` keys, one file: `dfl` is a second name for the same program,
    // not a second program, so there is nothing that can drift between them.
    expect(cli.bin?.['dfl']).toBe(cli.bin?.['deflow']);
  });

  it('points every bin at a file the build produces', () => {
    // `scripts/build.ts` chmods exactly these three, and `tsdown` emits them
    // from the three entry sources. A bin key renamed without its target
    // shipping is invisible from inside the monorepo — that is EPIC-20-S2's
    // whole argument, and this is the half of it that can be read off disk.
    const emitted = readText('packages/cli/scripts/build.ts');
    for (const [name, target] of Object.entries(cli.bin ?? {})) {
      const file = target.replace('./dist/', '');
      expect([name, emitted.includes(`'${file}'`)]).toEqual([name, true]);
      expect([name, exists(`packages/cli/src/${file.replace('.mjs', '.ts')}`)]).toEqual([
        name,
        true,
      ]);
    }
  });

  it('is selected by its new name wherever the workspace selects it by name', () => {
    // A filter naming the old package name still exits 0 and selects
    // *nothing*, which is the quiet half of a rename that looks finished.
    const packCheck = root.scripts?.['pack:check'] ?? '';
    expect(packCheck).toContain(`--filter ${String(cli.name)} `);
    expect(packCheck.match(/--filter (\S+)/g)).toEqual([
      `--filter ${String(cli.name)}`,
      `--filter ${String(cli.name)}`,
    ]);
  });
});

suite('the published dependency graph (AC2, AC7)', () => {
  const runtime = {
    ...(cli.dependencies ?? {}),
    ...((cli as { optionalDependencies?: Record<string, string> }).optionalDependencies ?? {}),
    ...((cli as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
  };

  it('asks npm for the two natives and nothing else', () => {
    // Everything else is inlined by tsdown, so anything left here is either a
    // native or a leak. A `@DeFlow/*` name in this object is the worst case:
    // they are all private, so npm answers 404 and the install fails.
    expect(Object.keys(runtime).sort()).toEqual([...EXTERNAL_NATIVES].sort());
  });

  it('makes @lydell/node-pty optional and better-sqlite3 required', () => {
    expect(cli.optionalDependencies).toEqual({ '@lydell/node-pty': 'catalog:' });
    expect(cli.dependencies).toEqual({ 'better-sqlite3': 'catalog:' });
  });

  it('never lists vite, in any dependency field', () => {
    expect(JSON.stringify(runtime)).not.toContain('vite');
  });

  it('imports vite dynamically, and only under DeFlow_DEV', () => {
    const importers = packageProductionSources().filter(({ text }) =>
      /(?:from|import)\s*\(?\s*['"]vite['"]/.test(text),
    );

    // One importer, one import, and it is an `await import(...)` inside the dev
    // branch. A static `import { createServer } from 'vite'` at the top of the
    // same file would be invisible in development and would drag a dev server
    // into the published tarball.
    expect(importers.map(({ path }) => path)).toEqual(['packages/daemon/src/http/server.ts']);
    for (const source of importers) {
      expect(source.text).not.toMatch(/^\s*import\s[^\n]*from\s+['"]vite['"]/m);
      expect(source.text).toContain("await import('vite')");
      expect(source.text).toContain("process.env.DeFlow_DEV === '1'");
    }
  });
});

suite('the UI is found relative to the module that serves it (AC1, EPIC-18-S37)', () => {
  // A source assertion rather than a bundle one, deliberately. `dist/ui/` is a
  // sibling of the emitted JavaScript, so `./ui/` relative to
  // `import.meta.url` is the same path in the workspace and in the tarball —
  // and that is a property of how the daemon asks, not of what the bundler
  // emitted. The build spec next door asserts the files are there; this asserts
  // nothing ever computes their location from `process.cwd()`, which would work
  // from the repository root and from nowhere else.
  const server = readText('packages/daemon/src/http/server.ts');

  it('resolves ./ui/ from import.meta.url', () => {
    expect(server).toContain("fileURLToPath(new URL('./ui/', import.meta.url))");
  });

  it('never resolves it from the working directory', () => {
    expect(server).not.toMatch(/process\.cwd\(\)[^\n]*ui/);
  });
});

suite('the fixed build order and the release gate (AC1, AC4)', () => {
  it('the root build script runs one orchestrator, so the order lives in one place', () => {
    expect(root.scripts?.build).toBe('node packages/cli/scripts/build.ts');
  });

  it('pack:check builds first, then runs publint and attw --pack', () => {
    const packCheck = root.scripts?.['pack:check'] ?? '';
    expect(packCheck).toContain('pnpm build');
    expect(packCheck).toContain('publint');
    expect(packCheck).toContain('attw --pack');
    // Order matters: linting a package whose dist/ is stale lints the previous
    // release.
    expect(packCheck.indexOf('pnpm build')).toBeLessThan(packCheck.indexOf('publint'));
  });

  it('pins both package-shape linters exactly, at the versions the story names', () => {
    const catalog = readWorkspaceYaml().catalog ?? {};
    expect(catalog['publint']).toBe('0.3.22');
    expect(catalog['@arethetypeswrong/cli']).toBe('0.18.5');
  });

  it('fails CI, in the one job that is not held back behind a repository variable', () => {
    // AC4's last clause. It goes in `check` rather than in the test matrix
    // because the matrix is currently gated on RUN_TESTS_IN_CI (owner's
    // decision, 2026-08-05) and a release gate nobody runs is not a gate. It is
    // also the only step in that job that proves the *tarball* builds at all,
    // which no amount of typechecking does.
    const workflow = readYaml<{
      jobs: Record<string, { if?: string; steps?: { run?: string }[] }>;
    }>('.github/workflows/ci.yml');
    const check = workflow.jobs['check'];

    expect(check?.if).toBeUndefined();
    expect((check?.steps ?? []).map((step) => step.run)).toContain('pnpm pack:check');
  });

  it('keeps both linters out of the published package, as devDependencies', () => {
    expect(cli.devDependencies?.['publint']).toBe('catalog:');
    expect(cli.devDependencies?.['@arethetypeswrong/cli']).toBe('catalog:');
  });
});

/**
 * AC5. The guards themselves are shared (`test/support/guards.ts`) and are run
 * against the real workspace by `test/typescript-config.test.ts` and
 * `test/import-conventions.test.ts`. What this story adds is the requirement on
 * the *message*: both mistakes are green in `pnpm dev`, so a bare "expected []
 * to equal []" teaches the next person nothing about why it matters.
 */
suite('the two mistakes that are invisible until someone installs the package (AC5)', () => {
  it('no tsconfig in the workspace declares a paths alias', () => {
    expect(render(checkNoPathsAlias(tsconfigFiles()))).toBe('');
  });

  it('says why a paths alias survives into the emitted JavaScript', () => {
    const message = render(
      checkNoPathsAlias([
        {
          path: 'tsconfig.base.json',
          json: { compilerOptions: { paths: { '@/*': ['src/*'] } } },
        },
      ]),
    );

    expect(message).toContain('rewriteRelativeImportExtensions');
    expect(message).toContain('microsoft/TypeScript#61991');
    expect(message).toContain('module-not-found');
    expect(message).toContain('development');
  });

  it('names the file, the specifier and the package contract for a deep import', () => {
    const message = render(
      checkNoDeepWorkspaceImports(
        [
          {
            path: 'packages/daemon/src/plan/apply.ts',
            text: "import { reduce } from '@DeFlow/core/src/reduce.ts';",
          },
        ],
        ['@DeFlow/core'],
      ),
    );

    expect(message).toContain('packages/daemon/src/plan/apply.ts');
    expect(message).toContain('@DeFlow/core/src/reduce.ts');
    expect(message).toContain('does not exist in the tarball');
    expect(message).toContain('publishConfig swaps exports "." to ./dist/index.js');
    // S41's last clause: the rule is not "deep imports are untidy", it is that
    // index.ts is the whole of what a package promises.
    expect(message).toContain("index.ts is the package's contract");
  });
});
