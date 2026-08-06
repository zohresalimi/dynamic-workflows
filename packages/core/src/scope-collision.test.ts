/**
 * KAR-07.6 AC7 — the *only* thing declared path scopes still gate at plan time
 * (docs/09-workspace-and-safety.md §6.3, §7.3).
 *
 * Decision D14 demotes F5.3's declared scopes from "the thing merges depend
 * on" to a prediction, because most declared overlaps never actually conflict
 * — two agents editing different functions in one file merge fine, and static
 * serialization on `src/**` throws away real parallelism the run has already
 * paid for. What survives is one refusal: two concurrent write nodes whose
 * *entire* scope is the same single file. That plan cannot succeed, and it can
 * be known before a token is spent.
 *
 * Verifies: EPIC-07-S25 (scenarios 1 and 3) · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import { scopeCollisions } from './scope-collision.ts';

interface NodeShape {
  readonly id: string;
  readonly deps?: readonly string[];
  readonly write: readonly string[];
  readonly permission?: 'read' | 'worktree' | 'worktree+net' | 'full';
}

function agent(shape: NodeShape): Record<string, unknown> {
  return {
    id: shape.id,
    title: shape.id,
    type: 'agent',
    deps: [...(shape.deps ?? [])],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: shape.permission ?? 'worktree',
    pathScopes: { write: [...shape.write] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 500 },
    brief: `Do ${shape.id}.`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'native-if-available',
  };
}

function planOf(shapes: readonly NodeShape[]): PlanGraph {
  const nodes = shapes.map(agent);
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: 'run_20260802T141133Z_9f2a1c',
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'a'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes,
    edges: shapes.flatMap((shape) =>
      (shape.deps ?? []).map((from) => ({ from, to: shape.id, kind: 'control' })),
    ),
  });
}

suite('an overlapping declared scope is never a collision (AC7, EPIC-07-S25 scenario 1)', () => {
  it('lets two write nodes both scoped to "src/**" through untouched', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/**'] },
          { id: 'n2', write: ['src/**'] },
        ]),
      ),
    ).toEqual([]);
  });

  it('lets two write nodes both scoped to the same directory through — it is not a file', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/'] },
          { id: 'n2', write: ['src/'] },
        ]),
      ),
    ).toEqual([]);
  });

  it('lets two nodes sharing one file among several through — merge-tree decides that', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/a.ts', 'src/b.ts'] },
          { id: 'n2', write: ['src/a.ts', 'src/c.ts'] },
        ]),
      ),
    ).toEqual([]);
  });
});

suite('the identical single file is refused (AC7, EPIC-07-S25 scenario 3)', () => {
  it('names both nodes and the file they both claim entirely', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/a.ts'] },
          { id: 'n2', write: ['src/a.ts'] },
        ]),
      ),
    ).toEqual([{ nodes: ['n1', 'n2'], path: 'src/a.ts' }]);
  });

  it('reports each colliding pair once, in node order', () => {
    const collisions = scopeCollisions(
      planOf([
        { id: 'n1', write: ['src/a.ts'] },
        { id: 'n2', write: ['src/a.ts'] },
        { id: 'n3', write: ['src/a.ts'] },
      ]),
    );

    expect(collisions.map((collision) => collision.nodes)).toEqual([
      ['n1', 'n2'],
      ['n1', 'n3'],
      ['n2', 'n3'],
    ]);
  });

  it('does not fire on a read node, which writes nothing whatever it declares', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/a.ts'], permission: 'read' },
          { id: 'n2', write: ['src/a.ts'] },
        ]),
      ),
    ).toEqual([]);
  });

  it('does not fire when one node depends on the other — they never run at once', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/a.ts'] },
          { id: 'n2', deps: ['n1'], write: ['src/a.ts'] },
        ]),
      ),
    ).toEqual([]);
  });

  it('does not fire on a transitive dependency either', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/a.ts'] },
          { id: 'n2', deps: ['n1'], write: ['docs/x.md'] },
          { id: 'n3', deps: ['n2'], write: ['src/a.ts'] },
        ]),
      ),
    ).toEqual([]);
  });

  it('terminates on a graph with a cycle, because it runs on unvalidated planner output', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', deps: ['n2'], write: ['src/a.ts'] },
          { id: 'n2', deps: ['n1'], write: ['src/a.ts'] },
        ]),
      ),
    ).toEqual([]);
  });
});
