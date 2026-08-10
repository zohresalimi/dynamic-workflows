/**
 * KAR-12.5 test plan #5, #6, #7, #8, #11 — the repair loop against a real
 * repository, a real compiler and a real branch.
 *
 * Nothing here is scripted at the boundary that matters. The findings come from
 * a real `tsc` over a real type error; the fix node's two commits are real git
 * commits on `DeFlow/<runId>__<nodeId>`; and the ordering claim is checked by
 * **checking out `HEAD~1` and running the gate again**, which is the only way
 * to tell "the agent wrote the test first" from "the agent said it did".
 *
 * The producer's bug is one a deterministic gate could not have caught on its
 * own — a signature that is wrong rather than ill-typed — which is why the
 * regression test has to come first: without it, "fixed" would be a claim
 * rather than a demonstration (§7).
 *
 * Verifies: EPIC-12-S29, EPIC-12-S30 (first scenario), EPIC-12-S35 (first
 * scenario) · AC1, AC4, AC5, AC10
 */
import type { GateId, NodeId } from '@DeFlow/core';
import { git, it, makeRepo, type Repo, repoRoot } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { loadGateDefinition } from '../../src/definition.ts';
import {
  assertRepairScope,
  gatesAfterRepair,
  REPAIR_NO_FAILING_TEST,
  type RepairCommit,
  RepairScopeViolation,
  repairOrdering,
  repairPatchesFor,
} from '../../src/index.ts';
import { type GateRun, runGate } from '../../src/run-gate.ts';
import { realClock } from './support/clock.ts';

const SPEC_HASH = `sha256-${'ab'.repeat(32)}`;
const RUN_ID = 'run_20260806T090000Z_5c1d2e';
const PRODUCER = 'impl-1' as NodeId;
const GATE_NODE = 'gate-typecheck' as NodeId;

/** The workspace's own tsc, resolved at run time — never a committed path. */
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'es2024',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      allowImportingTsExtensions: true,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src', 'test'],
  },
  null,
  2,
);

const typecheckYaml = (id: string) => `id: ${id}
kind: deterministic
title: TypeScript project check
run: ${TSC} -p tsconfig.json --noEmit --pretty false
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-3]
severityFloor: error
`;

const unitYaml = `id: unit
kind: deterministic
title: The unit suite
run: node --test --test-reporter=tap
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: none
satisfies: [ac-4]
severityFloor: error
`;

interface Harness {
  readonly worktree: string;
  readonly dataDir: string;
  readonly repo: Repo;
}

async function harness(tmp: string, files: Readonly<Record<string, string>>): Promise<Harness> {
  const worktree = join(tmp, 'wt');
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const repo = await makeRepo({ dir: worktree, files: { ...files, 'tsconfig.json': TSCONFIG } });
  return { worktree, dataDir, repo };
}

async function runOne(fixture: Harness, yaml: string, id: string): Promise<GateRun> {
  return runGate({
    definition: loadGateDefinition(`.DeFlow/gates/${id}.yaml`, yaml),
    worktree: fixture.worktree,
    repoRoot: fixture.worktree,
    node: GATE_NODE,
    evaluatedNode: PRODUCER,
    specHash: SPEC_HASH,
    dataDir: fixture.dataDir,
    clock: realClock,
    scrubbedEnv: [],
  });
}

const typecheck = (fixture: Harness) => runOne(fixture, typecheckYaml('typecheck'), 'typecheck');

/** Writes `files` into the worktree and commits them as one commit. */
async function commit(fixture: Harness, message: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    const target = join(fixture.worktree, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  await fixture.repo.git('add', '-A');
  await fixture.repo.git('commit', '-m', message);
  return (await fixture.repo.git('rev-parse', 'HEAD')).trim();
}

/** The paths one commit touched, straight out of git. */
async function pathsOf(fixture: Harness, sha: string): Promise<string[]> {
  const out = await fixture.repo.git('show', '--name-only', '--format=', sha);
  return out.split('\n').filter((line) => line !== '');
}

// ── test plan #5: one fix node per finding, from a real tsc ──────────────────

suite('a real tsc with two errors earns two fix nodes (test plan #5)', () => {
  const TWO_ERRORS = {
    'src/one.ts': 'export const first: number = "not a number";\n',
    'src/two.ts': 'export const second: number = "also not a number";\n',
  };

  it('proposes one patch per finding, with the finding id in the node id', async ({ tmp }) => {
    const fixture = await harness(tmp, TWO_ERRORS);
    const gate = await typecheck(fixture);

    expect(gate.outcome).toBe('fail');
    expect(gate.verdict.findings).toHaveLength(2);

    const decision = repairPatchesFor(gate.verdict, {
      evaluatedNode: PRODUCER,
      ambientPermission: 'worktree',
      replanDepth: 1,
      evidence: gate.evidence === null ? [] : [gate.evidence.handle],
      proposedBy: GATE_NODE,
    });

    expect(decision.kind).toBe('fix');
    if (decision.kind !== 'fix') return;
    expect(decision.patches).toHaveLength(2);
    for (const target of decision.findings) {
      expect(target.node).toBe(`fix-${target.finding.id}`);
    }
  });

  it('gives each node the file its own finding names — identity is not positional', async ({
    tmp,
  }) => {
    const fixture = await harness(tmp, TWO_ERRORS);
    const gate = await typecheck(fixture);
    const decision = repairPatchesFor(gate.verdict, {
      evaluatedNode: PRODUCER,
      ambientPermission: 'worktree',
      replanDepth: 1,
      evidence: [],
      proposedBy: GATE_NODE,
    });

    if (decision.kind !== 'fix') throw new Error('expected fix nodes');
    const scopes = decision.patches.map((patch) => {
      const op = patch.ops[0];
      if (op?.op !== 'insert-nodes') throw new Error('expected an insert');
      return op.nodes[0]?.pathScopes.write;
    });

    expect(scopes.flat().toSorted()).toEqual(['src/one.ts', 'src/two.ts']);
    // The ids are content-derived, so two findings in two files are two nodes
    // whichever order tsc happened to print them in.
    expect(new Set(decision.findings.map((target) => target.node)).size).toBe(2);
  });
});

// ── test plan #6, #7, #8: what the branch has to show ────────────────────────

const BUGGY = {
  // The producer's mistake: a day count that takes a string. Nothing
  // deterministic catches it — the code compiles — which is exactly why the
  // repair has to be demonstrated by a test rather than asserted.
  'src/date-picker.ts':
    'export function daysUntil(target: string): number {\n  return target.length;\n}\n',
  'test/smoke.test.ts': 'export const smokeRan: boolean = true;\n',
};

const FIXED =
  'export function daysUntil(target: Date): number {\n' +
  '  return Math.round(target.getTime() / 86_400_000);\n}\n';

/** The regression test: it fails at the type level for exactly the reported
 * reason, and it goes green the moment the signature is right. */
const REGRESSION =
  "import { daysUntil } from '../src/date-picker.ts';\n\n" +
  'export const days: number = daysUntil(new Date());\n';

const FIX_NODE = 'fix-a13f5c2b1e04';
const BRANCH = `DeFlow/${RUN_ID}__${FIX_NODE}`;

suite('a fix node that wrote the failing test first (EPIC-12-S29, test plan #6)', () => {
  it('fails the gate at HEAD~1 and passes it at HEAD', async ({ tmp }) => {
    const fixture = await harness(tmp, BUGGY);
    expect((await typecheck(fixture)).outcome).toBe('pass');

    await fixture.repo.git('checkout', '-b', BRANCH);
    const testCommit = await commit(fixture, 'repair: reproduce a13f5c2b1e04', {
      'test/days-until.test.ts': REGRESSION,
    });
    const fixCommit = await commit(fixture, 'repair: accept a Date', {
      'src/date-picker.ts': FIXED,
    });

    // The claim, checked the only way it can be: go back one commit and ask
    // the gate again.
    await fixture.repo.git('checkout', 'HEAD~1');
    const atTestCommit = await typecheck(fixture);
    await fixture.repo.git('checkout', BRANCH);
    const atFixCommit = await typecheck(fixture);

    expect(atTestCommit.outcome).toBe('fail');
    expect(atTestCommit.findings[0]?.file).toBe('test/days-until.test.ts');
    expect(atFixCommit.outcome).toBe('pass');

    const ordering = repairOrdering([
      { sha: testCommit, paths: await pathsOf(fixture, testCommit), outcome: atTestCommit.outcome },
      { sha: fixCommit, paths: await pathsOf(fixture, fixCommit), outcome: atFixCommit.outcome },
    ] satisfies RepairCommit[]);

    expect(ordering.ok).toBe(true);
    if (!ordering.ok) return;
    expect(ordering.testCommit).toBe(testCommit);
    expect(ordering.fixCommit).toBe(fixCommit);
  });
});

suite('a fix node that skipped the test (EPIC-12-S29 inverted, test plan #7)', () => {
  it('records repair.no_failing_test rather than accepting the shortcut', async ({ tmp }) => {
    const fixture = await harness(tmp, BUGGY);
    await fixture.repo.git('checkout', '-b', BRANCH);
    const only = await commit(fixture, 'repair: accept a Date', { 'src/date-picker.ts': FIXED });

    const atFix = await typecheck(fixture);
    expect(atFix.outcome).toBe('pass');

    const ordering = repairOrdering([
      { sha: only, paths: await pathsOf(fixture, only), outcome: atFix.outcome },
    ]);

    expect(ordering.ok).toBe(false);
    if (ordering.ok) return;
    expect(ordering.code).toBe(REPAIR_NO_FAILING_TEST);
    // The branch is green. That is precisely the problem: a green gate with no
    // failing test behind it is indistinguishable from a repair that worked.
    expect(await pathsOf(fixture, only)).toEqual(['src/date-picker.ts']);
  });
});

suite('the gate set re-runs from the deterministic tier (test plan #8, AC5)', () => {
  it('reopens both deterministic gates and not the adversarial one', async ({ tmp }) => {
    const fixture = await harness(tmp, BUGGY);
    await fixture.repo.git('checkout', '-b', BRANCH);
    await commit(fixture, 'repair: reproduce a13f5c2b1e04', {
      'test/days-until.test.ts': REGRESSION,
    });
    await commit(fixture, 'repair: accept a Date', { 'src/date-picker.ts': FIXED });

    const ladder = [
      { node: 'gate-review' as NodeId, gate: 'review' as GateId, kind: 'adversarial' as const },
      { node: GATE_NODE, gate: 'typecheck' as GateId, kind: 'deterministic' as const },
      { node: 'gate-unit' as NodeId, gate: 'unit' as GateId, kind: 'deterministic' as const },
    ];
    const admitted = gatesAfterRepair(ladder);

    expect(admitted.map((gate) => gate.gate)).toEqual(['typecheck', 'unit']);

    // And they are re-run for real, including `unit`, which had never failed:
    // a fix that broke a gate that was already green is the case re-running
    // only the failed gate would miss.
    const results = [];
    for (const gate of admitted) {
      results.push(
        await runOne(
          fixture,
          gate.gate === 'unit' ? unitYaml : typecheckYaml('typecheck'),
          gate.gate,
        ),
      );
    }

    expect(results.map((result) => result.outcome)).toEqual(['pass', 'pass']);
  });
});

// ── test plan #11: the agent that fixes the check ────────────────────────────

suite('a fix node that edits the gate definition (EPIC-12-S35, test plan #11)', () => {
  it('fails on path scope before the gate is ever run', async ({ tmp }) => {
    const fixture = await harness(tmp, {
      ...BUGGY,
      '.DeFlow/gates/typecheck.yaml': typecheckYaml('typecheck'),
    });
    await fixture.repo.git('checkout', '-b', BRANCH);

    // The classic failure, committed for real: the finding is inconvenient, so
    // the node raises the gate's severity floor instead of fixing the code.
    const sha = await commit(fixture, 'repair: relax the typecheck gate', {
      '.DeFlow/gates/typecheck.yaml': typecheckYaml('typecheck').replace(
        'severityFloor: error',
        'severityFloor: info',
      ),
    });

    let evaluated = false;
    const evaluate = async () => {
      // The order under test: scope first, verdict second. Reversing these two
      // lines is the bug, and it records a verdict from a run in which the
      // check itself was edited.
      assertRepairScope({
        gate: 'scope' as GateId,
        worktree: fixture.worktree,
        declared: ['src/**', 'test/**'],
        changed: await pathsOf(fixture, sha),
      });
      evaluated = true;
      return typecheck(fixture);
    };

    await expect(evaluate()).rejects.toThrow(RepairScopeViolation);
    expect(evaluated).toBe(false);
  });

  it('carries the finding at severity error, with the rule the diff view reads', async ({
    tmp,
  }) => {
    const fixture = await harness(tmp, {
      ...BUGGY,
      '.DeFlow/gates/typecheck.yaml': typecheckYaml('typecheck'),
    });
    await fixture.repo.git('checkout', '-b', BRANCH);
    const sha = await commit(fixture, 'repair: relax the typecheck gate', {
      '.DeFlow/gates/typecheck.yaml': typecheckYaml('typecheck').replace(
        'severityFloor: error',
        'severityFloor: info',
      ),
    });

    try {
      assertRepairScope({
        gate: 'scope' as GateId,
        worktree: fixture.worktree,
        declared: ['src/**', 'test/**'],
        changed: await pathsOf(fixture, sha),
      });
      expect.unreachable('editing the gate definition must fail the node');
    } catch (error) {
      const violation = error as RepairScopeViolation;
      expect(violation.findings.map((finding) => finding.file)).toEqual([
        '.DeFlow/gates/typecheck.yaml',
      ]);
      expect(violation.findings[0]?.severity).toBe('error');
      expect(violation.findings[0]?.rule).toBe('scope/undeclared-write');
    }
  });

  it('leaves an ordinary out-of-scope edit as a warning', async ({ tmp }) => {
    const fixture = await harness(tmp, BUGGY);
    await fixture.repo.git('checkout', '-b', BRANCH);
    const sha = await commit(fixture, 'repair: touch one import site too', {
      'src/index.ts': "export { daysUntil } from './date-picker.ts';\n",
    });

    const findings = assertRepairScope({
      gate: 'scope' as GateId,
      worktree: fixture.worktree,
      declared: ['src/date-picker.ts', 'test/**'],
      changed: await pathsOf(fixture, sha),
    });

    expect(findings.map((finding) => finding.severity)).toEqual(['warning']);
    // Still on the record: §6.2's violations are never free, they just are not
    // fatal. `git` is what says the file changed, not the agent's word for it.
    expect(await git(fixture.worktree, ['show', '--name-only', '--format=', sha])).toContain(
      'src/index.ts',
    );
  });
});
