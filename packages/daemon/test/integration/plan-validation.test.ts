/**
 * KAR-11.2 — the two halves of §3 that need a real boundary: git's own verdict
 * on a node id, and the ledger's refusal to commit a patched plan that does not
 * revalidate.
 *
 * Integration rather than unit for the reason §3.3 gives: *"validate the
 * resulting ref with git itself rather than reimplementing its rules"*. A
 * TypeScript approximation of `check-ref-format` is the thing this file exists
 * to make unnecessary, so a stubbed checker here would assert the approximation
 * against itself. The ledger half is integration for the same kind of reason —
 * a fake db would let "before the transaction commits" pass while the write had
 * already happened.
 *
 * Verifies: EPIC-11-S10, EPIC-11-S12, EPIC-11-S18 (the validation half) ·
 * AC7, AC9, AC11 · test plan #7, #8, #11
 */
import type { Db, PlanGraph, PlanNode, PlanTimeCapability, TaskSpec } from '@DeFlow/core';
import { PlanGraphSchema, planHash, TaskSpecSchema } from '@DeFlow/core';
import { openLedger, persistPlanVersion, readPlanDoc, readRange } from '@DeFlow/ledger';
import { GIT_ENV, git, it, makeRepo, tryGit } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { commitPatchedPlan, nodeRefOf, validatePlanVersion } from '../../src/plan/validate.ts';

const RUN = 'run_20260807T101500Z_ac1101';
const T0 = 1_754_380_800_000;
const EPOCH = 3;
const PLANNER = { model: 'a-model', effort: 'max', tier: 'strongest' } as const;

const CAPS: readonly PlanTimeCapability[] = [
  {
    provider: 'claude',
    version: '2.1.220',
    structuredOutput: true,
    resume: true,
    permissionLevels: ['read', 'worktree', 'worktree+net', 'full'],
    maxContext: 200_000,
  },
];

const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Migrate every component under packages/ui to Vue 3.',
  scope: { included: ['packages/ui'] },
  nonGoals: ['Do not touch packages/legacy.'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'it works', check: { kind: 'manual', rubric: 'a human looks' } },
  ],
  knownFailureModes: [],
  approvedBy: { at: '2026-08-07T10:15:00.000Z', via: 'ui' },
  specHash: `sha256-${'1'.repeat(64)}`,
});

const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Do ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  brief: `Do ${id}, carefully.`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
  ...over,
});

function parsed(nodes: unknown[], over: Record<string, unknown> = {}): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: SPEC.specHash,
    createdBy: 'planner',
    createdAt: '2026-08-07T10:15:00.000Z',
    nodes,
    edges: [],
    ...over,
  });
}

/** A graph whose declared hash really addresses it — what persistence demands. */
async function addressed(plan: PlanGraph): Promise<PlanGraph> {
  return { ...plan, planHash: await planHash(plan as unknown as Record<string, unknown>) };
}

/**
 * A graph carrying node ids `NodeIdSchema` would refuse, which is the shape a
 * patched graph assembled in code can take. `validatePlanVersion` has to reach
 * git with the raw value, or §3.3's whole point — git is the authority — is
 * decided by a Zod regex before git is ever asked.
 */
function unparsed(ids: readonly string[]): PlanGraph {
  return {
    ...parsed([]),
    nodes: ids.map((id) => agent(id)) as unknown as PlanNode[],
  };
}

const checkerFor = (tmp: string) => new RefFormatChecker(new Git(tmp, { env: GIT_ENV }));

const validate = (plan: PlanGraph, tmp: string) =>
  validatePlanVersion({
    plan,
    spec: SPEC,
    caps: CAPS,
    estimatePacketTokens: () => 0,
    refs: checkerFor(tmp),
  });

// ── EPIC-11-S10 — git is the authority on ref names ──────────────────────────

suite('EPIC-11-S10 — node ids are validated by real git, then by a stricter charset', () => {
  it('composes the flat D13 ref, and real git accepts it', async ({ tmp }) => {
    const ref = nodeRefOf('r1', 'impl-checkout');
    expect(ref).toBe('refs/heads/DeFlow/r1__impl-checkout');

    const result = await tryGit(tmp, ['check-ref-format', ref]);
    expect(result.exitCode).toBe(0);
  });

  // `it.each` cannot be used here: the testkit's `it` delivers `tmp` through
  // the fixture context, and `each` takes that argument slot for its own row.
  for (const id of ['impl:checkout', 'impl checkout', 'impl..checkout']) {
    it(`real git refuses refs/heads/DeFlow/r1__${id}`, async ({ tmp }) => {
      const result = await tryGit(tmp, ['check-ref-format', nodeRefOf('r1', id)]);
      expect(result.exitCode).not.toBe(0);
    });
  }

  it("reports git's refusal as INVALID_NODE_ID, naming the id", async ({ tmp }) => {
    const diagnostics = await validate(unparsed(['impl:checkout']), tmp);

    const invalid = diagnostics.filter((one) => one.code === 'INVALID_NODE_ID');
    expect(invalid.map((one) => one.key)).toContain('impl:checkout');
    expect(invalid.some((one) => one.message.includes('check-ref-format'))).toBe(true);
  });

  for (const id of ['Impl-Checkout', '-impl', 'x'.repeat(70)]) {
    it(`refuses ${id.slice(0, 20)} on the DeFlow charset, whatever git says about the ref`, async ({
      tmp,
    }) => {
      const diagnostics = await validate(unparsed([id]), tmp);

      expect(diagnostics.filter((one) => one.code === 'INVALID_NODE_ID')).not.toHaveLength(0);
    });
  }

  it('refuses "recon" and "Recon" in one plan, naming the case-insensitive filesystem', async ({
    tmp,
  }) => {
    const diagnostics = await validate(unparsed(['recon', 'Recon']), tmp);

    const duplicate = diagnostics.find((one) => one.message.includes('case-insensitive'));
    expect(duplicate).toMatchObject({ code: 'INVALID_NODE_ID', key: 'Recon' });
  });

  it('accepts a plan of legal ids with no identifier diagnostic at all', async ({ tmp }) => {
    const diagnostics = await validate(parsed([agent('recon'), agent('implement')]), tmp);

    expect(diagnostics).toEqual([]);
  });
});

suite("EPIC-11-S10 — the PRD's nested branch scheme stays dead (AC7 regression)", () => {
  it('git refs are files in a directory tree, so DeFlow/r1 cannot also be a directory', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });

    // The scheme the PRD proposed, for the same two nodes this plan contains.
    await git(repo, ['branch', `DeFlow/${RUN}/recon`]);
    const conflict = await tryGit(repo, ['branch', `DeFlow/${RUN}`]);

    expect(conflict.exitCode).not.toBe(0);
    expect(`${conflict.stderr}${conflict.stdout}`.toLowerCase()).toContain('exist');
  });

  it('what DeFlow composes instead is flat, for every node in the plan', () => {
    const plan = parsed([agent('recon'), agent('implement')]);

    const refs = plan.nodes.map((node) => nodeRefOf(plan.runId, node.id));
    expect(refs).toEqual([
      `refs/heads/DeFlow/${RUN}__recon`,
      `refs/heads/DeFlow/${RUN}__implement`,
    ]);
    // The failing shape, stated as the thing none of them is: a `/` after the
    // run id is what makes `DeFlow/<runId>` have to be a directory.
    expect(refs.some((ref) => ref.includes(`${RUN}/`))).toBe(false);
  });

  it('and all of them coexist with the run-level integration branch on real git', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    const plan = parsed([agent('recon'), agent('implement')]);

    for (const node of plan.nodes) {
      await git(repo, ['branch', nodeRefOf(plan.runId, node.id).replace('refs/heads/', '')]);
    }
    await git(repo, ['branch', `DeFlow/int/${RUN}`]);

    const listed = await git(repo, ['branch', '--list', 'DeFlow/*']);
    expect(listed.split('\n').filter((line) => line.trim() !== '')).toHaveLength(3);
  });
});

// ── EPIC-11-S12 / S18 — every patched plan revalidates before it commits ─────

suite('EPIC-11-S12 — validation runs on every patched plan, not only on v1', () => {
  /** v3 of a run already 26 nodes in: `recon` writes the key `implement` reads. */
  async function committedV3(db: Db, tmp: string): Promise<PlanGraph> {
    const v3 = await addressed(
      parsed(
        [
          agent('recon', {
            writes: [{ kind: 'fact', key: 'finding/api-surface', schemaId: 'DeFlow.finding.v1' }],
          }),
          agent('implement', {
            deps: ['recon'],
            reads: [{ kind: 'fact', key: 'finding/api-surface' }],
          }),
        ],
        { version: 3 },
      ),
    );
    await persistPlanVersion(db, {
      runDir: join(tmp, 'runs', RUN),
      graph: v3,
      by: 'planner',
      planner: PLANNER,
      diagnostics: [],
      ts: T0,
      epoch: EPOCH,
    });
    return v3;
  }

  it('rejects a patch whose new node reads a key no ancestor writes, before anything commits', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const v3 = await committedV3(db, tmp);
      // What `insert-nodes` would have produced: a new node reading a key
      // nothing in the patched graph writes.
      const v4 = await addressed(
        parsed(
          [
            ...(v3.nodes as unknown as Record<string, unknown>[]),
            agent('migrate', { reads: [{ kind: 'fact', key: 'finding/db-schema' }] }),
          ],
          { version: 4, parent: v3.planHash },
        ),
      );

      const outcome = await commitPatchedPlan({
        db,
        runDir: join(tmp, 'runs', RUN),
        graph: v4,
        spec: SPEC,
        caps: CAPS,
        estimatePacketTokens: () => 0,
        refs: checkerFor(tmp),
        patchId: 'patch_01j9v1s5t1m1q9x8y7z6w5v4u3',
        by: 'planner',
        planner: PLANNER,
        ts: T0,
        epoch: EPOCH,
      });

      expect(outcome.outcome).toBe('rejected');
      expect(outcome.diagnostics.map((one) => one.code)).toContain('READ_UNREACHABLE');

      // The base plan is untouched: no v4 row, and the newest plan.proposed is
      // still v3's.
      expect(readPlanDoc(db, v4.planHash)).toBeNull();
      expect(readPlanDoc(db, v3.planHash)).not.toBeNull();
      const proposed = readRange(db, RUN, 0, 200).events.filter(
        (row) => row.kind === 'plan.proposed',
      );
      expect(proposed).toHaveLength(1);
      expect((proposed[0]?.payload as Record<string, unknown>).planHash).toBe(v3.planHash);

      const [rejected] = readRange(db, RUN, 0, 200).events.filter(
        (row) => row.kind === 'plan.patch.rejected',
      );
      const payload = rejected?.payload as Record<string, unknown>;
      expect(payload.by).toBe('validation');
      expect(payload.patchId).toBe('patch_01j9v1s5t1m1q9x8y7z6w5v4u3');
      expect((payload.diagnostics as { code: string }[]).map((one) => one.code)).toContain(
        'READ_UNREACHABLE',
      );
    } finally {
      db.close();
    }
  });

  it('commits the same patch once it reads a key its new ancestor writes', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const v3 = await committedV3(db, tmp);
      const v4 = await addressed(
        parsed(
          [
            ...(v3.nodes as unknown as Record<string, unknown>[]),
            agent('migrate', {
              deps: ['recon'],
              reads: [{ kind: 'fact', key: 'finding/api-surface' }],
            }),
          ],
          { version: 4, parent: v3.planHash },
        ),
      );

      const outcome = await commitPatchedPlan({
        db,
        runDir: join(tmp, 'runs', RUN),
        graph: v4,
        spec: SPEC,
        caps: CAPS,
        estimatePacketTokens: () => 0,
        refs: checkerFor(tmp),
        patchId: 'patch_01j9v1s5t1m1q9x8y7z6w5v4u4',
        by: 'planner',
        planner: PLANNER,
        ts: T0,
        epoch: EPOCH,
      });

      expect(outcome.outcome).toBe('committed');
      expect(readPlanDoc(db, v4.planHash)).not.toBeNull();
      expect(
        readRange(db, RUN, 0, 200).events.filter((row) => row.kind === 'plan.patch.rejected'),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('EPIC-11-S18 — a policy `auto` does not exempt a patch from revalidation', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const v3 = await committedV3(db, tmp);
      const v4 = await addressed(
        parsed(
          [
            ...(v3.nodes as unknown as Record<string, unknown>[]),
            agent('migrate', { reads: [{ kind: 'fact', key: 'finding/db-schema' }] }),
          ],
          { version: 4, parent: v3.planHash },
        ),
      );

      // The policy engine's answer is not an argument this function takes, and
      // that is the assertion: *should we?* and *can we?* are different
      // questions, so there is no seam through which a `auto` decision could
      // skip the check.
      const outcome = await commitPatchedPlan({
        db,
        runDir: join(tmp, 'runs', RUN),
        graph: v4,
        spec: SPEC,
        caps: CAPS,
        estimatePacketTokens: () => 0,
        refs: checkerFor(tmp),
        patchId: 'patch_01j9v1s5t1m1q9x8y7z6w5v4u5',
        by: 'planner',
        planner: PLANNER,
        ts: T0,
        epoch: EPOCH,
      });

      expect(outcome.outcome).toBe('rejected');
      expect(readPlanDoc(db, v4.planHash)).toBeNull();
    } finally {
      db.close();
    }
  });
});
