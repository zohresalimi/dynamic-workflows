/**
 * KAR-02.3 — the seven-types fixture parses, and its shape is pinned.
 *
 * The same fixture is the input to KAR-02.9's `planHash` golden
 * (./plan-hash-golden.test.ts), so it is the one plan document in the repo
 * that both the schema and the content-addressing agree on.
 *
 * Verifies: EPIC-02-S9 · AC1, AC8
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { planHash } from '../src/hash.ts';
import { PlanGraphSchema, TOOL_KINDS, ToolNodeSchema } from '../src/plan-graph.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/plans/seven-types.json', import.meta.url));
const planFixture: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));

suite('PlanGraphSchema — the seven-types fixture', () => {
  it('parses a graph containing one node of each of the seven types', () => {
    const result = PlanGraphSchema.safeParse(planFixture);
    expect(result.success, JSON.stringify(result, null, 2)).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.nodes.map((node) => node.type)).toEqual([
      'agent',
      'tool',
      'gate',
      'human',
      'map',
      'loop',
      'subgraph',
    ]);
  });

  it('matches the committed file snapshot', async () => {
    const parsed = PlanGraphSchema.parse(planFixture);
    await expect(JSON.stringify(parsed, null, 2)).toMatchFileSnapshot(
      '__snapshots__/plan-seven-types.json',
    );
  });

  it('carries the type-specific fields each node type owes', () => {
    const parsed = PlanGraphSchema.parse(planFixture);
    const byId = new Map(parsed.nodes.map((node) => [node.id as string, node]));

    const agent = byId.get('recon-auth-surface');
    if (agent?.type !== 'agent') throw new Error('unreachable');
    expect(agent.brief.length).toBeGreaterThan(0);
    expect(agent.provider.prefer).toEqual(['claude-code']);

    const tool = byId.get('run-lint');
    if (tool?.type !== 'tool') throw new Error('unreachable');
    expect(['pure', 'mutating']).toContain(tool.effectClass);

    const gate = byId.get('gate-lint-clean');
    if (gate?.type !== 'gate') throw new Error('unreachable');
    expect(gate.criteria).not.toHaveLength(0);
    expect(gate.independence.notSessionOf).toEqual([]);

    const human = byId.get('approve-release');
    if (human?.type !== 'human') throw new Error('unreachable');
    for (const option of human.options) {
      expect(['approve', 'reject', 'edit', 'inject']).toContain(option.effect);
    }

    const loop = byId.get('retry-flaky-check');
    if (loop?.type !== 'loop') throw new Error('unreachable');
    expect(loop.noProgress.sameFailureSignatureLimit).toBeGreaterThan(0);
    expect(loop.noProgress.diffSimilarityThreshold).toBeGreaterThan(0);

    const map = byId.get('review-each-file');
    if (map?.type !== 'map') throw new Error('unreachable');
    expect(map.itemIdFrom).toBe('value-hash');

    const subgraph = byId.get('ship-it');
    if (subgraph?.type !== 'subgraph') throw new Error('unreachable');
    expect(['inline', 'template']).toContain(subgraph.graph.kind);
  });

  it('carries the planHash it hashes to (AC8)', async () => {
    expect(await planHash(planFixture)).toBe(planFixture.planHash);
  });
});

/**
 * KAR-23.9 — `TOOL_KINDS` is the schema's own vocabulary, not a second list.
 *
 * Two callers now read it — the daemon's `PERFORMABLE_TOOL_KINDS` and the
 * plan-time diagnostic that refuses the rest — so a fourth kind added to
 * `ToolNodeSchema` without appearing in the constant would quietly become a
 * kind nothing refuses and nothing performs.
 */
suite('TOOL_KINDS is exactly what ToolNodeSchema accepts (KAR-23.9)', () => {
  const toolNode = (tool: Record<string, unknown>) => ({
    id: 'run-lint',
    title: 'run lint',
    type: 'tool',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.toolresult.v1' },
    effectClass: 'pure',
    tool,
  });

  const EXAMPLE: Record<string, Record<string, unknown>> = {
    script: { kind: 'script', run: 'pnpm lint' },
    mcp: { kind: 'mcp', server: 'linear', tool: 'create_issue', args: {} },
    http: { kind: 'http', method: 'POST', url: 'https://example.com/hook' },
  };

  it('every named kind parses', () => {
    for (const kind of TOOL_KINDS) {
      const example = EXAMPLE[kind];
      expect(example, `no example for the ${kind} kind — TOOL_KINDS grew`).toBeDefined();
      expect(
        ToolNodeSchema.safeParse(toolNode(example as Record<string, unknown>)).success,
        kind,
      ).toBe(true);
    }
  });

  it('and no kind outside the list does', () => {
    expect(
      ToolNodeSchema.safeParse(toolNode({ kind: 'grpc', service: 'x', method: 'y' })).success,
    ).toBe(false);
  });
});
