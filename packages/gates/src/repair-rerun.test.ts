/**
 * KAR-12.5 AC5 — *"after a fix node completes, the gate set re-runs from the
 * deterministic tier"*, expressed as the one thing a run can actually execute:
 * a `PlanPatch`.
 *
 * `gatesAfterRepair` already answers *which* gates re-open. What it cannot
 * answer is how a run gets to run them again, and the answer is not "re-admit
 * the node": `admitGates` reads a recorded outcome per **node**, so a gate node
 * that has answered `fail` is answered for ever. The milestone rule states the
 * consequence out loud — *"gate ids, not node ids: the same definition may be
 * scheduled more than once across a repair loop"* — so a re-run is a **new gate
 * node**, depending on the fix, and the answered one is retired.
 *
 * Verifies: EPIC-12-S29 (re-run half) · AC5
 */
import {
  applyPatch,
  type NodeId,
  type PlanGraph,
  PlanGraphSchema,
  PlanPatchSchema,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { rerunGateNodeId, rerunGatePatch } from './repair-rerun.ts';

const RUN = 'run_20260810T120000Z_a1b2c3';
const FIX: NodeId = 'fix-a13f0c2b91e4' as NodeId;
const T0 = '2026-08-10T12:00:00.000Z';

const node = (over: Record<string, unknown>): Record<string, unknown> => ({
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  pathScopes: { write: [] },
  permission: 'worktree',
  returns: { schemaId: 'DeFlow.verdict.v3', maxTokens: 600 },
  retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  ...over,
});

const gate = (id: string, kind: 'deterministic' | 'adversarial', gateId: string) =>
  node({
    id,
    title: `gate ${id}`,
    type: 'gate',
    deps: ['impl-1'],
    gate:
      kind === 'deterministic'
        ? { kind: 'deterministic', gateId }
        : { kind: 'adversarial', brief: 'review it' },
    criteria: ['ac-1'],
    independence: { notSessionOf: [], preferDifferentProvider: false },
  });

function graph(nodes: readonly Record<string, unknown>[]): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 2,
    planHash: `sha256-${'a'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'b'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: T0,
    nodes: [
      node({
        id: 'impl-1',
        title: 'Implement',
        type: 'agent',
        brief: 'implement it',
        provider: { prefer: ['claude'], requires: [] },
        resume: 'always-replay',
        pathScopes: { write: ['src/**'] },
      }),
      node({
        id: FIX,
        title: 'Repair',
        type: 'agent',
        deps: ['impl-1'],
        brief: 'repair it',
        provider: { prefer: ['claude'], requires: [] },
        resume: 'always-replay',
        pathScopes: { write: ['src/**', 'test/**'] },
      }),
      ...nodes,
    ],
    edges: [],
  });
}

const FULL_LADDER = graph([
  gate('gate-review', 'adversarial', 'review'),
  gate('gate-typecheck', 'deterministic', 'typecheck'),
  gate('gate-unit', 'deterministic', 'unit'),
]);

const patchOf = (base: PlanGraph, round = 2) =>
  rerunGatePatch({
    base,
    after: [FIX],
    proposedBy: 'scheduler',
    replanDepth: 2,
    round,
  });

suite('the re-run patch reopens the deterministic tier, and nothing above it', () => {
  it('inserts one fresh node per deterministic gate and leaves the adversarial one alone', () => {
    const patch = patchOf(FULL_LADDER);

    expect(patch).not.toBeNull();
    const inserted = patch?.ops.find((op) => op.op === 'insert-nodes');
    expect(inserted?.op).toBe('insert-nodes');
    if (inserted?.op !== 'insert-nodes') return;

    expect(inserted.nodes.map((entry) => entry.id)).toEqual(['gate-typecheck-r2', 'gate-unit-r2']);
    // The review is a tier above: re-running it here would buy the review the
    // ladder's whole point is to withhold until the cheap gates are green.
    expect(inserted.nodes.map((entry) => entry.id)).not.toContain('gate-review-r2');
  });

  it('makes every re-run gate wait for the fix node, on a control edge', () => {
    const patch = patchOf(FULL_LADDER);
    const inserted = patch?.ops.find((op) => op.op === 'insert-nodes');
    if (inserted?.op !== 'insert-nodes') throw new Error('expected an insert-nodes op');

    for (const entry of inserted.nodes) expect(entry.deps).toEqual([FIX]);
    expect(inserted.edges).toEqual([
      { from: FIX, to: 'gate-typecheck-r2', kind: 'control' },
      { from: FIX, to: 'gate-unit-r2', kind: 'control' },
    ]);
  });

  it('carries the answered gate’s own definition, criteria and contract across', () => {
    const patch = patchOf(FULL_LADDER);
    const inserted = patch?.ops.find((op) => op.op === 'insert-nodes');
    if (inserted?.op !== 'insert-nodes') throw new Error('expected an insert-nodes op');

    const typecheck = inserted.nodes.find((entry) => entry.id === 'gate-typecheck-r2');
    expect(typecheck?.type).toBe('gate');
    if (typecheck?.type !== 'gate') return;
    // The same definition, or the re-run is a different check wearing the same
    // name — and the criterion travels with it, or KAR-12.4's coverage
    // validation sees a criterion no gate speaks to.
    expect(typecheck.gate).toEqual({ kind: 'deterministic', gateId: 'typecheck' });
    expect(typecheck.criteria).toEqual(['ac-1']);
    expect(typecheck.returns.schemaId).toBe('DeFlow.verdict.v3');
    expect(typecheck.lifecycle).toBe('active');
  });

  it('retires the answered gate node rather than deleting it', () => {
    const patch = patchOf(FULL_LADDER);
    const abandons = patch?.ops.filter((op) => op.op === 'abandon-branch') ?? [];

    expect(abandons.map((op) => op.root)).toEqual(['gate-typecheck', 'gate-unit']);
  });

  it('adds no permission and claims no cost, which is what makes the ruling arguable', () => {
    const patch = patchOf(FULL_LADDER);

    expect(patch?.policy.escalatesPermission).toBeNull();
    expect(patch?.policy.addsWriteCapability).toBe(false);
    // A deterministic gate spends nothing (KAR-12.1): claiming otherwise here
    // would put the re-run in front of the `expensive` rule for a number
    // nobody measured.
    expect(patch?.policy.estimatedCostDeltaUsd).toBe(0);
    expect(patch?.policy.replanDepth).toBe(2);
    expect(patch?.policy.blastRadius).toEqual({ paths: [], nodeCount: 2 });
  });

  it('names the fix it follows, in words the plan scrubber renders verbatim', () => {
    const patch = rerunGatePatch({
      base: FULL_LADDER,
      after: [FIX],
      proposedBy: 'scheduler',
      replanDepth: 2,
      round: 2,
      detail: 'test 1a2b3c4, fix 5d6e7f8',
    });

    expect(patch?.reason).toContain(FIX);
    expect(patch?.reason).toContain('deterministic');
    expect(patch?.reason).toContain('test 1a2b3c4, fix 5d6e7f8');
  });

  it('is a well-formed patch that really produces the successor graph', async () => {
    const patch = patchOf(FULL_LADDER);
    if (patch === null) throw new Error('expected a patch');

    // Parsed rather than trusted: a patch this function builds by hand must
    // survive the same schema every proposer's does.
    const applied = await applyPatch(FULL_LADDER, PlanPatchSchema.parse(patch), {
      createdAt: T0,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const lifecycles = Object.fromEntries(
      applied.graph.nodes.map((entry) => [entry.id, entry.lifecycle]),
    );
    expect(lifecycles['gate-typecheck']).toBe('abandoned');
    expect(lifecycles['gate-typecheck-r2']).toBe('active');
    expect(lifecycles['gate-review']).toBe('active');
  });
});

suite('there is nothing to re-run', () => {
  it('answers null for a plan whose gates are all above the deterministic tier', () => {
    expect(patchOf(graph([gate('gate-review', 'adversarial', 'review')]))).toBeNull();
  });

  it('answers null when the plan has no gate nodes at all', () => {
    expect(patchOf(graph([]))).toBeNull();
  });
});

suite('the re-run node id says which round it is', () => {
  it('appends the round, and stays inside the NodeId charset', () => {
    expect(rerunGateNodeId('gate-typecheck' as NodeId, 2)).toBe('gate-typecheck-r2');
    expect(rerunGateNodeId('gate-typecheck' as NodeId, 3)).toBe('gate-typecheck-r3');
  });

  it('truncates a long gate node id rather than minting an unparseable one', () => {
    const long = `gate-${'x'.repeat(70)}` as NodeId;
    const id = rerunGateNodeId(long, 2);

    expect(id.length).toBeLessThanOrEqual(63);
    expect(id.endsWith('-r2')).toBe(true);
  });
});
