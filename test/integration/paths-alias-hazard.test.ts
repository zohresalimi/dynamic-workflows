/**
 * KAR-18.5 — why `checkNoPathsAlias` exists, demonstrated against the real
 * compiler rather than asserted from the issue tracker.
 *
 * The guard in `packages/cli/test/packaging.test.ts` fails if any
 * `tsconfig*.json` declares a `paths` key. A guard is only worth its
 * maintenance if the thing it forbids really is fatal, and this one forbids a
 * setting most TypeScript projects use happily. What makes it fatal *here* is
 * that this layout has no bundler resolution step for types (D4, ESM-only,
 * `rewriteRelativeImportExtensions`): an alias is a compile-time fiction that
 * nothing rewrites, so it reaches the emitted JavaScript verbatim and Node has
 * no idea what `@/` means.
 *
 * The spec carries its own control. If it only asserted "the alias survived" it
 * could pass on a compiler that had stopped rewriting anything at all, which
 * would make the hazard imaginary and the guard superstition. So the same
 * fixture, the same compiler invocation and the same emitted file must show a
 * *relative* `.ts` specifier being rewritten to `.js` — the feature working —
 * beside the aliased one that is not.
 *
 * **Amended 2026-08-12 on the EPIC-18 gate.** EPIC-18-S40 was written as
 * "green in dev, broken in the tarball, no warning", citing
 * microsoft/TypeScript#61991. Measured against TypeScript 6.0.3 that last
 * clause is no longer true, and the flow file has been corrected to match: the
 * compiler *does* flag both spellings of the alias, `@/patch.ts` with TS2877
 * ("will not be rewritten during emit because it is not a relative path") and
 * `@/patch` with TS2307 (`nodenext` needs the extension the alias cannot
 * supply). What has not changed is the part the guard is really for — `tsc`
 * emits the broken file anyway, and the release build is `tsdown`, which does
 * not typecheck at all. So the alias still reaches a tarball; it is the
 * compiler's silence, not the breakage, that was overstated.
 *
 * Real `tsc` as a subprocess and real `node` on the emitted output, because
 * every claim here is a claim about what those two programs do.
 *
 * Verifies: EPIC-18-S40 (the hazard scenario) · AC5
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { repoRoot } from '../support/workspace.ts';

const TSC = join(repoRoot, 'node_modules/.bin/tsc');
const NODE_TYPE_ROOTS = join(repoRoot, 'node_modules/@types');

interface Build {
  readonly status: number | null;
  readonly output: string;
  readonly emitted: string;
  readonly dir: string;
}

const builds = new Map<string, Build>();
let root: string;

/**
 * One fixture per aliased spelling, each compiled on its own. `patch` is
 * reached through the alias; `helper` is reached relatively, from the same
 * file, so the control and the hazard cannot differ in how they were compiled.
 */
function build(name: string, aliasSpecifier: string): Build {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  cpSync(join(repoRoot, 'tsconfig.base.json'), join(dir, 'tsconfig.base.json'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `paths-alias-${name}`, private: true, type: 'module' }),
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        typeRoots: [NODE_TYPE_ROOTS],
        // No `baseUrl`: deprecated in TypeScript 6 (TS5101) and unneeded since
        // 4.4 — a bare `paths` resolves relative to this tsconfig, which is
        // also the spelling the workspace guard has to catch.
        paths: { '@/*': ['./src/*'] },
        noEmit: false,
        rootDir: 'src',
        outDir: 'dist',
      },
      include: ['src'],
    }),
  );
  writeFileSync(join(dir, 'src/patch.ts'), 'export const patch = "aliased";\n');
  writeFileSync(join(dir, 'src/helper.ts'), 'export const helper = "relative";\n');
  writeFileSync(
    join(dir, 'src/index.ts'),
    [
      `import { patch } from "${aliasSpecifier}";`,
      'import { helper } from "./helper.ts";',
      'console.log(patch, helper);',
      '',
    ].join('\n'),
  );

  const tsc = spawnSync(TSC, ['-p', join(dir, 'tsconfig.json')], { cwd: dir, encoding: 'utf8' });
  return {
    status: tsc.status,
    output: `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`,
    // `tsc` emits through a type error unless `noEmitOnError` is set, which is
    // the whole reason a broken bundle is reachable from here.
    emitted: readFileSync(join(dir, 'dist/index.js'), 'utf8'),
    dir,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'DeFlow-paths-alias-'));
  builds.set('extension', build('extension', '@/patch.ts'));
  builds.set('bare', build('bare', '@/patch'));
}, 180_000);

afterAll(() => {
  if (root !== undefined && process.env.DeFlow_KEEP_TMP !== '1') {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Never undefined in practice; the cast keeps the assertions readable. */
const built = (name: string): Build => builds.get(name) as Build;

suite('a "paths" alias survives emit and breaks at runtime (EPIC-18-S40)', () => {
  it('rewrites the relative ".ts" specifier to ".js" — the control', () => {
    // rewriteRelativeImportExtensions is genuinely on and genuinely working in
    // this fixture. Without this the assertions below would also pass on a
    // compiler that rewrote nothing at all.
    const { emitted } = built('extension');
    expect(emitted).toContain('./helper.js');
    expect(emitted).not.toContain('./helper.ts');
  });

  it('leaves the aliased specifier untouched in the emitted JavaScript', () => {
    // The same emit, the same file, the other specifier: the alias survives
    // verbatim in both spellings. Nothing downstream of `tsc` will fix it,
    // because in this layout there is nothing downstream of `tsc` that resolves
    // types at all.
    expect(built('extension').emitted).toContain('@/patch.ts');
    expect(built('bare').emitted).toContain('@/patch');
  });

  it('fails at runtime with a module-not-found error, where a user finds it', () => {
    // The alias is a compile-time fiction; node has no idea what "@/" means and
    // this layout ships no bundler to invent one.
    for (const name of ['extension', 'bare']) {
      const { dir } = built(name);
      const run = spawnSync(process.execPath, [join(dir, 'dist/index.js')], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(run.status, `${name}: node exited ${String(run.status)}`).not.toBe(0);
      expect(run.stderr, `${name} stderr`).toContain('ERR_MODULE_NOT_FOUND');
    }
  });

  it('is flagged by TypeScript 6, which the release build does not run', () => {
    // Recorded rather than assumed, because EPIC-18-S40 originally claimed the
    // opposite. Both spellings are diagnosed — but `tsc` still emitted the
    // broken file above, and `pnpm build` is tsdown, which never typechecks.
    // That gap is exactly the width of the guard.
    expect(built('extension').status).not.toBe(0);
    expect(built('extension').output).toContain('TS2877');
    expect(built('bare').status).not.toBe(0);
    expect(built('bare').output).toContain('TS2307');
  });
});
