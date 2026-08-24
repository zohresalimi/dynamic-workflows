/**
 * KAR-11.1 — plan diagnostics are values, and their message is the one
 * docs/06-planning-and-replanning.md §3.1 prints.
 *
 * The retry in EPIC-11-S5 is only worth taking if the planner is handed back
 * something it can act on, so the two things asserted here are the two the
 * retry depends on: the diagnostic names the node *and* the key, and the
 * rendering is stable enough to be pasted into a packet verbatim.
 *
 * Verifies: EPIC-11-S5 (first scenario) · AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { canonicalJson } from './canonical-json.ts';
import { planHash } from './hash.ts';
import { renderPlanDiagnostics } from './plan-diagnostics.ts';
import { NODE_TYPES, type PlanGraph, PlanGraphSchema, TOOL_KINDS } from './plan-graph.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';
import { type PlanTimeCapability, validatePlan } from './validate-plan.ts';

const RUN = 'run_20260807T101500Z_ac1101';

/**
 * The one entry point, with everything §3 checks *besides* reachability made
 * uninteresting: one manual criterion nothing has to cover, one probed adapter
 * that can honour anything, and no packet to overflow. KAR-11.1's claim is
 * about the shape and the wording of a diagnostic, and calling `validatePlan`
 * rather than a reachability-only helper is what keeps that claim true of the
 * function the compiler actually calls.
 */
const CAPS: readonly PlanTimeCapability[] = [
  {
    provider: 'claude',
    version: '0.64.1',
    structuredOutput: true,
    resume: true,
    permissionLevels: ['read', 'worktree', 'worktree+net', 'full'],
    maxContext: 200_000,
  },
];

const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'migrate the app',
  scope: { included: ['the app'] },
  nonGoals: ['rewriting the backend'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'it works', check: { kind: 'manual', rubric: 'a human looks' } },
  ],
  knownFailureModes: [],
  approvedBy: null,
  specHash: `sha256-${'2'.repeat(64)}`,
});

const planDiagnostics = (plan: PlanGraph) =>
  validatePlan(plan, SPEC, CAPS, {
    estimatePacketTokens: () => 0,
    // "Assume everything is performable": this file is about the diagnostic
    // *vocabulary*, and KAR-23.9's own check has its own suite next door.
    performable: { nodeTypes: [...NODE_TYPES], toolKinds: [...TOOL_KINDS] },
  });

function graph(nodes: unknown[]): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-07T10:15:00.000Z',
    nodes,
    edges: [],
  });
}

const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1' },
  brief: `do ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
  ...over,
});

suite('EPIC-11-S5 — an unreachable read is a diagnostic, not an exception', () => {
  it('reports READ_UNREACHABLE naming the node and the key, in §3.1 wording', () => {
    const plan = graph([
      agent('implement', { reads: [{ kind: 'fact', key: 'finding/db-schema' }] }),
    ]);

    expect(planDiagnostics(plan)).toEqual([
      {
        severity: 'error',
        code: 'READ_UNREACHABLE',
        node: 'implement',
        key: 'finding/db-schema',
        message:
          "node 'implement' reads 'finding/db-schema' but no ancestor writes it and it is not " +
          'in the pinned spec',
      },
    ]);
  });

  it('returns nothing for a graph whose reads an ancestor writes', () => {
    const plan = graph([
      agent('recon', {
        writes: [{ kind: 'fact', key: 'finding/db-schema', schemaId: 'DeFlow.finding.v1' }],
      }),
      agent('implement', {
        deps: ['recon'],
        reads: [{ kind: 'fact', key: 'finding/db-schema' }],
      }),
    ]);

    expect(planDiagnostics(plan)).toEqual([]);
  });

  it('does not throw on the failing graph — that is the whole of §3.5', () => {
    const plan = graph([agent('implement', { reads: [{ kind: 'fact', key: 'nope/at-all' }] })]);
    expect(() => planDiagnostics(plan)).not.toThrow();
  });
});

suite('the rendering a retry packet carries verbatim', () => {
  it('renders one line per diagnostic, carrying the code and the message', () => {
    const plan = graph([
      agent('implement', {
        reads: [
          { kind: 'fact', key: 'finding/db-schema' },
          { kind: 'fact', key: 'finding/api-surface' },
        ],
      }),
    ]);

    const rendered = renderPlanDiagnostics(planDiagnostics(plan));
    expect(rendered).toContain('READ_UNREACHABLE');
    expect(rendered).toContain('finding/db-schema');
    expect(rendered).toContain('finding/api-surface');
    expect(rendered.split('\n').filter((line) => line.includes('READ_UNREACHABLE'))).toHaveLength(
      2,
    );
  });

  it('says so explicitly when there is nothing to report', () => {
    expect(renderPlanDiagnostics([])).toContain('no diagnostics');
  });
});

suite('EPIC-11-S4 — a diagnostic never depends on the document it rejected being persisted', () => {
  it('is computable from the document alone, before any hash is stored', async () => {
    const plan = graph([agent('implement', { reads: [{ kind: 'fact', key: 'finding/x' }] })]);
    // The hash of the rejected document is what the ledger records instead of
    // the document itself, so it has to be computable off the same value.
    const hash = await planHash(plan as unknown as Record<string, unknown>);
    expect(hash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(canonicalJson(planDiagnostics(plan))).toContain('READ_UNREACHABLE');
  });
});
