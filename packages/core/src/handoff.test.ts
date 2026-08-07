/**
 * KAR-09.9 — the handoff contract: what the budget is, what happens when a
 * return misses it, and the fact that nothing here can shorten a payload.
 *
 * The properties worth stating up front, because they are what the tests are
 * shaped around:
 *
 *   * The per-node-type defaults are read from one table, and a `gate` that
 *     omitted `maxTokens` gets 300 rather than the global 1,500.
 *   * A judgement is a *value*: accept, repair once, or fail. There is no
 *     fourth arm, and in particular no arm that returns a shortened payload.
 *   * `repairAttempted` on the second `handoff.oversize` is what tells the two
 *     events apart, so a reader can see that the repair happened and did not
 *     help.
 *
 * Verifies: EPIC-09-S46 (the budget table and the measurement), EPIC-09-S47,
 * EPIC-09-S48, EPIC-09-S49 (the reason half) · AC1, AC4, AC5, AC6, AC7, AC8,
 * AC9 · test plan #1, #2, #8
 */
import { expect, it, describe as suite } from 'vitest';
import type { SchemaIssue } from './accept-fact.ts';
import type { TokenCount } from './context-packet.ts';
import {
  agentRoleOf,
  DEFAULT_RETURN_BUDGET,
  defaultReturnBudget,
  HANDOFF_REPAIR_LIMIT,
  handoffOversizeRates,
  judgeHandoff,
  judgeVendorFailure,
  RETURN_BUDGET_DEFAULTS,
  withReturnBudgetDefaults,
} from './handoff.ts';
import { type NodeId, NodeIdSchema, type SchemaId, SchemaIdSchema } from './ids.ts';
import { parsePlanGraph } from './plan-graph.ts';
import type { Tokenizer } from './tokenizer.ts';

const NODE: NodeId = NodeIdSchema.parse('implement-auth');
const SCHEMA: SchemaId = SchemaIdSchema.parse('DeFlow.implementreturn.v1');

/**
 * A tokenizer whose count is a stated function of the serialised text, so a
 * test can put a return exactly one token over a budget. Real BPE counting is
 * KAR-09.7's business and is exercised against `gpt-tokenizer` in the daemon;
 * what this module owes is the comparison, not the arithmetic.
 */
function tokenizerOf(count: (text: string) => number): Tokenizer {
  return {
    method: 'gpt-tokenizer/o200k_base',
    count: (text: string): TokenCount => ({
      estimated: count(text),
      method: 'gpt-tokenizer/o200k_base',
    }),
  };
}

/** Every character is a token: the simplest tokenizer a size assertion can be
 * written against without restating the BPE table. */
const perCharacter = tokenizerOf((text) => text.length);

const valid = (): readonly SchemaIssue[] => [];
const invalid = (): readonly SchemaIssue[] => [
  { pointer: '/summary', message: "must have required property 'summary'" },
  { pointer: '/files', message: 'must be array' },
];

function judge(options: {
  readonly budget: number;
  readonly value?: unknown;
  readonly present?: boolean;
  readonly repairAttempted?: boolean;
  readonly issues?: readonly SchemaIssue[];
  readonly tokenizer?: Tokenizer;
}) {
  return judgeHandoff({
    node: NODE,
    attempt: 0,
    contract: { schemaId: SCHEMA, maxTokens: options.budget },
    structuredOutput:
      options.present === false
        ? { present: false }
        : { present: true, value: options.value ?? { summary: 'ok' } },
    repairAttempted: options.repairAttempted ?? false,
    validate: () => options.issues ?? valid(),
    tokenizer: options.tokenizer ?? perCharacter,
  });
}

suite('the per-node-type return budgets (AC1, test plan #2)', () => {
  it('is the table docs/08 §9.3 prints, and nothing else', () => {
    expect(RETURN_BUDGET_DEFAULTS).toEqual({
      gate: 300,
      human: 500,
      'agent.implementation': 1500,
      'agent.recon': 4000,
      default: 1500,
    });
  });

  it.each([
    ['gate', undefined, 300],
    ['human', undefined, 500],
    ['agent', 'implementation', 1500],
    ['agent', 'recon', 4000],
    ['agent', undefined, 1500],
    ['tool', undefined, 1500],
    ['map', undefined, 1500],
    ['loop', undefined, 1500],
    ['subgraph', undefined, 1500],
  ] as const)('resolves %s (%s) to %i', (type, role, budget) => {
    expect(defaultReturnBudget(type, role)).toBe(budget);
  });

  it('agrees with the global default the plan schema falls back to', () => {
    expect(DEFAULT_RETURN_BUDGET).toBe(1500);
    expect(RETURN_BUDGET_DEFAULTS.default).toBe(DEFAULT_RETURN_BUDGET);
  });

  it('reads recon-versus-implementation off the permission the node already carries', () => {
    // No new plan field: `returns` is already emitted at v1 and schemas are
    // append-only. A node that cannot write is surveying, and a node that can
    // is implementing — which is the same distinction §9.3 draws, taken from
    // data the plan states rather than from a second field saying it again.
    expect(agentRoleOf('read')).toBe('recon');
    expect(agentRoleOf('worktree')).toBe('implementation');
    expect(agentRoleOf('worktree+net')).toBe('implementation');
    expect(agentRoleOf('full')).toBe('implementation');
  });
});

suite('filling the defaults in before the plan is parsed (AC1)', () => {
  const rawNode = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'n1',
    title: 'a node',
    deps: [],
    lifecycle: 'stable',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    ...over,
  });

  it('gives a gate that omitted maxTokens 300, not the global 1500', () => {
    const filled = withReturnBudgetDefaults({
      nodes: [
        rawNode({
          type: 'gate',
          gate: { kind: 'deterministic', gateId: 'g.lint' },
          criteria: [],
          independence: { notSessionOf: [], preferDifferentProvider: false },
          returns: { schemaId: 'DeFlow.verdict.v1' },
        }),
      ],
    }) as { nodes: { returns: { maxTokens: number } }[] };

    expect(filled.nodes[0]?.returns.maxTokens).toBe(300);
  });

  it('leaves an author-supplied budget alone, at any node type', () => {
    const filled = withReturnBudgetDefaults({
      nodes: [
        rawNode({
          type: 'gate',
          gate: { kind: 'deterministic', gateId: 'g.lint' },
          criteria: [],
          independence: { notSessionOf: [], preferDifferentProvider: false },
          returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 42 },
        }),
      ],
    }) as { nodes: { returns: { maxTokens: number } }[] };

    expect(filled.nodes[0]?.returns.maxTokens).toBe(42);
  });

  it('gives a read-only survey agent 4000 and a writing agent 1500', () => {
    const filled = withReturnBudgetDefaults({
      nodes: [
        rawNode({
          type: 'agent',
          permission: 'read',
          brief: 'survey the auth surface',
          provider: { prefer: [], requires: [] },
          resume: 'always-replay',
          returns: { schemaId: 'DeFlow.finding.v1' },
        }),
        rawNode({
          id: 'n2',
          type: 'agent',
          permission: 'worktree',
          pathScopes: { write: ['src/**'] },
          brief: 'implement it',
          provider: { prefer: [], requires: [] },
          resume: 'always-replay',
          returns: { schemaId: 'DeFlow.implementreturn.v1' },
        }),
      ],
    }) as { nodes: { returns: { maxTokens: number } }[] };

    expect(filled.nodes[0]?.returns.maxTokens).toBe(4000);
    expect(filled.nodes[1]?.returns.maxTokens).toBe(1500);
  });

  it('invents no contract for a node that declared none (test plan #1)', () => {
    // The budget defaults; the *schema id* does not, and must not — a return
    // nobody named a shape for cannot be validated against anything.
    const filled = withReturnBudgetDefaults({
      nodes: [
        rawNode({
          type: 'agent',
          brief: 'do the thing',
          provider: { prefer: [], requires: [] },
          resume: 'always-replay',
        }),
      ],
    }) as { nodes: Record<string, unknown>[] };

    expect(filled.nodes[0]?.returns).toBeUndefined();
  });

  it('leaves a document it cannot read untouched rather than guessing', () => {
    expect(withReturnBudgetDefaults(null)).toBeNull();
    expect(withReturnBudgetDefaults({ nodes: 'not an array' })).toEqual({
      nodes: 'not an array',
    });
  });
});

suite('plan validation still requires the contract itself (test plan #1)', () => {
  it('rejects an agent node with no returns, naming the node id', () => {
    const parsed = parsePlanGraph({
      schemaId: 'DeFlow.plangraph.v1',
      runId: '01JBQ0000000000000000000AB',
      version: 1,
      planHash: `sha256-${'a'.repeat(64)}`,
      parent: null,
      taskSpecHash: `sha256-${'b'.repeat(64)}`,
      createdBy: 'planner',
      createdAt: '2026-08-06T00:00:00.000Z',
      edges: [],
      nodes: [
        {
          id: 'implement-auth',
          type: 'agent',
          title: 'implement',
          deps: [],
          lifecycle: 'stable',
          reads: [],
          writes: [],
          permission: 'worktree',
          pathScopes: { write: ['src/**'] },
          brief: 'do it',
          provider: { prefer: [], requires: [] },
          resume: 'always-replay',
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.issues.some((issue) => issue.path.join('.') === 'nodes.implement-auth.returns'),
    ).toBe(true);
  });
});

suite('a return inside budget is accepted (EPIC-09-S46)', () => {
  it('measures the serialised return and appends no oversize event', () => {
    const judgement = judge({ budget: 1500, value: { summary: 'ok' } });

    expect(judgement.outcome).toBe('accepted');
    expect(judgement.cause).toBe('in-budget');
    expect(judgement.oversize).toBeNull();
    expect(judgement.repairPrompt).toBeNull();
    expect(judgement.failure).toBeNull();
    // `{"summary":"ok"}` — the canonical encoding, counted per character.
    expect(judgement.tokens).toEqual({
      estimated: '{"summary":"ok"}'.length,
      method: 'gpt-tokenizer/o200k_base',
    });
  });

  it('counts the canonical encoding, so key order cannot change the figure', () => {
    const one = judge({ budget: 1500, value: { b: 2, a: 1 } });
    const other = judge({ budget: 1500, value: { a: 1, b: 2 } });
    expect(one.tokens.estimated).toBe(other.tokens.estimated);
  });
});

suite('one repair, then a failure (EPIC-09-S47, EPIC-09-S48 · AC4, AC5, AC6)', () => {
  it('emits handoff.oversize with repairAttempted false and asks for a compression', () => {
    const judgement = judge({ budget: 10, value: { summary: 'far too long to fit in ten' } });

    expect(judgement.outcome).toBe('repair');
    expect(judgement.cause).toBe('oversize');
    expect(judgement.oversize).toEqual({
      node: NODE,
      attempt: 0,
      budget: 10,
      actual: judgement.tokens.estimated,
      repairAttempted: false,
    });
    expect(judgement.repairPrompt).toContain('10');
    expect(judgement.failure).toBeNull();
  });

  it('is bounded to exactly one repair', () => {
    expect(HANDOFF_REPAIR_LIMIT).toBe(1);
  });

  it('fails on the second oversize, and the event says the repair was spent', () => {
    const judgement = judge({
      budget: 10,
      value: { summary: 'still far too long' },
      repairAttempted: true,
    });

    expect(judgement.outcome).toBe('failed');
    expect(judgement.oversize?.repairAttempted).toBe(true);
    expect(judgement.repairPrompt).toBeNull();
    expect(judgement.failure?.deflowFailure.reason).toBe('contract.handoff-oversize');
  });

  it('never shortens the payload — what it carries is the whole return', () => {
    const long = { summary: 'x'.repeat(4000) };
    const first = judge({ budget: 10, value: long });
    const second = judge({ budget: 10, value: long, repairAttempted: true });

    for (const judgement of [first, second]) {
      expect(judgement.returned).toEqual(long);
      expect(judgement.tokens.estimated).toBeGreaterThan(4000);
    }
  });
});

suite('a schema-invalid return never becomes a fact (AC8)', () => {
  it('asks for one repair, carrying every violation Ajv reported', () => {
    const judgement = judge({ budget: 1500, issues: invalid() });

    expect(judgement.outcome).toBe('repair');
    expect(judgement.cause).toBe('schema-invalid');
    expect(judgement.issues).toHaveLength(2);
    expect(judgement.repairPrompt).toContain('/summary');
    expect(judgement.repairPrompt).toContain('/files');
    // The return is still carried, whole, as the evidence a human needs to fix
    // the prompt. What it is not is *accepted* — that is `outcome`, and only
    // `outcome` (AC8).
    expect(judgement.returned).toEqual({ summary: 'ok' });
  });

  it('fails after the repair, as contract.schema-invalid', () => {
    const judgement = judge({ budget: 1500, issues: invalid(), repairAttempted: true });

    expect(judgement.outcome).toBe('failed');
    expect(judgement.failure?.deflowFailure.reason).toBe('contract.schema-invalid');
    expect(judgement.oversize).toBeNull();
  });

  it('validates before it measures, so an invalid return is not also called oversize', () => {
    const judgement = judge({ budget: 1, issues: invalid() });
    expect(judgement.cause).toBe('schema-invalid');
    expect(judgement.oversize).toBeNull();
  });
});

suite('an absent structured_output is a contract failure, not an empty object', () => {
  it('says so in the message rather than accepting {}', () => {
    const judgement = judge({ budget: 1500, present: false, repairAttempted: true });

    expect(judgement.outcome).toBe('failed');
    expect(judgement.cause).toBe('absent-structured-output');
    expect(judgement.failure?.deflowFailure.reason).toBe('contract.schema-invalid');
    expect(judgement.failure?.message).toContain('structured_output');
    expect(judgement.returned).toBeUndefined();
  });

  it('spends the one repair on it first', () => {
    const judgement = judge({ budget: 1500, present: false });
    expect(judgement.outcome).toBe('repair');
    expect(judgement.repairPrompt).toContain(SCHEMA);
  });
});

suite('the vendor’s own exhausted repair loop (EPIC-09-S49 · AC7)', () => {
  it('fails without proposing a DeFlow-side repair', () => {
    const judgement = judgeVendorFailure(NODE, 0);

    expect(judgement.outcome).toBe('failed');
    expect(judgement.repairPrompt).toBeNull();
    expect(judgement.oversize).toBeNull();
    expect(judgement.failure?.deflowFailure.reason).toBe('agent.schema-repair-exhausted');
  });

  it('is a different reason from DeFlow’s own oversize failure', () => {
    const vendor = judgeVendorFailure(NODE, 0).failure?.deflowFailure.reason;
    const ours = judge({ budget: 10, value: { s: 'too long by far' }, repairAttempted: true })
      .failure?.deflowFailure.reason;

    expect(vendor).toBe('agent.schema-repair-exhausted');
    expect(ours).toBe('contract.handoff-oversize');
    expect(vendor).not.toBe(ours);
  });
});

suite('the oversize rate per node type (AC9)', () => {
  it('counts handoffs and oversize handoffs per type, not events per type', () => {
    const rates = handoffOversizeRates([
      { nodeType: 'agent', oversize: true },
      { nodeType: 'agent', oversize: false },
      { nodeType: 'agent', oversize: false },
      { nodeType: 'agent', oversize: false },
      { nodeType: 'gate', oversize: true },
    ]);

    expect(rates).toEqual([
      { nodeType: 'agent', handoffs: 4, oversize: 1, rate: 0.25 },
      { nodeType: 'gate', handoffs: 1, oversize: 1, rate: 1 },
    ]);
  });

  it('reports nothing for a node type nothing was measured on', () => {
    expect(handoffOversizeRates([])).toEqual([]);
  });
});
