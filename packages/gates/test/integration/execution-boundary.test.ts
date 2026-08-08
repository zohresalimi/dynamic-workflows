/**
 * KAR-12.1 test plan #11 and the deny list — a gate is not a licence.
 *
 * > "a gate that wants to run a migration against a database is not a gate; it
 * > is an infrastructure action wearing a gate's clothing"
 * > — docs/10-verification-gates.md §2
 *
 * The deny list itself is EPIC-08's. What is asserted here is that the gate
 * path does not route around it, and — because "no child process is spawned"
 * is the actual claim — the binaries the refused commands name are **real
 * executables on a temp PATH that write a marker file when they run**. An
 * assertion that a command nobody installed did not run proves nothing.
 *
 * Verifies: EPIC-12-S10 · AC3, AC11
 */
import type { NodeId } from '@DeFlow/core';
import { it, makeRepo, TestClock } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { GateLoadError, loadGateDefinition } from '../../src/definition.ts';
import { GateExecutionRefused, runGate } from '../../src/run-gate.ts';

const SPEC_HASH = `sha256-${'ef'.repeat(32)}`;

const yamlFor = (command: string) => `id: migrate-check
kind: deterministic
title: A gate that is really an infrastructure action
run: ${command}
cwd: worktree
timeout: 30s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: none
satisfies: [ac-1]
severityFloor: error
`;

/** Real executables that record having run, on a temp PATH. */
async function installMarkers(binDir: string, marker: string, names: readonly string[]) {
  await mkdir(binDir, { recursive: true });
  for (const name of names) {
    const path = join(binDir, name);
    await writeFile(path, `#!/bin/sh\necho "$0" >> "${marker}"\nexit 0\n`);
    await chmod(path, 0o755);
  }
}

const REFUSED: readonly { readonly command: string; readonly rule: string }[] = [
  { command: `psql -h db.prod.internal -c "TRUNCATE runs"`, rule: 'psql-remote' },
  { command: 'terraform apply -auto-approve', rule: 'terraform-apply' },
  { command: 'kubectl delete ns staging', rule: 'kubectl-delete' },
  { command: 'git push --force origin main', rule: 'git-push-force' },
];

suite('a gate that is really an infrastructure action (S10, first scenario)', () => {
  for (const entry of REFUSED) {
    it(`refuses ${entry.rule} before spawn`, async ({ tmp }) => {
      const worktree = join(tmp, 'worktree');
      const dataDir = join(tmp, 'data');
      const binDir = join(tmp, 'bin');
      const marker = join(tmp, 'ran.log');
      await mkdir(dataDir, { recursive: true });
      await makeRepo({ dir: worktree });
      await installMarkers(binDir, marker, ['psql', 'terraform', 'kubectl', 'git']);

      const call = runGate({
        definition: loadGateDefinition('.DeFlow/gates/migrate-check.yaml', yamlFor(entry.command)),
        worktree,
        repoRoot: worktree,
        node: 'gate-migrate-check' as NodeId,
        evaluatedNode: 'impl-1' as NodeId,
        specHash: SPEC_HASH,
        dataDir,
        clock: new TestClock(1_754_313_093_000),
        scrubbedEnv: [],
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      });

      await expect(call).rejects.toBeInstanceOf(GateExecutionRefused);
      await call.catch((error: unknown) => {
        expect((error as GateExecutionRefused).reason).toBe('safety.execution-boundary');
        expect((error as GateExecutionRefused).rule).toBe(entry.rule);
      });

      // The claim, asserted rather than assumed: nothing ran.
      expect(existsSync(marker)).toBe(false);
    });
  }
});

suite('a gate definition on disk that declares effect: mutating (test plan #11)', () => {
  it('fails at load, before any node could be scheduled', async ({ tmp }) => {
    const gatesDir = join(tmp, '.DeFlow', 'gates');
    await mkdir(gatesDir, { recursive: true });
    const file = join(gatesDir, 'seed.yaml');
    await writeFile(
      file,
      yamlFor('node scripts/seed.mjs').replace('effect: pure', 'effect: mutating'),
    );

    const { readFile } = await import('node:fs/promises');
    const source = await readFile(file, 'utf8');
    try {
      loadGateDefinition('.DeFlow/gates/seed.yaml', source);
      expect.unreachable('a mutating gate must not load');
    } catch (error) {
      expect(error).toBeInstanceOf(GateLoadError);
      expect((error as GateLoadError).code).toBe('GATE_MUST_BE_PURE');
      expect((error as GateLoadError).file).toBe('.DeFlow/gates/seed.yaml');
    }
  });
});

suite('cwd: repo needs an explicit opt-in (S10, second scenario)', () => {
  it('refuses to load a repo-cwd gate without it', async ({ tmp }) => {
    const gatesDir = join(tmp, '.DeFlow', 'gates');
    await mkdir(gatesDir, { recursive: true });
    const source = yamlFor('node -e "process.exit(0)"').replace('cwd: worktree', 'cwd: repo');
    try {
      loadGateDefinition('.DeFlow/gates/migrate-check.yaml', source);
      expect.unreachable('cwd: repo must not load without the opt-in');
    } catch (error) {
      expect((error as GateLoadError).code).toBe('GATE_REPO_CWD_NOT_PERMITTED');
    }
  });
});
