/**
 * KAR-11.2 — `validatePlan`, the cheapest correctness gate in the system
 * (docs/06-planning-and-replanning.md §3).
 *
 * Every suite below is one of §3's four checks or one of §3.2's five capability
 * refusals, and each asserts the property that would be silently lost if the
 * check were reimplemented rather than delegated: the exact `READ_UNREACHABLE`
 * sentence, `PlanCycleError` as the *only* cycle detector, warnings that do not
 * block, and the 0.6 ceiling read from the packet-assembly policy rather than
 * spelled again here.
 *
 * Verifies: EPIC-11-S6, EPIC-11-S7, EPIC-11-S8, EPIC-11-S9, EPIC-11-S10
 * (charset half), EPIC-11-S11 · AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC12
 */
import { expect, it, describe as suite } from 'vitest';
import { BUDGET_FRACTION_CEILING } from './build-packet.ts';
import type { PlanDiagnostic } from './plan-diagnostics.ts';
import { hasBlockingDiagnostic } from './plan-diagnostics.ts';
import {
  NODE_TYPES,
  type PlanGraph,
  PlanGraphSchema,
  type PlanNode,
  TOOL_KINDS,
} from './plan-graph.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';
import {
  PLAN_SCOPE,
  type PlanTimeCapability,
  resumeByReplayNodes,
  validatePlan,
} from './validate-plan.ts';

const RUN = 'run_20260808T101500Z_ac1102';

const CLAUDE: PlanTimeCapability = {
  provider: 'claude',
  version: '0.64.1',
  structuredOutput: true,
  resume: true,
  permissionLevels: ['read', 'worktree', 'worktree+net', 'full'],
  maxContext: 200_000,
};

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

const gate = (id: string, criteria: string[], over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  type: 'gate',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.verdict.v2' },
  gate: { kind: 'deterministic', gateId: 'typecheck' },
  criteria,
  independence: { notSessionOf: [], preferDifferentProvider: true },
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

/**
 * A graph assembled in code rather than parsed, which is how KAR-11.3 will hand
 * a patched document to this validator. `NodeIdSchema` would refuse `Recon` or
 * `impl:checkout` at the parse boundary; the identifier checks here are the
 * second layer, for values that never crossed it.
 */
function unparsedGraph(nodes: readonly Record<string, unknown>[]): PlanGraph {
  return {
    ...graph([]),
    nodes: nodes as unknown as PlanNode[],
  };
}

function spec(criteria: readonly Record<string, unknown>[]): TaskSpec {
  return TaskSpecSchema.parse({
    schemaId: 'DeFlow.taskspec.v1',
    goal: 'migrate the app',
    scope: { included: ['the app'] },
    nonGoals: ['rewriting the backend'],
    constraints: [],
    priorDecisions: [],
    acceptanceCriteria: criteria,
    knownFailureModes: [],
    approvedBy: null,
    specHash: `sha256-${'2'.repeat(64)}`,
  });
}

/** A spec whose single criterion the plans below cover, so a suite about
 * reachability is not also a suite about coverage. */
const COVERED = spec([
  { id: 'ac-1', statement: 'it works', check: { kind: 'manual', rubric: 'x' } },
]);

const NO_TOKENS = () => 0;

/**
 * "Assume every node type and every tool kind is performable."
 *
 * The option is **required** rather than defaulted, so every existing suite in
 * this file has to say what it assumes. That is the price of the check being
 * impossible to disable by forgetting it, and it is the right price: an
 * optional set would silently switch off the one gate KAR-23.9 exists to add.
 */
const ANYTHING_PERFORMABLE = {
  nodeTypes: [...NODE_TYPES],
  toolKinds: [...TOOL_KINDS],
} as const;

const check = (
  plan: PlanGraph,
  taskSpec: TaskSpec = COVERED,
  caps: readonly PlanTimeCapability[] = [CLAUDE],
): readonly PlanDiagnostic[] =>
  validatePlan(plan, taskSpec, caps, {
    estimatePacketTokens: NO_TOKENS,
    performable: ANYTHING_PERFORMABLE,
  });

// ── §3.1 reachability (EPIC-11-S6) ───────────────────────────────────────────

suite('EPIC-11-S6 — an undeclared read fails validation before a token is spent', () => {
  it('is clean when an ancestor writes the key, and refuses when the edge is removed', () => {
    const reads = [{ kind: 'fact', key: 'finding/db-schema' }];
    const writes = [{ kind: 'fact', key: 'finding/db-schema', schemaId: 'DeFlow.finding.v1' }];

    expect(
      check(graph([agent('recon', { writes }), agent('implement', { deps: ['recon'], reads })])),
    ).toEqual([]);

    expect(check(graph([agent('recon', { writes }), agent('implement', { reads })]))).toEqual([
      {
        severity: 'error',
        code: 'READ_UNREACHABLE',
        node: 'implement',
        key: 'finding/db-schema',
        message:
          "node 'implement' reads 'finding/db-schema' but no ancestor writes it and it is not " +
          'in the pinned spec',
      },
    ]);
  });

  it('a write some node reads is not an orphan, even when that node is not a descendant', () => {
    // §3.1's two checks answer different questions: reachability asks whether
    // an *ancestor* writes the key, and the orphan check asks whether anything
    // in the plan reads it at all. A sibling's read is the case where the two
    // answers legitimately differ, and collapsing them would report the same
    // authoring mistake twice under two severities.
    const plan = graph([
      agent('recon', {
        writes: [{ kind: 'fact', key: 'finding/db-schema', schemaId: 'DeFlow.finding.v1' }],
      }),
      agent('implement', { reads: [{ kind: 'fact', key: 'finding/db-schema' }] }),
    ]);

    expect(check(plan).map((diagnostic) => diagnostic.code)).toEqual(['READ_UNREACHABLE']);
  });

  it('satisfies a spec read from the pinned set, with no ancestor required', () => {
    const plan = graph([agent('root', { reads: [{ kind: 'spec', section: 'criteria' }] })]);

    expect(check(plan)).toEqual([]);
  });

  it('returns every diagnostic, ordered by node id, not just the first (AC1)', () => {
    const reads = [{ kind: 'fact', key: 'finding/missing' }];
    const plan = graph([
      agent('delta', { reads }),
      agent('bravo', { reads }),
      agent('charlie', { reads }),
      agent('alpha', { reads }),
    ]);

    expect(check(plan).map((diagnostic) => diagnostic.node)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ]);
  });

  it("a sibling's write is not an ancestor's write", () => {
    const plan = graph([
      agent('root'),
      agent('analyse-a', {
        deps: ['root'],
        writes: [{ kind: 'fact', key: 'finding/a', schemaId: 'DeFlow.finding.v1' }],
      }),
      agent('analyse-b', { deps: ['root'], reads: [{ kind: 'fact', key: 'finding/a' }] }),
    ]);

    expect(
      check(plan).filter((diagnostic) => diagnostic.code === 'READ_UNREACHABLE'),
    ).toMatchObject([{ node: 'analyse-b', key: 'finding/a' }]);
  });
});

// ── §3.1 cycles and orphan writes (EPIC-11-S7) ───────────────────────────────

suite('EPIC-11-S7 — cycles, orphan writes and the severity distinction', () => {
  it('reports a cycle from PlanCycleError, naming every node on it', () => {
    const plan = graph([
      agent('a', { deps: ['c'] }),
      agent('b', { deps: ['a'] }),
      agent('c', { deps: ['b'] }),
    ]);

    const cycles = check(plan).filter((diagnostic) => diagnostic.code === 'PLAN_CYCLE');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.severity).toBe('error');
    expect(cycles[0]?.message).toContain('a -> b -> c -> a');
  });

  it('an orphan write is a warning and the plan is still runnable', () => {
    const plan = graph([
      agent('recon', {
        writes: [{ kind: 'fact', key: 'finding/unused', schemaId: 'DeFlow.finding.v1' }],
      }),
    ]);

    const diagnostics = check(plan);
    expect(diagnostics).toMatchObject([{ severity: 'warning', code: 'ORPHAN_WRITE' }]);
    expect(hasBlockingDiagnostic(diagnostics)).toBe(false);
  });

  it('a write a `finding/*` glob read covers is not an orphan', () => {
    const plan = graph([
      agent('recon', {
        writes: [{ kind: 'fact', key: 'finding/db-schema', schemaId: 'DeFlow.finding.v1' }],
      }),
      agent('implement', { deps: ['recon'], reads: [{ kind: 'fact', key: 'finding/*' }] }),
    ]);

    expect(check(plan)).toEqual([]);
  });

  it('warnings never block, errors always do', () => {
    const warned = graph([
      agent('a', { writes: [{ kind: 'fact', key: 'finding/x', schemaId: 'DeFlow.finding.v1' }] }),
      agent('b', { writes: [{ kind: 'fact', key: 'finding/y', schemaId: 'DeFlow.finding.v1' }] }),
    ]);
    expect(hasBlockingDiagnostic(check(warned))).toBe(false);

    const failed = graph([agent('a', { reads: [{ kind: 'fact', key: 'finding/nope' }] })]);
    expect(hasBlockingDiagnostic(check(failed))).toBe(true);
  });
});

// ── §3.2 capability refusals (EPIC-11-S8, EPIC-11-S9) ────────────────────────

suite('EPIC-11-S8 — a node an adapter cannot honour is refused at plan time', () => {
  it('PROVIDER_NOT_PROBED when no row exists for any preferred provider', () => {
    const plan = graph([agent('impl', { provider: { prefer: ['cursor'], requires: [] } })]);

    expect(check(plan)).toMatchObject([
      { severity: 'error', code: 'PROVIDER_NOT_PROBED', node: 'impl', key: 'cursor' },
    ]);
  });

  it('resolves to the first preferred provider that has been probed', () => {
    const plan = graph([
      agent('impl', { provider: { prefer: ['cursor', 'claude'], requires: [] } }),
    ]);

    expect(check(plan)).toEqual([]);
  });

  it('NO_STRUCTURED_OUTPUT when the row cannot hold the return contract', () => {
    const caps = [{ ...CLAUDE, structuredOutput: false }];
    const plan = graph([agent('impl')]);

    expect(check(plan, COVERED, caps)).toMatchObject([
      { severity: 'error', code: 'NO_STRUCTURED_OUTPUT', node: 'impl', key: 'DeFlow.finding.v1' },
    ]);
  });

  it('PERMISSION_UNSUPPORTED rather than a silent escalation or a silent downgrade', () => {
    const caps = [{ ...CLAUDE, permissionLevels: ['read'] as const }];
    const plan = graph([agent('impl', { permission: 'worktree' })]);

    const diagnostics = check(plan, COVERED, caps);
    expect(diagnostics).toMatchObject([
      { severity: 'error', code: 'PERMISSION_UNSUPPORTED', node: 'impl', key: 'worktree' },
    ]);
    expect(diagnostics[0]?.message).toContain('refuses to schedule');
  });

  it('PACKET_EXCEEDS_BUDGET at 61% of maxContext, and nothing at 59% (AC5)', () => {
    const plan = graph([agent('impl')]);
    const at = (fraction: number) =>
      validatePlan(plan, COVERED, [CLAUDE], {
        estimatePacketTokens: () => Math.round(CLAUDE.maxContext * fraction),
        performable: ANYTHING_PERFORMABLE,
      });

    expect(at(0.61)).toMatchObject([
      { severity: 'error', code: 'PACKET_EXCEEDS_BUDGET', node: 'impl' },
    ]);
    expect(at(0.59)).toEqual([]);
  });

  it('takes the ceiling from the packet-assembly policy, not from a literal here', () => {
    const plan = graph([agent('impl')]);
    const justOver = Math.floor(CLAUDE.maxContext * BUDGET_FRACTION_CEILING) + 1;

    expect(
      validatePlan(plan, COVERED, [CLAUDE], {
        estimatePacketTokens: () => justOver,
        performable: ANYTHING_PERFORMABLE,
      }),
    ).toMatchObject([{ code: 'PACKET_EXCEEDS_BUDGET' }]);
    expect(
      validatePlan(plan, COVERED, [CLAUDE], {
        estimatePacketTokens: () => Math.floor(CLAUDE.maxContext * BUDGET_FRACTION_CEILING),
        performable: ANYTHING_PERFORMABLE,
      }),
    ).toEqual([]);
  });

  it('checks only agent nodes: a gate node names no adapter to refuse', () => {
    const caps = [{ ...CLAUDE, structuredOutput: false, permissionLevels: ['read'] as const }];
    const plan = graph([gate('gate-ac1', ['ac-1'], { permission: 'worktree' })]);

    expect(check(plan, spec([{ id: 'ac-1', statement: 'it works' }]), caps)).toEqual([]);
  });
});

suite('EPIC-11-S9 — NO_RESUME is soft unless the node declares requiresResume', () => {
  const noResume = [{ ...CLAUDE, provider: 'gemini', resume: false }];
  const preferGemini = { prefer: ['gemini'], requires: [] };

  it('a node that merely benefits from resume gets a warning and a replay annotation', () => {
    const plan = graph([agent('impl', { resume: 'native-if-available', provider: preferGemini })]);

    const diagnostics = check(plan, COVERED, noResume);
    expect(diagnostics).toMatchObject([
      { severity: 'warning', code: 'NO_RESUME', node: 'impl', key: 'session.resume' },
    ]);
    expect(hasBlockingDiagnostic(diagnostics)).toBe(false);
    expect(resumeByReplayNodes(diagnostics)).toEqual(['impl']);
    expect(diagnostics[0]?.message).toContain('ResumeByReplay');
  });

  it('a node that genuinely requires resume is an error and the plan is refused', () => {
    const plan = graph([
      agent('impl', {
        resume: 'native-if-available',
        provider: { prefer: ['gemini'], requires: ['resumableSessions'] },
      }),
    ]);

    const diagnostics = check(plan, COVERED, noResume);
    expect(diagnostics).toMatchObject([{ severity: 'error', code: 'NO_RESUME', node: 'impl' }]);
    expect(hasBlockingDiagnostic(diagnostics)).toBe(true);
    // An error is a refusal, not an annotation: nothing falls back to replay.
    expect(resumeByReplayNodes(diagnostics)).toEqual([]);
  });

  it('a capable adapter produces neither diagnostic, for either node', () => {
    const plan = graph([
      agent('soft', { resume: 'native-if-available' }),
      agent('hard', { provider: { prefer: ['claude'], requires: ['resumableSessions'] } }),
    ]);

    expect(check(plan)).toEqual([]);
  });

  it('a node that always replays is not warned about an adapter that cannot resume', () => {
    const plan = graph([agent('impl', { resume: 'always-replay', provider: preferGemini })]);

    expect(check(plan, COVERED, noResume)).toEqual([]);
  });
});

// ── §3.3 identifiers, charset half (EPIC-11-S10) ─────────────────────────────

suite('EPIC-11-S10 — the DeFlow charset and case-insensitive duplicates', () => {
  it.each([
    ['impl:checkout', 'charset'],
    ['impl checkout', 'charset'],
    ['Impl-Checkout', 'charset'],
    ['-impl', 'charset'],
    ['x'.repeat(70), 'charset'],
  ])('rejects %s', (id) => {
    const plan = unparsedGraph([agent(id)]);

    expect(
      validatePlan(plan, COVERED, [CLAUDE], {
        estimatePacketTokens: NO_TOKENS,
        performable: ANYTHING_PERFORMABLE,
      }),
    ).toMatchObject([{ severity: 'error', code: 'INVALID_NODE_ID', key: id }]);
  });

  it('rejects "recon" and "Recon" in one plan as a duplicate, case-insensitively', () => {
    const plan = unparsedGraph([agent('recon'), agent('Recon')]);

    const duplicates = validatePlan(plan, COVERED, [CLAUDE], {
      estimatePacketTokens: NO_TOKENS,
      performable: ANYTHING_PERFORMABLE,
    }).filter((diagnostic) => diagnostic.message.includes('case-insensitive'));

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ code: 'INVALID_NODE_ID', key: 'Recon' });
  });

  it('rejects two nodes sharing an id even when the id is otherwise legal', () => {
    const plan = unparsedGraph([agent('recon'), agent('recon')]);

    expect(
      validatePlan(plan, COVERED, [CLAUDE], {
        estimatePacketTokens: NO_TOKENS,
        performable: ANYTHING_PERFORMABLE,
      }),
    ).toMatchObject([{ code: 'INVALID_NODE_ID', node: 'recon', key: 'recon' }]);
  });

  it('reports an id real git refused, naming the ref that was checked', () => {
    const plan = graph([agent('impl')]);

    const diagnostics = validatePlan(plan, COVERED, [CLAUDE], {
      estimatePacketTokens: NO_TOKENS,
      performable: ANYTHING_PERFORMABLE,
      refusedRefs: ['impl'],
    });

    expect(diagnostics).toMatchObject([{ code: 'INVALID_NODE_ID', node: 'impl', key: 'impl' }]);
    expect(diagnostics[0]?.message).toContain('check-ref-format');
  });
});

// ── §3.4 criteria coverage (EPIC-11-S11) ─────────────────────────────────────

suite('EPIC-11-S11 — every criterion reaches a gate, or the plan is refused', () => {
  const uncovered = spec([
    { id: 'ac-5', statement: 'No component may import from packages/legacy.' },
  ]);

  it('a criterion no gate node names is an error naming the criterion', () => {
    const plan = graph([agent('impl')]);

    const coverage = validatePlan(plan, uncovered, [CLAUDE], {
      estimatePacketTokens: NO_TOKENS,
      performable: ANYTHING_PERFORMABLE,
    }).filter((diagnostic) => diagnostic.code === 'CRITERION_UNCOVERED');

    expect(coverage).toMatchObject([{ severity: 'error', node: PLAN_SCOPE, key: 'ac-5' }]);
    expect(coverage[0]?.message).toContain('ac-5');
  });

  it('a gate node declaring it fixes the plan', () => {
    const plan = graph([agent('impl'), gate('gate-import-rules', ['ac-5'])]);

    expect(check(plan, uncovered)).toEqual([]);
  });

  it('an unverifiable criterion needs no gate node', () => {
    const manual = spec([
      {
        id: 'ac-9',
        statement: 'the UI feels right',
        check: { kind: 'manual', rubric: 'looks ok' },
      },
    ]);

    expect(check(graph([agent('impl')]), manual)).toEqual([]);
  });

  it('naming a gate in the spec is not the same as planning one', () => {
    const named = spec([
      {
        id: 'ac-5',
        statement: 'No component may import from packages/legacy.',
        check: { kind: 'gate', gate: 'import-rules' },
      },
    ]);

    expect(
      check(graph([agent('impl')]), named).filter(
        (diagnostic) => diagnostic.code === 'CRITERION_UNCOVERED',
      ),
    ).toHaveLength(1);
  });
});

// ── KAR-12.4 — the totality rule's remaining two codes ───────────────────────

suite('KAR-12.4 AC2, test plan #2 — the escape hatch costs one sentence', () => {
  it('a manual check whose rubric is blank once trimmed is CRITERION_UNVERIFIABLE_NO_REASON', () => {
    const blank = spec([
      { id: 'ac-9', statement: 'the UI feels right', check: { kind: 'manual', rubric: '  ' } },
    ]);

    const diagnostics = check(graph([agent('impl')]), blank);

    expect(diagnostics).toMatchObject([
      {
        severity: 'error',
        code: 'CRITERION_UNVERIFIABLE_NO_REASON',
        node: PLAN_SCOPE,
        key: 'ac-9',
      },
    ]);
    expect(diagnostics[0]?.message).toContain('ac-9');
  });
});

suite('KAR-12.4 AC3 — coveredByGates is computed, and a hand-supplied value is checked', () => {
  it('is silent when the spec supplies no coveredByGates at all', () => {
    const plan = graph([agent('impl'), gate('gate-import-rules', ['ac-5'])]);
    const uncovered = spec([
      { id: 'ac-5', statement: 'No component may import from packages/legacy.' },
    ]);

    expect(check(plan, uncovered).filter((d) => d.code === 'COVERED_BY_GATES_MISMATCH')).toEqual(
      [],
    );
  });

  it('warns when a hand-supplied coveredByGates does not match the computed walk', () => {
    const plan = graph([agent('impl'), gate('gate-import-rules', ['ac-5'])]);
    const handEdited = spec([
      {
        id: 'ac-5',
        statement: 'No component may import from packages/legacy.',
        coveredByGates: ['some-other-node'],
      },
    ]);

    const mismatch = check(plan, handEdited).filter((d) => d.code === 'COVERED_BY_GATES_MISMATCH');

    expect(mismatch).toMatchObject([{ severity: 'warning', node: PLAN_SCOPE, key: 'ac-5' }]);
    expect(mismatch[0]?.message).toContain('gate-import-rules');
  });

  it('is silent when a hand-supplied coveredByGates happens to match the computed walk', () => {
    const plan = graph([agent('impl'), gate('gate-import-rules', ['ac-5'])]);
    const matching = spec([
      {
        id: 'ac-5',
        statement: 'No component may import from packages/legacy.',
        coveredByGates: ['gate-import-rules'],
      },
    ]);

    expect(check(plan, matching).filter((d) => d.code === 'COVERED_BY_GATES_MISMATCH')).toEqual([]);
  });
});

// ── KAR-13.1 AC7 — a human deadline's default names an option that exists ─────

suite('KAR-13.1 AC7 — an unanswerable deadline is caught at plan time', () => {
  const human = (deadline: Record<string, unknown>) => ({
    id: 'approve-scope',
    title: 'approve the scope',
    type: 'human',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1' },
    prompt: 'Extend the migration scope?',
    options: [
      { id: 'yes', label: 'Extend scope', effect: 'approve' },
      { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
    ],
    deadline,
  });

  const twoHours = '2026-08-08T12:15:00.000Z';

  it('a default naming an option that does not exist is an error naming both', () => {
    const plan = graph([
      human({ wakeAt: twoHours, onTimeout: 'default', default: 'maybe' }),
      gate('gate-typecheck', ['ac-1']),
    ]);

    const found = check(plan).filter(
      (diagnostic) => diagnostic.code === 'HUMAN_DEFAULT_UNKNOWN_OPTION',
    );

    expect(found).toMatchObject([{ severity: 'error', node: 'approve-scope', key: 'maybe' }]);
    expect(found[0]?.message).toContain('approve-scope');
    expect(found[0]?.message).toContain('maybe');
    expect(hasBlockingDiagnostic(found)).toBe(true);
  });

  it('onTimeout: default with no default at all is the same error', () => {
    const plan = graph([
      human({ wakeAt: twoHours, onTimeout: 'default' }),
      gate('gate-typecheck', ['ac-1']),
    ]);

    expect(
      check(plan).filter((diagnostic) => diagnostic.code === 'HUMAN_DEFAULT_UNKNOWN_OPTION'),
    ).toHaveLength(1);
  });

  it('a default naming a declared option is clean', () => {
    const plan = graph([
      human({ wakeAt: twoHours, onTimeout: 'default', default: 'no' }),
      gate('gate-typecheck', ['ac-1']),
    ]);

    expect(check(plan)).toEqual([]);
  });

  it('fail and escalate need no default, and one they carry anyway is ignored', () => {
    for (const onTimeout of ['fail', 'escalate']) {
      const plan = graph([
        human({ wakeAt: twoHours, onTimeout, default: 'maybe' }),
        gate('gate-typecheck', ['ac-1']),
      ]);

      expect(
        check(plan).filter((diagnostic) => diagnostic.code === 'HUMAN_DEFAULT_UNKNOWN_OPTION'),
        onTimeout,
      ).toEqual([]);
    }
  });

  it('a human node with no deadline at all is clean', () => {
    const plan = graph([
      {
        ...human({ wakeAt: twoHours, onTimeout: 'fail' }),
        deadline: undefined,
      },
      gate('gate-typecheck', ['ac-1']),
    ]);

    expect(check(plan)).toEqual([]);
  });
});

// ── KAR-23.9 — a node nothing can perform ────────────────────────────────────

/**
 * The set the shipped daemon actually composes performers for, spelled here as
 * a literal on purpose: `@DeFlow/core` may not import `@DeFlow/daemon`, and the
 * two are held together by `packages/daemon/src/exec/performable.ts` being what
 * `plan/validate.ts` really passes.
 */
const THIS_DAEMON = { nodeTypes: ['agent', 'gate', 'tool'], toolKinds: ['script'] } as const;

const performableCheck = (plan: PlanGraph, taskSpec: TaskSpec = COVERED) =>
  validatePlan(plan, taskSpec, [CLAUDE], {
    estimatePacketTokens: NO_TOKENS,
    performable: THIS_DAEMON,
  });

const structural = (id: string, over: Record<string, unknown>) => ({
  id,
  title: id,
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1' },
  ...over,
});

const mapNode = structural('fan-out-per-service', {
  type: 'map',
  over: { kind: 'glob', pattern: 'services/*' },
  concurrency: 2,
  body: 'impl',
});

const loopNode = structural('until-green', {
  type: 'loop',
  body: 'impl',
  maxRounds: 3,
  goal: { kind: 'gate', gate: 'gate-typecheck' },
  noProgress: { sameFailureSignatureLimit: 2, diffSimilarityThreshold: 0.9 },
});

const subgraphNode = structural('nested', {
  type: 'subgraph',
  graph: { kind: 'template', templateId: 'library-upgrade', params: {} },
});

const toolNode = (over: Record<string, unknown>) =>
  structural('post-webhook', { type: 'tool', effectClass: 'pure', ...over });

suite('KAR-23.9 — a plan naming work nobody can perform is refused at plan time', () => {
  it('a map node is one blocking NODE_TYPE_UNPERFORMABLE naming the node and the type', () => {
    const found = performableCheck(
      graph([agent('impl'), mapNode, gate('gate-typecheck', ['ac-1'])]),
    );
    const unperformable = found.filter((one) => one.code === 'NODE_TYPE_UNPERFORMABLE');

    expect(unperformable).toMatchObject([
      { severity: 'error', node: 'fan-out-per-service', key: 'map' },
    ]);
    // The message has to be actionable by a *planner*, because it is handed
    // back verbatim on the one retry §3.5 allows.
    expect(unperformable[0]?.message).toContain('agent, gate, tool');
    expect(hasBlockingDiagnostic(found)).toBe(true);
  });

  it('reports loop and subgraph too, one diagnostic each, and every one of them', () => {
    const found = performableCheck(
      graph([agent('impl'), mapNode, loopNode, subgraphNode, gate('gate-typecheck', ['ac-1'])]),
    );

    expect(
      found.filter((one) => one.code === 'NODE_TYPE_UNPERFORMABLE').map((one) => one.node),
    ).toEqual(['fan-out-per-service', 'nested', 'until-green']);
  });

  it('a human node is never diagnosed: the scheduler answers it, nothing performs it', () => {
    // Load-bearing. `decide()` admits a `human` node by `SuspendNode` and never
    // by `StartNode`, so diagnosing it here would refuse every plan KAR-13.1
    // exists to make possible.
    const humanNode = structural('approve-scope', {
      type: 'human',
      prompt: 'Extend the migration scope?',
      options: [{ id: 'yes', label: 'Extend scope', effect: 'approve' }],
    });

    expect(
      performableCheck(graph([humanNode, gate('gate-typecheck', ['ac-1'])])).filter(
        (one) => one.code === 'NODE_TYPE_UNPERFORMABLE',
      ),
    ).toEqual([]);
  });

  it('an http tool node is TOOL_KIND_UNPERFORMABLE, and a script one is clean', () => {
    const http = performableCheck(
      graph([
        toolNode({ tool: { kind: 'http', method: 'POST', url: 'https://example.com/hook' } }),
        gate('gate-typecheck', ['ac-1']),
      ]),
    );

    expect(http.filter((one) => one.code === 'TOOL_KIND_UNPERFORMABLE')).toMatchObject([
      { severity: 'error', node: 'post-webhook', key: 'http' },
    ]);

    const script = performableCheck(
      graph([
        toolNode({ tool: { kind: 'script', run: 'pnpm build' } }),
        gate('gate-typecheck', ['ac-1']),
      ]),
    );
    expect(script).toEqual([]);
  });

  it('an mcp tool node is refused for its kind and not for its type', () => {
    const found = performableCheck(
      graph([
        toolNode({ tool: { kind: 'mcp', server: 'linear', tool: 'create_issue', args: {} } }),
        gate('gate-typecheck', ['ac-1']),
      ]),
    );

    expect(found.map((one) => one.code)).toEqual(['TOOL_KIND_UNPERFORMABLE']);
  });

  it('a daemon that performs everything reports nothing — the check is the set, not a habit', () => {
    expect(
      check(
        graph([agent('impl'), mapNode, loopNode, subgraphNode, gate('gate-typecheck', ['ac-1'])]),
      ).filter((one) => one.code === 'NODE_TYPE_UNPERFORMABLE'),
    ).toEqual([]);
  });
});

suite('KAR-23.13 — a tool node’s static refusals are diagnostics, not run-time deaths', () => {
  it('a full tool node is one blocking TOOL_PERMISSION_UNSCHEDULABLE naming the node and the level', () => {
    // The 2026-08-24 incident, at the moment it was knowable:
    // `run_20260824T174326Z_3b9ba1` validated, started, and lost all fourteen
    // nodes inside a second to this exact refusal plus thirteen
    // `dependency.failed`. `permission` is plan content.
    const found = performableCheck(
      graph([
        toolNode({
          id: 'branch-setup',
          tool: { kind: 'script', run: 'git checkout -b feature' },
          permission: 'full',
        }),
        gate('gate-typecheck', ['ac-1']),
      ]),
    );
    const refused = found.filter((one) => one.code === 'TOOL_PERMISSION_UNSCHEDULABLE');

    expect(refused).toMatchObject([{ severity: 'error', node: 'branch-setup', key: 'full' }]);
    expect(refused[0]?.message).toContain('full is not a sandbox');
    expect(refused[0]?.message).toContain("'worktree'");
    expect(hasBlockingDiagnostic(found)).toBe(true);
  });

  it('a tool node at a level DeFlow enforces is clean', () => {
    for (const permission of ['read', 'worktree', 'worktree+net']) {
      expect(
        performableCheck(
          graph([
            toolNode({ tool: { kind: 'script', run: 'pnpm install' }, permission }),
            gate('gate-typecheck', ['ac-1']),
          ]),
        ),
        permission,
      ).toEqual([]);
    }
  });

  it('an agent node at full is NOT diagnosed — this story refuses tool nodes only', () => {
    // The boundary. `fullPermissionIssues` still has no production caller and
    // wiring F5.4's per-run opt-in is its own story; what the tool performer
    // refuses today is what validation refuses now, and nothing more.
    expect(
      performableCheck(
        graph([agent('impl', { permission: 'full' }), gate('gate-typecheck', ['ac-1'])]),
      ).filter((one) => one.code === 'TOOL_PERMISSION_UNSCHEDULABLE'),
    ).toEqual([]);
  });

  it('a deny-listed run line is one blocking TOOL_COMMAND_REFUSED', () => {
    const found = performableCheck(
      graph([
        toolNode({ id: 'deploy', tool: { kind: 'script', run: 'terraform apply -auto-approve' } }),
        gate('gate-typecheck', ['ac-1']),
      ]),
    );
    const refused = found.filter((one) => one.code === 'TOOL_COMMAND_REFUSED');

    expect(refused).toMatchObject([{ severity: 'error', node: 'deploy', key: 'terraform-apply' }]);
    expect(refused[0]?.message).toContain('terraform apply -auto-approve');
    expect(hasBlockingDiagnostic(found)).toBe(true);
  });

  it('leaves the everyday build verbs a plan is made of alone', () => {
    for (const run of ['git checkout -b feature', 'pnpm install', 'rm -rf ./build']) {
      expect(
        performableCheck(
          graph([
            toolNode({ tool: { kind: 'script', run }, permission: 'worktree' }),
            gate('gate-typecheck', ['ac-1']),
          ]),
        ),
        run,
      ).toEqual([]);
    }
  });

  it('reports both faults of one node, so a two-fault plan costs one retry and not two', () => {
    const found = performableCheck(
      graph([
        toolNode({
          id: 'deploy',
          tool: { kind: 'script', run: 'terraform destroy' },
          permission: 'full',
        }),
        gate('gate-typecheck', ['ac-1']),
      ]),
    );

    expect(found.map((one) => one.code).toSorted()).toEqual([
      'TOOL_COMMAND_REFUSED',
      'TOOL_PERMISSION_UNSCHEDULABLE',
    ]);
  });
});
