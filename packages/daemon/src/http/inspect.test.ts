/**
 * KAR-15.6 AC3, AC5, AC6 — the projections behind the inspection surfaces.
 *
 * Pure functions of a `RunState`, a stored `ContextPacketRecord` and the two
 * `fact_edges` queries, so each shape can be pinned without a socket. The
 * routes in `./api.ts` are then thin: resolve the run, apply the bound, call
 * one of these.
 *
 * The one assertion here that is load-bearing rather than descriptive is the
 * packet's: *"the per-segment counts sum exactly to the header total"*. That
 * sum is a Playwright smoke for a reason — a breakdown that does not sum is the
 * visible symptom of the packet being re-derived from the rendered prompt
 * instead of served from the stored manifest, and re-deriving is exactly what
 * `packetView` must not do.
 *
 * Verifies: EPIC-15-S42, EPIC-15-S43, EPIC-15-S44 · AC3, AC5, AC6
 */
import type {
  ContextPacketRecord,
  FindingV2,
  GateVerdictState,
  NodeState,
  RunState,
} from '@DeFlow/core';
import { initialRunState, packetTotalsAreConsistent, RunIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { factsPage, findingsByFile, gatesView, nodeBundle, packetView } from './inspect.ts';

const RUN = RunIdSchema.parse('run_20260810T090000Z_ac1506');
const T0 = 1_754_726_400_000;

const node = (over: Partial<NodeState> = {}): NodeState =>
  ({
    status: 'completed',
    attempt: 2,
    attempts: 3,
    provider: 'claude',
    model: 'the-model',
    permission: 'worktree',
    worktree: '/tmp/deflow/wt/n-impl',
    result: {
      status: 'completed',
      output: { ok: true },
      outputSchemaId: 'DeFlow.finding.v1',
      usage: { source: 'vendor', input: 100, output: 20 },
      costUsd: 0.25,
      producedFacts: [],
      artifacts: [],
    },
    failure: null,
    suspension: null,
    requestHash: null,
    wakeAt: null,
    startedTs: T0,
    updatedSeq: 42,
    ...over,
  }) as NodeState;

const state = (over: Partial<RunState> = {}): RunState => ({
  ...initialRunState(),
  runId: RUN,
  nodes: { 'n-impl': node() },
  ...over,
});

suite('the node inspector bundle (AC3, EPIC-15-S42)', () => {
  const bundle = () =>
    nodeBundle({
      runId: RUN,
      nodeId: 'n-impl',
      attempt: 2,
      node: node(),
      budget: state().budget,
      timing: { startedTs: T0, endedTs: T0 + 12_000, durationMs: 12_000 },
      binaryVersion: '0.64.1',
    });

  it('carries every field the inspector renders', () => {
    // The scenario's list, verbatim: provider, model, binary version,
    // permission level, duration, cost, retries and worktree path.
    expect(bundle()).toMatchObject({
      runId: RUN,
      nodeId: 'n-impl',
      attempt: 2,
      provider: 'claude',
      model: 'the-model',
      binaryVersion: '0.64.1',
      permission: 'worktree',
      durationMs: 12_000,
      worktree: '/tmp/deflow/wt/n-impl',
      retries: 2,
    });
    expect(bundle().cost).not.toBeUndefined();
  });

  it('reports retries as attempts beyond the first, never as the attempt index', () => {
    // `attempts` is 1-based and `attempt` is 0-based (§9's envelope). A bundle
    // that reported either raw would be off by one in one direction or the
    // other, and "3 retries" on a node that ran three times is a bug report.
    const once = nodeBundle({
      runId: RUN,
      nodeId: 'n-impl',
      attempt: 0,
      node: node({ attempt: 0, attempts: 1 }),
      budget: state().budget,
      timing: { startedTs: T0, endedTs: T0 + 10, durationMs: 10 },
      binaryVersion: null,
    });
    expect(once.retries).toBe(0);
    expect(once.binaryVersion).toBeNull();
  });

  it('leaves duration null while the node is still running', () => {
    const running = nodeBundle({
      runId: RUN,
      nodeId: 'n-impl',
      attempt: 0,
      node: node({ status: 'running', result: null }),
      budget: state().budget,
      timing: { startedTs: T0, endedTs: null, durationMs: null },
      binaryVersion: null,
    });
    expect(running.durationMs).toBeNull();
    expect(running.endedTs).toBeNull();
  });
});

/** A stored manifest with three segments, one of them pinned and last. */
const record = (): ContextPacketRecord =>
  ({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: RUN,
    nodeId: 'n-impl',
    attempt: 0,
    builtAtEvent: 91,
    target: { provider: 'claude', model: 'the-model', maxContext: 200_000 },
    budget: { fraction: 0.5, limitTokens: 100_000 },
    totals: {
      tokens: 60,
      byKind: {
        'pinned.constraints': 0,
        'pinned.spec': 40,
        'pinned.pathscope': 0,
        'task.brief': 20,
        fact: 0,
        'artifact.handle': 0,
        retrieved: 0,
        'history.summary': 0,
        'tool.output': 0,
      },
    },
    renderedPromptHandle: `artifact:sha256-${'a'.repeat(64)}`,
    pinnedDigests: [`sha256-${'c'.repeat(64)}`],
    segments: [
      {
        id: 'brief',
        kind: 'task.brief',
        sourceEvent: 88,
        contentHash: `sha256-${'b'.repeat(64)}`,
        tokens: { estimated: 20, method: 'gpt-tokenizer/o200k_base' },
        pinned: false,
        compactable: true,
      },
      {
        id: 'spec-goal',
        kind: 'pinned.spec',
        sourceEvent: 12,
        contentHash: `sha256-${'c'.repeat(64)}`,
        tokens: { estimated: 40, method: 'gpt-tokenizer/o200k_base' },
        pinned: true,
        compactable: false,
      },
    ],
  }) as unknown as ContextPacketRecord;

suite('the packet breakdown (AC3, EPIC-15-S42)', () => {
  it('sums its per-segment counts exactly to the header total', () => {
    const view = packetView(record());
    const sum = view.segments.reduce((total, segment) => total + segment.tokens.estimated, 0);

    expect(sum).toBe(view.totals.tokens);
  });

  it('serves the stored manifest rather than re-deriving it', () => {
    // The figures come back byte-identical to what `context.built` recorded:
    // no recount, no re-tokenisation, and therefore nothing that can disagree
    // with the prompt the agent was actually given.
    const stored = record();
    const view = packetView(stored);

    expect(view.totals).toEqual(stored.totals);
    expect(view.builtAtEvent).toBe(stored.builtAtEvent);
    expect(view.renderedPromptHandle).toBe(stored.renderedPromptHandle);
  });

  it('puts pinned segments first', () => {
    expect(packetView(record()).segments.map((segment) => segment.id)).toEqual([
      'spec-goal',
      'brief',
    ]);
  });

  it('keeps the sourceEvent and the counting method on every segment', () => {
    for (const segment of packetView(record()).segments) {
      expect(segment.sourceEvent).toBeGreaterThan(0);
      expect(segment.tokens.method).toBe('gpt-tokenizer/o200k_base');
    }
  });

  it('carries no segment text, because the text is behind a handle', () => {
    // A packet is the whole rendered prompt. Inlining it would make the
    // inspector's own request the largest one in the API.
    for (const segment of packetView(record()).segments) {
      expect(segment).not.toHaveProperty('text');
    }
  });

  it('is a view of a manifest the domain already calls consistent', () => {
    // A guard on the fixture rather than on the code: if this record ever
    // stopped summing, the sum assertion above would be vacuous.
    const rehydrated = {
      ...record(),
      segments: record().segments.map((segment) => ({ ...segment, text: '' })),
    };
    expect(packetTotalsAreConsistent(rehydrated as never)).toEqual({ consistent: true });
  });
});

const finding = (over: Partial<FindingV2> = {}): FindingV2 =>
  ({
    id: 'f0000000000a',
    severity: 'error',
    rule: 'ts2345',
    message: 'Argument of type X is not assignable',
    location: { file: 'src/b.ts', line: 42, blobSha: 'a'.repeat(40) },
    ...over,
  }) as FindingV2;

const verdict = (over: Partial<GateVerdictState> = {}): GateVerdictState =>
  ({
    gate: 'typecheck' as GateVerdictState['gate'],
    outcome: 'fail',
    seq: 120,
    summary: 'two type errors',
    findings: [],
    ...over,
  }) as GateVerdictState;

suite('gates and findings (AC6)', () => {
  const verdicts = {
    'n-gate-typecheck': verdict({
      findings: [
        finding({ id: 'f2', location: { file: 'src/b.ts', line: 9, blobSha: 'a'.repeat(40) } }),
        finding({ id: 'f1', location: { file: 'src/a.ts', line: 3, blobSha: 'a'.repeat(40) } }),
        finding({ id: 'f3', location: { file: 'src/b.ts', line: 4, blobSha: 'a'.repeat(40) } }),
      ],
    }),
    'n-gate-lint': verdict({
      gate: 'lint' as GateVerdictState['gate'],
      outcome: 'pass',
      seq: 130,
      summary: 'clean',
      findings: [finding({ id: 'f4', location: undefined })],
    }),
  } as unknown as Readonly<Record<string, GateVerdictState>>;

  it('lists gates in the order they were decided, with their verdict', () => {
    expect(gatesView(verdicts)).toEqual([
      {
        node: 'n-gate-typecheck',
        gate: 'typecheck',
        outcome: 'fail',
        seq: 120,
        summary: 'two type errors',
        findings: 3,
      },
      {
        node: 'n-gate-lint',
        gate: 'lint',
        outcome: 'pass',
        seq: 130,
        summary: 'clean',
        findings: 1,
      },
    ]);
  });

  it('groups findings by file and orders them by line', () => {
    const groups = findingsByFile(verdicts, undefined);

    expect(groups.map((group) => group.file)).toEqual(['src/a.ts', 'src/b.ts', null]);
    expect(groups[1]?.findings.map((entry) => entry.location?.line)).toEqual([4, 9]);
  });

  it('carries the gate and node that reported each finding', () => {
    const groups = findingsByFile(verdicts, 'src/a.ts');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.findings[0]).toMatchObject({
      id: 'f1',
      gate: 'typecheck',
      node: 'n-gate-typecheck',
    });
  });

  it('filters to one file when asked, and answers nothing for a file with none', () => {
    expect(findingsByFile(verdicts, 'src/nope.ts')).toEqual([]);
  });

  it('keeps a finding with no location rather than dropping it', () => {
    // A finding about the change as a whole has no line to be misdrawn
    // against; dropping it would hide a judgement that is still exactly as
    // true. It goes in its own group, last.
    const groups = findingsByFile(verdicts, undefined);
    expect(groups.at(-1)?.file).toBeNull();
    expect(groups.at(-1)?.findings.map((entry) => entry.id)).toEqual(['f4']);
  });
});

suite('facts with provenance (AC5, EPIC-15-S43)', () => {
  const stored = [
    {
      runId: RUN,
      writtenSeq: 30,
      invalidatedReason: null,
      fact: {
        id: 'fact_a',
        key: 'repo.layout',
        kind: 'observation',
        schemaId: 'DeFlow.fact.v1',
        value: { packages: 9 },
        provenance: {
          byNode: 'n-recon',
          byProvider: 'claude',
          byModel: 'the-model',
          fromEvidence: ['artifact:sha256-x'],
          atEvent: 29,
          at: '2026-08-10T09:00:00.000Z',
          confidence: 'verified',
        },
      },
    },
    {
      runId: RUN,
      writtenSeq: 40,
      invalidatedReason: 'superseded by a later survey',
      fact: {
        id: 'fact_b',
        key: 'build.tool',
        kind: 'observation',
        schemaId: 'DeFlow.fact.v1',
        value: 'pnpm',
        provenance: {
          byNode: 'n-recon',
          byProvider: 'claude',
          byModel: 'the-model',
          fromEvidence: [],
          atEvent: 39,
          at: '2026-08-10T09:01:00.000Z',
          confidence: 'speculative',
        },
      },
    },
  ] as never;

  it('carries who wrote it, from what evidence, when and at what confidence', () => {
    const page = factsPage(stored, { limit: 10 });

    expect(page).toHaveLength(2);
    expect(page[0]).toMatchObject({
      id: 'fact_a',
      key: 'repo.layout',
      provenance: {
        node: 'n-recon',
        provider: 'claude',
        model: 'the-model',
        evidence: ['artifact:sha256-x'],
        at: '2026-08-10T09:00:00.000Z',
        atEvent: 29,
        writtenSeq: 30,
        confidence: 'verified',
      },
    });
  });

  it('says an invalidated fact is invalidated rather than hiding it', () => {
    expect(factsPage(stored, { limit: 10 })[1]).toMatchObject({
      id: 'fact_b',
      invalidated: { reason: 'superseded by a later survey' },
    });
    expect(factsPage(stored, { limit: 10 })[0]?.invalidated).toBeNull();
  });

  it('filters by key and by writing node', () => {
    expect(factsPage(stored, { limit: 10, key: 'build.tool' }).map((row) => row.id)).toEqual([
      'fact_b',
    ]);
    expect(factsPage(stored, { limit: 10, by: 'n-nobody' })).toEqual([]);
  });

  it('is bounded by the limit it is given', () => {
    expect(factsPage(stored, { limit: 1 })).toHaveLength(1);
  });
});
