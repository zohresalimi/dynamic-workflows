/**
 * KAR-01.2 — the erasable-syntax constraint, enforced by both ends.
 *
 * D4 is permanent: Node's type stripping is stable, but
 * "--experimental-transform-types" was removed in Node 26.0.0, so any syntax
 * needing a runtime emit is now unrunnable by "node file.ts" forever.
 * "erasableSyntaxOnly" catches exactly five constructs at the compiler level
 * (verified against the compiler's own diagnostic call sites, not assumed from
 * the docs table): enum/const enum, a namespace carrying runtime code,
 * constructor parameter properties and "import X = require(...)". Real
 * subprocesses throughout — no mocked child_process.
 *
 * Verifies: EPIC-01-S6, EPIC-01-S7 · AC3, AC4, AC5
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { repoRoot } from '../support/workspace.ts';

const TSC = join(repoRoot, 'node_modules/.bin/tsc');
const NODE_TYPE_ROOTS = join(repoRoot, 'node_modules/@types');

let workdir: string;

function fixtureTsconfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(workdir, 'tsconfig.json'),
    JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: { typeRoots: [NODE_TYPE_ROOTS] },
      include: ['src'],
      ...extra,
    }),
  );
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'DeFlow-erasable-'));
  cpSync(join(repoRoot, 'tsconfig.base.json'), join(workdir, 'tsconfig.base.json'));
  writeFileSync(
    join(workdir, 'package.json'),
    JSON.stringify({ name: 'erasable-fixture', private: true, type: 'module' }),
  );
  mkdirSync(join(workdir, 'src'));
  fixtureTsconfig();
});

afterEach(() => {
  if (workdir !== undefined && process.env.DeFlow_KEEP_TMP !== '1') {
    rmSync(workdir, { recursive: true, force: true });
  }
});

function writeFixture(code: string): string {
  const file = join(workdir, 'src', 'index.ts');
  writeFileSync(file, code);
  return file;
}

function runTsc(): { status: number | null; output: string } {
  const result = spawnSync(TSC, ['-p', join(workdir, 'tsconfig.json')], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

suite('erasableSyntaxOnly rejects banned syntax at compile time (AC4)', () => {
  // Verified against the compiler's own diagnostic call sites in
  // typescript.js: TS1294 fires from exactly checkParameter,
  // checkEnumDeclarationWorker, the namespace-with-runtime-code check,
  // checkImportEqualsDeclaration and checkExportAssignment.
  const CONSTRUCTS: ReadonlyArray<readonly [name: string, code: string]> = [
    ['enum', 'enum Status { Ok, Fail }\nexport { Status };\n'],
    ['const enum', 'const enum Level { Read }\nexport { Level };\n'],
    [
      'a namespace carrying runtime code',
      'namespace X {\n  export const y = 1;\n}\nexport { X };\n',
    ],
    [
      'a constructor parameter property',
      'class C {\n  constructor(private readonly db: number) {}\n}\nexport { C };\n',
    ],
    ['import X = require(...)', 'import Foo = require("node:path");\nexport { Foo };\n'],
  ];

  it.each(CONSTRUCTS)('%s fails with error TS1294', (_name, code) => {
    writeFixture(code);
    const { status, output } = runTsc();
    expect(status).not.toBe(0);
    expect(output).toContain(
      "error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.",
    );
  });
});

suite('the runtime rejects the same syntax, which is what a developer meets first (AC5)', () => {
  it('node fails at runtime on the enum from the user story, with an unsupported-syntax error', () => {
    const file = writeFixture('enum Status { Ok, Fail }\nexport { Status };\n');
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(
      'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
    );
  });
});

suite(
  'a type error in an upstream project surfaces where it is consumed (EPIC-01-S6 scenario 2)',
  () => {
    it('reports the error against the consumer and emits no build artefact, because noEmit is true', () => {
      const upstream = join(workdir, 'upstream');
      const consumer = join(workdir, 'consumer');
      mkdirSync(join(upstream, 'src'), { recursive: true });
      mkdirSync(join(consumer, 'src'), { recursive: true });
      for (const dir of [upstream, consumer]) fixtureTsconfigAt(dir);
      writeFileSync(join(upstream, 'src', 'index.ts'), 'export function f(x: string): void {}\n');
      writeFileSync(
        join(consumer, 'src', 'index.ts'),
        "import { f } from '../../upstream/src/index.ts';\nf(123);\n",
      );
      writeFileSync(
        join(workdir, 'solution.tsconfig.json'),
        JSON.stringify({ files: [], references: [{ path: './upstream' }, { path: './consumer' }] }),
      );

      const result = spawnSync(TSC, ['-b', join(workdir, 'solution.tsconfig.json')], {
        encoding: 'utf8',
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain('consumer/src/index.ts');
      expect(output).toContain(
        "Argument of type 'number' is not assignable to parameter of type 'string'",
      );

      const emitted = [
        ...readdirSync(join(upstream, 'src')),
        ...readdirSync(join(consumer, 'src')),
      ];
      expect(emitted.some((name) => name.endsWith('.js') || name.endsWith('.d.ts'))).toBe(false);
    });

    function fixtureTsconfigAt(dir: string): void {
      cpSync(join(repoRoot, 'tsconfig.base.json'), join(dir, 'tsconfig.base.json'));
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: './tsconfig.base.json',
          compilerOptions: { typeRoots: [NODE_TYPE_ROOTS] },
          include: ['src'],
        }),
      );
    }
  },
);

suite('the real workspace solution build (EPIC-01-S6 happy path, AC3)', () => {
  // This spec's timeout is its own, not the integration slice's 30 s default,
  // and the number is measured rather than guessed. A whole `tsc -b` over the
  // nine-package solution graph is the most expensive single subprocess the
  // suite starts, and it is cold every time: with `noEmit` the projects are not
  // composite, so `.tsbuildinfo` buys nothing and the run is a full check on
  // every invocation — measured 2026-08-06, TypeScript 6.0.3, on an 8-core
  // machine: 4.90 s, 5.03 s, 5.10 s and 5.20 s, with and without the
  // buildinfo files present, which is why they are indistinguishable.
  //
  // What the 30 s default was actually measuring was the box. The same cold
  // build takes 13.8 s beside twelve CPU hogs and 24.1 s beside a live full
  // suite — a hundred forked workers, several of them driving real agent
  // subprocesses — and on the EPIC-07 gate run it went past 30 s and killed the
  // spec. Nothing was wrong with the build: it was the ceiling that had been
  // sized on an idle machine.
  //
  // Re-measured 2026-08-12 on the EPIC-18 gate, because the build this ceiling
  // was sized against no longer exists. The 5 s idle figure above was taken
  // when the solution graph was mostly empty; EPIC-15, EPIC-16, EPIC-17 and
  // EPIC-18 have since filled in packages/daemon, packages/web and
  // packages/cli, and the same cold check now costs 15.3 s, 16.0 s and 16.2 s
  // idle on the same 8-core machine — three consecutive runs with the buildinfo
  // files present, still indistinguishable, because `noEmit` still means they
  // buy nothing. Beside eight CPU hogs it costs 24.7 s, 32.0 s and 35.0 s, and
  // beside a live full suite it was measured at 157.7 s. It had already
  // overrun the 120 s ceiling twice on this gate.
  //
  // So the ceiling tripled with the build rather than the build regressing:
  // 24.7 s of CPU, single-threaded for most of its life, against eight forked
  // workers that are themselves spawning real git and agent subprocesses.
  //
  // 600 s is ~37x the idle build and ~3.8x the worst sample measured beside a
  // full suite. It still buys no slack in what is asserted — exit 0, with the
  // compiler's own output as the message — and there is no timing claim here to
  // weaken: this ceiling exists only so that a genuinely wedged `tsc` fails in
  // bounded time instead of hanging the slice. The real "does the workspace
  // still typecheck" gate is `pnpm typecheck`, which runs unloaded.
  //
  // The neighbouring `vue-tsc` spec keeps the default: it covers one package,
  // measures 1.33 s idle, and has never been near the ceiling.
  it('"tsc -b" typechecks all nine packages in dependency order and exits 0', () => {
    const result = spawnSync(TSC, ['-b', join(repoRoot, 'tsconfig.json')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
  }, 600_000);

  it('"vue-tsc --noEmit" passes against packages/web on an empty workspace', () => {
    expect(existsSync(join(repoRoot, 'packages/web/node_modules/.bin/vue-tsc'))).toBe(true);
    const result = spawnSync('pnpm', ['--filter', '@DeFlow/web', 'exec', 'vue-tsc', '--noEmit'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
  });
});
