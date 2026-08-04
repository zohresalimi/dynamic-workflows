/**
 * KAR-02.3 — `PlanGraph`, `NodeBase` and the seven-member `PlanNode`
 * discriminated union.
 *
 * Verifies: EPIC-02-S4 (the schema half), EPIC-02-S9, EPIC-02-S10 ·
 * AC2, AC3, AC4, AC5, AC7, AC8
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { planHash } from './hash.ts';
import { NodeIdSchema } from './ids.ts';
import { mapChildId } from './map-child-id.ts';
import {
  DEFAULT_ITEM_ID_FROM,
  DEFAULT_RETRY_POLICY,
  DEFAULT_RETURNS_MAX_TOKENS,
  NODE_TYPES,
  PlanGraphSchema,
  PlanNodeSchema,
  parsePlanGraph,
} from './plan-graph.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/plans/seven-types.json', import.meta.url),
);
const planFixture: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** The `NodeBase` contract, minus the three fields (`id`, `title`, `deps`)
 * that are structural rather than part of the safety/memory contract. */
const nodeBaseCommon = {
  id: 'a-node',
  title: 'A node',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300000, jitter: 'full' } },
  budget: {},
} as const;

/** The type-specific half of a minimal valid node, one entry per member of
 * the union. Kept next to the base above so a scenario outline can delete a
 * single field from any (type, field) pair. */
const typeSpecific: Record<string, Record<string, unknown>> = {
  agent: {
    type: 'agent',
    brief: 'Survey how the auth module verifies tokens.',
    provider: { prefer: ['claude-code'], requires: ['structuredOutput'] },
    resume: 'native-if-available',
  },
  tool: {
    type: 'tool',
    tool: { kind: 'script', run: 'pnpm lint' },
    effectClass: 'pure',
  },
  gate: {
    type: 'gate',
    gate: { kind: 'deterministic', gateId: 'lint-clean' },
    criteria: ['lint-has-zero-errors'],
    independence: { notSessionOf: [], preferDifferentProvider: false },
  },
  human: {
    type: 'human',
    prompt: 'Approve this release?',
    options: [{ id: 'approve', label: 'Approve', effect: 'approve' }],
  },
  map: {
    type: 'map',
    over: { kind: 'glob', pattern: 'src/**/*.ts' },
    concurrency: 3,
    body: 'review-one-file',
    itemIdFrom: 'value-hash',
  },
  loop: {
    type: 'loop',
    body: 'run-integration-check',
    maxRounds: 5,
    goal: { kind: 'gate', gate: 'gate-lint-clean' },
    noProgress: { sameFailureSignatureLimit: 3, diffSimilarityThreshold: 0.95 },
  },
  subgraph: {
    type: 'subgraph',
    graph: { kind: 'template', templateId: 'release', params: {} },
  },
};

function validNode(type: string): Record<string, unknown> {
  const specific = typeSpecific[type];
  if (specific === undefined) throw new Error(`no fixture for node type ${type}`);
  return structuredClone({ ...nodeBaseCommon, ...specific });
}

suite('PlanNodeSchema — AC2: the discriminated union is real', () => {
  it('parses one valid node of each of the seven types', () => {
    for (const type of NODE_TYPES) {
      const result = PlanNodeSchema.safeParse(validNode(type));
      expect(result.success, `${type} should parse: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('rejects an unknown type on the discriminator itself', () => {
    const result = PlanNodeSchema.safeParse({ ...validNode('agent'), type: 'wizard' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues[0]?.path).toEqual(['type']);
  });

  it("rejects type: 'agent' carrying a gate field, naming gate", () => {
    // The discriminator selects the `agent` branch and that branch is strict,
    // so `gate` is a hard parse error naming the offending key — not an
    // ignored extra property (EPIC-02-S9, third scenario).
    const result = PlanNodeSchema.safeParse({
      ...validNode('agent'),
      gate: { kind: 'deterministic', gateId: 'typecheck' },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(JSON.stringify(result.error.issues)).toContain('gate');
  });

  it("requires brief and provider.prefer on type: 'agent'", () => {
    for (const path of [['brief'], ['provider', 'prefer']]) {
      const node = validNode('agent');
      if (path.length === 1) delete node[path[0] as string];
      else delete (node.provider as Record<string, unknown>)[path[1] as string];
      const result = PlanNodeSchema.safeParse(node);
      expect(result.success, `omitting ${path.join('.')} must fail`).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.error.issues[0]?.path).toEqual(path);
    }
  });

  it("requires criteria and independence on type: 'gate'", () => {
    for (const field of ['criteria', 'independence']) {
      const node = validNode('gate');
      delete node[field];
      const result = PlanNodeSchema.safeParse(node);
      expect(result.success, `omitting ${field} must fail`).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.error.issues[0]?.path).toEqual([field]);
    }
  });
});

/**
 * EPIC-02-S10, scenario outline. `retry` and `budget` are deliberately not in
 * this list and not in the scenario's Examples table either: the same
 * scenario's second half requires them to *default*, so "every node carries
 * them" (AC3) is satisfied after parse rather than demanded of the author.
 * The six below have no default, because a defaulted `permission` is how a
 * system silently escalates (PRD G6).
 */
const REQUIRED_CONTRACT_FIELDS = [
  'permission',
  'pathScopes',
  'returns',
  'reads',
  'writes',
  'lifecycle',
] as const;

suite('NodeBase — AC3: the safety and memory contract is required on every node type', () => {
  for (const type of NODE_TYPES) {
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      it(`rejects a ${type} node with ${field} omitted, naming ${field}`, () => {
        const node = validNode(type);
        delete node[field];
        const result = PlanNodeSchema.safeParse(node);
        expect(result.success).toBe(false);
        if (result.success) throw new Error('unreachable');
        expect(result.error.issues[0]?.path).toEqual([field]);
      });
    }
  }
});

suite('NodeBase — AC3: a graph-level omission names the node id, not its index', () => {
  it('reports nodes/<nodeId>/<field> for a missing contract field', () => {
    const graph = structuredClone(planFixture);
    const nodes = graph.nodes as Array<Record<string, unknown>>;
    delete nodes[0]?.permission;
    const result = parsePlanGraph(graph);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.issues[0]?.path).toEqual(['nodes', 'recon-auth-surface', 'permission']);
  });
});

suite('NodeBase — AC4, AC5: defaults are applied, not required', () => {
  const parsed = (() => {
    const node = validNode('agent');
    delete node.retry;
    delete node.budget;
    delete (node.returns as Record<string, unknown>).maxTokens;
    return PlanNodeSchema.parse(node);
  })();

  it(`defaults returns.maxTokens to ${DEFAULT_RETURNS_MAX_TOKENS}`, () => {
    expect(DEFAULT_RETURNS_MAX_TOKENS).toBe(1500);
    expect(parsed.returns.maxTokens).toBe(DEFAULT_RETURNS_MAX_TOKENS);
  });

  it('defaults retry to three attempts with full-jitter backoff', () => {
    expect(parsed.retry).toEqual({
      maxAttempts: 3,
      backoff: { base: 2000, cap: 300_000, jitter: 'full' },
    });
    expect(DEFAULT_RETRY_POLICY).toEqual(parsed.retry);
  });

  it('defaults budget to {}', () => {
    expect(parsed.budget).toEqual({});
  });

  it('lets any node type set returns.maxTokens per node', () => {
    for (const type of NODE_TYPES) {
      const node = { ...validNode(type) };
      (node.returns as Record<string, unknown>).maxTokens = 4000;
      expect(PlanNodeSchema.parse(node).returns.maxTokens).toBe(4000);
    }
  });

  it('mutating the default retry policy through one parsed node cannot affect the next', () => {
    const first = PlanNodeSchema.parse(
      (() => {
        const node = validNode('agent');
        delete node.retry;
        return node;
      })(),
    );
    first.retry.maxAttempts = 99;
    const second = PlanNodeSchema.parse(
      (() => {
        const node = validNode('tool');
        delete node.retry;
        return node;
      })(),
    );
    expect(second.retry.maxAttempts).toBe(3);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });
});

suite('MapNode — AC7, EPIC-02-S4: itemIdFrom defaults to value-hash', () => {
  it("defaults itemIdFrom to 'value-hash' when the author omits it", () => {
    const node = validNode('map');
    delete node.itemIdFrom;
    const parsed = PlanNodeSchema.parse(node);
    if (parsed.type !== 'map') throw new Error('unreachable');
    expect(parsed.itemIdFrom).toBe('value-hash');
    expect(DEFAULT_ITEM_ID_FROM).toBe('value-hash');
  });

  it('so children materialised from a plan that omits the field keep their ids when the collection is re-derived', () => {
    const node = validNode('map');
    node.id = 'migrate-components';
    delete node.itemIdFrom;
    const parsed = PlanNodeSchema.parse(node);
    if (parsed.type !== 'map') throw new Error('unreachable');

    const before = ['Header.vue', 'Footer.vue', 'Sidebar.vue'];
    const after = ['Sidebar.vue', 'Header.vue', 'Footer.vue', 'Nav.vue'];
    const idsOf = (items: string[]) =>
      items.map((item, i) => mapChildId(parsed.id, item, i, parsed.itemIdFrom));

    const idsBefore = new Set(idsOf(before));
    const idsAfter = idsOf(after);
    expect(idsAfter.filter((id) => idsBefore.has(id))).toHaveLength(3);
    expect(idsAfter.filter((id) => !idsBefore.has(id))).toHaveLength(1);
  });
});

suite('SubgraphNode — an inline subgraph nests the union in itself', () => {
  it('parses a subgraph whose graph is inline nodes and edges', () => {
    const inner = validNode('tool');
    inner.id = 'inner-tool';
    const node = validNode('subgraph');
    node.graph = { kind: 'inline', nodes: [inner], edges: [] };
    const parsed = PlanNodeSchema.parse(node);
    if (parsed.type !== 'subgraph' || parsed.graph.kind !== 'inline') {
      throw new Error('unreachable');
    }
    expect(parsed.graph.nodes[0]?.id).toBe('inner-tool');
  });

  it('rejects an inline subgraph whose nested node breaks the contract', () => {
    const inner = validNode('tool');
    delete inner.permission;
    const node = validNode('subgraph');
    node.graph = { kind: 'inline', nodes: [inner], edges: [] };
    const result = PlanNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues[0]?.path).toEqual(['graph', 'nodes', 0, 'permission']);
  });
});

suite('PlanGraphSchema — AC8: planHash excludes itself', () => {
  it('recomputes to the committed planHash after a parse and reserialise', async () => {
    const parsed = PlanGraphSchema.parse(planFixture);
    const reserialised: Record<string, unknown> = JSON.parse(JSON.stringify(parsed));
    expect(await planHash(reserialised)).toBe(planFixture.planHash);
  });

  it('is unchanged when planHash itself is replaced by a different value', async () => {
    const other = { ...planFixture, planHash: `sha256-${'a'.repeat(64)}` };
    expect(await planHash(other)).toBe(await planHash(planFixture));
  });

  it('changes when any other field changes', async () => {
    const edited = structuredClone(planFixture);
    const first = (edited.nodes as Array<Record<string, unknown>>)[0];
    if (first === undefined) throw new Error('unreachable');
    first.title = 'Survey the auth surface, again';
    expect(await planHash(edited)).not.toBe(await planHash(planFixture));
  });
});

suite('PlanEdge — F10.1 data edges carry fact keys', () => {
  it('accepts carries on a data edge and omits it on a control edge', () => {
    const graph = PlanGraphSchema.parse(planFixture);
    const dataEdge = graph.edges.find((edge) => edge.kind === 'data');
    expect(dataEdge?.carries).toEqual(['lint/result']);
    expect(graph.edges.find((edge) => edge.kind === 'control')?.carries).toBeUndefined();
  });

  it('rejects an edge kind outside control | data', () => {
    const graph = structuredClone(planFixture);
    const edge = (graph.edges as Array<Record<string, unknown>>)[0];
    if (edge === undefined) throw new Error('unreachable');
    edge.kind = 'sometimes';
    expect(PlanGraphSchema.safeParse(graph).success).toBe(false);
  });
});

suite('PlanGraphSchema — the document envelope', () => {
  it('rejects a schemaId without the version suffix', () => {
    expect(
      PlanGraphSchema.safeParse({ ...planFixture, schemaId: 'DeFlow.plangraph' }).success,
    ).toBe(false);
  });

  it('accepts createdBy of planner, human, or a NodeId', () => {
    for (const createdBy of ['planner', 'human', 'recon-auth-surface']) {
      expect(PlanGraphSchema.safeParse({ ...planFixture, createdBy }).success).toBe(true);
    }
    expect(PlanGraphSchema.safeParse({ ...planFixture, createdBy: 'The Planner' }).success).toBe(
      false,
    );
  });

  it('accepts a null parent and rejects a malformed one', () => {
    expect(PlanGraphSchema.safeParse({ ...planFixture, parent: null }).success).toBe(true);
    expect(PlanGraphSchema.safeParse({ ...planFixture, parent: 'sha256-nope' }).success).toBe(
      false,
    );
  });

  it('rejects a node id that is not a legal path segment', () => {
    const graph = structuredClone(planFixture);
    const node = (graph.nodes as Array<Record<string, unknown>>)[0];
    if (node === undefined) throw new Error('unreachable');
    node.id = 'Recon Auth Surface';
    expect(PlanGraphSchema.safeParse(graph).success).toBe(false);
    expect(NodeIdSchema.safeParse('Recon Auth Surface').success).toBe(false);
  });
});
