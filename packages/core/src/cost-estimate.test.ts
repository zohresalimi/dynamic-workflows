/**
 * KAR-14.3 — the pre-flight estimator, as a pure function of its inputs.
 *
 * The fixture plan is parsed through `PlanGraphSchema` rather than hand-built,
 * for the reason ./budget-ceiling.test.ts gives about `RunState`: an estimator
 * fed a node shape the schema would reject is an estimator agreeing with a plan
 * that cannot exist, and the defaults it reads — `returns.maxTokens`, `budget`
 * — only appear once the schema has applied them.
 *
 * **The tokenizer stub is labelled `'heuristic'` on purpose.** AC2 wants
 * `method: 'gpt-tokenizer/o200k_base'` on every figure, and the way to prove
 * that is *not* to label a stub with it — that would pass just as well against
 * an estimator that hardcoded the string. It is proved where it is true: the
 * daemon integration spec drives the real `o200kTokenizer` through
 * `GET /api/runs/:id`. What these specs prove is the half that lives here —
 * that the label travels from the port that produced the count.
 *
 * Verifies: EPIC-14-S18, EPIC-14-S19 · KAR-14.3 AC1, AC2, AC7 · test plan
 * #1, #2, #3, #6
 */
import { expect, it, describe as suite } from 'vitest';
import type { TokenCount } from './context-packet.ts';
import {
  DEFAULT_PRICE_TABLE,
  type EstimatorInputs,
  estimateNode,
  estimatePatch,
  estimatePlan,
  PRICE_TABLE_VERSION,
  priceKey,
} from './cost-estimate.ts';
import type { NodeId, ProviderId } from './ids.ts';
import { type PlanGraph, PlanGraphSchema, type PlanNode } from './plan-graph.ts';
import { type PlanPatch, PlanPatchSchema } from './plan-patch.ts';
import type { TokenAccounting } from './token-accounting.ts';
import type { Calibration } from './token-calibration.ts';
import type { Tokenizer } from './tokenizer.ts';

const RUN_ID = 'run_20260807T090000Z_1a2b3c';
const PLAN_HASH = `sha256-${'b'.repeat(64)}`;
const SPEC_HASH = `sha256-${'d'.repeat(64)}`;

const SONNET = 'claude-sonnet-4-5';
const OPUS = 'claude-opus-4-1';
const GPT5 = 'gpt-5';

/**
 * Four characters to a token, labelled honestly as the heuristic it is. Any
 * deterministic function of the text would do; what matters is that it is *not*
 * the o200k tokenizer and does not claim to be.
 */
const stubTokenizer: Tokenizer = {
  method: 'heuristic',
  count: (text: string): TokenCount => ({
    estimated: Math.ceil(text.length / 4),
    method: 'heuristic',
  }),
};

const FAMILIES: Readonly<Record<string, string>> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'default',
};

const ACCOUNTING: Readonly<Record<string, TokenAccounting>> = {
  claude: 'exact',
  codex: 'exact',
  gemini: 'none',
};

/** A learned calibration for every (provider, model) unless a spec overrides. */
const LEARNED: Calibration = { n: 24, ratio: 1.18 };

function inputs(overrides: Partial<EstimatorInputs> = {}): EstimatorInputs {
  return {
    tokenizer: stubTokenizer,
    accounting: (provider: ProviderId) => ACCOUNTING[provider] ?? 'none',
    family: (provider: ProviderId) => FAMILIES[provider] ?? 'default',
    calibration: () => LEARNED,
    ...overrides,
  };
}

interface AgentSpec {
  readonly id: string;
  readonly provider?: string;
  readonly model?: string;
  readonly permission?: string;
  readonly maxTokens?: number;
  readonly brief?: string;
  readonly write?: readonly string[];
  readonly wallclockMs?: number;
}

function agentNode(spec: AgentSpec): Record<string, unknown> {
  return {
    id: spec.id,
    title: `do ${spec.id}`,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: spec.permission ?? 'read',
    pathScopes: { write: [...(spec.write ?? [])] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: spec.maxTokens ?? 1500 },
    budget: spec.wallclockMs === undefined ? {} : { maxWallClockMs: spec.wallclockMs },
    brief: spec.brief ?? `brief for ${spec.id}, which is long enough to count.`,
    provider: { prefer: [spec.provider ?? 'claude'], requires: [] },
    ...(spec.model === undefined ? {} : { model: spec.model }),
    resume: 'always-replay',
  };
}

function toolNode(id: string): Record<string, unknown> {
  return {
    id,
    title: `run ${id}`,
    type: 'tool',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 400 },
    budget: {},
    tool: { kind: 'script', run: 'pnpm lint' },
    effectClass: 'pure',
  };
}

function gateNode(id: string): Record<string, unknown> {
  return {
    id,
    title: `judge ${id}`,
    type: 'gate',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 800 },
    budget: {},
    gate: { kind: 'adversarial', brief: 'find every way this change breaks the contract.' },
    criteria: ['ac-1'],
    independence: { notSessionOf: [], preferDifferentProvider: true },
  };
}

function humanNode(id: string): Record<string, unknown> {
  return {
    id,
    title: `ask about ${id}`,
    type: 'human',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 200 },
    budget: {},
    prompt: 'is this the migration you meant?',
    options: [{ id: 'yes', label: 'Yes', effect: 'approve' }],
  };
}

function graphOf(nodes: readonly Record<string, unknown>[]): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN_ID,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-07T09:00:00.000Z',
    nodes,
    edges: [],
  });
}

/** The four archetypes the golden covers: model work, script work, an
 * adversarial gate (model work with no declared provider) and a person. */
const FIXTURE_PLAN = graphOf([
  agentNode({ id: 'n-recon', model: SONNET, maxTokens: 1200 }),
  agentNode({ id: 'n-impl', model: OPUS, permission: 'worktree', maxTokens: 4000 }),
  toolNode('n-lint'),
  gateNode('n-review'),
  humanNode('n-signoff'),
]);

const nodeById = (graph: PlanGraph, id: string): PlanNode => {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
};

suite('the whole-plan estimate (AC1, AC2 · test plan #1)', () => {
  it('is a golden file, per node archetype', () => {
    expect(estimatePlan(FIXTURE_PLAN, inputs())).toMatchSnapshot();
  });

  it('carries the method, the factor and the sample count on every figure', () => {
    const estimate = estimatePlan(FIXTURE_PLAN, inputs());
    expect(estimate.nodes).toHaveLength(5);
    for (const node of estimate.nodes) {
      expect(node.method).toBe('heuristic');
      expect(node.priceTableVersion).toBe(PRICE_TABLE_VERSION);
    }
    for (const node of estimate.nodes.filter((row) => row.calibration !== null)) {
      expect(node.calibration).toMatchObject({ tokenEstimateFactor: 1.18, samples: 24 });
    }
    expect(estimate.calibrations).toContainEqual({
      provider: 'claude',
      model: SONNET,
      tokenEstimateFactor: 1.18,
      samples: 24,
      seedBased: false,
    });
  });

  it('prices the priced nodes and names the ones it cannot price', () => {
    const estimate = estimatePlan(FIXTURE_PLAN, inputs());
    // The adversarial gate names no provider, so nothing can price it: the
    // whole-plan figure is unknown, and the part that *is* known is beside it.
    expect(estimate.costUsd).toBeNull();
    expect(estimate.pricedCostUsd).toBeGreaterThan(0);
    expect(estimate.unpriceable).toEqual([
      { node: 'n-review', provider: null, reason: 'no-provider' },
    ]);
  });

  it('prices a resolved plan end to end, and a tool node costs nothing at all', () => {
    const estimate = estimatePlan(
      FIXTURE_PLAN,
      inputs({
        routing: (node: PlanNode) =>
          node.id === 'n-review' ? { provider: 'codex' as ProviderId, model: GPT5 } : null,
      }),
    );
    expect(estimate.unpriceable).toEqual([]);
    expect(estimate.costUsd).toBe(estimate.pricedCostUsd);

    const lint = estimate.nodes.find((row) => row.node === 'n-lint');
    expect(lint).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0, provider: null });
  });

  it('is arithmetic anyone can check: calibrated input tokens times the table rate', () => {
    const recon = estimateNode(nodeById(FIXTURE_PLAN, 'n-recon'), inputs());
    const rate = DEFAULT_PRICE_TABLE.rates[priceKey('claude', SONNET)];
    if (rate === undefined) throw new Error('the fixture model must be in the shipped table');

    const raw = stubTokenizer.count('brief for n-recon, which is long enough to count.').estimated;
    expect(recon.inputTokens).toBe(Math.ceil(raw * 1.18));
    expect(recon.outputTokens).toBe(1200);
    expect(recon.costUsd).toBeCloseTo(
      (recon.inputTokens / 1_000_000) * rate.inputUsdPerMTok +
        (recon.outputTokens / 1_000_000) * rate.outputUsdPerMTok,
      9,
    );
  });
});

suite('purity: the same inputs answer the same way (test plan #2)', () => {
  it('produces byte-identical output twice over', () => {
    const first = estimatePlan(FIXTURE_PLAN, inputs());
    const second = estimatePlan(FIXTURE_PLAN, inputs());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not mutate the plan it was handed', () => {
    const before = JSON.stringify(FIXTURE_PLAN);
    estimatePlan(FIXTURE_PLAN, inputs());
    expect(JSON.stringify(FIXTURE_PLAN)).toBe(before);
  });
});

/**
 * EPIC-14-S19, verbatim. The seeds exist because tiktoken-family tokenizers
 * undercount Claude tokens, and an undercount overfills — the dangerous
 * direction. Marking an estimate seed-based is what lets a surface say "early
 * estimate" instead of quietly being wrong.
 */
suite('seed factor below five samples, learned factor from five (S19 · test plan #3)', () => {
  const examples = [
    { provider: 'claude', family: 'anthropic', n: 0, ratio: 1.0, applied: 1.2, seedBased: true },
    { provider: 'claude', family: 'anthropic', n: 3, ratio: 1.14, applied: 1.2, seedBased: true },
    { provider: 'claude', family: 'anthropic', n: 5, ratio: 1.16, applied: 1.16, seedBased: false },
    { provider: 'codex', family: 'openai', n: 2, ratio: 1.03, applied: 1.0, seedBased: true },
    { provider: 'gemini', family: 'default', n: 1, ratio: 1.09, applied: 1.05, seedBased: true },
  ] as const;

  for (const example of examples) {
    it(`applies ${example.applied} at n ${example.n} on ${example.provider}`, () => {
      const node = nodeById(
        graphOf([agentNode({ id: 'n-one', provider: example.provider, model: 'm' })]),
        'n-one',
      );

      const estimate = estimateNode(
        node,
        inputs({
          family: () => example.family,
          calibration: () => ({ n: example.n, ratio: example.ratio }),
        }),
      );
      expect(estimate.calibration).toEqual({
        provider: example.provider,
        model: 'm',
        tokenEstimateFactor: example.applied,
        samples: example.n,
        seedBased: example.seedBased,
      });
    });
  }
});

/**
 * EPIC-14-S18's first half. The second half — that `null` matches no numeric
 * rule and the patch falls to the `default` arm — is ./patch-policy.test.ts.
 */
suite('an unpriceable node estimates null, and never 0 (S18 · test plan #6)', () => {
  it('is null when the provider reports no usage at all', () => {
    const node = nodeById(
      graphOf([agentNode({ id: 'n-x', provider: 'gemini', model: 'g' })]),
      'n-x',
    );
    const estimate = estimateNode(node, inputs());
    expect(estimate.costUsd).toBeNull();
    expect(estimate.costUsd).not.toBe(0);
    expect(estimate.unpriceable).toBe('no-accounting');
  });

  it('is null when the price table has no rate for the model', () => {
    const node = nodeById(
      graphOf([agentNode({ id: 'n-x', provider: 'claude', model: 'claude-from-next-year' })]),
      'n-x',
    );
    const estimate = estimateNode(node, inputs());
    expect(estimate.costUsd).toBeNull();
    expect(estimate.unpriceable).toBe('no-rate');
  });

  it('is null when no model was named, rather than priced at some default', () => {
    const node = nodeById(graphOf([agentNode({ id: 'n-x' })]), 'n-x');
    const estimate = estimateNode(node, inputs());
    expect(estimate.costUsd).toBeNull();
    expect(estimate.unpriceable).toBe('no-model');
  });

  it('still counts the tokens it can count: a blank cost cell is not a blank row', () => {
    const node = nodeById(
      graphOf([agentNode({ id: 'n-x', provider: 'gemini', model: 'g' })]),
      'n-x',
    );
    expect(estimateNode(node, inputs()).inputTokens).toBeGreaterThan(0);
  });
});

// ── the patch estimate ───────────────────────────────────────────────────────

const BASE_GRAPH = graphOf([
  agentNode({ id: 'n-recon', model: SONNET }),
  agentNode({ id: 'n-impl', model: OPUS, permission: 'worktree', write: ['packages/ui/**'] }),
]);

function patchOf(ops: readonly Record<string, unknown>[]): PlanPatch {
  return PlanPatchSchema.parse({
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch-1',
    proposedBy: 'n-recon',
    reason: 'recon found three more packages importing the v2 API',
    ops,
    policy: {
      // The proposer's own declaration. The estimator recomputes every figure
      // it reads; this block exists so the patch is *rulable* at all (AC4).
      estimatedCostDeltaUsd: 0,
      estimatedWallClockDeltaMs: 0,
      blastRadius: { paths: [], nodeCount: 0 },
      replanDepth: 1,
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  });
}

suite('the patch estimate (AC1, AC7)', () => {
  it('sums the nodes an insert adds, and reports what the patch changes', () => {
    const patch = patchOf([
      {
        op: 'insert-nodes',
        nodes: [
          agentNode({ id: 'n-a', model: SONNET, wallclockMs: 60_000 }),
          agentNode({
            id: 'n-b',
            model: SONNET,
            permission: 'worktree',
            write: ['packages/forms/**'],
            wallclockMs: 30_000,
          }),
        ],
        edges: [],
      },
    ]);

    const estimate = estimatePatch(patch, BASE_GRAPH, { ...inputs(), planVersion: 1 });
    expect(estimate.nodesAdded).toBe(2);
    expect(estimate.maxPermission).toBe('worktree');
    expect(estimate.replanDepth).toBe(1);
    expect(estimate.estimatedWallClockDeltaMs).toBe(90_000);
    expect(estimate.blastRadiusFiles).toBe(1);
    expect(estimate.costUsdDelta).toBeGreaterThan(0);
    expect(estimate.costUsdDelta).toBe(
      Math.round(
        (estimateNode(
          nodeById(graphOf([agentNode({ id: 'n-a', model: SONNET, wallclockMs: 60_000 })]), 'n-a'),
          inputs(),
        ).costUsd ?? 0) *
          1e6 +
          (estimateNode(
            nodeById(
              graphOf([
                agentNode({
                  id: 'n-b',
                  model: SONNET,
                  permission: 'worktree',
                  write: ['packages/forms/**'],
                  wallclockMs: 30_000,
                }),
              ]),
              'n-b',
            ),
            inputs(),
          ).costUsd ?? 0) *
            1e6,
      ) / 1e6,
    );
  });

  it('is null — not a partial sum — when any inserted node cannot be priced', () => {
    const patch = patchOf([
      {
        op: 'insert-nodes',
        nodes: [
          agentNode({ id: 'n-a', model: SONNET }),
          agentNode({ id: 'n-b', provider: 'gemini', model: 'g' }),
        ],
        edges: [],
      },
    ]);
    const estimate = estimatePatch(patch, BASE_GRAPH, { ...inputs(), planVersion: 2 });
    expect(estimate.costUsdDelta).toBeNull();
    expect(estimate.unpriceable).toEqual([
      { node: 'n-b' as NodeId, provider: 'gemini' as ProviderId, reason: 'no-accounting' },
    ]);
    expect(estimate.replanDepth).toBe(2);
  });

  it('counts a patch that removes work as a negative delta', () => {
    const patch = patchOf([{ op: 'abandon-branch', root: 'n-impl', reason: 'superseded' }]);
    const estimate = estimatePatch(patch, BASE_GRAPH, { ...inputs(), planVersion: 3 });
    expect(estimate.costUsdDelta).toBeLessThan(0);
    expect(estimate.nodesAdded).toBe(0);
  });
});
