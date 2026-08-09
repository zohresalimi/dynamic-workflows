/**
 * KAR-11.3 — applying a `PlanPatch` to a `PlanGraph`.
 *
 * Verifies: EPIC-11-S13 (third and fourth scenarios), EPIC-11-S17 ·
 * AC2, AC7, AC9
 */
import { expect, it, describe as suite } from 'vitest';
import { applyPatch } from './apply-patch.ts';
import { planHash } from './hash.ts';
import { type RunId, RunIdSchema } from './ids.ts';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import { type PlanPatch, PlanPatchSchema } from './plan-patch.ts';

const RUN_ID: RunId = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');
const BASE_HASH = `sha256-${'a'.repeat(64)}`;
const CREATED_AT = '2026-08-08T09:00:00.000Z';

/** A minimal but complete agent node — every `NodeBase` field is required. */
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
    body: 'impl-checkout',
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
    planHash: BASE_HASH,
    parent: null,
    taskSpecHash: `sha256-${'b'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes,
    edges,
  });
}

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

function patchOf(ops: unknown[], over: Record<string, unknown> = {}): PlanPatch {
  return PlanPatchSchema.parse({
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch-7f3a1c',
    proposedBy: 'planner',
    reason: 'The auth module turned out to use JWT, so the header work splits in three.',
    ops,
    policy: policy(),
    ...over,
  });
}

const edge = (from: string, to: string): Record<string, unknown> => ({
  from,
  to,
  kind: 'control',
});

/** The base every op kind in this file is applied to. */
function baseGraph(): PlanGraph {
  return graphOf(
    [
      agent('recon-auth-surface'),
      agent('impl-checkout', { deps: ['recon-auth-surface'] }),
      agent('ship-it', { deps: ['impl-checkout'] }),
      agent('announce', { deps: ['ship-it'] }),
      loop('fix-lint', { deps: ['impl-checkout'] }),
    ],
    [
      edge('recon-auth-surface', 'impl-checkout'),
      edge('impl-checkout', 'ship-it'),
      edge('ship-it', 'announce'),
      edge('impl-checkout', 'fix-lint'),
    ],
  );
}

async function applied(patch: PlanPatch, base: PlanGraph = baseGraph()): Promise<PlanGraph> {
  const result = await applyPatch(base, patch, { createdAt: CREATED_AT });
  if (!result.ok) {
    throw new Error(
      `expected the patch to apply: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.graph;
}

const nodeOf = (graph: PlanGraph, id: string) => graph.nodes.find((node) => node.id === id);

const splitInto = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  agent(id, { derivedFrom: ['impl-checkout'], deps: ['recon-auth-surface'], ...over });

suite('AC2 — all five op kinds apply, and the result is a golden document', () => {
  it('insert-nodes appends the nodes and the edges', async () => {
    const graph = await applied(
      patchOf([
        {
          op: 'insert-nodes',
          nodes: [agent('analyse-ui'), agent('analyse-forms')],
          edges: [
            edge('recon-auth-surface', 'analyse-ui'),
            edge('recon-auth-surface', 'analyse-forms'),
          ],
        },
      ]),
    );

    expect(graph.nodes.map((node) => node.id)).toContain('analyse-ui');
    expect(graph).toMatchSnapshot();
  });

  it('split-node retires the source and mints its successors', async () => {
    const graph = await applied(
      patchOf([
        {
          op: 'split-node',
          node: 'impl-checkout',
          into: [splitInto('impl-checkout-cart'), splitInto('impl-checkout-payment')],
          edges: [edge('impl-checkout-cart', 'impl-checkout-payment')],
        },
      ]),
    );

    expect(graph).toMatchSnapshot();
  });

  it('replace-provider swaps the vendor and leaves the id alone', async () => {
    const graph = await applied(
      patchOf([
        {
          op: 'replace-provider',
          node: 'recon-auth-surface',
          provider: 'codex',
          model: 'gpt-5-codex',
        },
      ]),
    );

    expect(graph).toMatchSnapshot();
  });

  it('extend-loop raises maxRounds', async () => {
    const graph = await applied(patchOf([{ op: 'extend-loop', node: 'fix-lint', maxRounds: 8 }]));

    expect(graph).toMatchSnapshot();
  });

  it('abandon-branch marks the root and everything downstream of it', async () => {
    const graph = await applied(
      patchOf([
        {
          op: 'abandon-branch',
          root: 'ship-it',
          reason: 'Shipping is out of scope for this task; the release subgraph never runs.',
        },
      ]),
    );

    expect(graph).toMatchSnapshot();
  });
});

suite('the successor document, not a mutation of the base (AC5 upstream half)', () => {
  it('leaves the base graph untouched, object for object', async () => {
    const base = baseGraph();
    const before = structuredClone(base);

    await applied(patchOf([{ op: 'extend-loop', node: 'fix-lint', maxRounds: 9 }]), base);

    expect(base).toEqual(before);
  });

  it('bumps the version, points parent at the base hash and re-addresses itself', async () => {
    const graph = await applied(patchOf([{ op: 'extend-loop', node: 'fix-lint', maxRounds: 9 }]));

    expect(graph.version).toBe(4);
    expect(graph.parent).toBe(BASE_HASH);
    expect(graph.createdAt).toBe(CREATED_AT);
    expect(graph.planHash).toBe(await planHash(graph as unknown as Record<string, unknown>));
    expect(graph.planHash).not.toBe(BASE_HASH);
  });

  it('records who proposed it, so the scrubber can say who changed the plan', async () => {
    const graph = await applied(
      patchOf([{ op: 'extend-loop', node: 'fix-lint', maxRounds: 9 }], {
        proposedBy: 'recon-auth-surface',
      }),
    );

    expect(graph.createdBy).toBe('recon-auth-surface');
  });

  it("keeps a scheduler-proposed reroute attributable rather than laundering it as the planner's", async () => {
    const graph = await applied(
      patchOf([{ op: 'replace-provider', node: 'recon-auth-surface', provider: 'codex' }], {
        proposedBy: 'scheduler',
      }),
    );

    expect(graph.createdBy).toBe('scheduler');
  });
});

suite('AC7 — ids are retired, never moved and never reused', () => {
  it("split-node leaves the source in the graph as 'superseded'", async () => {
    const graph = await applied(
      patchOf([
        {
          op: 'split-node',
          node: 'impl-checkout',
          into: [splitInto('impl-checkout-cart'), splitInto('impl-checkout-payment')],
          edges: [],
        },
      ]),
    );

    expect(nodeOf(graph, 'impl-checkout')?.lifecycle).toBe('superseded');
    expect(nodeOf(graph, 'impl-checkout-cart')?.derivedFrom).toEqual(['impl-checkout']);
    expect(nodeOf(graph, 'impl-checkout-payment')?.derivedFrom).toEqual(['impl-checkout']);
  });

  it("abandon-branch marks the root and its descendants 'abandoned' and removes nothing", async () => {
    const before = baseGraph();
    const graph = await applied(
      patchOf([{ op: 'abandon-branch', root: 'ship-it', reason: 'out of scope' }]),
      before,
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id));
    expect(nodeOf(graph, 'ship-it')?.lifecycle).toBe('abandoned');
    expect(nodeOf(graph, 'announce')?.lifecycle).toBe('abandoned');
    // Not downstream of the abandoned root, so untouched.
    expect(nodeOf(graph, 'fix-lint')?.lifecycle).toBe('active');
  });

  it('refuses an op that would move a node id, before any policy engine sees it', async () => {
    const result = await applyPatch(
      baseGraph(),
      patchOf([
        {
          op: 'insert-nodes',
          nodes: [agent('impl-checkout-v2', { derivedFrom: ['impl-checkout'] })],
          edges: [],
        },
      ]),
      { createdAt: CREATED_AT },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.kind)).toEqual(['node-id-would-move']);
  });

  it('never lets a retired id be allocated again, including after a later replan', async () => {
    const v4 = await applied(
      patchOf([
        {
          op: 'split-node',
          node: 'impl-checkout',
          into: [splitInto('impl-checkout-cart'), splitInto('impl-checkout-payment')],
          edges: [],
        },
      ]),
    );

    const later = await applyPatch(
      v4,
      patchOf([{ op: 'insert-nodes', nodes: [agent('impl-checkout')], edges: [] }], {
        id: 'patch-later',
      }),
      { createdAt: CREATED_AT },
    );

    expect(later.ok).toBe(false);
    if (later.ok) return;
    expect(later.errors.map((error) => error.kind)).toEqual(['node-id-reused']);
    expect(later.errors[0]?.message).toContain('superseded');
  });

  it('refuses a second split of an already-retired id', async () => {
    const v4 = await applied(
      patchOf([
        {
          op: 'split-node',
          node: 'impl-checkout',
          into: [splitInto('impl-checkout-cart'), splitInto('impl-checkout-payment')],
          edges: [],
        },
      ]),
    );

    const later = await applyPatch(
      v4,
      patchOf(
        [
          {
            op: 'split-node',
            node: 'impl-checkout',
            into: [
              agent('impl-checkout-a', { derivedFrom: ['impl-checkout'] }),
              agent('impl-checkout-b', { derivedFrom: ['impl-checkout'] }),
            ],
            edges: [],
          },
        ],
        { id: 'patch-later' },
      ),
      { createdAt: CREATED_AT },
    );

    expect(later.ok).toBe(false);
    if (later.ok) return;
    expect(later.errors.map((error) => error.kind)).toContain('node-already-retired');
  });
});

suite('a patch is applied whole or not at all', () => {
  it('applies none of three ops when the middle one is wrong', async () => {
    const base = baseGraph();
    const result = await applyPatch(
      base,
      patchOf([
        { op: 'extend-loop', node: 'fix-lint', maxRounds: 8 },
        { op: 'replace-provider', node: 'no-such-node', provider: 'codex' },
        { op: 'insert-nodes', nodes: [agent('analyse-ui')], edges: [] },
      ]),
      { createdAt: CREATED_AT },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.kind)).toEqual(['unknown-node']);
  });

  it('refuses replace-provider against a node that has no provider to replace', async () => {
    const result = await applyPatch(
      baseGraph(),
      patchOf([{ op: 'replace-provider', node: 'fix-lint', provider: 'codex' }]),
      { createdAt: CREATED_AT },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.kind)).toEqual(['wrong-node-type']);
  });
});

suite('AC9 — reason is required, non-empty and never rewritten', () => {
  it('fails schema validation on an empty reason', () => {
    const parsed = PlanPatchSchema.safeParse({
      schemaId: 'DeFlow.planpatch.v1',
      id: 'patch-7f3a1c',
      proposedBy: 'planner',
      reason: '',
      ops: [{ op: 'extend-loop', node: 'fix-lint', maxRounds: 8 }],
      policy: policy(),
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path[0] === 'reason')).toBe(true);
  });

  it('leaves the reason byte-for-byte alone through application', async () => {
    const reason =
      'recon found @acme/ui, @acme/forms and @acme/charts also import the v2 API   — all three need analysing';
    const patch = patchOf([{ op: 'extend-loop', node: 'fix-lint', maxRounds: 8 }], { reason });

    await applied(patch);

    expect(patch.reason).toBe(reason);
  });
});
