/**
 * KAR-10.3 — the approval gate's pure half: the document the operator is shown,
 * the identity that survives approval, the patch an edit produces, and the
 * revalidation a mid-run edit forces.
 *
 * Verifies: EPIC-10-S13 (third scenario), EPIC-10-S14 (first and third),
 * EPIC-10-S17, EPIC-10-S29 (second scenario) · AC1, AC5, AC6, AC8 ·
 * test plan #1, #5
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { decide } from './decide.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { sealTaskSpec, type TaskSpecDraft } from './framing.ts';
import { specHash } from './hash.ts';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';
import {
  coveredByGatesOf,
  currentSpec,
  hashableSpec,
  renderSpecForReview,
  revalidateSpecAgainstPlan,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
  sealEditedSpec,
  specHistory,
  withCoveredByGates,
} from './spec-approval.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const TS = 1_754_313_093_000;

const FRAMED: TaskSpecDraft = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../test/fixtures/specs/vue3-migration.framed.json', import.meta.url)),
    'utf8',
  ),
) as TaskSpecDraft;

/** A deep copy, so a case that edits one field cannot leak into the next. */
const framed = (): TaskSpecDraft => structuredClone(FRAMED);

function event(kind: keyof typeof EVENT_SCHEMAS, payload: unknown, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

function fold(events: readonly Event[]): RunState {
  let state = initialRunState();
  for (const one of events) state = reduce(state, one);
  return state;
}

// ── test plan #1 — the gate is a fold of the log ─────────────────────────────

suite('the approval gate is derived from the log (test plan #1, EPIC-10-S13)', () => {
  it('reduces task.submitted, framing completion and human.requested to awaiting-spec-approval', async () => {
    const spec = await sealTaskSpec(framed());
    const state = fold([
      event(
        'task.submitted',
        {
          sha256: 'a'.repeat(64),
          raw: 'Migrate the checkout module to Vue 3.',
          provenance: { kind: 'text', by: 'cli', submittedAt: TS },
        },
        1,
      ),
      event(
        'run.created',
        { spec, cwd: '/tmp/repo', repo: { head: 'e83c516', branch: 'main' } },
        2,
      ),
      event(
        'human.requested',
        {
          node: SPEC_GATE_NODE,
          prompt: renderSpecForReview(framed()),
          options: SPEC_APPROVAL_OPTIONS,
        },
        3,
      ),
    ]);

    expect(state.status).toBe('awaiting-spec-approval');
    expect(state.specApproved).toBeNull();
    expect(decide(state, TS)).toEqual([]);
  });

  it('offers the four operator actions F1.3 names, in order', () => {
    expect(SPEC_APPROVAL_OPTIONS.map((option) => option.id)).toEqual([
      'approve',
      'edit',
      'reject',
      'abandon',
    ]);
  });

  it('renders the goal, every non-goal and every criterion verbatim', () => {
    const rendered = renderSpecForReview(framed());
    expect(rendered).toContain(FRAMED.goal);
    for (const nonGoal of FRAMED.nonGoals) expect(rendered).toContain(nonGoal);
    for (const criterion of FRAMED.acceptanceCriteria) {
      expect(rendered).toContain(criterion.statement);
    }
  });
});

// ── test plan #5 / EPIC-10-S17 — specHash identity ───────────────────────────

suite('specHash excludes approvedBy in both directions (EPIC-10-S17)', () => {
  it('is unchanged by either approval record', async () => {
    const spec = await sealTaskSpec(framed());
    const h = spec.specHash;
    expect(await specHash({ ...spec, approvedBy: { at: '2026-08-04T09:00:00Z', via: 'ui' } })).toBe(
      h,
    );
    expect(
      await specHash({ ...spec, approvedBy: { at: '2026-08-05T11:30:00Z', via: 'cli' } }),
    ).toBe(h);
  });

  it('changes when one character of goal changes', async () => {
    const spec = await sealTaskSpec(framed());
    const edited = await sealTaskSpec({ ...framed(), goal: `${FRAMED.goal}.` });
    expect(edited.specHash).not.toBe(spec.specHash);
  });

  it('changes when one whitespace character is added inside a criterion statement', async () => {
    const document = framed();
    const first = document.acceptanceCriteria[0];
    if (first === undefined) throw new Error('the fixture has no acceptance criteria');
    const spaced = structuredClone(document);
    const target = spaced.acceptanceCriteria[0];
    if (target === undefined) throw new Error('unreachable');
    (target as { statement: string }).statement = `${first.statement} `;

    expect((await sealTaskSpec(spaced)).specHash).not.toBe((await sealTaskSpec(document)).specHash);
  });

  it('is key-order independent', async () => {
    const spec = await sealTaskSpec(framed());
    const shuffled = Object.fromEntries(Object.entries(spec).toReversed());
    expect(await specHash(shuffled)).toBe(await specHash(spec));
  });
});

// ── EPIC-10-S14 — the history a UI reads back ────────────────────────────────

suite('the spec history is readable and nothing is overwritten (EPIC-10-S14)', () => {
  /** S14's two edits: sharpen a criterion, add a non-goal. The differ that
   * produces this patch is `@DeFlow/daemon`'s `amendSpec` (R1 — core declares
   * no rfc6902), and its own spec asserts the operations; here the patch is
   * data, which is exactly how it arrives from the ledger. */
  const PATCH = [
    { op: 'add', path: '/nonGoals/-', value: 'changing the public API of @voyado/ui' },
    {
      op: 'replace',
      path: '/acceptanceCriteria/0/statement',
      value: 'pnpm build exits zero and emits no new type errors.',
    },
  ] as const;

  function edited(): TaskSpecDraft {
    const document = framed();
    const target = document.acceptanceCriteria[0];
    if (target === undefined) throw new Error('the fixture has no acceptance criteria');
    (target as { statement: string }).statement = PATCH[1].value;
    return { ...document, nonGoals: [...document.nonGoals, PATCH[0].value] };
  }

  it('returns each version with its hash and the patch between them', async () => {
    const before = await sealTaskSpec(framed());
    const document = edited();
    const after = await sealTaskSpec(document);
    const history = await specHistory([
      event(
        'run.created',
        { spec: before, cwd: '/tmp/repo', repo: { head: 'e83c516', branch: 'main' } },
        1,
      ),
      event(
        'spec.amended',
        {
          from: before.specHash,
          to: after.specHash,
          patch: PATCH,
          document,
          by: 'ui',
        },
        2,
      ),
    ]);

    expect(history.map((version) => version.specHash)).toEqual([before.specHash, after.specHash]);
    expect(history[0]?.patch).toBeNull();
    expect(history[1]?.patch).toEqual(PATCH);
    // Nothing was overwritten: the pre-edit spec is still readable at its hash.
    expect(history[0]?.spec).toEqual(before);
    expect(await currentSpec([])).toBeNull();
  });

  it('refuses an edit that breaks the criteria contract, with EPIC-10-S9’s error text', async () => {
    const broken = framed();
    const target = broken.acceptanceCriteria[0];
    if (target === undefined) throw new Error('the fixture has no acceptance criteria');
    delete (target as { verifiedBy?: unknown }).verifiedBy;

    await expect(sealEditedSpec(broken)).rejects.toThrow(
      /acceptance criterion ac-1 must name at least one gate in verifiedBy/,
    );
  });
});

// ── EPIC-10-S29 — revalidation against the plan ──────────────────────────────

suite('a spec edit is revalidated against the current plan (EPIC-10-S29)', () => {
  const gateNode = (id: string, criteria: readonly string[]): Record<string, unknown> => ({
    id,
    title: `gate ${id}`,
    type: 'gate',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 1500 },
    retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    gate: { kind: 'deterministic', gateId: 'typecheck' },
    criteria: [...criteria],
    independence: { notSessionOf: [], preferDifferentProvider: false },
  });

  const plan = (criteria: readonly string[]): Record<string, unknown> => ({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN_ID,
    version: 3,
    planHash: `sha256-${'a'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'c'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes: [gateNode('gate-1', criteria)],
    edges: [],
  });

  it('passes when every criterion is covered by a gate node or marked unverifiable', async () => {
    const spec = await sealTaskSpec(framed());
    const state = fold([
      event(
        'plan.proposed',
        {
          version: 3,
          planHash: `sha256-${'a'.repeat(64)}`,
          graph: plan(['ac-1', 'ac-2']),
          by: 'planner',
        },
        1,
      ),
    ]);
    const graph = state.proposedPlans[`sha256-${'a'.repeat(64)}`];
    if (graph === undefined) throw new Error('the fixture plan was not folded');

    // ac-3 is unverifiable in the fixture, so nothing has to cover it.
    expect(revalidateSpecAgainstPlan(spec, graph)).toEqual([]);
  });

  it('names the uncovered criterion when a new one reaches no gate', async () => {
    const document = framed();
    const spec = await sealTaskSpec({
      ...document,
      acceptanceCriteria: [
        ...document.acceptanceCriteria,
        {
          id: 'ac-8',
          statement: 'No component may import from packages/legacy.',
          verifiedBy: ['import-lint'],
        },
      ],
    });
    const state = fold([
      event(
        'plan.proposed',
        {
          version: 3,
          planHash: `sha256-${'a'.repeat(64)}`,
          graph: plan(['ac-1', 'ac-2']),
          by: 'planner',
        },
        1,
      ),
    ]);
    const graph = state.proposedPlans[`sha256-${'a'.repeat(64)}`];
    if (graph === undefined) throw new Error('the fixture plan was not folded');

    const issues = revalidateSpecAgainstPlan(spec, graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.criterion).toBe('ac-8');
    expect(issues[0]?.message).toMatch(/ac-8/);
    expect(issues[0]?.code).toBe('CRITERION_UNCOVERED');
  });

  it('does not count a gate node whose lifecycle has retired as covering anything (EPIC-12-S28)', async () => {
    const document = framed();
    const spec = await sealTaskSpec(document);
    const state = fold([
      event(
        'plan.proposed',
        {
          version: 3,
          planHash: `sha256-${'a'.repeat(64)}`,
          graph: {
            ...plan(['ac-1', 'ac-2']),
            nodes: [{ ...gateNode('gate-1', ['ac-1', 'ac-2']), lifecycle: 'abandoned' }],
          },
          by: 'planner',
        },
        1,
      ),
    ]);
    const graph = state.proposedPlans[`sha256-${'a'.repeat(64)}`];
    if (graph === undefined) throw new Error('the fixture plan was not folded');

    const issues = revalidateSpecAgainstPlan(spec, graph);
    expect(issues.map((issue) => issue.criterion).toSorted()).toEqual(['ac-1', 'ac-2']);
    expect(issues.every((issue) => issue.code === 'CRITERION_UNCOVERED')).toBe(true);
  });
});

// ── KAR-12.4 — acceptance-criteria traceability ──────────────────────────────

suite('the escape hatch costs one sentence (KAR-12.4 AC2, test plan #2)', () => {
  const spec = (rubric: string): TaskSpec =>
    TaskSpecSchema.parse({
      schemaId: 'DeFlow.taskspec.v1',
      goal: 'Migrate the checkout module to Vue 3.',
      scope: { included: ['packages/checkout'] },
      nonGoals: ['Do not touch packages/legacy.'],
      constraints: [],
      priorDecisions: [],
      acceptanceCriteria: [
        {
          id: 'ac-9',
          statement: 'The migrated date picker feels as responsive as the old one.',
          check: { kind: 'manual', rubric },
          coveredByGates: [],
        },
      ],
      knownFailureModes: [],
      approvedBy: null,
      specHash: `sha256-${'0'.repeat(64)}`,
    });

  const emptyPlan: Record<string, unknown> = {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN_ID,
    version: 1,
    planHash: `sha256-${'a'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'c'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes: [],
    edges: [],
  };

  it('a manual check with a real reason emits no diagnostic', () => {
    const issues = revalidateSpecAgainstPlan(
      spec('Subjective. Route to a human node.'),
      emptyPlan as never,
    );
    expect(issues).toEqual([]);
  });

  it('a manual check with a blank reason is CRITERION_UNVERIFIABLE_NO_REASON', () => {
    // The framing draft schema requires a non-blank rubric before a spec is
    // ever sealed (AC4 in framing.ts), so this constructs the sealed TaskSpec
    // directly — a whitespace-only reason a hand-edited or bypassed document
    // could still carry, which is exactly the escape hatch AC2 closes.
    const issues = revalidateSpecAgainstPlan(spec('   '), emptyPlan as never);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      criterion: 'ac-9',
      code: 'CRITERION_UNVERIFIABLE_NO_REASON',
    });
    expect(issues[0]?.message).toMatch(/ac-9/);
  });
});

suite(
  'coveredByGatesOf populates plan node ids, not gate definition ids (KAR-12.4 AC3, test plan #3)',
  () => {
    it('maps a criterion to the ids of the plan nodes that cover it', () => {
      const graph = {
        schemaId: 'DeFlow.plangraph.v1',
        runId: RUN_ID,
        version: 1,
        planHash: `sha256-${'a'.repeat(64)}`,
        parent: null,
        taskSpecHash: `sha256-${'c'.repeat(64)}`,
        createdBy: 'planner',
        createdAt: '2026-08-02T14:11:33.000Z',
        nodes: [
          {
            id: 'gate-typecheck',
            title: 'gate gate-typecheck',
            type: 'gate',
            deps: [],
            lifecycle: 'active',
            reads: [],
            writes: [],
            permission: 'read',
            pathScopes: { write: [] },
            returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 1500 },
            retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
            budget: {},
            gate: { kind: 'deterministic', gateId: 'typecheck' },
            criteria: ['ac-1'],
            independence: { notSessionOf: [], preferDifferentProvider: false },
          },
          {
            id: 'gate-review',
            title: 'gate gate-review',
            type: 'gate',
            deps: [],
            lifecycle: 'active',
            reads: [],
            writes: [],
            permission: 'read',
            pathScopes: { write: [] },
            returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 1500 },
            retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
            budget: {},
            // The gate *definition* id, 'code-review', is deliberately different
            // from the plan node id, 'gate-review' — the mismatch is the point of
            // the test.
            gate: { kind: 'deterministic', gateId: 'code-review' },
            criteria: ['ac-1'],
            independence: { notSessionOf: [], preferDifferentProvider: false },
          },
        ],
        edges: [],
      };

      const covered = coveredByGatesOf(graph as never);
      expect([...(covered.get('ac-1' as never) ?? [])].toSorted()).toEqual([
        'gate-review',
        'gate-typecheck',
      ]);
      expect(covered.get('ac-2' as never)).toBeUndefined();
    });
  },
);

// ── KAR-12.4 AC3 — validation writes coveredByGates, the planner does not ────

suite('coveredByGates is written by validation (KAR-12.4 AC3, EPIC-12-S24)', () => {
  const gateNode = (id: string, criteria: readonly string[]): Record<string, unknown> => ({
    id,
    title: `gate ${id}`,
    type: 'gate',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 1500 },
    retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    gate: { kind: 'deterministic', gateId: 'typecheck' },
    criteria: [...criteria],
    independence: { notSessionOf: [], preferDifferentProvider: false },
  });

  /** Two gate nodes over the fixture's three criteria: `ac-3` is unverifiable
   * and reaches no gate at all, which is the case the walk must still answer
   * (with `[]`, not by leaving the criterion alone). */
  const planWith = (nodes: readonly Record<string, unknown>[]): PlanGraph =>
    PlanGraphSchema.parse({
      schemaId: 'DeFlow.plangraph.v1',
      runId: RUN_ID,
      version: 3,
      planHash: `sha256-${'a'.repeat(64)}`,
      parent: null,
      taskSpecHash: `sha256-${'c'.repeat(64)}`,
      createdBy: 'planner',
      createdAt: '2026-08-02T14:11:33.000Z',
      nodes,
      edges: [],
    });

  const twoGates = (): PlanGraph =>
    planWith([gateNode('gate-unit-tests', ['ac-1']), gateNode('gate-codemod', ['ac-1', 'ac-2'])]);

  it('populates every criterion with the plan node ids that cover it', async () => {
    const spec = await sealTaskSpec(framed());

    const written = withCoveredByGates(spec, twoGates());

    expect(
      written.acceptanceCriteria.map((criterion) => [
        criterion.id,
        [...criterion.coveredByGates].toSorted(),
      ]),
    ).toEqual([
      ['ac-1', ['gate-codemod', 'gate-unit-tests']],
      ['ac-2', ['gate-codemod']],
      // Unverifiable, answered by a human, covered by no plan node: the field
      // is written as empty rather than left at whatever arrived.
      ['ac-3', []],
    ]);
  });

  it('recomputes and overwrites a value that arrived pre-populated', async () => {
    const sealed = await sealTaskSpec(framed());
    // What a hand-edited spec — or a planner that filled the field in — looks
    // like on the way into validation: node ids that are not the ones the plan
    // actually carries, plus one for a criterion nothing covers.
    const handEdited = TaskSpecSchema.parse({
      ...sealed,
      acceptanceCriteria: sealed.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        coveredByGates: ['gate-somebody-typed'],
      })),
    });

    const written = withCoveredByGates(handEdited, twoGates());

    expect(
      written.acceptanceCriteria.flatMap((criterion) => criterion.coveredByGates),
    ).not.toContain('gate-somebody-typed');
    expect(written.acceptanceCriteria[2]?.coveredByGates).toEqual([]);
  });

  it('does not count a retired gate node, so an abandoned branch writes []', async () => {
    const spec = await sealTaskSpec(framed());
    const retired = planWith([
      { ...gateNode('gate-unit-tests', ['ac-1']), lifecycle: 'abandoned' },
      gateNode('gate-codemod', ['ac-2']),
    ]);

    const written = withCoveredByGates(spec, retired);

    expect(written.acceptanceCriteria[0]?.coveredByGates).toEqual([]);
    expect(written.acceptanceCriteria[1]?.coveredByGates).toEqual(['gate-codemod']);
  });

  /**
   * The invariant that makes the overwrite safe to hand onward.
   *
   * AC6 voids any verdict whose `specHash` differs from the run's current one.
   * `coveredByGates` is derived from the plan, and the plan changes on every
   * patch — so if the digest covered it, annotating the spec after validation
   * would silently void every verdict in the ledger and re-run every gate. The
   * digest is the identity of the *authored* document; this field is not part
   * of it (./hash.ts).
   */
  it('leaves the spec’s identity alone: the annotated document hashes the same', async () => {
    const spec = await sealTaskSpec(framed());

    const written = withCoveredByGates(spec, twoGates());

    expect(written.acceptanceCriteria[0]?.coveredByGates).not.toEqual([]);
    expect(await specHash(written as unknown as Record<string, unknown>)).toBe(spec.specHash);
    expect(written.specHash).toBe(spec.specHash);
  });
});

// ── the digest and the diff are over the same document ───────────────────────

suite('hashableSpec is exactly what specHash is over (KAR-10.3 AC5, KAR-12.4 AC3)', () => {
  const gateNode = (id: string, criteria: readonly string[]): Record<string, unknown> => ({
    id,
    title: `gate ${id}`,
    type: 'gate',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 1500 },
    retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    gate: { kind: 'deterministic', gateId: 'typecheck' },
    criteria: [...criteria],
    independence: { notSessionOf: [], preferDifferentProvider: false },
  });

  /**
   * A `spec.amended` patch is a diff of `hashableSpec`, so anything the digest
   * ignores has to be ignored here too — otherwise validating a plan would
   * produce a spec that *diffs* against the pinned one while hashing the same,
   * and the amendment panel would show an operator a change nobody made.
   */
  it('drops the derived coveredByGates, so an annotated spec diffs as unchanged', async () => {
    const spec = await sealTaskSpec(framed());
    const plan = PlanGraphSchema.parse({
      schemaId: 'DeFlow.plangraph.v1',
      runId: RUN_ID,
      version: 1,
      planHash: `sha256-${'a'.repeat(64)}`,
      parent: null,
      taskSpecHash: `sha256-${'c'.repeat(64)}`,
      createdBy: 'planner',
      createdAt: '2026-08-02T14:11:33.000Z',
      nodes: [gateNode('gate-1', ['ac-1', 'ac-2'])],
      edges: [],
    });

    expect(hashableSpec(withCoveredByGates(spec, plan))).toEqual(hashableSpec(spec));
  });
});
