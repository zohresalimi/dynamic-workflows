/**
 * KAR-09.1 — `validateDeclaredReads`, `satisfies` and `PINNED_KEYS`
 * (docs/08-context-and-memory.md §2.1).
 *
 * Verifies: EPIC-09-S1, EPIC-09-S2, EPIC-09-S3, EPIC-09-S4, EPIC-09-S5 ·
 * AC1, AC2, AC3, AC4, AC5, AC6, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import { InsertNodesOpSchema, type PatchOp, PlanPatchSchema } from './plan-patch.ts';
import { PINNED_KEYS, satisfies, validateDeclaredReads } from './validate-declared-reads.ts';

const RETURNS = { schemaId: 'DeFlow.finding.v1', maxTokens: 500 };

function agent(
  id: string,
  deps: string[],
  extra: { reads?: unknown[]; writes?: unknown[] } = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    type: 'agent',
    deps,
    lifecycle: 'active',
    reads: extra.reads ?? [],
    writes: extra.writes ?? [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: RETURNS,
    brief: `Do ${id}.`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'native-if-available',
  };
}

function write(key: string): Record<string, unknown> {
  return { kind: 'fact', key, schemaId: 'DeFlow.finding.v1' };
}

function graphOf(nodes: unknown[], edges: unknown[] = []): PlanGraph {
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
    edges,
  });
}

/** Recursively freezes a plain object/array tree — `Object.freeze` alone is
 * shallow, and the purity scenario (EPIC-09-S1) is only meaningful if
 * `validateDeclaredReads` cannot get away with mutating a nested array. */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || Array.isArray(value))) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

suite('EPIC-09-S1 — happy path: an ancestor satisfies a declared read', () => {
  function chain(): PlanGraph {
    return graphOf([
      agent('recon', [], {
        writes: [write('finding/auth-uses-jwt'), write('scope/touched-paths')],
      }),
      agent('implement', ['recon'], { reads: [{ kind: 'fact', key: 'finding/*' }] }),
      agent('gate-typecheck', ['implement'], {
        reads: [{ kind: 'fact', key: 'scope/touched-paths' }],
      }),
    ]);
  }

  it('a direct ancestor satisfies the read', () => {
    expect(validateDeclaredReads(chain())).toEqual([]);
  });

  it("a transitive ancestor satisfies gate-typecheck's read, two hops up", () => {
    const errors = validateDeclaredReads(chain());
    expect(errors.filter((e) => e.node === 'gate-typecheck')).toEqual([]);
  });

  it('the pinned spec satisfies a spec read with no ancestor at all', () => {
    const graph = graphOf([agent('frame', [], { reads: [{ kind: 'spec', section: 'criteria' }] })]);
    expect(validateDeclaredReads(graph)).toEqual([]);
  });

  it('the reachable set contains PINNED_KEYS before any ancestor is walked', () => {
    expect(PINNED_KEYS.has('spec:criteria')).toBe(true);
    expect(satisfies([], 'spec:criteria')).toBe(true);
  });

  it('is pure: two calls over a deep-frozen graph do not throw and return deeply equal results', () => {
    const frozen = deepFreeze(chain());
    expect(() => validateDeclaredReads(frozen)).not.toThrow();
    const first = validateDeclaredReads(frozen);
    const second = validateDeclaredReads(frozen);
    expect(first).not.toBe(second); // fresh array each call — nothing is cached on `g`
    expect(first).toEqual(second);
  });
});

suite('EPIC-09-S2 — an unsatisfiable read fails plan validation', () => {
  it('the producing node was never planned: exactly one error', () => {
    const graph = graphOf([
      agent('implement', [], { reads: [{ kind: 'fact', key: 'finding/db-schema' }] }),
    ]);
    expect(validateDeclaredReads(graph)).toEqual([
      { code: 'undeclared-read', node: 'implement', key: 'finding/db-schema' },
    ]);
  });

  it('all errors are returned, not the first, ordered by node id', () => {
    const graph = graphOf([
      agent('delta', [], { reads: [{ kind: 'fact', key: 'finding/d' }] }),
      agent('bravo', [], { reads: [{ kind: 'fact', key: 'finding/b' }] }),
      agent('alpha', [], { reads: [{ kind: 'fact', key: 'finding/a' }] }),
      agent('charlie', [], { reads: [{ kind: 'fact', key: 'finding/c' }] }),
    ]);
    expect(validateDeclaredReads(graph)).toEqual([
      { code: 'undeclared-read', node: 'alpha', key: 'finding/a' },
      { code: 'undeclared-read', node: 'bravo', key: 'finding/b' },
      { code: 'undeclared-read', node: 'charlie', key: 'finding/c' },
      { code: 'undeclared-read', node: 'delta', key: 'finding/d' },
    ]);
  });

  // AC7's 400-node-fan-out timing scenario lives in
  // packages/core/test/validate-declared-reads-perf.test.ts: measuring
  // elapsed time needs `performance.now`, and packages/core/src is linted to
  // refuse that identifier everywhere under it, tests included — a clock
  // read wearing a different name is still a clock read (.oxlintrc.json).
});

suite('EPIC-09-S3 — a sibling write is not a satisfied read', () => {
  function siblings(edges: Record<string, unknown>[] = []): PlanGraph {
    return graphOf(
      [
        agent('plan', []),
        agent('analyse-a', ['plan'], { writes: [write('finding/uses-pinia')] }),
        agent('analyse-b', ['plan'], { reads: [{ kind: 'fact', key: 'finding/uses-pinia' }] }),
      ],
      edges,
    );
  }

  it("a sibling's write does not satisfy a sibling's read", () => {
    expect(validateDeclaredReads(siblings())).toEqual([
      { code: 'undeclared-read', node: 'analyse-b', key: 'finding/uses-pinia' },
    ]);
  });

  it('adding a control edge from analyse-a to analyse-b fixes it', () => {
    const graph = siblings([{ from: 'analyse-a', to: 'analyse-b', kind: 'control' }]);
    expect(validateDeclaredReads(graph)).toEqual([]);
  });

  it('a data edge carrying the key also fixes it', () => {
    const graph = siblings([
      { from: 'analyse-a', to: 'analyse-b', kind: 'data', carries: ['finding/uses-pinia'] },
    ]);
    expect(validateDeclaredReads(graph)).toEqual([]);
  });
});

suite('EPIC-09-S4 — satisfies() across exact, glob, ext: and near-miss keys', () => {
  it.each([
    { reachable: ['finding/auth-uses-jwt'], requested: 'finding/auth-uses-jwt', result: true },
    { reachable: ['finding/auth-uses-jwt'], requested: 'finding/*', result: true },
    { reachable: ['finding/*'], requested: 'finding/auth-uses-jwt', result: true },
    { reachable: ['finding/auth'], requested: 'finding/authz', result: false },
    { reachable: ['ext:migration/vue3-incompat'], requested: 'ext:migration/*', result: true },
    { reachable: ['ext:migration/vue3-incompat'], requested: 'ext:other/*', result: false },
    { reachable: ['decision/router-strategy'], requested: 'finding/*', result: false },
    { reachable: [], requested: 'spec:criteria', result: true },
  ])('satisfies($reachable, $requested) === $result', ({ reachable, requested, result }) => {
    expect(satisfies(reachable, requested)).toBe(result);
  });
});

function baseGraphWithImplement(): PlanGraph {
  return graphOf([agent('implement', [])]);
}

function insertNodesOp(...nodes: Record<string, unknown>[]): PatchOp {
  return InsertNodesOpSchema.parse({ op: 'insert-nodes', nodes, edges: [] });
}

function planPatch(...ops: PatchOp[]) {
  return PlanPatchSchema.parse({
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch_1',
    proposedBy: 'planner',
    reason: 'add a post-implementation polish pass',
    ops,
    policy: {
      estimatedCostDeltaUsd: 0,
      estimatedWallClockDeltaMs: 0,
      blastRadius: { paths: [], nodeCount: ops.length },
      replanDepth: 1,
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  });
}

/** Merges a patch's `insert-nodes` ops into a base graph. This is a test
 * fixture, not `applyOps` (KAR-11.3) — it exists only to build the
 * post-patch `PlanGraph` this suite validates, using real `PlanPatch` shapes
 * rather than inventing a parallel one. */
function applyInsertNodes(base: PlanGraph, appliedPatch: ReturnType<typeof planPatch>): PlanGraph {
  const inserted = appliedPatch.ops.filter(
    (op): op is Extract<PatchOp, { op: 'insert-nodes' }> => op.op === 'insert-nodes',
  );
  return graphOf(
    [...base.nodes, ...inserted.flatMap((op) => op.nodes)],
    [...base.edges, ...inserted.flatMap((op) => op.edges)],
  );
}

suite('EPIC-09-S5 / AC6 — the same function guards a proposed plan and a patched plan', () => {
  const READ_KEY = 'verdict/visual-regression';

  it('a runtime patch inserting a node whose read no ancestor writes is rejected, naming the node and the key', () => {
    const patchInsertingPolishOnly = planPatch(
      insertNodesOp(agent('polish', ['implement'], { reads: [{ kind: 'fact', key: READ_KEY }] })),
    );
    const candidate = applyInsertNodes(baseGraphWithImplement(), patchInsertingPolishOnly);

    expect(validateDeclaredReads(candidate)).toEqual([
      { code: 'undeclared-read', node: 'polish', key: READ_KEY },
    ]);
  });

  it('the same rejection is produced for a plan.proposed-shaped graph, not just a patched one', () => {
    const proposed = graphOf([agent('polish', [], { reads: [{ kind: 'fact', key: READ_KEY }] })]);
    expect(validateDeclaredReads(proposed)).toEqual([
      { code: 'undeclared-read', node: 'polish', key: READ_KEY },
    ]);
  });

  it('a patch that also inserts the producer as an ancestor is accepted', () => {
    const patchInsertingBoth = planPatch(
      insertNodesOp(agent('visual-gate', ['implement'], { writes: [write(READ_KEY)] })),
      insertNodesOp(agent('polish', ['visual-gate'], { reads: [{ kind: 'fact', key: READ_KEY }] })),
    );
    const candidate = applyInsertNodes(baseGraphWithImplement(), patchInsertingBoth);

    expect(validateDeclaredReads(candidate)).toEqual([]);
  });
});

suite('validateDeclaredReads — kinds beyond fact and spec', () => {
  it('never treats an artifact read as a violation: a handle is content-addressed, not planned', () => {
    const graph = graphOf([
      agent('reads-an-artifact', [], {
        reads: [{ kind: 'artifact', handle: `artifact://${'b'.repeat(64)}` }],
      }),
    ]);
    expect(validateDeclaredReads(graph)).toEqual([]);
  });

  it('does not let a node satisfy its own read', () => {
    const graph = graphOf([
      agent('self-serving', [], {
        reads: [{ kind: 'fact', key: 'finding/x' }],
        writes: [write('finding/x')],
      }),
    ]);
    expect(validateDeclaredReads(graph)).toEqual([
      { code: 'undeclared-read', node: 'self-serving', key: 'finding/x' },
    ]);
  });
});
