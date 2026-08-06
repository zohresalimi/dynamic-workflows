/**
 * KAR-08.1 — `full` never arrives by accident (EPIC-08-S4).
 *
 * Two doors and both are locked from the inside. A plan cannot *contain* a
 * `full` node unless the run carries the operator's opt-in, and a `PlanPatch`
 * cannot *raise* a node to `full` on its own authority however good its
 * reason. The second is the one that matters at runtime: a running node
 * proposing a patch is DeFlow's normal replanning path (F2.5), so "auto-apply
 * anything that does not add write capability" is a rule that would hand out
 * `full` to a well-worded justification.
 *
 * The approval request has to say plainly that `full` is not a sandbox. That
 * is not decoration — security model §6.1 puts defending the user against
 * themselves at `full` explicitly out of scope, which is exactly why the
 * consent has to be informed at the moment it is given rather than in a
 * document nobody opens.
 *
 * Verifies: EPIC-08-S4 · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  FULL_OPT_IN_RULE,
  FullPermissionOptInSchema,
  fullEscalationRuling,
  fullPermissionIssues,
} from './full-permission.ts';
import { NodeIdSchema } from './ids.ts';
import type { PermissionLevel } from './plan-graph.ts';
import { PlanNodeSchema } from './plan-graph.ts';
import type { PatchPolicy, PlanPatch } from './plan-patch.ts';

const OPT_IN = { at: '2026-08-06T09:15:00.000Z', by: 'operator' } as const;

function node(id: string, permission: PermissionLevel): Record<string, unknown> {
  return {
    id,
    title: `Node ${id}`,
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission,
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 500 },
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300000, jitter: 'full' } },
    budget: {},
    type: 'agent',
    brief: 'Do the thing.',
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'native-if-available',
  };
}

function plan(...levels: [string, PermissionLevel][]): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    version: 1,
    specHash: `sha256-${'a'.repeat(64)}`,
    nodes: levels.map(([id, level]) => node(id, level)),
    edges: [],
  };
}

const policy = (escalation: PatchPolicy['escalatesPermission']): PatchPolicy => ({
  estimatedCostDeltaUsd: 0.4,
  estimatedWallClockDeltaMs: 60_000,
  blastRadius: { paths: ['infra/**'], nodeCount: 1 },
  replanDepth: 1,
  escalatesPermission: escalation,
  addsWriteCapability: true,
});

const patch = (escalation: PatchPolicy['escalatesPermission']): PlanPatch => ({
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-1',
  proposedBy: NodeIdSchema.parse('n1'),
  reason: 'The migration needs to reach the cluster.',
  ops: [{ op: 'extend-loop', node: NodeIdSchema.parse('n2'), maxRounds: 2 }],
  policy: policy(escalation),
});

suite('a run without the opt-in cannot contain a full node', () => {
  it('fails validation naming the node and the missing run-level opt-in', () => {
    const issues = fullPermissionIssues(plan(['n1', 'worktree'], ['n2', 'full']), null);

    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue?.code).toBe('full-permission-not-opted-in');
    expect(issue?.path).toEqual(['nodes', 'n2', 'permission']);
    expect(issue?.message).toContain('n2');
    expect(issue?.message).toContain('opt-in');
  });

  it('names every offending node rather than stopping at the first', () => {
    const issues = fullPermissionIssues(
      plan(['n1', 'full'], ['n2', 'worktree'], ['n3', 'full']),
      null,
    );
    expect(issues.map((issue) => issue.path[1])).toEqual(['n1', 'n3']);
  });

  it('admits the same plan once the run carries the opt-in', () => {
    expect(fullPermissionIssues(plan(['n1', 'full']), OPT_IN)).toEqual([]);
  });

  it('admits a plan with no full node either way', () => {
    const below = plan(['n1', 'read'], ['n2', 'worktree'], ['n3', 'worktree+net']);
    expect(fullPermissionIssues(below, null)).toEqual([]);
    expect(fullPermissionIssues(below, OPT_IN)).toEqual([]);
  });

  it('reads the levels off the raw plan, so an unparseable node cannot smuggle one in', () => {
    // The check runs at plan validation, beside the schema parse and not after
    // it: a node that fails some *other* field's validation still must not
    // sneak `permission: "full"` past this rule on the retry.
    const smuggled = { ...plan(['n1', 'worktree']), nodes: [{ id: 'n1', permission: 'full' }] };
    expect(fullPermissionIssues(smuggled, null)).toHaveLength(1);
  });
});

suite('the opt-in is a recorded, rendered fact', () => {
  it('carries who opted in and when', () => {
    const parsed = FullPermissionOptInSchema.safeParse(OPT_IN);
    expect(parsed.success).toBe(true);
  });

  it('refuses an opt-in with no timestamp — "it was on" is not a record', () => {
    expect(FullPermissionOptInSchema.safeParse({ by: 'operator' }).success).toBe(false);
    expect(FullPermissionOptInSchema.safeParse({ at: 'yesterday', by: 'op' }).success).toBe(false);
  });
});

suite('a PlanPatch cannot raise a node to full on its own authority', () => {
  it('rules requires-approval, never auto', () => {
    const ruling = fullEscalationRuling(patch({ from: 'worktree', to: 'full' }));

    expect(ruling.ruling).toBe('requires-approval');
    if (ruling.ruling !== 'requires-approval') return;
    expect(ruling.rule).toBe(FULL_OPT_IN_RULE);
    expect(ruling.from).toBe('worktree');
    expect(ruling.to).toBe('full');
  });

  it('states plainly that full is not a sandbox', () => {
    const ruling = fullEscalationRuling(patch({ from: 'read', to: 'full' }));
    if (ruling.ruling !== 'requires-approval') throw new Error('unreachable');
    expect(ruling.message).toContain('not a sandbox');
  });

  it('fires for every escalation whose destination is full, from any level', () => {
    for (const from of ['read', 'worktree', 'worktree+net', 'full'] as const) {
      expect(fullEscalationRuling(patch({ from, to: 'full' })).ruling).toBe('requires-approval');
    }
  });

  it('does not fire on a patch that escalates below full, or escalates nothing', () => {
    // Those are KAR-11.4's rules to make. This one has nothing to say, and
    // saying "auto" would be this rule granting an approval it never assessed.
    expect(fullEscalationRuling(patch({ from: 'read', to: 'worktree' })).ruling).toBe(
      'not-applicable',
    );
    expect(fullEscalationRuling(patch(null)).ruling).toBe('not-applicable');
  });

  it('fires on an insert-nodes op that lands a full node, not only on the declared pair', () => {
    // `escalatesPermission` is the proposer's own account of what it is doing.
    // A patch that inserts a `full` node while declaring no escalation is
    // either a bug or the attack, and either way the ops are the ground truth.
    // Parsed rather than cast, so the op carries a node the schema accepts —
    // a hand-cast object would let this pass against a shape no planner can
    // actually produce.
    const inserting: PlanPatch = {
      ...patch(null),
      ops: [{ op: 'insert-nodes', nodes: [PlanNodeSchema.parse(node('n9', 'full'))], edges: [] }],
    };
    expect(fullEscalationRuling(inserting).ruling).toBe('requires-approval');
  });
});
