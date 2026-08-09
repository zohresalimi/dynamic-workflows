/**
 * KAR-11.2 — `topoSort` is the plan's one cycle detector
 * (docs/06-planning-and-replanning.md §3.1).
 *
 * *"Cycle detection. `topoSort` throwing is the check."* The point of these
 * specs is not that a cycle is noticed — any traversal notices a cycle — it is
 * that the **order the scheduler would walk** and the **answer the validator
 * gives** come out of the same function, so a graph cannot be acyclic for one
 * and cyclic for the other.
 *
 * Verifies: EPIC-11-S7 (first scenario) · AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import { PlanCycleError, topoSort } from './topo-sort.ts';

const RUN = 'run_20260808T101500Z_ac1102';

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

function graph(nodes: unknown[], edges: unknown[] = []): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-08T10:15:00.000Z',
    nodes,
    edges,
  });
}

suite('topoSort orders a DAG, deterministically (AC3)', () => {
  it('returns every node with each dependency before its dependant', () => {
    const plan = graph([
      agent('implement', { deps: ['recon'] }),
      agent('recon'),
      agent('review', { deps: ['implement'] }),
    ]);

    expect(topoSort(plan)).toEqual(['recon', 'implement', 'review']);
  });

  it('breaks ties by node id, so two runs over the same graph agree', () => {
    const plan = graph([agent('zeta'), agent('alpha'), agent('mid')]);

    expect(topoSort(plan)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('treats a graph edge as ancestry, not only `deps`', () => {
    const plan = graph([agent('b'), agent('a')], [{ from: 'a', to: 'b', kind: 'control' }]);

    expect(topoSort(plan)).toEqual(['a', 'b']);
  });
});

suite('a cycle throws PlanCycleError naming the nodes on it (AC3)', () => {
  it('names all three members of an a -> b -> c -> a cycle', () => {
    const plan = graph([
      agent('a', { deps: ['c'] }),
      agent('b', { deps: ['a'] }),
      agent('c', { deps: ['b'] }),
    ]);

    let thrown: unknown;
    try {
      topoSort(plan);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PlanCycleError);
    const cycle = (thrown as PlanCycleError).cycle;
    expect([...cycle].toSorted()).toEqual(['a', 'b', 'c']);
    expect((thrown as PlanCycleError).message).toContain('a -> b -> c -> a');
  });

  it('names a self-edge as its own one-node cycle', () => {
    const plan = graph([agent('a', { deps: ['a'] })]);

    expect(() => topoSort(plan)).toThrow(PlanCycleError);
  });

  it('reports the nodes on the cycle and not the acyclic tail hanging off it', () => {
    const plan = graph([
      agent('a', { deps: ['b'] }),
      agent('b', { deps: ['a'] }),
      agent('tail', { deps: ['b'] }),
    ]);

    let thrown: PlanCycleError | undefined;
    try {
      topoSort(plan);
    } catch (error) {
      thrown = error as PlanCycleError;
    }

    expect([...(thrown?.cycle ?? [])].toSorted()).toEqual(['a', 'b']);
  });
});
