/**
 * KAR-20.5 — the half of "what gets published is what was tested" that has to
 * produce an artefact before it can assert anything.
 *
 * `packages/cli/package.json` says `"better-sqlite3": "catalog:"` and that is
 * correct; the tarball must not, and the only way to know what the tarball says
 * is to pack it and open it. So this spec packs the real package with `pnpm
 * pack`, reads the manifest out of the tarball, and then — EPIC-20-S42 — puts
 * `catalog:` back and watches the release gate go red, in the manner
 * `build.test.ts`'s "exits non-zero on a deliberately broken exports map"
 * already establishes for publint.
 *
 * `pnpm pack` rather than `pnpm build` first: nothing here reads `dist/`, and
 * the property under test is a field in a manifest, so the expensive step buys
 * nothing. `packBrokenTarball`'s `npm pack` of an extracted copy is reused for
 * the sabotage, because that is the tool a person with no pnpm would reach for
 * and the one whose behaviour this whole story is about.
 *
 * Verifies: EPIC-20-S41 (the artefact half) · EPIC-20-S42 · AC2, AC3
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { repoRoot } from '../../../../test/support/workspace.ts';
import { readPackedManifest, unresolvedSpecifiers } from '../../scripts/release.ts';

const cliDir = join(repoRoot, 'packages/cli');
const releaseScript = join(cliDir, 'scripts/release.ts');

let scratch: string;
let tgz: string;

function verify(tarball: string): { status: number | null; output: string } {
  const child = spawnSync(process.execPath, [releaseScript, '--verify', tarball], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: child.status, output: child.stdout + child.stderr };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'DeFlow-publish-'));
  const packed = execFileSync('pnpm', ['pack', '--pack-destination', scratch, '--json'], {
    cwd: cliDir,
    encoding: 'utf8',
  });
  const entry = JSON.parse(packed) as { filename?: string };
  if (typeof entry.filename !== 'string') {
    throw new Error(`pnpm pack --json returned no filename:\n${packed}`);
  }
  tgz = entry.filename;
}, 120_000);

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

suite('the packed artefact (AC2, EPIC-20-S41)', () => {
  it('resolves the workspace protocol into real versions', () => {
    const manifest = readPackedManifest(tgz);

    expect(manifest.dependencies).toEqual({ 'better-sqlite3': expect.stringMatching(/^\d+\./) });
    expect(manifest.optionalDependencies).toEqual({
      '@lydell/node-pty': expect.stringMatching(/^\d+\./),
    });
  });

  it('carries no specifier only the workspace could resolve', () => {
    const found = unresolvedSpecifiers(readPackedManifest(tgz));
    expect(found.map((entry) => `${entry.block}.${entry.name}=${entry.value}`)).toEqual([]);
  });

  it('is what the release gate passes', () => {
    const ran = verify(tgz);
    expect([ran.status, ran.output]).toEqual([0, expect.stringContaining('no unresolved')]);
  });
});

suite('the gate, observed failing (AC3, EPIC-20-S42)', () => {
  let brokenTgz: string;
  let stage: string;

  beforeAll(() => {
    // The real artefact with one field put back to what deflowai@0.1.0 shipped
    // — not a fixture invented for the test.
    stage = mkdtempSync(join(tmpdir(), 'DeFlow-publish-broken-'));
    execFileSync('tar', ['xzf', tgz, '-C', stage], { encoding: 'utf8' });
    const packageDir = join(stage, 'package');
    const manifestPath = join(packageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...manifest.dependencies, 'better-sqlite3': 'catalog:' };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const out = join(stage, 'out');
    mkdirSync(out, { recursive: true });
    const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', out], {
      cwd: packageDir,
      encoding: 'utf8',
    });
    const [entry] = JSON.parse(packed) as { filename: string }[];
    if (entry === undefined) throw new Error(`npm pack --json returned no entry:\n${packed}`);
    brokenTgz = join(out, entry.filename);
  }, 120_000);

  afterAll(() => {
    if (stage !== undefined) rmSync(stage, { recursive: true, force: true });
  });

  it('exits non-zero, and for the reason rather than by accident', () => {
    const ran = verify(brokenTgz);

    expect(ran.status).not.toBe(0);
    // Asserted on what it said: a verifier that could not find the tarball at
    // all would also exit non-zero and would prove nothing.
    expect(ran.output).toContain('better-sqlite3');
    expect(ran.output).toContain('catalog:');
    expect(ran.output).toContain('dependencies');
  });

  it('names a tarball that does not exist as a different failure', () => {
    const ran = verify(join(stage, 'no-such-package.tgz'));

    expect(ran.status).not.toBe(0);
    expect(ran.output).toContain('no-such-package.tgz');
    expect(ran.output).not.toContain('catalog:');
  });
});
