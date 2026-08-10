/**
 * KAR-12.6 test plan #4, #5, #6 — discovery against a real `.DeFlow/gates/`
 * directory, a real edited file, and a real malformed one.
 *
 * Verifies: EPIC-12-S36, EPIC-12-S37 · AC1, AC2, AC3
 */
import { it } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { GateLoadError } from '../../src/definition.ts';
import {
  checkGateDivergence,
  discoverGateDefinitions,
  type GateManifestEntry,
  sealDivergedVerdict,
} from '../../src/discovery.ts';

const TYPECHECK = `id: typecheck
kind: deterministic
title: TypeScript project check
run: pnpm exec tsc -p tsconfig.json --noEmit
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-3]
`;

const BUNDLE_BUDGET = `id: bundle-budget
kind: deterministic
title: Bundle size budget
run: node scripts/bundle-budget.mjs --json
cwd: worktree
timeout: 120s
effect: pure
expect:
  exitCode: 0
findings:
  parser: jsonl
  path: $.violations
satisfies: [ac-11]
`;

const A11Y = `id: a11y
kind: deterministic
title: Accessibility audit
run: node scripts/a11y.mjs --json
cwd: worktree
timeout: 60s
effect: pure
expect:
  exitCode: 0
findings:
  parser: none
`;

async function writeGates(dir: string, files: Readonly<Record<string, string>>): Promise<string> {
  const gatesDir = join(dir, '.DeFlow', 'gates');
  await mkdir(gatesDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(gatesDir, name), body);
  }
  return gatesDir;
}

const sha256sum = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

suite('discovering a real .DeFlow/gates/ directory (test plan #4)', () => {
  it('carries three sha256 values matching sha256sum on disk', async ({ tmp }) => {
    const gatesDir = await writeGates(tmp, {
      'typecheck.yaml': TYPECHECK,
      'bundle-budget.yml': BUNDLE_BUDGET,
      'a11y.yaml': A11Y,
    });

    const discovered = await discoverGateDefinitions({ gatesDir });

    expect(discovered.map((entry) => entry.id).toSorted()).toEqual([
      'a11y',
      'bundle-budget',
      'typecheck',
    ]);
    for (const entry of discovered) {
      const onDisk = await sha256sum(
        join(gatesDir, `${entry.id}.${entry.id === 'bundle-budget' ? 'yml' : 'yaml'}`),
      );
      expect(entry.sha256).toBe(onDisk);
    }
  });

  it('includes a built-in derived from a package.json script, path naming the recon source', async ({
    tmp,
  }) => {
    const gatesDir = await writeGates(tmp, { 'a11y.yaml': A11Y });

    const discovered = await discoverGateDefinitions({
      gatesDir,
      scripts: { typecheck: 'tsc -b' },
    });

    const builtin = discovered.find((entry) => entry.id === 'typecheck');
    expect(builtin?.path).toBe('package.json#scripts.typecheck');
  });
});

suite('a bad definition refuses the run (test plan #6)', () => {
  it('names the offending file rather than skipping it', async ({ tmp }) => {
    const gatesDir = await writeGates(tmp, {
      'typecheck.yaml': TYPECHECK,
      'bundle-budget.yml': BUNDLE_BUDGET,
      'a11y.yaml': 'id: [unclosed\n',
    });

    await expect(discoverGateDefinitions({ gatesDir })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GateLoadError);
      expect((error as GateLoadError).file).toContain('a11y.yaml');
      return true;
    });
  });
});

suite('a gate file edited mid-run diverges from the manifest (test plan #5, S37)', () => {
  it('needs-human with gate-definition-diverged and both hashes; the gate never runs', async ({
    tmp,
  }) => {
    const gatesDir = await writeGates(tmp, { 'typecheck.yaml': TYPECHECK });
    const [discovered] = await discoverGateDefinitions({ gatesDir });
    if (discovered === undefined) throw new Error('unreachable');

    const manifestEntry: GateManifestEntry = {
      id: discovered.id,
      path: discovered.path,
      sha256: discovered.sha256,
    };

    // The file is edited after `gates.loaded` recorded its hash.
    await writeFile(join(gatesDir, 'typecheck.yaml'), `${TYPECHECK}\n# loosened for a review\n`);

    const currentBytes = await readFile(join(gatesDir, 'typecheck.yaml'));
    const divergence = checkGateDivergence(manifestEntry, currentBytes);
    expect(divergence.diverged).toBe(true);

    // Whether or not the gate runs is decided *before* `runGate` is ever
    // called — this is the whole of "does not run against the new definition
    // and does not run against the cached one either". A caller that finds
    // `diverged: true` never reaches the runner at all.
    let ranTheGate = false;
    const verdict = divergence.diverged
      ? sealDivergedVerdict({
          gate: discovered.id as never,
          node: 'gate-typecheck' as never,
          evaluatedNode: 'impl-1' as never,
          specHash: `sha256-${'a'.repeat(64)}`,
          criteria: discovered.definition.satisfies,
          manifestSha256: divergence.manifestSha256,
          currentSha256: divergence.currentSha256,
          durationMs: 0,
        })
      : ((ranTheGate = true), null);

    expect(ranTheGate).toBe(false);
    expect(verdict?.outcome).toBe('needs-human');
    expect(verdict?.summary).toContain('gate-definition-diverged');
    expect(verdict?.summary).toContain(divergence.manifestSha256);
    expect(verdict?.summary).toContain(divergence.currentSha256);
  });

  it('an unrelated gate file edit does not affect this gate', async ({ tmp }) => {
    const gatesDir = await writeGates(tmp, { 'typecheck.yaml': TYPECHECK, 'a11y.yaml': A11Y });
    const discovered = await discoverGateDefinitions({ gatesDir });
    const typecheckEntry = discovered.find((entry) => entry.id === 'typecheck');
    if (typecheckEntry === undefined) throw new Error('unreachable');

    await writeFile(join(gatesDir, 'a11y.yaml'), `${A11Y}\n# edited\n`);

    const currentBytes = await readFile(join(gatesDir, 'typecheck.yaml'));
    const divergence = checkGateDivergence(typecheckEntry, currentBytes);
    expect(divergence.diverged).toBe(false);
  });
});
