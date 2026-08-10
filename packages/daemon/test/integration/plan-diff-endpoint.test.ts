/**
 * KAR-11.5 AC3, AC4, AC5, AC6, AC7 — `GET /api/runs/:id/plans/diff`, the
 * scrubber's server-side contract (docs/06-planning-and-replanning.md §5,
 * docs/11-api-and-realtime.md §7.4).
 *
 * Integration and over a real socket, for the reason
 * `../integration/run-rollup-api.test.ts` states for the run summary: proving
 * the projection is not the same as proving an operator — or EPIC-17's
 * plan-evolution scrubber — can reach it. Two real plan versions are really
 * persisted with `persistPlanVersion`/`applyPatchedPlanVersion`, a real
 * DeFlowd binds an ephemeral port over that ledger, and every assertion is
 * against JSON that came back over `fetch`.
 *
 * Verifies: EPIC-11-S27, EPIC-11-S28 · AC3, AC4, AC5, AC6, AC7 ·
 * test plan #3, #6
 */
import type { PlanGraph, RunId, RunState } from '@DeFlow/core';
import { initialRunState, PlanGraphSchema, planHash, RunIdSchema } from '@DeFlow/core';
import {
  appendEvents,
  applyPatchedPlanVersion,
  type Db,
  type EventDraft,
  openLedger,
  pendingPatchApprovals,
  persistPlanVersion,
} from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { rulePatch } from '../../src/budget/patch-gate.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

/**
 * Every request this spec makes carries the daemon's bearer token (KAR-15.2).
 *
 * Assigned to a local `fetch` so the call sites below read the way they did
 * before the daemon authenticated anything — the token is a property of this
 * whole file, not a decision at each request.
 */
const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260809T090000Z_ac1105');
const T0 = 1_754_726_400_000;
const EPOCH = 1;
const PLANNER = { model: 'the-planner-model', effort: 'max', tier: 'strongest' } as const;

const node = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
  ...over,
});

const edge = (from: string, to: string): Record<string, unknown> => ({ from, to, kind: 'control' });

async function graph(
  version: number,
  nodes: readonly Record<string, unknown>[],
  edges: readonly Record<string, unknown>[],
  parent: string | null,
): Promise<PlanGraph> {
  const parsed = PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: version === 1 ? 'planner' : 'scheduler',
    createdAt: '2026-08-09T09:00:00.000Z',
    nodes,
    edges,
  });
  return { ...parsed, planHash: await planHash(parsed) };
}

function seedRun(db: Db, planHashValue: string): void {
  db.prepare(
    `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
        daemon_epoch)
      VALUES (?, 'running', ?, 0, '{}', 1, ?)
      ON CONFLICT(run_id) DO UPDATE SET plan_hash = excluded.plan_hash`,
  ).run(RUN, planHashValue, EPOCH);
}

const draft = (kind: string, payload: unknown, ts = T0): EventDraft =>
  ({ runId: RUN, ts, kind, v: 1, epoch: EPOCH, payload }) as EventDraft;

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

/**
 * A run whose plan has three real versions:
 *
 *   - v1: `n-recon` -> `n-impl` (control edge).
 *   - v2: an `insert-nodes` patch adds `n-probe-deps` downstream of `n-recon`.
 *   - v3: a `replace-provider` patch reroutes `n-impl` onto `codex`, with a
 *     reason carrying a newline and a double quote (AC5's own example).
 *
 * Both patches are recorded the way the real pipeline records one: a
 * `plan.patch.proposed` naming the reason, then the applied version.
 */
async function serveThreeVersionRun(tmp: string): Promise<Served> {
  const runDir = join(tmp, 'runs', RUN);
  const db = openLedger(tmp);

  const v1 = await graph(1, [node('n-recon'), node('n-impl')], [edge('n-recon', 'n-impl')], null);
  await persistPlanVersion(db, {
    runDir,
    graph: v1,
    diagnostics: [],
    by: 'planner',
    planner: PLANNER,
    ts: T0,
    epoch: EPOCH,
  });
  seedRun(db, v1.planHash);

  const insertPatch = {
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch-probe-deps',
    proposedBy: 'n-recon',
    reason: 'recon needs the dependency graph resolved before implementation starts',
    ops: [
      {
        op: 'insert-nodes',
        nodes: [node('n-probe-deps')],
        edges: [edge('n-recon', 'n-probe-deps')],
      },
    ],
    policy: {
      estimatedCostDeltaUsd: 0.1,
      estimatedWallClockDeltaMs: 0,
      blastRadius: { paths: [], nodeCount: 1 },
      replanDepth: 1,
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  };
  appendEvents(db, [
    draft('plan.patch.proposed', { patch: insertPatch, basePlanHash: v1.planHash }),
  ]);
  const v2 = await graph(
    2,
    [node('n-recon'), node('n-impl'), node('n-probe-deps')],
    [edge('n-recon', 'n-impl'), edge('n-recon', 'n-probe-deps')],
    v1.planHash,
  );
  await applyPatchedPlanVersion(db, {
    runDir,
    graph: v2,
    basePlanHash: v1.planHash,
    patchId: 'patch-probe-deps',
    decision: {
      decision: 'auto',
      by: 'policy',
      rule: 'read-only-analysis',
      at: '2026-08-09T09:00:01.000Z',
    },
    diagnostics: [],
    by: 'n-recon',
    planner: PLANNER,
    ts: T0 + 1000,
    epoch: EPOCH,
  });

  const rerouteReason =
    'node "n-impl" rerouted: claude was rate-limited\nretrying implementation on codex';
  const reroutePatch = {
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch-reroute-impl',
    proposedBy: 'scheduler',
    reason: rerouteReason,
    ops: [{ op: 'replace-provider', node: 'n-impl', provider: 'codex' }],
    policy: {
      estimatedCostDeltaUsd: null,
      estimatedWallClockDeltaMs: 0,
      blastRadius: { paths: [], nodeCount: 1 },
      replanDepth: 2,
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  };
  appendEvents(db, [
    draft(
      'plan.patch.proposed',
      { patch: reroutePatch, basePlanHash: v2.planHash, cause: 'quota' },
      T0 + 2000,
    ),
  ]);
  const v3 = await graph(
    3,
    [
      node('n-recon'),
      node('n-impl', { provider: { prefer: ['codex'], requires: [] } }),
      node('n-probe-deps'),
    ],
    [edge('n-recon', 'n-impl'), edge('n-recon', 'n-probe-deps')],
    v2.planHash,
  );
  await applyPatchedPlanVersion(db, {
    runDir,
    graph: v3,
    basePlanHash: v2.planHash,
    patchId: 'patch-reroute-impl',
    decision: {
      decision: 'auto',
      by: 'policy',
      rule: 'quota-reroute-equivalent',
      at: '2026-08-09T09:00:02.000Z',
    },
    diagnostics: [],
    by: 'scheduler',
    planner: PLANNER,
    ts: T0 + 3000,
    epoch: EPOCH,
  });

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

suite('EPIC-11-S27 — an inserted node appears as added, with its edges', () => {
  it('reports v1 -> v2 as one added node and one added edge (AC3)', async ({ tmp }) => {
    served = await serveThreeVersionRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/plans/diff?from=1&to=2`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      from: 1,
      to: 2,
      nodes: {
        added: ['n-probe-deps'],
        removed: [],
        unchanged: ['n-recon', 'n-impl'],
      },
      edges: {
        added: [{ from: 'n-recon', to: 'n-probe-deps', kind: 'control' }],
        removed: [],
      },
      unionLayoutKey: `${RUN}:union:v1-v2`,
      reason: 'recon needs the dependency graph resolved before implementation starts',
      decision: 'auto',
    });
  });
});

suite('EPIC-11-S27 — a provider change is a field-level patch, not a remove plus add', () => {
  it('reports v2 -> v3 as a changed node with a /provider replace op (AC3, AC6)', async ({
    tmp,
  }) => {
    served = await serveThreeVersionRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/plans/diff?from=2&to=3`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: { added: string[]; removed: string[]; changed: { id: string; patch: unknown[] }[] };
      reason: string;
      decision: string;
      unionLayoutKey: string;
    };

    expect(body.nodes.added).toEqual([]);
    expect(body.nodes.removed).toEqual([]);
    const changed = body.nodes.changed.find((entry) => entry.id === 'n-impl');
    expect(changed).toBeDefined();
    expect(changed?.patch).toEqual([{ op: 'replace', path: '/provider/prefer/0', value: 'codex' }]);
    expect(body.unionLayoutKey).toBe(`${RUN}:union:v2-v3`);
    expect(body.decision).toBe('auto');
  });

  it('carries the reason byte-identical, newline and double quote included (AC5)', async ({
    tmp,
  }) => {
    served = await serveThreeVersionRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/plans/diff?from=2&to=3`);
    const body = (await response.json()) as { reason: string };

    expect(body.reason).toBe(
      'node "n-impl" rerouted: claude was rate-limited\nretrying implementation on codex',
    );
  });
});

suite('GET /api/runs/:id/plans/diff — the edges the route table has to refuse', () => {
  it('404s a run the directory does not hold', async ({ tmp }) => {
    served = await serveThreeVersionRun(tmp);

    const response = await fetch(
      `${served.origin}/api/runs/run_20260809T090000Z_ffffff/plans/diff?from=1&to=2`,
    );
    expect(response.status).toBe(404);
  });

  it('404s a version this run never proposed', async ({ tmp }) => {
    served = await serveThreeVersionRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/plans/diff?from=1&to=99`);
    expect(response.status).toBe(404);
  });

  it('400s a request with no from/to', async ({ tmp }) => {
    served = await serveThreeVersionRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/plans/diff`);
    expect(response.status).toBe(400);
  });
});

// ── EPIC-11-S28 — a rejected patch is still part of the history ─────────────

suite('EPIC-11-S28 — a rejected patch produces no new version, but stays retrievable', () => {
  it('leaves the diff at the version it was already on, and names the rule that refused it', async ({
    tmp,
  }) => {
    served = await serveThreeVersionRun(tmp);
    const db = served.db;

    // Any patch is rejected once the run's replan depth already exceeds the
    // rule's threshold — `replanDepth` is `state.planVersion`, and this run is
    // already at v3, past `MAX_REPLAN_DEPTH` (3)'s "> 3" once one more patch
    // would-be v4 is not itself over — so seed the state a rule further along
    // than a real run would ever legitimately need to go, forcing the rejection
    // deterministically rather than depending on a specific cost figure.
    // `initialRunState()` supplies every field `rulePatch`'s estimator and
    // policy engine read that this scenario is not about, so only what the
    // rule actually keys on is overridden.
    const overDepth: RunState = { ...initialRunState(), runId: RUN, planVersion: 4 };

    const rejectedPatch = {
      schemaId: 'DeFlow.planpatch.v1',
      id: 'patch-over-depth',
      proposedBy: 'planner',
      reason: 'one replan too many — proposed anyway to prove the rejection is on the log',
      ops: [{ op: 'insert-nodes', nodes: [node('n-extra')], edges: [] }],
      policy: {
        estimatedCostDeltaUsd: 0.1,
        estimatedWallClockDeltaMs: 0,
        blastRadius: { paths: [], nodeCount: 1 },
        replanDepth: 4,
        escalatesPermission: null,
        addsWriteCapability: false,
      },
    };

    // The real pipeline logs the proposal before ruling on it (`mcp/host.ts`);
    // `pendingPatchApprovals` joins the rejection back onto that proposal, so
    // a rejection with no logged proposal is not what this run would produce.
    appendEvents(db, [draft('plan.patch.proposed', { patch: rejectedPatch })]);

    const ruling = rulePatch(db, {
      runId: RUN,
      state: overDepth,
      patch: rejectedPatch,
      estimator: {
        tokenizer: o200kTokenizer(),
        accounting: () => 'exact',
        family: () => 'anthropic',
        calibration: () => ({ n: 0, ratio: 1 }),
        countFiles: () => 0,
      },
      now: T0 + 4000,
    });

    expect(ruling.decision).toBe('reject');
    expect(ruling.ruleId).toBe('replan-depth-exceeded');

    // No new version: the diff endpoint still answers v2 -> v3 the same way,
    // and there is nothing at v4 to ask for.
    const missing = await fetch(`${served.origin}/api/runs/${RUN}/plans/diff?from=3&to=4`);
    expect(missing.status).toBe(404);

    // The rejection itself is retrievable, with the rule that fired.
    const pending = pendingPatchApprovals(db, RUN);
    const rejected = pending.find((entry) => entry.patchId === 'patch-over-depth');
    expect(rejected).toMatchObject({
      status: 'rejected',
      rule: 'replan-depth-exceeded',
      by: 'policy',
    });
    expect(rejected?.patch.reason).toBe(
      'one replan too many — proposed anyway to prove the rejection is on the log',
    );
  });
});
