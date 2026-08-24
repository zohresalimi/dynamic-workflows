/**
 * KAR-11.1 — compiling `PlanGraph` v1 from the three inputs, end to end.
 *
 * Integration rather than unit because every claim the story makes is about a
 * boundary: a real file-backed ledger with real transaction semantics, the real
 * Ajv2020 validator over the repository's own emitted `DeFlow.plangraph.v1.json`,
 * a real `provider_capabilities` table the list is projected from, and a real
 * `plan/v1.json` in a run directory. A stubbed validator would let a prose
 * return through the one gate that exists to stop it.
 *
 * The agent is a port with a scripted queue, exactly as
 * ./recon-survey.test.ts and ./framing-interview.test.ts script one. What a
 * scripted session cannot prove — that the vendor CLI really honours
 * `--json-schema` — is KAR-05.x's conformance battery, and is not re-litigated
 * here.
 *
 * Verifies: EPIC-11-S1, EPIC-11-S2, EPIC-11-S3, EPIC-11-S5 · AC1, AC2, AC3,
 * AC5, AC6, AC7, AC8 · test plan #3, #4, #5, #6, #7, #8
 */
import type { Db, NodeId, RunId, StructuredOutput, TaskSpec } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema, TaskSpecSchema } from '@DeFlow/core';
import {
  openLedger,
  planPathOf,
  readPlanDoc,
  readRange,
  recordProviderCapabilities,
} from '@DeFlow/ledger';
import { GIT_ENV, it } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { compilePlanV1, type PlannerAgent, type PlannerTurn } from '../../src/plan/compile.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';

/** The repository's own emitted documents — the bytes `deflow init` copies. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

/** The one plan document the schema and the content-addressing both agree on.
 * Content-pinned by `packages/core/test/plan-hash-golden.test.ts`, so it is read
 * here and never rewritten. */
const sevenTypesFixture = fileURLToPath(
  new URL('../../../core/test/fixtures/plans/seven-types.json', import.meta.url),
);

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ac1101');
const PLANNER: NodeId = NodeIdSchema.parse('planner');
const T0 = 1_754_380_800_000;
const EPOCH = 3;
const SPEC_HASH = `sha256-${'1'.repeat(64)}`;

const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Migrate every component under packages/ui to Vue 3.',
  scope: { included: ['packages/ui'] },
  nonGoals: ['Do not touch packages/legacy.'],
  constraints: ['No new runtime dependency.'],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'pnpm typecheck passes.' },
    { id: 'ac-2', statement: 'Every component renders.' },
  ],
  knownFailureModes: [],
  approvedBy: { at: '2026-08-07T10:15:00.000Z', via: 'ui' },
  specHash: SPEC_HASH,
});

const FACTS = [
  {
    key: 'finding/test-command',
    confidence: 'verified' as const,
    value: { reconKind: 'command', role: 'test', command: 'pnpm test', script: 'vitest run' },
    fromEvidence: ['file://package.json#L5-L5'],
    sourceEvent: 9,
  },
  {
    key: 'scope/touched-paths',
    confidence: 'verified' as const,
    value: { reconKind: 'scope', paths: ['packages/ui'], fileCount: 47 },
    fromEvidence: [`artifact://${'a'.repeat(64)}`],
    sourceEvent: 10,
  },
];

/** The 2026-08-02 fixture rows: one adapter that enforces a schema natively,
 * one that does not, and one that answers nothing about sessions. */
const ROWS: readonly { provider: string; version: string; caps: unknown }[] = [
  {
    provider: 'claude',
    version: '2.1.220',
    caps: { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } } },
  },
  {
    provider: 'opencode',
    version: '1.18.11',
    caps: { agentCapabilities: { sessionCapabilities: { resume: true, fork: true } } },
  },
  { provider: 'gemini', version: '0.53.1', caps: { agentCapabilities: { loadSession: false } } },
];

function seedCapabilities(db: Db, only?: readonly string[]): void {
  for (const row of ROWS) {
    if (only !== undefined && !only.includes(row.provider)) continue;
    recordProviderCapabilities(db, {
      provider: row.provider,
      version: row.version,
      binarySha256: 'b'.repeat(64),
      binaryPath: `/opt/bin/${row.provider}`,
      capsJson: JSON.stringify(row.caps),
      probedAt: T0,
    });
  }
}

const present = (value: unknown): StructuredOutput => ({ present: true, value });
const absent: StructuredOutput = { present: false };

/** A node the planner might legitimately emit. */
const agentNode = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Do ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'goal' }],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `Do ${id}, carefully.`,
  provider: { prefer: ['claude'], requires: ['structuredOutput'] },
  resume: 'always-replay',
  ...over,
});

/**
 * KAR-11.2 AC8 — the gate every plan the planner returns has to contain.
 *
 * F7.4's coverage check runs on v1 as much as on a patched successor, so a plan
 * that names no gate for `ac-1` and `ac-2` is now refused before it is
 * persisted. Adding it to the shared fixture rather than to each spec is the
 * honest fix: the spec these tests pin really does have two criteria, and a
 * plan that never checks them is exactly the plan §3.4 calls *"a lie on the
 * acceptance board"*.
 */
const gateNode = {
  id: 'gate-acceptance',
  title: 'Check the acceptance criteria',
  type: 'gate',
  deps: ['implement'],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'criteria' }],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.verdict.v2', maxTokens: 1500 },
  gate: { kind: 'deterministic', gateId: 'typecheck' },
  criteria: ['ac-1', 'ac-2'],
  independence: { notSessionOf: ['implement'], preferDifferentProvider: true },
} as const;

/** The envelope fields a planner is asked to fill in; DeFlow overwrites the
 * ones it owns, which is what the second suite below asserts. */
const returned = (nodes: unknown[], over: Record<string, unknown> = {}) => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN,
  version: 1,
  planHash: `sha256-${'0'.repeat(64)}`,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-07T10:15:00.000Z',
  nodes: [...nodes, gateNode],
  edges: [],
  ...over,
});

/** A scripted planner: one queued turn per attempt, and a record of what it
 * was prompted with — which is how "the retry carried the diagnostics" and
 * "nothing was spawned" are both assertable. */
function scripted(...turns: readonly StructuredOutput[]): PlannerAgent & {
  readonly prompts: string[];
  readonly efforts: (string | null)[];
} {
  const queue = [...turns];
  const prompts: string[] = [];
  const efforts: (string | null)[] = [];
  return {
    prompts,
    efforts,
    plan: async (request): Promise<PlannerTurn> => {
      prompts.push(request.prompt);
      efforts.push(request.effort);
      const next = queue.shift();
      if (next === undefined) throw new Error('the planner was prompted more times than scripted');
      return { structuredOutput: next };
    },
  };
}

async function compile(
  db: Db,
  tmp: string,
  agent: PlannerAgent,
  over: Record<string, unknown> = {},
) {
  return compilePlanV1({
    db,
    runId: RUN,
    node: PLANNER,
    epoch: EPOCH,
    ts: T0,
    runDir: join(tmp, 'runs', RUN),
    spec: SPEC,
    facts: FACTS,
    provider: 'claude',
    model: 'the-model-the-plan-ran-on',
    maxContext: 200_000,
    probedEvent: 7,
    schemas: loadSchemaDirectory(SCHEMAS_DIR),
    schemasDir: SCHEMAS_DIR,
    agent,
    // KAR-11.2 AC7 — real `git check-ref-format`, per node id. It runs from any
    // cwd, repository or not: the answer is a property of the string.
    refs: new RefFormatChecker(new Git(tmp, { env: GIT_ENV })),
    ...over,
  });
}

suite('EPIC-11-S1 — three inputs compile to PlanGraph v1', () => {
  it('persists the row, the file and plan.proposed, all agreeing on the hash', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(returned([agentNode('implement'), agentNode('verify')])));

      const result = await compile(db, tmp, agent);
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      expect(result.plan.nodes.map((node) => node.id)).toEqual([
        'implement',
        'verify',
        // KAR-11.2 AC8: the fixture carries the gate that covers the pinned
        // spec's two criteria, because a plan that covers neither is now
        // refused before it can be persisted.
        'gate-acceptance',
      ]);
      expect(readPlanDoc(db, result.plan.planHash)).not.toBeNull();

      const onDisk = JSON.parse(readFileSync(planPathOf(join(tmp, 'runs', RUN), 1), 'utf8'));
      expect(onDisk.planHash).toBe(result.plan.planHash);

      const [proposed] = readRange(db, RUN, 0, 200).events.filter(
        (row) => row.kind === 'plan.proposed',
      );
      const payload = proposed?.payload as Record<string, unknown>;
      expect(payload.planHash).toBe(result.plan.planHash);
      expect(payload.version).toBe(1);
      expect(payload.by).toBe('planner');
    } finally {
      db.close();
    }
  });

  it('AC6/AC8 — records the model, the strongest effort and the tier', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(returned([agentNode('implement')])));

      const result = await compile(db, tmp, agent);
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      const [proposed] = readRange(db, RUN, 0, 200).events.filter(
        (row) => row.kind === 'plan.proposed',
      );
      expect((proposed?.payload as Record<string, unknown>).planner).toEqual({
        model: 'the-model-the-plan-ran-on',
        // 06 §6: the initial PlanGraph is planned at the strongest available
        // setting, resolved from the adapter rather than from a constant.
        effort: 'max',
        tier: 'strongest',
      });
      expect(agent.efforts).toEqual(['max']);
    } finally {
      db.close();
    }
  });

  it('AC4 — the identity is DeFlow’s to compute, not the planner’s to assert', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(
        present(returned([agentNode('implement')], { planHash: `sha256-${'f'.repeat(64)}` })),
      );

      const result = await compile(db, tmp, agent);
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      expect(result.plan.planHash).not.toBe(`sha256-${'f'.repeat(64)}`);
      expect(readPlanDoc(db, result.plan.planHash)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('AC7 — the four node types this daemon can admit round-trip', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const seven: Record<string, unknown> = JSON.parse(readFileSync(sevenTypesFixture, 'utf8'));
      // Two re-pointings on the *returned* document, neither of which touches
      // the fixture — it is content-pinned by
      // `packages/core/test/plan-hash-golden.test.ts` and must not move.
      //
      // The first is KAR-11.1's: the fixture names `claude-code`, which this
      // machine has not probed, so validation would (correctly) refuse it with
      // PROVIDER_NOT_PROBED.
      //
      // The second is KAR-23.9's, and it is the honest half of what this test
      // now claims. The fixture really does carry all seven types — that is
      // AC7's *schema* claim, still pinned in
      // `packages/core/test/plan-graph-fixture.test.ts` — but three of them are
      // types no daemon composes a performer for, so a plan carrying one is now
      // refused at compile time. The case below is the other side of the same
      // coin.
      const admissible = (seven.nodes as Record<string, unknown>[]).filter((node) =>
        ['agent', 'tool', 'gate', 'human'].includes(node.type as string),
      );
      const nodes = admissible.map((node) =>
        node.type === 'agent'
          ? { ...node, provider: { prefer: ['claude'], requires: ['structuredOutput'] } }
          : node,
      );
      const ids = new Set(nodes.map((node) => node.id as string));
      const edges = (seven.edges as Record<string, unknown>[]).filter(
        (edge) => ids.has(edge.from as string) && ids.has(edge.to as string),
      );
      const agent = scripted(
        present({ ...seven, nodes, edges, runId: RUN, taskSpecHash: SPEC_HASH }),
      );

      // The fixture's gate covers `lint-has-zero-errors`, so the spec pinned
      // for this one case is the spec that gate is a gate *for*. Reusing the
      // shared two-criterion spec would make this a coverage test wearing a
      // round-trip test's name.
      const result = await compile(db, tmp, agent, {
        spec: TaskSpecSchema.parse({
          ...SPEC,
          acceptanceCriteria: [
            { id: 'lint-has-zero-errors', statement: 'pnpm lint reports zero errors.' },
          ],
        }),
      });
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      expect(result.plan.nodes.map((node) => node.type)).toEqual([
        'agent',
        'tool',
        'gate',
        'human',
      ]);
    } finally {
      db.close();
    }
  });

  it('AC7 — and the other three are refused, by name, with a repairable diagnostic', async ({
    tmp,
  }) => {
    // KAR-23.9. `map`, `loop` and `subgraph` are in the *schema* — KAR-11.1
    // AC7's claim, which `packages/core/test/plan-graph-fixture.test.ts` still
    // pins — and no daemon composes a performer for any of them. Admitting one
    // produces a run that fails at node 27 and takes its dependants with it, so
    // compile time is where the planner is told, once.
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const seven: Record<string, unknown> = JSON.parse(readFileSync(sevenTypesFixture, 'utf8'));
      const nodes = (seven.nodes as Record<string, unknown>[]).map((node) =>
        node.type === 'agent'
          ? { ...node, provider: { prefer: ['claude'], requires: ['structuredOutput'] } }
          : node,
      );
      // The same document twice: `compilePlanV1` retries once, and the second
      // failure is the escalation.
      const document = present({ ...seven, nodes, runId: RUN, taskSpecHash: SPEC_HASH });
      const agent = scripted(document, document);

      const result = await compile(db, tmp, agent, {
        spec: TaskSpecSchema.parse({
          ...SPEC,
          acceptanceCriteria: [
            { id: 'lint-has-zero-errors', statement: 'pnpm lint reports zero errors.' },
          ],
        }),
      });

      expect(result.outcome).toBe('failed');
      const failures = readRange(db, RUN, 0, 500).events.filter(
        (event) => event.kind === 'plan.validation_failed',
      );
      expect(failures.length).toBe(2);

      const codes = (failures[0]?.payload as { diagnostics: { code: string; node: string }[] })
        .diagnostics;
      expect(
        codes.filter((one) => one.code === 'NODE_TYPE_UNPERFORMABLE').map((one) => one.node),
      ).toEqual(['retry-flaky-check', 'review-each-file', 'ship-it']);

      // §3.5 — the retry's packet carries the diagnostics **verbatim**, which
      // is the whole mechanism by which the planner can act on them.
      expect(agent.prompts).toHaveLength(2);
      expect(agent.prompts[1]).toContain('NODE_TYPE_UNPERFORMABLE');
      expect(agent.prompts[1]).toContain('agent, gate, tool');
    } finally {
      db.close();
    }
  });
});

suite('EPIC-11-S2 — the planner sees the spec, the facts and the capability list', () => {
  it('assembles exactly three input groups and no foreign transcript', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(returned([agentNode('implement')])));

      const result = await compile(db, tmp, agent);
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      expect(result.packet.segments.some((s) => s.kind === 'history.summary')).toBe(false);
      expect(result.packet.totals.byKind['history.summary']).toBe(0);
      await expect(JSON.stringify(result.packet, null, 2)).toMatchFileSnapshot(
        '__snapshots__/packet-planner.json',
      );
    } finally {
      db.close();
    }
  });

  it('AC2 — deleting a provider_capabilities row removes it from the list', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const withAll = scripted(present(returned([agentNode('implement')])));
      await compile(db, tmp, withAll);
      expect(withAll.prompts[0]).toContain('opencode');

      db.prepare("DELETE FROM provider_capabilities WHERE provider = 'opencode'").run();

      const without = scripted(present(returned([agentNode('implement')])));
      await compile(db, tmp, without);
      expect(without.prompts[0]).not.toContain('opencode');
      expect(without.prompts[0]).toContain('claude');
    } finally {
      db.close();
    }
  });

  it('does not offer an unprobed provider, however many are installed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db, ['claude']);
      const agent = scripted(present(returned([agentNode('implement')])));

      await compile(db, tmp, agent);

      expect(agent.prompts[0]).toContain('claude 2.1.220');
      expect(agent.prompts[0]).not.toContain('gemini');
    } finally {
      db.close();
    }
  });
});

suite('EPIC-11-S3 — a prose plan is refused; there is no extraction fallback', () => {
  it('fails with contract.schema-invalid when nothing came back structured', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(absent);

      const result = await compile(db, tmp, agent);

      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('unreachable');
      expect(result.failure.deflowFailure.reason).toBe('contract.schema-invalid');
      expect(readRange(db, RUN, 0, 200).events.map((row) => row.kind)).not.toContain(
        'plan.proposed',
      );
      expect(existsSync(planPathOf(join(tmp, 'runs', RUN), 1))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('does not go looking for a fenced JSON block in a markdown answer', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const markdown =
        'Here is the plan I would suggest:\n\n```json\n' +
        `${JSON.stringify(returned([agentNode('implement')]))}\n` +
        '```\n\nLet me know what you think.';
      // The vendor put prose in `structured_output` — the closest a real
      // adapter gets to "here is a fenced block".
      const agent = scripted(present(markdown));

      const result = await compile(db, tmp, agent);

      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('unreachable');
      expect(result.failure.deflowFailure.reason).toBe('contract.schema-invalid');
      expect(result.failure.message).not.toContain('extracted');
      expect(readPlanDoc(db, `sha256-${'0'.repeat(64)}`)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('names the failing instance path for an unknown node type', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(returned([agentNode('implement', { type: 'workflow' })])));

      const result = await compile(db, tmp, agent);

      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('unreachable');
      expect(result.failure.deflowFailure.reason).toBe('contract.schema-invalid');
      const issues = result.failure.deflowFailure.detail?.issues as { pointer: string }[];
      expect(issues.some((issue) => issue.pointer.startsWith('/nodes/0'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('refuses before spawning when the adapter cannot enforce a schema', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted();

      const result = await compile(db, tmp, agent, { provider: 'opencode' });

      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('unreachable');
      expect(result.failure.deflowFailure.reason).toBe('adapter.capability-missing');
      // No tokens were spent: the agent was never prompted.
      expect(agent.prompts).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses an adapter with no probed row at all', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db, ['opencode']);
      const agent = scripted();

      const result = await compile(db, tmp, agent, { provider: 'claude' });

      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('unreachable');
      expect(result.failure.deflowFailure.reason).toBe('adapter.capability-missing');
      expect(agent.prompts).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-11-S5 — one retry with the diagnostics, then a human', () => {
  /** `implement` reads a key nothing writes and the spec does not pin. */
  const unreachable = () =>
    returned([agentNode('implement', { reads: [{ kind: 'fact', key: 'finding/db-schema' }] })]);

  it('appends the diagnostics as an event and retries exactly once', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(unreachable()), present(returned([agentNode('implement')])));

      const result = await compile(db, tmp, agent);
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      const failures = readRange(db, RUN, 0, 200).events.filter(
        (row) => row.kind === 'plan.validation_failed',
      );
      expect(failures).toHaveLength(1);
      const diagnostics = (failures[0]?.payload as Record<string, unknown>).diagnostics as {
        code: string;
        key: string;
      }[];
      expect(diagnostics[0]?.code).toBe('READ_UNREACHABLE');
      expect(diagnostics[0]?.key).toBe('finding/db-schema');

      // The retry's packet carries them verbatim.
      expect(agent.prompts).toHaveLength(2);
      expect(agent.prompts[0]).not.toContain('READ_UNREACHABLE');
      expect(agent.prompts[1]).toContain('READ_UNREACHABLE');
      expect(agent.prompts[1]).toContain('finding/db-schema');
    } finally {
      db.close();
    }
  });

  it('persists no plan row for the failing document', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(unreachable()), present(returned([agentNode('implement')])));

      const result = await compile(db, tmp, agent);
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      const [failed] = readRange(db, RUN, 0, 200).events.filter(
        (row) => row.kind === 'plan.validation_failed',
      );
      const rejectedHash = (failed?.payload as Record<string, string>).planHash;
      expect(readPlanDoc(db, rejectedHash)).toBeNull();
      expect(readPlanDoc(db, result.plan.planHash)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('escalates to a human on the second failure, and makes no third attempt', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(unreachable()), present(unreachable()));

      const result = await compile(db, tmp, agent);

      expect(result.outcome).toBe('needs-human');
      if (result.outcome !== 'needs-human') throw new Error('unreachable');
      expect(result.diagnostics[0]?.code).toBe('READ_UNREACHABLE');

      const kinds = readRange(db, RUN, 0, 200).events.map((row) => row.kind);
      expect(kinds.filter((kind) => kind === 'plan.validation_failed')).toHaveLength(2);
      expect(kinds).toContain('run.needs_human');
      expect(kinds).not.toContain('plan.proposed');
      expect(agent.prompts).toHaveLength(2);

      const [escalation] = readRange(db, RUN, 0, 200).events.filter(
        (row) => row.kind === 'run.needs_human',
      );
      const payload = escalation?.payload as Record<string, string>;
      expect(payload.reason).toBe('plan-invalid');
      expect(payload.detail).toContain('READ_UNREACHABLE');
    } finally {
      db.close();
    }
  });
});

// ── EPIC-12-S24 / S25 — the criterion → gate mapping is total ────────────────

/**
 * KAR-12.4 AC1, AC2, AC3, at the boundary the acceptance criteria name:
 * *"the run does not start. No agent process is spawned."*
 *
 * Integration rather than unit because "does not start" is a claim about what
 * the ledger and the run directory hold afterwards, not about what a pure
 * function returned: nothing to schedule means no `plan.proposed`, no plan row,
 * no `plan/v1.json`, and a `run.needs_human` in its place. The pure walk has its
 * own unit tests in `@DeFlow/core`; what those cannot show is that the refusal
 * really does happen before anything is persisted for a scheduler to pick up.
 */
suite('EPIC-12-S24 — an uncovered acceptance criterion refuses to start the run', () => {
  /** The shared fixture's plan, with the gate narrowed to `ac-1` — so `ac-2` is
   * a criterion nothing in the plan checks. */
  const coversOnlyAc1 = () =>
    returned([], {
      nodes: [agentNode('implement'), { ...gateNode, criteria: ['ac-1'] }],
    });

  it('refuses both attempts with CRITERION_UNCOVERED and persists no plan', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(coversOnlyAc1()), present(coversOnlyAc1()));

      const result = await compile(db, tmp, agent);

      expect(result.outcome).toBe('needs-human');
      if (result.outcome !== 'needs-human') throw new Error('unreachable');
      expect(result.diagnostics).toMatchObject([
        { severity: 'error', code: 'CRITERION_UNCOVERED', key: 'ac-2' },
      ]);

      const events = readRange(db, RUN, 0, 200).events;
      const kinds = events.map((row) => row.kind);
      expect(kinds.filter((kind) => kind === 'plan.validation_failed')).toHaveLength(2);
      expect(kinds).toContain('run.needs_human');

      // Nothing exists for a scheduler to admit: no plan was proposed, no row
      // was written, no file was left in the run directory — so no node, and
      // therefore no agent process, can be spawned from this compilation.
      expect(kinds).not.toContain('plan.proposed');
      expect(kinds).not.toContain('node.scheduled');
      expect(existsSync(planPathOf(join(tmp, 'runs', RUN), 1))).toBe(false);

      const [failed] = events.filter((row) => row.kind === 'plan.validation_failed');
      const diagnostics = (failed?.payload as Record<string, unknown>).diagnostics as {
        code: string;
        key: string;
      }[];
      expect(diagnostics.map((one) => one.code)).toContain('CRITERION_UNCOVERED');
      expect(readPlanDoc(db, (failed?.payload as Record<string, string>).planHash)).toBeNull();

      // Two attempts, not three: the planner was prompted twice and the second
      // prompt carried the diagnostic verbatim.
      expect(agent.prompts).toHaveLength(2);
      expect(agent.prompts[1]).toContain('CRITERION_UNCOVERED');
      expect(agent.prompts[1]).toContain('ac-2');
    } finally {
      db.close();
    }
  });

  it('AC3 — the compiled spec carries coveredByGates as plan node ids', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(returned([agentNode('implement')])));

      const result = await compile(db, tmp, agent);
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      // The plan node id, not the gate definition id ('typecheck').
      expect(
        result.spec.acceptanceCriteria.map((criterion) => [criterion.id, criterion.coveredByGates]),
      ).toEqual([
        ['ac-1', ['gate-acceptance']],
        ['ac-2', ['gate-acceptance']],
      ]);
      // The identity is untouched: a derived field must not move the digest a
      // verdict is judged against (KAR-12.4 AC6).
      expect(result.spec.specHash).toBe(SPEC_HASH);
      // And the document handed in is not mutated on the way through.
      expect(SPEC.acceptanceCriteria.every((one) => one.coveredByGates.length === 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('AC3 — a spec arriving with coveredByGates has it recomputed and overwritten', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const agent = scripted(present(returned([agentNode('implement')])));

      const handEdited = TaskSpecSchema.parse({
        ...SPEC,
        acceptanceCriteria: SPEC.acceptanceCriteria.map((criterion) => ({
          ...criterion,
          coveredByGates: ['gate-somebody-typed'],
        })),
      });
      const result = await compile(db, tmp, agent, { spec: handEdited });
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      expect(
        result.spec.acceptanceCriteria.flatMap((criterion) => criterion.coveredByGates),
      ).toEqual(['gate-acceptance', 'gate-acceptance']);

      // AC3's second half — the overwrite is not silent. The warning survives a
      // *successful* compile, because that is the only compile a hand-edited
      // spec produces: a mismatch never blocks the run, so if the diagnostic
      // did not come back with the outcome nothing would ever see it.
      expect(
        result.diagnostics.filter((one) => one.code === 'COVERED_BY_GATES_MISMATCH'),
      ).toMatchObject([
        { severity: 'warning', key: 'ac-1' },
        { severity: 'warning', key: 'ac-2' },
      ]);
      expect(result.diagnostics[0]?.message).toContain('gate-somebody-typed');
    } finally {
      db.close();
    }
  });
});

/**
 * KAR-12.4 AC2 — the escape hatch costs one sentence, at the same boundary.
 *
 * The blank-rubric document cannot come out of `sealTaskSpec` (the framing draft
 * schema refuses it), which is exactly why this level matters: what is under
 * test is that a spec assembled by anything *other* than the framing interview
 * still cannot start a run.
 */
suite('EPIC-12-S25 — unverifiable with a blank reason stops the run too', () => {
  const blankReason = TaskSpecSchema.parse({
    ...SPEC,
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'pnpm typecheck passes.' },
      {
        id: 'ac-2',
        statement: 'The migrated date picker feels as responsive as the old one.',
        check: { kind: 'manual', rubric: '   ' },
      },
    ],
  });

  it('refuses the plan with CRITERION_UNVERIFIABLE_NO_REASON and starts nothing', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const plan = () => returned([], { nodes: [agentNode('implement'), gateNode] });
      const agent = scripted(present(plan()), present(plan()));

      const result = await compile(db, tmp, agent, { spec: blankReason });

      expect(result.outcome).toBe('needs-human');
      if (result.outcome !== 'needs-human') throw new Error('unreachable');
      expect(result.diagnostics).toMatchObject([
        { severity: 'error', code: 'CRITERION_UNVERIFIABLE_NO_REASON', key: 'ac-2' },
      ]);

      const events = readRange(db, RUN, 0, 200).events;
      expect(events.map((row) => row.kind)).not.toContain('plan.proposed');
      const [escalation] = events.filter((row) => row.kind === 'run.needs_human');
      expect((escalation?.payload as Record<string, string>).detail).toContain(
        'CRITERION_UNVERIFIABLE_NO_REASON',
      );
    } finally {
      db.close();
    }
  });

  it('accepts the same criterion once the reason is a sentence', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCapabilities(db);
      const withReason = TaskSpecSchema.parse({
        ...blankReason,
        acceptanceCriteria: [
          { id: 'ac-1', statement: 'pnpm typecheck passes.' },
          {
            id: 'ac-2',
            statement: 'The migrated date picker feels as responsive as the old one.',
            check: {
              kind: 'manual',
              rubric: 'Subjective. No harness exists; route to a human at the milestone.',
            },
          },
        ],
      });
      const agent = scripted(
        present(
          returned([], { nodes: [agentNode('implement'), { ...gateNode, criteria: ['ac-1'] }] }),
        ),
      );

      const result = await compile(db, tmp, agent, { spec: withReason });
      if (result.outcome !== 'compiled') throw new Error(JSON.stringify(result, null, 2));

      // ac-1 is covered by the gate that names it; ac-2 is answered by a human
      // and covered by no plan node at all — which is written as `[]` rather
      // than left to look like nobody has looked.
      expect(result.spec.acceptanceCriteria.map((one) => one.coveredByGates)).toEqual([
        ['gate-acceptance'],
        [],
      ]);
    } finally {
      db.close();
    }
  });
});
