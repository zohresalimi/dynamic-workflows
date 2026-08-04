/**
 * KAR-00.2 — Spike: zero-build dev loop through pnpm workspace symlinks.
 *
 * The one load-bearing assumption behind the whole dev story
 * (docs/03-local-development.md): does `node` type-strip a `.ts` file
 * resolved through a pnpm workspace symlink inside `node_modules`? This spike
 * answers it with real subprocesses — a real `pnpm install`, real `node`
 * binaries for majors 24 and 26, a real `vitest run`, `tsc -b`, `vite build`
 * and `pnpm pack` — against the throwaway workspace at spikes/s2-zero-build/.
 * Nothing is mocked; the whole point is that the answer is an executed fact.
 *
 * Verifies: EPIC-00-S1, EPIC-00-S3 · AC1, AC2, AC3, AC4, AC5, AC6.
 *
 * EPIC-00-S2 is deliberately NOT verified here: its Given is "`node
 * a/src/main.ts` failed to strip types", and it did not fail, so its fallback
 * branch (adopt tsx@4.23.4, change KAR-01.3 AC 2 and 5, lose node --watch
 * crash-resume) is not applicable and nothing below asserts it. What the S2
 * suite below asserts instead is the counterfactual: the
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING refusal S2 predicted is real on
 * both majors, and the pnpm symlink is exactly what avoids it — so the fallback
 * was not needed rather than merely not reached. See
 * docs/spikes/S2-zero-build.md and the Outcome note on EPIC-00-S2 in
 * docs/delivery/flows/EPIC-00-foundation-spikes-flows.md.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { resolveNodeBinary } from '../support/node-majors.ts';
import { repoRoot } from '../support/workspace.ts';

const SPIKE_ROOT = join(repoRoot, 'spikes/s2-zero-build');
const A_DIR = join(SPIKE_ROOT, 'a');
const B_DIR = join(SPIKE_ROOT, 'b');
const B_INDEX = join(B_DIR, 'src/index.ts');

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, npm_config_update_notifier: 'false' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function pnpm(args: string[], cwd: string) {
  return run('pnpm', args, cwd);
}

let node24: string;
let node26: string;

beforeAll(() => {
  node24 = resolveNodeBinary(24);
  node26 = resolveNodeBinary(26);

  // A real, fresh `pnpm install` against the spike's own lockfile-less
  // workspace — the same step AC2 makes load-bearing. Not faked, not skipped
  // even though the packages already declare their wiring on disk.
  const install = pnpm(['install'], SPIKE_ROOT);
  if (install.status !== 0) {
    throw new Error(`pnpm install failed in ${SPIKE_ROOT}:\n${install.stdout}${install.stderr}`);
  }
}, 120_000);

afterAll(() => {
  for (const path of [
    join(A_DIR, 'dist'),
    join(A_DIR, 'tsconfig.tsbuildinfo'),
    join(B_DIR, 'dist'),
    join(B_DIR, 'tsconfig.tsbuildinfo'),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
});

suite('EPIC-00-S1 — zero-build import across a pnpm workspace symlink, on both Node majors', () => {
  it.each([
    ['24', () => node24],
    ['26', () => node26],
  ])('node %s runs a/src/main.ts through the @spike/b symlink and exits 0', (_label, getBin) => {
    const result = run(getBin(), ['src/main.ts'], A_DIR);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello from @spike/b');
    // AC2's "no build step" half: nothing was ever compiled to produce this.
    expect(existsSync(join(B_DIR, 'dist'))).toBe(false);
  });

  it('vitest resolves @spike/b the same way node does (AC3)', () => {
    const result = pnpm(['exec', 'vitest', 'run'], A_DIR);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/1 passed/);
  });

  it('tsc -b typechecks the two-project graph across the symlink (AC3)', () => {
    const result = pnpm(['exec', 'tsc', '-b'], SPIKE_ROOT);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('vite build resolves @spike/b for a bundled entry (AC3)', () => {
    const result = pnpm(['exec', 'vite', 'build'], A_DIR);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(A_DIR, 'dist/scratch.js'))).toBe(true);
  });
});

/**
 * A minimal two-package fixture in a fresh tmpdir, wired the same way as
 * spikes/s2-zero-build/ but with one variable exposed: how "@spike/b" is
 * materialised inside "a/node_modules/@spike/". `symlink` reproduces what
 * `pnpm install` does; `directory` is what a non-workspace install (or a
 * `--node-linker=hoisted` copy) leaves behind. Nothing else differs, so the
 * two runs isolate exactly the realpath question S2 turns on.
 */
function materialiseFixture(linkage: 'symlink' | 'directory'): string {
  const root = mkdtempSync(join(tmpdir(), `DeFlow-spike-s2-${linkage}-`));
  cpSync(join(B_DIR, 'src'), join(root, 'b/src'), { recursive: true });
  cpSync(join(B_DIR, 'package.json'), join(root, 'b/package.json'));
  cpSync(join(A_DIR, 'src'), join(root, 'a/src'), { recursive: true });
  cpSync(join(A_DIR, 'package.json'), join(root, 'a/package.json'));

  const scope = join(root, 'a/node_modules/@spike');
  mkdirSync(scope, { recursive: true });
  if (linkage === 'symlink') {
    symlinkSync('../../../b', join(scope, 'b'), 'dir');
  } else {
    cpSync(join(root, 'b'), join(scope, 'b'), { recursive: true });
  }
  return root;
}

suite(
  'EPIC-00-S2 — the node_modules type-stripping refusal is real, and the symlink is what avoids it',
  () => {
    const fixtures: string[] = [];

    afterAll(() => {
      for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    });

    function runFixture(linkage: 'symlink' | 'directory', bin: string) {
      const root = materialiseFixture(linkage);
      fixtures.push(root);
      return run(bin, ['src/main.ts'], join(root, 'a'));
    }

    it.each([
      ['24', () => node24],
      ['26', () => node26],
    ])(
      'node %s refuses to type-strip @spike/b when it is a real directory under node_modules',
      (_label, getBin) => {
        const result = runFixture('directory', getBin());
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
      },
    );

    it.each([
      ['24', () => node24],
      ['26', () => node26],
    ])(
      'node %s strips types happily when the only change is that @spike/b is a symlink',
      (_label, getBin) => {
        const result = runFixture('symlink', getBin());
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('hello from @spike/b');
        expect(result.stderr).not.toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
      },
    );

    it('pnpm leaves the real spike workspace in the symlinked shape, with a realpath outside node_modules', () => {
      const link = join(A_DIR, 'node_modules/@spike/b');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link).includes(`${sep}node_modules${sep}`)).toBe(false);
    });

    it("the decision note records S2's precondition as not applicable rather than verified", () => {
      const note = readFileSync(join(repoRoot, 'docs/spikes/S2-zero-build.md'), 'utf8');
      expect(note).toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
      expect(note).toContain('not applicable');
      expect(note).toContain('tsx@4.23.4');
      // The fallback branch's own consequences (KAR-01.3 AC 2 and 5) are named as
      // *unchanged*, which is the claim that has to be legible to a later reader.
      expect(note).toMatch(/KAR-01\.3'?s? acceptance criteria 2 and 5[\s\S]{0,80}unchanged/);
    });
  },
);

suite('EPIC-00-S3 — non-erasable syntax in a linked package fails at runtime', () => {
  const original = readFileSync(B_INDEX, 'utf8');

  afterAll(() => {
    writeFileSync(B_INDEX, original);
  });

  it.each([
    ['enum', 'enum Status2 { Ok, Fail }'],
    ['namespace', 'namespace X { export const y = 1; }'],
    ['parameter property', 'class C { constructor(private readonly db: string) {} }'],
  ])('%s is rejected by the runtime, not merely by the compiler (Node 26)', (_label, snippet) => {
    writeFileSync(B_INDEX, `${original}\n${snippet}\n`);
    try {
      const result = run(node26, ['src/main.ts'], A_DIR);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    } finally {
      writeFileSync(B_INDEX, original);
    }
  });

  it('the replacement idiom (a const object plus a derived union) runs on both majors', () => {
    // b/src/index.ts already exports `Status` as `{ ... } as const` plus a
    // derived `StatusValue` union — D4's replacement for `enum`. Every S1 spec
    // above already proves node parses this file successfully; this spec
    // makes the claim explicit rather than incidental.
    expect(original).toContain('as const');
    expect(original).not.toContain('enum ');
    const result = run(node24, ['src/main.ts'], A_DIR);
    expect(result.status).toBe(0);
  });
});

suite('AC5 — the publishConfig exports-override applies at pack time', () => {
  it('pnpm pack on b produces a tarball whose exports point at dist/, not src/', () => {
    const packResult = pnpm(['pack'], B_DIR);
    expect(packResult.status, packResult.stdout + packResult.stderr).toBe(0);

    const tarball = join(B_DIR, 'spike-b-0.0.0.tgz');
    expect(existsSync(tarball)).toBe(true);

    const extractDir = mkdtempSync(join(tmpdir(), 'DeFlow-spike-b-pack-'));
    try {
      const extract = run('tar', ['-xzf', tarball, '-C', extractDir], B_DIR);
      expect(extract.status).toBe(0);

      const packed = JSON.parse(readFileSync(join(extractDir, 'package/package.json'), 'utf8')) as {
        exports: Record<string, unknown>;
      };
      expect(packed.exports).toEqual({
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      });
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
      rmSync(tarball, { force: true });
    }
  });
});

suite('AC6 — the decision note names an explicit outcome', () => {
  it('records "adopt node --watch" and the measured stderr, not a shrug', () => {
    const note = readFileSync(join(repoRoot, 'docs/spikes/S2-zero-build.md'), 'utf8');
    expect(note).toContain('adopt `node --watch`');
    expect(note).toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    expect(note).toMatch(/## Measurement/);
    expect(note).toMatch(/## Decision/);
  });
});
