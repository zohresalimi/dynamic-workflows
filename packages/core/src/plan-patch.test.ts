/**
 * KAR-02.4 — `PlanPatch`, `PatchDecision` and `patchIsWellFormed`.
 *
 * Verifies: EPIC-02-S2, EPIC-02-S3 (the validation half — the applier and the
 * `plan` row are KAR-11.3), EPIC-02-S12, EPIC-02-S13 ·
 * AC1, AC2, AC3, AC4, AC5, AC6, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { NodeIdSchema, type RunId, RunIdSchema } from './ids.ts';
import { ikey } from './ikey.ts';
import { NodeIdRegistry, NodeIdReused } from './node-id-registry.ts';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import {
  PatchDecisionSchema,
  type PatchError,
  type PatchWellFormedness,
  PlanPatchSchema,
  patchIsWellFormed,
  retirementsOf,
} from './plan-patch.ts';

const RUN_ID: RunId = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');

/** A minimal but complete agent node — every `NodeBase` field is required
 * (KAR-02.3 AC3), so there is no shorter honest way to write one. */
function agent(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Node ${id}`,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: ['src/**'] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 500 },
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    brief: 'Do the thing.',
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'native-if-available',
    ...over,
  };
}

function loop(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const { brief, provider, resume, ...base } = agent(id);
  void brief;
  void provider;
  void resume;
  return {
    ...base,
    type: 'loop',
    body: 'run-integration-check',
    maxRounds: 3,
    goal: { kind: 'gate', gate: 'gate-lint-clean' },
    noProgress: { sameFailureSignatureLimit: 2, diffSimilarityThreshold: 0.9 },
    ...over,
  };
}

function graphOf(nodes: Record<string, unknown>[], edges: unknown[] = []): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN_ID,
    version: 3,
    planHash: `sha256-${'a'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'b'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes,
    edges,
  });
}

const POLICY_FIELDS = [
  'estimatedCostDeltaUsd',
  'estimatedWallClockDeltaMs',
  'blastRadius',
  'replanDepth',
  'escalatesPermission',
  'addsWriteCapability',
] as const;

function policy(): Record<string, unknown> {
  return {
    estimatedCostDeltaUsd: 0.4,
    estimatedWallClockDeltaMs: 120_000,
    blastRadius: { paths: ['src/auth/**'], nodeCount: 1 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  };
}

function patchOf(ops: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch-7f3a1c',
    proposedBy: 'planner',
    reason: 'The auth module turned out to use JWT, so the header work splits in three.',
    ops,
    policy: policy(),
    ...over,
  };
}

function parsePatch(raw: Record<string, unknown>) {
  const result = PlanPatchSchema.safeParse(raw);
  if (!result.success) throw new Error(`fixture does not parse: ${result.error.message}`);
  return result.data;
}

function errorsOf(result: PatchWellFormedness): readonly PatchError[] {
  return result.ok ? [] : result.errors;
}

function kindsOf(result: PatchWellFormedness): string[] {
  return errorsOf(result).map((error) => error.kind);
}

// ---------------------------------------------------------------------------
// EPIC-02-S12 — the policy block is mandatory (AC1)
// ---------------------------------------------------------------------------

suite('PlanPatchSchema — the policy block is mandatory (EPIC-02-S12, AC1)', () => {
  const validOps = [{ op: 'extend-loop', node: 'retry-flaky-check', maxRounds: 5 }];

  it.each(POLICY_FIELDS)('rejects a patch whose policy.%s is missing', (field) => {
    const raw = patchOf(validOps);
    const block = raw.policy as Record<string, unknown>;
    delete block[field];

    const result = PlanPatchSchema.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(`policy.${field}`);
  });

  it('rejects a patch with no policy block at all — policy is not optional', () => {
    const raw = patchOf(validOps);
    delete raw.policy;

    const result = PlanPatchSchema.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('policy');
  });

  it('rejects a bare permission level for escalatesPermission — it is null or a from/to pair', () => {
    const raw = patchOf(validOps);
    (raw.policy as Record<string, unknown>).escalatesPermission = 'full';

    expect(PlanPatchSchema.safeParse(raw).success).toBe(false);
  });

  it('accepts a from/to escalation pair, and accepts null', () => {
    const escalating = patchOf(validOps);
    (escalating.policy as Record<string, unknown>).escalatesPermission = {
      from: 'worktree',
      to: 'worktree+net',
    };

    expect(PlanPatchSchema.safeParse(escalating).success).toBe(true);
    expect(PlanPatchSchema.safeParse(patchOf(validOps)).success).toBe(true);
  });

  it('rejects an unknown level inside the escalation pair', () => {
    const raw = patchOf(validOps);
    (raw.policy as Record<string, unknown>).escalatesPermission = {
      from: 'worktree',
      to: 'root',
    };

    expect(PlanPatchSchema.safeParse(raw).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The patch envelope: reason, proposedBy, strict ops (AC4, AC5, AC6)
// ---------------------------------------------------------------------------

suite('PlanPatchSchema — the proposal envelope', () => {
  const validOps = [{ op: 'extend-loop', node: 'retry-flaky-check', maxRounds: 5 }];

  it('rejects an empty reason — it is rendered verbatim in the scrubber (AC6)', () => {
    const result = PlanPatchSchema.safeParse(patchOf(validOps, { reason: '' }));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('reason');
  });

  it('rejects a whitespace-only reason', () => {
    expect(PlanPatchSchema.safeParse(patchOf(validOps, { reason: '   \n' })).success).toBe(false);
  });

  it('accepts proposedBy "scheduler", so F3.9 re-routing is an ordinary patch (AC5)', () => {
    const reroute = [
      { op: 'replace-provider', node: 'migrate-header-component', provider: 'codex' },
    ];

    const scheduled = PlanPatchSchema.safeParse(patchOf(reroute, { proposedBy: 'scheduler' }));
    const planned = PlanPatchSchema.safeParse(patchOf(reroute, { proposedBy: 'planner' }));

    expect(scheduled.success).toBe(true);
    expect(planned.success).toBe(true);
    if (!scheduled.success || !planned.success) throw new Error('unreachable');
    // Nothing but the proposer distinguishes the two (EPIC-02-S13, scenario 3).
    expect({ ...scheduled.data, proposedBy: 'planner' }).toEqual(planned.data);
  });

  it('accepts the four proposer forms and rejects an unknown one', () => {
    for (const proposedBy of ['planner', 'human', 'scheduler', 'recon-auth-surface']) {
      expect(PlanPatchSchema.safeParse(patchOf(validOps, { proposedBy })).success).toBe(true);
    }
    expect(PlanPatchSchema.safeParse(patchOf(validOps, { proposedBy: 'The Robot' })).success).toBe(
      false,
    );
  });

  it('rejects a patch carrying no ops — a patch that changes nothing is not a patch', () => {
    expect(PlanPatchSchema.safeParse(patchOf([])).success).toBe(false);
  });

  it('rejects an unknown op kind on the discriminator', () => {
    expect(
      PlanPatchSchema.safeParse(patchOf([{ op: 'rename-node', node: 'a', to: 'b' }])).success,
    ).toBe(false);
  });

  it.each(['id', 'pathScopes', 'permission'])(
    'rejects a replace-provider op smuggling %s through — the op schemas are strict (AC4)',
    (key) => {
      const smuggled: Record<string, unknown> = {
        op: 'replace-provider',
        node: 'migrate-header-component',
        provider: 'codex',
        model: 'gpt-5-codex',
      };
      smuggled[key] =
        key === 'permission' ? 'full' : key === 'pathScopes' ? { write: ['**'] } : 'x';

      const result = PlanPatchSchema.safeParse(patchOf([smuggled]));

      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      const unrecognised = result.error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys' ? issue.keys : [],
      );
      expect(unrecognised).toContain(key);
    },
  );

  it('accepts a replace-provider op changing provider and model and nothing else (AC4)', () => {
    const patch = parsePatch(
      patchOf([
        {
          op: 'replace-provider',
          node: 'migrate-header-component',
          provider: 'codex',
          model: 'gpt-5-codex',
        },
      ]),
    );

    expect(Object.keys(patch.ops[0] ?? {}).sort()).toEqual(['model', 'node', 'op', 'provider']);
  });

  it('rejects an outcome recorded on the proposal — the decision is a separate record', () => {
    expect(PlanPatchSchema.safeParse(patchOf(validOps, { decision: 'auto' })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EPIC-02-S13 — a rejected patch is still a recorded, well-formed value (AC7)
// ---------------------------------------------------------------------------

suite('PatchDecisionSchema — rejections are first-class records (EPIC-02-S13, AC7)', () => {
  const at = '2026-08-02T14:20:00.000Z';

  it('accepts a rejection that names the rule that fired', () => {
    expect(
      PatchDecisionSchema.parse({
        decision: 'rejected',
        by: 'policy',
        rule: 'replan-depth-gt-3',
        at,
      }),
    ).toEqual({ decision: 'rejected', by: 'policy', rule: 'replan-depth-gt-3', at });
  });

  it('rejects a rejection with no named rule, on the "rule" path', () => {
    const result = PatchDecisionSchema.safeParse({ decision: 'rejected', by: 'policy', at });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('rule');
    expect(() => PatchDecisionSchema.parse({ decision: 'rejected', by: 'policy', at })).toThrow();
  });

  it('rejects a rejection whose rule is an empty string', () => {
    expect(
      PatchDecisionSchema.safeParse({ decision: 'rejected', by: 'policy', rule: '', at }).success,
    ).toBe(false);
  });

  it('requires "by" on every decision', () => {
    expect(PatchDecisionSchema.safeParse({ decision: 'auto', at }).success).toBe(false);
  });

  it('leaves rule optional for the three non-rejection outcomes', () => {
    for (const decision of ['auto', 'approved', 'queued']) {
      expect(PatchDecisionSchema.safeParse({ decision, by: 'policy', at }).success).toBe(true);
    }
  });

  it('carries the plan.patch.rejected payload without the patch having been applied', () => {
    const patch = parsePatch(
      patchOf([{ op: 'extend-loop', node: 'retry-flaky-check', maxRounds: 5 }], {
        policy: { ...policy(), addsWriteCapability: true, replanDepth: 4 },
      }),
    );
    const decision = PatchDecisionSchema.parse({
      decision: 'rejected',
      by: 'policy',
      rule: 'replan-depth-gt-3',
      at,
    });

    // `{ patch }` and `{ patchId, rule, by }` — the two §9 payloads — are both
    // derivable from values that exist before anything is applied. The
    // envelope that carries them is KAR-02.7's.
    expect({ patch }).toMatchObject({ patch: { id: 'patch-7f3a1c' } });
    expect({ patchId: patch.id, rule: decision.rule, by: decision.by }).toEqual({
      patchId: 'patch-7f3a1c',
      rule: 'replan-depth-gt-3',
      by: 'policy',
    });
  });
});

// ---------------------------------------------------------------------------
// EPIC-02-S2 — a patch may change anything about a node except its id
// ---------------------------------------------------------------------------

suite('patchIsWellFormed — NodeId stability under runtime mutation (EPIC-02-S2, AC2)', () => {
  // The Background that makes this a hard error: an effect row is already
  // pending under this node's idempotency key. If the id moves between that
  // row being written and the daemon restarting, the memoised result is
  // orphaned and the side effect runs twice — undetectably (04 §1.1).
  const pendingIkey = ikey(RUN_ID, NodeIdSchema.parse('migrate-header-component'), 1, 0);

  const graph = (): PlanGraph =>
    graphOf([
      agent('migrate-header-component'),
      agent('recon-auth-surface', { lifecycle: 'abandoned' }),
    ]);

  it('accepts replace-provider, and the node keeps its id, its lifecycle and its pending ikey', () => {
    const before = graph();
    const snapshot = structuredClone(before);
    const patch = parsePatch(
      patchOf([
        {
          op: 'replace-provider',
          node: 'migrate-header-component',
          provider: 'codex',
          model: 'gpt-5-codex',
        },
      ]),
    );

    const result = patchIsWellFormed(patch, before);

    expect(result).toEqual({ ok: true });
    // The op has no `id` and no `lifecycle` field to change (proved by the
    // strict-schema test above), and validation is pure.
    expect(before).toEqual(snapshot);
    const node = before.nodes.find((candidate) => candidate.id === 'migrate-header-component');
    expect(node?.id).toBe('migrate-header-component');
    expect(node?.lifecycle).toBe('active');
    expect(ikey(RUN_ID, NodeIdSchema.parse('migrate-header-component'), 1, 0)).toBe(pendingIkey);
  });

  it('refuses a rename disguised as an insert, naming both the old and the new id', () => {
    const patch = parsePatch(
      patchOf([
        {
          op: 'insert-nodes',
          nodes: [agent('migrate-header-cmp', { derivedFrom: ['migrate-header-component'] })],
          edges: [],
        },
      ]),
    );

    const result = patchIsWellFormed(patch, graph());

    expect(kindsOf(result)).toEqual(['node-id-would-move']);
    const [error] = errorsOf(result);
    expect(error?.message).toContain('migrate-header-component');
    expect(error?.message).toContain('migrate-header-cmp');
    expect(error?.nodes).toEqual(['migrate-header-component', 'migrate-header-cmp']);
  });

  it('refuses reusing the id of a node whose lifecycle is abandoned', () => {
    const patch = parsePatch(
      patchOf([{ op: 'insert-nodes', nodes: [agent('recon-auth-surface')], edges: [] }]),
    );

    const result = patchIsWellFormed(patch, graph());

    expect(kindsOf(result)).toEqual(['node-id-reused']);
    expect(errorsOf(result)[0]?.nodes).toEqual(['recon-auth-surface']);
  });

  it('refuses reusing the id of an active node', () => {
    const patch = parsePatch(
      patchOf([{ op: 'insert-nodes', nodes: [agent('migrate-header-component')], edges: [] }]),
    );

    expect(kindsOf(patchIsWellFormed(patch, graph()))).toEqual(['node-id-reused']);
  });

  it('refuses a patch that inserts the same fresh id twice', () => {
    const patch = parsePatch(
      patchOf([
        { op: 'insert-nodes', nodes: [agent('harden-auth-tests')], edges: [] },
        { op: 'insert-nodes', nodes: [agent('harden-auth-tests')], edges: [] },
      ]),
    );

    expect(kindsOf(patchIsWellFormed(patch, graph()))).toEqual(['node-id-reused']);
  });

  it('accepts an insert whose derivedFrom names a node the same patch retires', () => {
    const patch = parsePatch(
      patchOf([
        {
          op: 'split-node',
          node: 'migrate-header-component',
          into: [
            agent('migrate-header-a', { derivedFrom: ['migrate-header-component'] }),
            agent('migrate-header-b', { derivedFrom: ['migrate-header-component'] }),
          ],
          edges: [],
        },
      ]),
    );

    expect(patchIsWellFormed(patch, graph())).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// EPIC-02-S3 — split-node retires the id and mints successors (AC3)
// ---------------------------------------------------------------------------

suite('patchIsWellFormed — split-node retires rather than renames (EPIC-02-S3, AC3)', () => {
  const graph = (): PlanGraph =>
    graphOf([agent('migrate-forms'), agent('already-split', { lifecycle: 'superseded' })]);

  const splitInto = (nodes: Record<string, unknown>[]): Record<string, unknown> => ({
    op: 'split-node',
    node: 'migrate-forms',
    into: nodes,
    edges: [],
  });

  const successors = (): Record<string, unknown>[] => [
    agent('migrate-forms-a', { derivedFrom: ['migrate-forms'] }),
    agent('migrate-forms-b', { derivedFrom: ['migrate-forms'] }),
    agent('migrate-forms-c', { derivedFrom: ['migrate-forms'] }),
  ];

  it('accepts a split into three fresh nodes that all name their ancestor', () => {
    const patch = parsePatch(patchOf([splitInto(successors())]));

    expect(patchIsWellFormed(patch, graph())).toEqual({ ok: true });
  });

  it('reports the retirement the split implies: the target is set to superseded', () => {
    const patch = parsePatch(patchOf([splitInto(successors())]));

    expect(retirementsOf(patch)).toEqual([{ node: 'migrate-forms', lifecycle: 'superseded' }]);
  });

  it('leaves the id registry refusing a later allocation of the retired id', () => {
    const patch = parsePatch(patchOf([splitInto(successors())]));
    const registry = new NodeIdRegistry();
    for (const node of graph().nodes) registry.allocate(node.id);

    for (const retirement of retirementsOf(patch)) registry.retire(retirement.node);

    expect(registry.isRetired(NodeIdSchema.parse('migrate-forms'))).toBe(true);
    expect(() => registry.allocate(NodeIdSchema.parse('migrate-forms'))).toThrow(NodeIdReused);
  });

  it('refuses a split whose successors omit derivedFrom, naming the offender', () => {
    const [first, , third] = successors();
    const patch = parsePatch(
      patchOf([splitInto([first ?? {}, agent('migrate-forms-b'), third ?? {}])]),
    );

    const result = patchIsWellFormed(patch, graph());

    expect(kindsOf(result)).toEqual(['split-missing-derived-from']);
    expect(errorsOf(result)[0]?.message).toContain('migrate-forms-b');
  });

  it('refuses a split whose successor names a different ancestor', () => {
    const patch = parsePatch(
      patchOf([
        splitInto([
          agent('migrate-forms-a', { derivedFrom: ['migrate-forms'] }),
          agent('migrate-forms-b', { derivedFrom: ['already-split'] }),
        ]),
      ]),
    );

    expect(kindsOf(patchIsWellFormed(patch, graph()))).toEqual(['split-missing-derived-from']);
  });

  it('refuses a split whose successor reuses the target id', () => {
    const patch = parsePatch(
      patchOf([
        splitInto([
          agent('migrate-forms', { derivedFrom: ['migrate-forms'] }),
          agent('migrate-forms-b', { derivedFrom: ['migrate-forms'] }),
        ]),
      ]),
    );

    expect(kindsOf(patchIsWellFormed(patch, graph()))).toContain('node-id-reused');
  });

  it('refuses splitting a node that is already retired — an id retires once', () => {
    const patch = parsePatch(
      patchOf([
        {
          op: 'split-node',
          node: 'already-split',
          into: [
            agent('already-split-a', { derivedFrom: ['already-split'] }),
            agent('already-split-b', { derivedFrom: ['already-split'] }),
          ],
          edges: [],
        },
      ]),
    );

    expect(kindsOf(patchIsWellFormed(patch, graph()))).toEqual(['node-already-retired']);
  });

  it('refuses a split into a single node — that is a rename with extra steps', () => {
    expect(
      PlanPatchSchema.safeParse(
        patchOf([splitInto([agent('migrate-forms-a', { derivedFrom: ['migrate-forms'] })])]),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rest of the structural contract: ops reference nodes that exist
// ---------------------------------------------------------------------------

suite('patchIsWellFormed — ops reference nodes that exist', () => {
  const graph = (): PlanGraph => graphOf([agent('migrate-forms'), loop('retry-flaky-check')]);

  it.each([
    ['replace-provider', { op: 'replace-provider', node: 'no-such-node', provider: 'codex' }],
    ['extend-loop', { op: 'extend-loop', node: 'no-such-node', maxRounds: 5 }],
    ['abandon-branch', { op: 'abandon-branch', root: 'no-such-node', reason: 'dead end' }],
    ['split-node', { op: 'split-node', node: 'no-such-node', into: [], edges: [] }],
  ] as const)('reports an unknown node targeted by %s', (_kind, op) => {
    const into =
      'into' in op
        ? [
            agent('no-such-node-a', { derivedFrom: ['no-such-node'] }),
            agent('no-such-node-b', { derivedFrom: ['no-such-node'] }),
          ]
        : undefined;
    const patch = parsePatch(patchOf([into === undefined ? op : { ...op, into }]));

    expect(kindsOf(patchIsWellFormed(patch, graph()))).toContain('unknown-node');
  });

  it('reports an edge whose endpoint is neither in the graph nor inserted by the patch', () => {
    const patch = parsePatch(
      patchOf([
        {
          op: 'insert-nodes',
          nodes: [agent('harden-auth-tests')],
          edges: [{ from: 'harden-auth-tests', to: 'nowhere', kind: 'control' }],
        },
      ]),
    );

    const result = patchIsWellFormed(patch, graph());

    expect(kindsOf(result)).toEqual(['unknown-node']);
    expect(errorsOf(result)[0]?.nodes).toEqual(['nowhere']);
  });

  it('accepts an edge from an inserted node to an existing one', () => {
    const patch = parsePatch(
      patchOf([
        {
          op: 'insert-nodes',
          nodes: [agent('harden-auth-tests')],
          edges: [{ from: 'migrate-forms', to: 'harden-auth-tests', kind: 'control' }],
        },
      ]),
    );

    expect(patchIsWellFormed(patch, graph())).toEqual({ ok: true });
  });

  it('refuses extend-loop against a node that is not a loop', () => {
    const patch = parsePatch(patchOf([{ op: 'extend-loop', node: 'migrate-forms', maxRounds: 5 }]));

    expect(kindsOf(patchIsWellFormed(patch, graph()))).toEqual(['wrong-node-type']);
  });

  it('accepts extend-loop against a loop node, and reports no retirement', () => {
    const patch = parsePatch(
      patchOf([{ op: 'extend-loop', node: 'retry-flaky-check', maxRounds: 5 }]),
    );

    expect(patchIsWellFormed(patch, graph())).toEqual({ ok: true });
    expect(retirementsOf(patch)).toEqual([]);
  });

  it('reports abandon-branch as retiring its root with lifecycle abandoned', () => {
    const patch = parsePatch(
      patchOf([{ op: 'abandon-branch', root: 'migrate-forms', reason: 'the API was removed' }]),
    );

    expect(patchIsWellFormed(patch, graph())).toEqual({ ok: true });
    expect(retirementsOf(patch)).toEqual([{ node: 'migrate-forms', lifecycle: 'abandoned' }]);
  });

  it('refuses abandoning a branch that is already retired', () => {
    const patch = parsePatch(
      patchOf([{ op: 'abandon-branch', root: 'gone', reason: 'already dead' }]),
    );
    const withAbandoned = graphOf([agent('gone', { lifecycle: 'abandoned' })]);

    expect(kindsOf(patchIsWellFormed(patch, withAbandoned))).toEqual(['node-already-retired']);
  });

  it('reports every violation in a patch, not just the first', () => {
    const patch = parsePatch(
      patchOf([
        { op: 'insert-nodes', nodes: [agent('migrate-forms')], edges: [] },
        { op: 'extend-loop', node: 'no-such-node', maxRounds: 5 },
      ]),
    );

    const result = patchIsWellFormed(patch, graph());

    expect(kindsOf(result).sort()).toEqual(['node-id-reused', 'unknown-node']);
    expect(errorsOf(result).map((error) => error.op)).toEqual([0, 1]);
  });
});
