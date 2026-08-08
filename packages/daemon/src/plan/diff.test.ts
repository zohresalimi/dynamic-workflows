/**
 * KAR-11.6 AC7 — the reroute has to be *visible*: a node whose provider was
 * swapped must read as `changed` with a `/provider` replace patch, and never as
 * a removed-plus-added pair (docs/06-planning-and-replanning.md §4.4, §5).
 *
 * `diffPlanGraphs` is the pure half of that claim, so it is tested here as pure
 * logic over two documents. `../../test/integration/quota-reroute.test.ts`
 * exercises the same function over a plan that was really patched, really
 * revalidated and really committed, which is where AC7's *"the swap is a plan
 * version"* is actually earned; this file is what pins the contract that makes
 * the integration assertion mean something.
 *
 * The load-bearing decision is **identity is `NodeId` and nothing else.** A
 * diff that identifies nodes by object equality reports a provider swap as
 * `removed: ['implement']` + `added: ['implement']`, which is not merely uglier
 * — it loses the fact that it is the *same step* running somewhere else, which
 * is the entire content of F3.9's wording. It is also the contract EPIC-17's
 * plan-evolution scrubber is budgeted against (KAR-11.5 AC6), so it is asserted
 * rather than assumed.
 *
 * Verifies: EPIC-11-S31 · AC7
 */
import type { NodeId, PlanGraph, ProviderId } from '@DeFlow/core';
import { PlanGraphSchema } from '@DeFlow/core';
import { describe, expect, it } from 'vitest';
import { diffPlanGraphs } from './diff.ts';

const RUN = 'run_20260808T090000Z_a71c04';
const IMPLEMENT = 'implement' as NodeId;
const CLAUDE = 'claude' as ProviderId;
const CODEX = 'codex' as ProviderId;
const hash = (fill: string): string => `sha256-${fill.repeat(64)}`;

function agent(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'agent',
    title: `do ${id}`,
    deps: [],
    lifecycle: 'active',
    permission: 'worktree',
    pathScopes: { write: ['src/**'] },
    reads: [],
    writes: [],
    returns: { schemaId: 'DeFlow.nodereturn.v1', maxTokens: 1500 },
    brief: `brief for ${id}`,
    provider: { prefer: [CLAUDE], requires: ['resumableSessions'] },
    resume: 'native-if-available',
    ...over,
  };
}

const edge = (from: string, to: string): Record<string, unknown> => ({ from, to, kind: 'control' });

function graph(
  nodes: readonly Record<string, unknown>[],
  edges: readonly Record<string, unknown>[] = [],
  version = 1,
): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version,
    planHash: hash(String(version)[0] === '1' ? 'a' : 'b'),
    parent: version === 1 ? null : hash('a'),
    taskSpecHash: `sha256-${'c'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-08T09:00:00.000Z',
    nodes,
    edges,
  });
}

describe('diffPlanGraphs — a provider swap is a change, not a replacement (AC7)', () => {
  it('reports the rerouted node as changed with a /provider replace patch', () => {
    const before = graph([agent(IMPLEMENT)]);
    const after = graph(
      [agent(IMPLEMENT, { provider: { prefer: [CODEX], requires: ['resumableSessions'] } })],
      [],
      2,
    );

    const diff = diffPlanGraphs(before, after);

    expect(diff.nodes.added).toEqual([]);
    expect(diff.nodes.removed).toEqual([]);
    expect(diff.nodes.unchanged).toEqual([]);
    expect(diff.nodes.changed.map((entry) => entry.id)).toEqual([IMPLEMENT]);
    expect(diff.nodes.changed[0]?.patch).toEqual([
      { op: 'replace', path: '/provider/prefer/0', value: CODEX },
    ]);
  });

  it('keeps identity on NodeId even when every other field of the node moved', () => {
    // Nothing but the id survives. Object equality would call this a different
    // node; NodeId identity calls it the same step, rewritten.
    const before = graph([agent(IMPLEMENT)]);
    const after = graph(
      [
        agent(IMPLEMENT, {
          title: 'do it differently',
          brief: 'a wholly rewritten brief',
          permission: 'read',
          pathScopes: { write: [] },
          provider: { prefer: [CODEX], requires: [] },
          resume: 'always-replay',
        }),
      ],
      [],
      2,
    );

    const diff = diffPlanGraphs(before, after);

    expect(diff.nodes.added).toEqual([]);
    expect(diff.nodes.removed).toEqual([]);
    expect(diff.nodes.changed.map((entry) => entry.id)).toEqual([IMPLEMENT]);
    expect(diff.nodes.changed[0]?.patch.some((op) => op.path.startsWith('/provider'))).toBe(true);
  });
});

describe('diffPlanGraphs — added, removed and unchanged node sets', () => {
  it('partitions the two node sets by id, and leaves untouched nodes patch-free', () => {
    const before = graph([agent('recon'), agent('implement'), agent('retire')]);
    const after = graph(
      [
        agent('recon'),
        agent('implement', { provider: { prefer: [CODEX], requires: ['resumableSessions'] } }),
        agent('review'),
      ],
      [],
      2,
    );

    const diff = diffPlanGraphs(before, after);

    expect(diff.nodes.added).toEqual(['review']);
    expect(diff.nodes.removed).toEqual(['retire']);
    expect(diff.nodes.unchanged).toEqual(['recon']);
    expect(diff.nodes.changed.map((entry) => entry.id)).toEqual(['implement']);
  });

  it('reports a graph against itself as wholly unchanged', () => {
    // The graph-level fields — version, planHash, parent, createdAt — differ
    // between any two real versions and are *not* node state. A diff that
    // folded them in would report every node as changed on every replan.
    const nodes = [agent('recon'), agent('implement', { deps: ['recon'] })];
    const before = graph(nodes, [edge('recon', 'implement')]);
    const after = graph(nodes, [edge('recon', 'implement')], 2);

    const diff = diffPlanGraphs(before, after);

    expect(diff.nodes).toEqual({
      added: [],
      removed: [],
      changed: [],
      unchanged: ['recon', 'implement'],
    });
    expect(diff.edges).toEqual({ added: [], removed: [] });
  });
});

describe('diffPlanGraphs — edges', () => {
  it('reports added and removed edges without touching the node sets', () => {
    const nodes = [agent('recon'), agent('implement'), agent('review')];
    const before = graph(nodes, [edge('recon', 'implement')]);
    const after = graph(nodes, [edge('recon', 'review'), edge('review', 'implement')], 2);

    const diff = diffPlanGraphs(before, after);

    expect(diff.edges.added).toEqual([
      { from: 'recon', to: 'review', kind: 'control' },
      { from: 'review', to: 'implement', kind: 'control' },
    ]);
    expect(diff.edges.removed).toEqual([{ from: 'recon', to: 'implement', kind: 'control' }]);
    expect(diff.nodes.changed).toEqual([]);
    expect(diff.nodes.unchanged).toEqual(['recon', 'implement', 'review']);
  });

  it('distinguishes two edges between the same pair by kind and carried keys', () => {
    const nodes = [agent('recon'), agent('implement')];
    const before = graph(nodes, [{ from: 'recon', to: 'implement', kind: 'control' }]);
    const after = graph(
      nodes,
      [
        { from: 'recon', to: 'implement', kind: 'control' },
        { from: 'recon', to: 'implement', kind: 'data', carries: ['finding/auth'] },
      ],
      2,
    );

    const diff = diffPlanGraphs(before, after);

    expect(diff.edges.added).toEqual([
      { from: 'recon', to: 'implement', kind: 'data', carries: ['finding/auth'] },
    ]);
    expect(diff.edges.removed).toEqual([]);
  });
});

describe('diffPlanGraphs — the version pair it describes', () => {
  it('carries the from and to plan versions so a caller need not re-derive them', () => {
    const diff = diffPlanGraphs(graph([agent('recon')]), graph([agent('recon')], [], 4));

    expect(diff.from).toBe(1);
    expect(diff.to).toBe(4);
  });
});
