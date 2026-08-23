/**
 * KAR-03.6 — the two things that make the checkpoint incapable of causing a
 * correctness bug: the version stamp, and the schema a decoded `state_json`
 * has to survive before it is allowed to become `RunState`
 * (docs/05-durable-execution.md §5.1).
 *
 * The subtle half is the second one, and it is why this file exists rather
 * than a `JSON.parse` in the ledger. A checkpoint written by last month's
 * binary parses cleanly. Every field it kept holds the right *kind* of value.
 * It decodes into an object that looks exactly like state and is not — and
 * the failure surfaces hours later as a node that never ran, or a lock nobody
 * holds. `checkpoint_version` is the first line of defence; this schema is the
 * second, and belt and braces are cheap when the alternative is a wrong run.
 *
 * Verifies: EPIC-03-S20 (scenario 2) · AC5, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { canonicalJson } from './canonical-json.ts';
import {
  CriterionIdSchema,
  type GateId,
  HandleSchema,
  NodeIdSchema,
  PlanHashSchema,
  ProviderIdSchema,
  RunIdSchema,
  SchemaIdSchema,
} from './ids.ts';
import { DEFAULT_NO_PROGRESS_POLICY } from './no-progress.ts';
import {
  CHECKPOINT_VERSION,
  initialRunState,
  lockKey,
  type RunState,
  RunStateSchema,
} from './run-state.ts';

const RUN_ID = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');
const NODE = NodeIdSchema.parse('recon-auth-surface');
const SHA = PlanHashSchema.parse(`sha256-${'a'.repeat(64)}`);
const HANDLE = HandleSchema.parse(`artifact://${'b'.repeat(64)}`);

/**
 * A state with something in every field, because a schema is only as strict as
 * the fixture that exercises it: an `initialRunState()`-only spec would accept
 * a schema that had never heard of `NodeState`.
 *
 * Typed as `RunState` rather than inferred, so the compiler refuses a fixture
 * the reducer could not have produced.
 */
/**
 * One `agent` node, spelled out to the last default, so the round trip through
 * the row is an identity: `PlanGraphSchema` fills `retry`, `budget` and
 * `returns.maxTokens` in when they are absent, and a fixture that leaned on
 * that would compare a defaulted decode against an undefaulted fixture.
 */
const graph = (planHash: string): NonNullable<RunState['plan']> => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN_ID,
  version: 3,
  planHash: PlanHashSchema.parse(planHash),
  parent: null,
  taskSpecHash: `sha256-${'c'.repeat(64)}`,
  createdBy: 'planner',
  createdAt: '2026-08-02T14:11:33.000Z',
  nodes: [
    {
      id: NODE,
      title: 'Survey the auth surface',
      type: 'agent',
      deps: [],
      lifecycle: 'active',
      reads: [],
      writes: [],
      permission: 'worktree',
      pathScopes: { write: [] },
      returns: { schemaId: SchemaIdSchema.parse('DeFlow.finding.v1'), maxTokens: 1500 },
      retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
      budget: {},
      brief: 'Survey how the auth module verifies tokens.',
      provider: { prefer: [ProviderIdSchema.parse('claude-code')], requires: [] },
      resume: 'always-replay',
    },
  ],
  edges: [],
});

const PROPOSED_HASH = `sha256-${'e'.repeat(64)}`;

const populated: RunState = {
  runId: RUN_ID,
  status: 'needs-human',
  repoRoot: '/home/u/proj',
  specApproved: { specHash: SHA, by: 'cli' },
  specHash: SHA,
  outcome: null,
  humanGates: {},
  interjections: {
    [NODE]: [
      {
        seq: 12,
        node: NODE,
        text: "Use the existing useToast composable, don't add a new one.",
        mode: 'next-turn',
        delivery: 'unsupported',
      },
    ],
  },
  gateVerdicts: {
    'gate-typecheck': {
      gate: 'typecheck' as GateId,
      outcome: 'pass',
      seq: 7,
      summary: 'tsc exited zero',
      findings: [],
    },
  },
  criteriaSatisfied: [CriterionIdSchema.parse('unit-tests-pass')],
  needsHuman: {
    reason: 'churn',
    detail: 'the planner has patched the same node four times',
    seq: 11,
  },
  patchPolicy: {
    hash: SHA,
    source: 'config',
    rules: [
      { id: 'expensive', when: { costDeltaUsd: '> 5.00' }, decision: 'approve' },
      { id: 'default', decision: 'approve' },
    ],
    drift: null,
  },
  cancel: { mode: 'forceful', requestedSeq: 6 },
  planHash: SHA,
  planVersion: 3,
  plan: graph(SHA),
  proposedPlans: { [PROPOSED_HASH]: graph(PROPOSED_HASH) },
  nodes: {
    [NODE]: {
      status: 'completed',
      attempt: 1,
      attempts: 2,
      provider: ProviderIdSchema.parse('claude-code'),
      model: 'claude-opus-4-6',
      permission: 'worktree',
      worktree: `.DeFlow/wt/${RUN_ID}__${NODE}`,
      result: {
        status: 'completed',
        output: { summary: 'done' },
        outputSchemaId: SchemaIdSchema.parse('DeFlow.artifact.v1'),
        usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
        costUsd: 0.42,
        producedFacts: [],
        artifacts: [HANDLE],
      },
      failure: null,
      suspension: null,
      requestHash: `sha256-${'f'.repeat(64)}`,
      wakeAt: null,
      startedTs: 1_754_149_500_000,
      updatedSeq: 8,
    },
  },
  locks: {
    [lockKey('repo', 'repo')]: { lock: 'repo', key: 'repo', node: NODE, sinceSeq: 7 },
  },
  nodeIds: { active: [NODE], retired: [NodeIdSchema.parse('retired-step')] },
  policy: { globalAgentSlots: 5, noProgress: DEFAULT_NO_PROGRESS_POLICY },
  budget: {
    run: {
      costUsd: { subscription: 0.42, apiKey: null, vendorReported: 0.42, estimated: null },
      usage: {
        vendorReported: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
        estimated: null,
      },
      unaccounted: [],
      authModes: ['subscription' as const],
    },
    nodes: {
      [NODE]: {
        costUsd: { subscription: 0.42, apiKey: null, vendorReported: 0.42, estimated: null },
        usage: {
          vendorReported: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
          estimated: null,
        },
        unaccounted: [],
        authModes: ['subscription' as const],
        attempts: [
          {
            attempt: 1,
            costUsd: { subscription: 0.42, apiKey: null, vendorReported: 0.42, estimated: null },
            usage: {
              vendorReported: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
              estimated: null,
            },
            unaccounted: [],
            authModes: ['subscription' as const],
          },
        ],
      },
    },
    providers: {
      claude: {
        costUsd: { subscription: 0.42, apiKey: null, vendorReported: 0.42, estimated: null },
        usage: {
          vendorReported: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
          estimated: null,
        },
        unaccounted: [],
        authModes: ['subscription' as const],
      },
    },
    breaches: [{ scope: 'run', dimension: 'cost', limit: 5, actual: 5.2, firedBy: 'deflow' }],
    // KAR-14.3 — one attempt reconciled: the estimate and the actual side by
    // side, and the ratio between them.
    estimateAccuracy: {
      samples: 1,
      estimatedCostUsd: 0.35,
      actualCostUsd: 0.42,
      costRatio: 1.2,
      estimatedInputTokens: 1000,
      actualInputTokens: 1200,
      tokenRatio: 1.2,
    },
  },
  ceilings: {
    run: { costUsd: 5, wallclockMs: 14_400_000 },
    node: { costUsd: 2, wallclockMs: null },
    nodes: { [NODE]: { costUsd: null, wallclockMs: 600_000 } },
    hash: `sha256-${'e'.repeat(64)}`,
    setSeq: 12,
  },
  watermarkSeq: 9,
  watermarkTs: 1_754_150_000_000,
  startedTs: 1_754_149_000_000,
  stalledAtSeq: 9,
  churnWindow: [{ node: NODE, requestHash: `sha256-${'f'.repeat(64)}`, attempt: 1, seq: 8 }],
  replans: { flat: 2, completed: 3, versions: [2, 3] },
  epoch: 2,
  staleEpochSkipped: 1,
  // KAR-27.3 — a framing turn that opened two sessions, spent one attempt, and
  // is running the second.
  preExecution: {
    framing: {
      running: true,
      sessions: 2,
      failures: 1,
      sinceTs: 1_754_149_500_000,
      maxAttempts: 3,
    },
  },
};

/** Exactly what the ledger hands the decoder: the row's text, parsed. */
const throughStorage = (state: RunState): unknown => JSON.parse(canonicalJson(state));

suite('CHECKPOINT_VERSION (AC7)', () => {
  it('is one positive integer constant', () => {
    expect(Number.isInteger(CHECKPOINT_VERSION)).toBe(true);
    expect(CHECKPOINT_VERSION).toBeGreaterThan(0);
  });
});

suite('RunStateSchema accepts what the reducer really produces', () => {
  it('accepts the initial state unchanged', () => {
    expect(RunStateSchema.parse(throughStorage(initialRunState()))).toEqual(initialRunState());
  });

  it('accepts a fully-populated state after the round trip through the row', () => {
    expect(RunStateSchema.parse(throughStorage(populated))).toEqual(populated);
  });

  it('returns a value the compiler agrees is RunState', () => {
    // Assignment, not a cast: if the schema ever describes a shape that is not
    // this build's `RunState`, `pnpm typecheck` fails here rather than a
    // checkpoint decoding into a state nobody can explain.
    const decoded: RunState = RunStateSchema.parse(throughStorage(populated));
    expect(decoded.nodes[NODE]?.status).toBe('completed');
  });
});

suite('a candidate that is not this build’s RunState is rejected (AC5)', () => {
  const rejected = (candidate: unknown): boolean =>
    RunStateSchema.safeParse(candidate).success === false;

  it('rejects JSON that is not an object at all', () => {
    expect(rejected([])).toBe(true);
    expect(rejected(null)).toBe(true);
    expect(rejected('{}')).toBe(true);
    expect(rejected(42)).toBe(true);
  });

  it('rejects an empty object', () => {
    expect(rejected({})).toBe(true);
  });

  it('rejects an older shape: a field this build requires is missing', () => {
    const { staleEpochSkipped: _dropped, ...older } = initialRunState();
    // This is the case criterion 5 exists for. It is valid JSON, it is an
    // object, every field it does have is the right type — and folding the
    // tail onto it produces a state the reducer would never have produced.
    expect(rejected(older)).toBe(true);
  });

  it('rejects a newer shape: a field this build has never heard of', () => {
    expect(rejected({ ...initialRunState(), sandboxEscalations: 3 })).toBe(true);
  });

  it('rejects a field of the wrong type, however plausible', () => {
    expect(rejected({ ...initialRunState(), planVersion: '3' })).toBe(true);
    expect(rejected({ ...initialRunState(), nodes: [] })).toBe(true);
    expect(rejected({ ...initialRunState(), status: 'sleeping' })).toBe(true);
    expect(rejected({ ...initialRunState(), watermarkSeq: -1 })).toBe(true);
    expect(rejected({ ...initialRunState(), runId: 'run-42' })).toBe(true);
  });

  it('validates nested values too, not only the top level', () => {
    const node = populated.nodes[NODE];
    if (node === undefined) throw new Error('fixture lost its node');
    const { attempts: _dropped, ...withoutAttempts } = node;

    expect(rejected({ ...populated, nodes: { [NODE]: withoutAttempts } })).toBe(true);
    expect(rejected({ ...populated, nodes: { [NODE]: { ...node, status: 'thinking' } } })).toBe(
      true,
    );
    expect(
      rejected({
        ...populated,
        locks: {
          [lockKey('repo', 'repo')]: { lock: 'database', key: 'repo', node: NODE, sinceSeq: 7 },
        },
      }),
    ).toBe(true);
    expect(
      rejected({
        ...populated,
        budget: {
          ...populated.budget,
          breaches: [{ scope: 'galaxy', dimension: 'cost', limit: 5, actual: 6 }],
        },
      }),
    ).toBe(true);
  });

  it('rejects an undefined where the shape says null', () => {
    // `{ outcome: undefined }` and `{}` are not the same object to a structural
    // comparison, and neither is `RunState`: absent is `null` here, always.
    expect(rejected({ ...initialRunState(), outcome: undefined })).toBe(true);
  });

  it('refuses a lock taken at seq 0, which is not a seq any event has', () => {
    expect(
      rejected({
        ...populated,
        locks: {
          [lockKey('repo', 'repo')]: { lock: 'repo', key: 'repo', node: NODE, sinceSeq: 0 },
        },
      }),
    ).toBe(true);
  });
});
