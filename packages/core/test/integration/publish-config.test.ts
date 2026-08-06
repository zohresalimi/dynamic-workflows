/**
 * The publishConfig exports-override trick: the workspace resolves
 * @DeFlow/core to live TypeScript source, the tarball resolves it to built
 * JavaScript. @DeFlow/* are never actually published, so this is
 * belt-and-braces — it exists so that the day someone packs one of them, the
 * result is correct rather than a package pointing at .ts files.
 *
 * Verifies: EPIC-01-S2 (the pack half) · AC10
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { readJson, repoRoot } from '../../../../test/support/workspace.ts';

let packed: Record<string, unknown>;
// Undefined until beforeAll runs, and stays that way if it throws before the
// assignment — afterAll's guard exists for exactly that path, so the type
// stays honestly optional rather than asserted.
let tarballDir: string | undefined;

/** What a failed child said for itself, folded into the assertion message. */
function describe(
  command: string,
  child: { readonly status: number | null; readonly stdout: string; readonly stderr: string },
): string {
  return [
    `\n${command} exited ${String(child.status)}`,
    `--- stdout\n${child.stdout.trim()}`,
    `--- stderr\n${child.stderr.trim()}`,
  ].join('\n');
}

beforeAll(() => {
  tarballDir = mkdtempSync(join(tmpdir(), 'DeFlow-core-pack-'));
  const pack = spawnSync('pnpm', ['pack', '--pack-destination', tarballDir], {
    cwd: join(repoRoot, 'packages/core'),
    encoding: 'utf8',
  });
  // Reported with the child's own output, not as a bare "expected 254 to be
  // 0". `pnpm` collapses every thrown error onto exit 254, so the status alone
  // names nothing; this pack has failed that way once under a saturated suite
  // and left no evidence of which error it was. The assertion is unchanged —
  // only what a failure says about itself.
  expect(pack.status, describe('pnpm pack', pack)).toBe(0);

  const tarball = readdirSync(tarballDir).find((entry) => entry.endsWith('.tgz'));
  expect(tarball, `a .tgz was produced${describe('pnpm pack', pack)}`).toBeDefined();

  const untar = spawnSync('tar', ['-xzf', tarball ?? '', '-C', tarballDir], {
    cwd: tarballDir,
    encoding: 'utf8',
  });
  expect(untar.status, describe('tar -xzf', untar)).toBe(0);

  packed = JSON.parse(readFileSync(join(tarballDir, 'package/package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}, 120_000);

afterAll(() => {
  if (tarballDir !== undefined) rmSync(tarballDir, { recursive: true, force: true });
});

suite('pnpm pack applies publishConfig', () => {
  it('resolves "." to built JavaScript in the tarball', () => {
    expect(packed.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
  });

  it('leaves the workspace manifest pointing at live source', () => {
    expect(readJson('packages/core/package.json').exports).toEqual({ '.': './src/index.ts' });
  });

  it('strips publishConfig from the packed manifest', () => {
    expect(packed.publishConfig).toBeUndefined();
  });
});
