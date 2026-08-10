/**
 * KAR-15.6 — the read half of docs/11-api-and-realtime.md §6 and §7, over a
 * real socket, against a real file-backed ledger.
 *
 * Integration for the reason `./run-rollup-api.test.ts` gives for the run
 * summary: proving a projection is not the same as proving that EPIC-17's nine
 * P0 views can *reach* it. Every assertion below is against JSON — or NDJSON,
 * or a patch — that came back over `fetch` from a DeFlowd bound to an
 * ephemeral port, reading through the same read-only connection production
 * uses.
 *
 * Verifies: EPIC-15-S39, EPIC-15-S42, EPIC-15-S43, EPIC-15-S44 ·
 * AC1, AC3, AC5, AC6, AC9, AC10, AC11 · test plan #3, #5, #8
 */
import type { PlanGraph, RunId } from '@DeFlow/core';
import { NodeIdSchema, PlanGraphSchema, planHash, RunIdSchema } from '@DeFlow/core';
import {
  ARTIFACT_SCHEME,
  appendEvents,
  appendIoChunks,
  type Db,
  type EventDraft,
  openLedger,
  openRead,
  persistPlanVersion,
  putBlob,
} from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260810T090000Z_ac1506');
const NODE = NodeIdSchema.parse('n-impl');
const RECON = NodeIdSchema.parse('n-recon');
const T0 = 1_754_812_800_000;
const EPOCH = 1;
const PLANNER = { model: 'the-planner-model', effort: 'max', tier: 'strongest' } as const;

const draft = (kind: string, payload: unknown, over: Partial<EventDraft> = {}): EventDraft =>
  ({ runId: RUN, ts: T0, kind, v: 1, epoch: EPOCH, payload, ...over }) as EventDraft;

/**
 * `node.started` as its schema really is: an idempotency key and the exact
 * binary the attempt ran on. The binary is what the inspector's
 * `binaryVersion` comes from, so the fixture has to carry a real one.
 */
const nodeStarted = (attempt: number, ts: number): EventDraft =>
  draft(
    'node.started',
    {
      node: NODE,
      attempt,
      ikey: `${RUN}/${NODE}/${attempt}/0`,
      binary: { path: '/opt/claude/bin/claude', version: '0.64.1', sha256: 'd'.repeat(64) },
    },
    { nodeId: NODE, attempt, ts },
  );

const planNode = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
  ...over,
});

async function graph(version: number, ids: readonly string[]): Promise<PlanGraph> {
  const parsed = PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: version === 1 ? 'planner' : 'scheduler',
    createdAt: '2026-08-10T09:00:00.000Z',
    nodes: ids.map((id) => planNode(id)),
    edges: [],
  });
  return { ...parsed, planHash: await planHash(parsed) };
}

/** The one segment kind table `context.built` carries; all zero but two. */
const byKind = (spec: number, brief: number) => ({
  'pinned.constraints': 0,
  'pinned.spec': spec,
  'pinned.pathscope': 0,
  'task.brief': brief,
  fact: 0,
  'artifact.handle': 0,
  retrieved: 0,
  'history.summary': 0,
  'tool.output': 0,
});

interface Served {
  readonly origin: string;
  readonly db: Db;
  readonly dataDir: string;
  readonly promptSha: string;
  close(): Promise<void>;
}

/**
 * One fixture run carrying everything the inspection surfaces read: two plan
 * versions, a node that ran twice, a built context packet, a blackboard with a
 * writer and two readers, a gate verdict with findings, and a blob.
 */
async function serveFixture(tmp: string): Promise<Served> {
  const runDir = join(tmp, 'runs', RUN);
  const db = openLedger(tmp);

  const v1 = await graph(1, ['n-recon', 'n-impl']);
  await persistPlanVersion(db, {
    runDir,
    graph: v1,
    diagnostics: [],
    by: 'planner',
    planner: PLANNER,
    ts: T0,
    epoch: EPOCH,
  });
  const v2 = await graph(2, ['n-recon', 'n-impl', 'n-probe']);
  await persistPlanVersion(db, {
    runDir,
    graph: v2,
    diagnostics: [],
    by: 'planner',
    planner: PLANNER,
    ts: T0 + 1_000,
    epoch: EPOCH,
  });

  const prompt = new TextEncoder().encode('the rendered prompt, which is derived and not truth\n');
  const promptHandle = putBlob(tmp, prompt, 'text/plain');
  const promptSha = promptHandle.slice(ARTIFACT_SCHEME.length);

  appendEvents(db, [
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'ship the read endpoints',
        scope: { included: ['packages/daemon'] },
        nonGoals: [],
        constraints: ['never widen the public API without a version bump'],
        priorDecisions: [],
        acceptanceCriteria: [
          { id: 'ac-1', statement: 'every list endpoint is bounded' },
          { id: 'ac-2', statement: 'every 404 names its own resource' },
        ],
        knownFailureModes: [],
        approvedBy: null,
        specHash: `sha256-${'1'.repeat(64)}`,
      },
      cwd: '/workspace/repo',
      repo: { head: 'abcdef1', branch: 'main' },
    }),
    // Without this the run has no pinned contract, and every verdict below is
    // void by construction (docs/10-verification-gates.md §5.2).
    draft('run.spec.approved', { specHash: `sha256-${'1'.repeat(64)}`, by: 'ui' }),
    draft('run.started', { planHash: v1.planHash }),
    draft('node.scheduled', {
      node: NODE,
      provider: 'claude',
      model: 'the-model',
      permission: 'worktree',
      worktree: '/workspace/wt/n-impl',
    }),
    draft('node.scheduled', {
      node: RECON,
      provider: 'claude',
      model: 'the-model',
      permission: 'read',
    }),
    nodeStarted(0, T0 + 2_000),
    draft(
      'node.failed',
      {
        node: NODE,
        attempt: 0,
        failure: {
          reason: 'adapter.protocol-error',
          class: 'transient',
          message: 'the agent hung up',
          evidence: [],
          occurredAtEvent: 5,
          attempt: 0,
        },
      },
      { nodeId: NODE, attempt: 0, ts: T0 + 5_000 },
    ),
    nodeStarted(1, T0 + 6_000),
    draft(
      'context.built',
      {
        node: NODE,
        attempt: 1,
        packet: {
          schemaId: 'DeFlow.contextpacket.v1',
          runId: RUN,
          nodeId: NODE,
          attempt: 1,
          builtAtEvent: 9,
          target: { provider: 'claude', model: 'the-model', maxContext: 200_000 },
          budget: { fraction: 0.5, limitTokens: 100_000 },
          totals: { tokens: 60, byKind: byKind(40, 20) },
          renderedPromptHandle: promptHandle,
          pinnedDigests: [`sha256-${'c'.repeat(64)}`],
          segments: [
            {
              id: 'brief',
              kind: 'task.brief',
              sourceEvent: 8,
              contentHash: `sha256-${'b'.repeat(64)}`,
              tokens: { estimated: 20, method: 'gpt-tokenizer/o200k_base' },
              pinned: false,
              compactable: true,
            },
            {
              id: 'spec-goal',
              kind: 'pinned.spec',
              sourceEvent: 2,
              contentHash: `sha256-${'c'.repeat(64)}`,
              tokens: { estimated: 40, method: 'gpt-tokenizer/o200k_base' },
              pinned: true,
              compactable: false,
            },
          ],
        },
      },
      { nodeId: NODE, attempt: 1, ts: T0 + 6_500 },
    ),
    draft(
      'node.completed',
      {
        node: NODE,
        attempt: 1,
        result: {
          status: 'completed',
          output: { findings: [] },
          outputSchemaId: 'DeFlow.finding.v1',
          usage: { source: 'vendor-reported', inputTokens: 900, outputTokens: 120 },
          costUsd: 0.42,
          producedFacts: [],
          artifacts: [],
        },
      },
      { nodeId: NODE, attempt: 1, ts: T0 + 18_000 },
    ),
    draft(
      'budget.consumed',
      {
        node: NODE,
        attempt: 1,
        provider: 'claude',
        usage: { source: 'vendor-reported', inputTokens: 900, outputTokens: 120 },
        costUsd: 0.42,
        authMode: 'subscription',
      },
      { nodeId: NODE, attempt: 1, ts: T0 + 18_500 },
    ),
    draft(
      'gate.evaluated',
      {
        gate: 'typecheck',
        node: 'n-gate-typecheck',
        verdict: {
          schemaId: 'DeFlow.verdict.v4',
          outcome: 'fail',
          gate: 'typecheck',
          evaluatedNode: NODE,
          by: { node: 'n-gate-typecheck', provider: 'claude', model: 'the-model' },
          summary: 'two type errors',
          specHash: `sha256-${'1'.repeat(64)}`,
          criteria: [],
          findings: [
            {
              id: 'f0000000000b',
              severity: 'blocker',
              message: 'the second one, on the later line',
              evidence: [],
              location: { file: 'src/b.ts', line: 42, blobSha: 'a'.repeat(40) },
            },
            {
              id: 'f0000000000a',
              severity: 'blocker',
              message: 'the first one, on the earlier line',
              evidence: [],
              location: { file: 'src/b.ts', line: 9, blobSha: 'a'.repeat(40) },
            },
            {
              // A judgement about the change as a whole: no line to draw it
              // against, and the most important thing on the panel.
              id: 'f0000000000c',
              severity: 'major',
              message: 'this change does something the spec did not ask for',
              evidence: [],
            },
          ],
        },
      },
      { nodeId: NodeIdSchema.parse('n-gate-typecheck'), attempt: 0, ts: T0 + 20_000, v: 4 },
    ),
  ]);

  // The blackboard: `n-recon` wrote a fact, `n-impl` read it twice and
  // `n-gate-typecheck` read it once.
  db.prepare(
    `INSERT INTO fact (fact_id, run_id, key, kind, schema_id, value, by_node, by_provider,
        by_model, from_evidence, at_event, at, confidence, supersedes, invalidated_by,
        invalidated_reason, written_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    'fact_repo_layout',
    RUN,
    'repo.layout',
    'observation',
    'DeFlow.fact.v1',
    JSON.stringify({ packages: 9 }),
    RECON,
    'claude',
    'the-model',
    JSON.stringify(['artifact:sha256-evidence']),
    3,
    '2026-08-10T09:00:03.000Z',
    'verified',
    4,
  );
  for (const [node, direction, seq] of [
    [RECON, 'write', 4],
    [NODE, 'read', 7],
    ['n-gate-typecheck', 'read', 9],
    [NODE, 'read', 11],
  ] as const) {
    db.prepare(
      `INSERT INTO fact_edges (fact_id, run_id, node_id, direction, event_seq)
         VALUES (?, ?, ?, ?, ?)`,
    ).run('fact_repo_layout', RUN, node, direction, seq);
  }

  appendIoChunks(db, [
    {
      runId: RUN,
      nodeId: NODE,
      attempt: 1,
      stream: 'stdout',
      ts: T0 + 7_000,
      data: new TextEncoder().encode('running the suite\n'),
    },
  ]);

  const view = openLedgerView(tmp);
  setLedgerView(view);
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    dataDir: tmp,
    promptSha,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const get = async (path: string): Promise<Response> => {
  const target = served;
  if (target === undefined) throw new Error('no server');
  return fetch(`${target.origin}${path}`);
};

const json = async <T>(path: string): Promise<T> => (await get(path)).json() as Promise<T>;

suite('the plan version rail (EPIC-15-S39, AC1)', () => {
  it('lists every version in order, each with its seq, hash, decision and reason', async ({
    tmp,
  }) => {
    served = await serveFixture(tmp);

    const response = await get(`/api/runs/${RUN}/plans`);
    expect(response.status).toBe(200);

    const rail = (await response.json()) as {
      version: number;
      seq: number;
      planHash: string;
      decision: string | null;
      reason: string | null;
    }[];

    expect(rail.map((row) => row.version)).toEqual([1, 2]);
    expect(rail.every((row) => row.seq > 0)).toBe(true);
    expect(rail.every((row) => row.planHash.startsWith('sha256-'))).toBe(true);
    // v1 is an initial compile: there is no patch behind it, so both are null
    // rather than invented.
    expect(rail[0]).toMatchObject({ decision: null, reason: null });
  });

  it('serves the immutable plan document at a version, addressed by hash', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const response = await get(`/api/runs/${RUN}/plans/2`);
    expect(response.status).toBe(200);
    // Content-addressed: the bytes for a version can never change, so a client
    // may cache them forever.
    expect(response.headers.get('cache-control')).toContain('immutable');

    const document = (await response.json()) as PlanGraph;
    expect(document.version).toBe(2);
    expect(document.nodes.map((node) => node.id)).toEqual(['n-recon', 'n-impl', 'n-probe']);
  });

  it('answers an unknown version with plan_version_not_found', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const response = await get(`/api/runs/${RUN}/plans/99`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'plan_version_not_found',
    );
  });

  it('marks unionLayoutKey as the opaque, unversioned cache key it is (AC11)', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const response = await get(`/api/runs/${RUN}/plans/diff?from=1&to=2`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { unionLayoutKey: string }).toHaveProperty('unionLayoutKey');
    expect(response.headers.get('x-deflow-unversioned')).toContain('unionLayoutKey');
  });
});

suite('the node inspector (EPIC-15-S42, AC3)', () => {
  it('returns the bundle the inspector renders', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const bundle = await json<Record<string, unknown>>(`/api/runs/${RUN}/nodes/${NODE}?attempt=1`);

    expect(bundle).toMatchObject({
      nodeId: NODE,
      attempt: 1,
      provider: 'claude',
      model: 'the-model',
      permission: 'worktree',
      worktree: '/workspace/wt/n-impl',
      // Two attempts: it failed once and then ran.
      retries: 1,
      // T0+2000 to T0+18000 — the first start to the last terminal event.
      durationMs: 16_000,
    });
    expect(bundle.cost).not.toBeNull();
  });

  it('returns a packet whose per-segment counts sum to the header total', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const packet = await json<{
      totals: { tokens: number };
      segments: {
        id: string;
        pinned: boolean;
        sourceEvent: number;
        tokens: { estimated: number; method: string };
      }[];
    }>(`/api/runs/${RUN}/nodes/${NODE}/packet?attempt=1`);

    const sum = packet.segments.reduce((total, segment) => total + segment.tokens.estimated, 0);
    expect(sum).toBe(packet.totals.tokens);

    // Pinned first, every count carrying its method, every segment carrying
    // the event that put it there.
    expect(packet.segments[0]?.pinned).toBe(true);
    expect(packet.segments.every((segment) => segment.tokens.method.length > 0)).toBe(true);
    expect(packet.segments.every((segment) => segment.sourceEvent > 0)).toBe(true);
  });

  it('answers an unknown node with node_not_found', async ({ tmp }) => {
    served = await serveFixture(tmp);

    for (const path of [
      `/api/runs/${RUN}/nodes/n-nope`,
      `/api/runs/${RUN}/nodes/n-nope/packet`,
      `/api/runs/${RUN}/nodes/n-nope/io`,
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code, path).toBe(
        'node_not_found',
      );
    }
  });
});

suite('the memory graph (EPIC-15-S43, AC5)', () => {
  it('carries provenance on every fact', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const facts = await json<{ id: string; key: string; provenance: Record<string, unknown> }[]>(
      `/api/runs/${RUN}/facts`,
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]?.provenance).toMatchObject({
      node: RECON,
      provider: 'claude',
      model: 'the-model',
      evidence: ['artifact:sha256-evidence'],
      at: '2026-08-10T09:00:03.000Z',
      confidence: 'verified',
    });
  });

  it('returns every reader of a fact and no writer', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const consumers = await json<{ node: string; firstReadSeq: number; reads: number }[]>(
      `/api/runs/${RUN}/facts/fact_repo_layout/consumers`,
    );

    expect(consumers).toEqual([
      { node: NODE, firstReadSeq: 7, reads: 2 },
      { node: 'n-gate-typecheck', firstReadSeq: 9, reads: 1 },
    ]);
    expect(consumers.map((row) => row.node)).not.toContain(RECON);
  });

  it('filters facts by key and by writing node', async ({ tmp }) => {
    served = await serveFixture(tmp);

    expect(await json<unknown[]>(`/api/runs/${RUN}/facts?key=repo.layout`)).toHaveLength(1);
    expect(await json<unknown[]>(`/api/runs/${RUN}/facts?key=nothing`)).toHaveLength(0);
    expect(await json<unknown[]>(`/api/runs/${RUN}/facts?by=${RECON}`)).toHaveLength(1);
  });
});

suite('gates, criteria and findings (AC6)', () => {
  it('returns the typed verdict shape for each gate', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const gates = await json<{ node: string; gate: string; outcome: string }[]>(
      `/api/runs/${RUN}/gates`,
    );

    expect(gates).toEqual([
      {
        node: 'n-gate-typecheck',
        gate: 'typecheck',
        outcome: 'fail',
        seq: expect.any(Number) as number,
        summary: 'two type errors',
        findings: 3,
      },
    ]);
  });

  it('groups findings by file and orders them by line', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const groups = await json<
      { file: string | null; findings: { location?: { line: number } }[] }[]
    >(`/api/runs/${RUN}/findings`);

    expect(groups.map((group) => group.file)).toEqual(['src/b.ts', null]);
    expect(groups[0]?.findings.map((entry) => entry.location?.line)).toEqual([9, 42]);
  });

  it('filters findings to one file', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const groups = await json<{ file: string | null }[]>(`/api/runs/${RUN}/findings?file=src/b.ts`);
    expect(groups.map((group) => group.file)).toEqual(['src/b.ts']);
  });

  it('returns one criteria row per acceptance criterion and per constraint', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const rows = await json<{ criterion: string; status: string; statement: string }[]>(
      `/api/runs/${RUN}/criteria`,
    );

    expect(rows.map((row) => row.criterion)).toEqual(['ac-1', 'ac-2', 'constraint-1']);
    // Nothing has spoken to them, and `pending` is what that looks like.
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
  });
});

suite('every 404 names its own resource (EPIC-15-S44, AC9)', () => {
  it('answers each missing resource with its own code', async ({ tmp }) => {
    served = await serveFixture(tmp);

    const cases = [
      ['/api/runs/nope', 'run_not_found'],
      [`/api/runs/${RUN}/nodes/n-nope`, 'node_not_found'],
      ['/api/artifacts/deadbeef', 'artifact_not_found'],
      [`/api/runs/${RUN}/plans/99`, 'plan_version_not_found'],
    ] as const;

    for (const [path, code] of cases) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code, path).toBe(code);
    }
  });

  it('applies a documented default and caps an oversized limit rather than honouring it', async ({
    tmp,
  }) => {
    served = await serveFixture(tmp);

    for (const path of [
      `/api/runs/${RUN}/plans`,
      `/api/runs/${RUN}/facts`,
      `/api/runs/${RUN}/facts/fact_repo_layout/consumers`,
      `/api/runs/${RUN}/findings`,
      `/api/runs/${RUN}/gates`,
    ]) {
      const bare = await get(path);
      const documentedDefault = Number(bare.headers.get('x-deflow-limit'));
      expect(bare.status, path).toBe(200);
      expect(documentedDefault, path).toBeGreaterThan(0);

      // Capped rather than honoured, and capped rather than refused: the
      // header says which bound was applied, so a caller can tell a truncated
      // page from a complete one.
      const greedy = await get(`${path}?limit=100000000`);
      const cap = Number(greedy.headers.get('x-deflow-limit'));
      expect(greedy.status, path).toBe(200);
      expect(cap, path).toBeGreaterThanOrEqual(documentedDefault);
      expect(cap, path).toBeLessThan(100_000_000);
    }
  });
});

suite('every read runs on the read-only connection (AC10)', () => {
  it('reads through a connection that cannot write and has a busy_timeout', async ({ tmp }) => {
    served = await serveFixture(tmp);

    // The routes read through `openLedgerView`, which opens its own read-only
    // connection with its own `busy_timeout`. SQLite enforces the first — a
    // write on it fails rather than queueing behind the daemon's appends —
    // and the second is what stops a read failing outright while a checkpoint
    // holds the file.
    const db = openRead(join(tmp, 'ledger.db'));
    try {
      expect(() =>
        db.prepare(`INSERT INTO fact_edges VALUES ('x', 'y', 'z', 'read', 1)`).run(),
      ).toThrow(/readonly/i);
      expect(db.prepare<{ timeout: number }>('PRAGMA busy_timeout').get()?.timeout).toBeGreaterThan(
        0,
      );
    } finally {
      db.close();
    }
  });
});
