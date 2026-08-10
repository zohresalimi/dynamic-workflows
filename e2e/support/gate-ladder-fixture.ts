/**
 * A real repository with a real type error in it, and a run parked ready to be
 * verified — seeded before any process is started over the data directory.
 *
 * Everything a gate needs is on disk rather than in a fixture object: a real
 * git worktree, a real `tsconfig.json`, a real `.DeFlow/gates/*.yaml` pair that
 * KAR-12.6's discovery reads and hashes. The adversarial gate's command is a
 * **real executable that creates a file when it runs**, because *"the review
 * gate was never scheduled"* is a claim about the world and an assertion about
 * the absence of a log line is not.
 *
 * The write happens with no daemon running and the connection is closed before
 * one is spawned: `boot()` takes an exclusive lease on the directory, and two
 * writers is the failure EPIC-03-S21 exists to prevent, not one to reproduce
 * here by accident.
 */
import { PlanGraphSchema, RunIdSchema, sealTaskSpec, type TaskSpecDraft } from '@DeFlow/core';
import { appendEvents, openLedger } from '@DeFlow/ledger';
import { git, makeRepo } from '@DeFlow/testkit';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_RUN = RunIdSchema.parse('run_20260810T090000Z_3ea77c');

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The workspace's own compiler, resolved at run time. */
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

const T0 = 1_754_812_800_000;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;

const SPEC_DRAFT: TaskSpecDraft = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Keep the checkout module compiling.',
  scope: { included: ['src'] },
  nonGoals: ['Do not touch anything outside src.'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'the project typechecks', verifiedBy: ['typecheck'] },
  ],
  knownFailureModes: [],
} as unknown as TaskSpecDraft;

const gateNode = (
  id: string,
  gate: Record<string, unknown>,
  deps: readonly string[],
): Record<string, unknown> => ({
  id,
  title: `gate ${id}`,
  type: 'gate',
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.verdict.v3', maxTokens: 600 },
  retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  gate,
  criteria: ['ac-1'],
  independence: { notSessionOf: [], preferDifferentProvider: true },
});

const yamlFor = (id: string, command: string, parser: string): string => `id: ${id}
kind: deterministic
title: gate ${id}
run: ${command}
cwd: worktree
timeout: 120s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: ${parser}
satisfies: [ac-1]
severityFloor: error
`;

export interface GateLadderFixture {
  readonly worktree: string;
  /** Created by the review gate's command if it is ever scheduled. */
  readonly reviewMarker: string;
  readonly specHash: string;
}

/**
 * Builds the worktree and seeds `dataDir` with a run whose plan is two gates:
 * a deterministic one that will fail against a real type error, and an
 * adversarial one that must never be reached.
 */
export async function seedGateLadder(
  dataDir: string,
  worktree: string,
): Promise<GateLadderFixture> {
  await makeRepo({ dir: worktree });
  await mkdir(join(worktree, 'src'), { recursive: true });
  await writeFile(join(worktree, 'src', 'app.ts'), 'export const n: number = "not a number";\n');
  await writeFile(
    join(worktree, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: { target: 'es2024', module: 'nodenext', strict: true, noEmit: true },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  );

  // The review gate's "reviewer": a real executable that leaves a trace.
  const reviewMarker = join(worktree, 'review-ran');
  const reviewBin = join(worktree, 'review.sh');
  await writeFile(reviewBin, `#!/bin/sh\ntouch "${reviewMarker}"\nexit 0\n`);
  await chmod(reviewBin, 0o755);

  const gatesDir = join(worktree, '.DeFlow', 'gates');
  await mkdir(gatesDir, { recursive: true });
  await writeFile(
    join(gatesDir, 'typecheck.yaml'),
    yamlFor('typecheck', `${TSC} -p tsconfig.json --noEmit --pretty false`, 'tsc'),
  );
  await writeFile(join(gatesDir, 'review.yaml'), yamlFor('review', reviewBin, 'none'));

  await git(worktree, ['add', '-A']);
  await git(worktree, ['commit', '-m', 'the work under review']);

  const spec = await sealTaskSpec(structuredClone(SPEC_DRAFT));
  const plan = PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: GATE_RUN,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: spec.specHash,
    createdBy: 'planner',
    createdAt: '2026-08-10T09:00:00.000Z',
    // Adversarial first in the array, so a ladder derived from insertion order
    // would be wrong rather than accidentally right.
    nodes: [
      gateNode('gate-review', { kind: 'adversarial', brief: 'review the implementation' }, []),
      gateNode('gate-typecheck', { kind: 'deterministic', gateId: 'typecheck' }, []),
    ],
    edges: [],
  });

  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      {
        runId: GATE_RUN,
        ts: T0,
        kind: 'run.created',
        v: 1,
        epoch: 1,
        payload: { spec, cwd: worktree, repo: { head: 'e83c516', branch: 'main' } },
      },
      {
        runId: GATE_RUN,
        ts: T0,
        kind: 'run.spec.approved',
        v: 1,
        epoch: 1,
        payload: { specHash: spec.specHash, by: 'ui' },
      },
      {
        runId: GATE_RUN,
        ts: T0,
        kind: 'plan.proposed',
        v: 2,
        epoch: 1,
        payload: { version: 1, planHash: PLAN_HASH, graph: plan, by: 'planner' },
      },
      {
        runId: GATE_RUN,
        ts: T0,
        kind: 'run.started',
        v: 1,
        epoch: 1,
        payload: { planHash: PLAN_HASH },
      },
    ]);
  } finally {
    db.close();
  }

  return { worktree, reviewMarker, specHash: spec.specHash };
}
