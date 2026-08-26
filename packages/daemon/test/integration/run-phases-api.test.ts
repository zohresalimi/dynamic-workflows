/**
 * KAR-28.5 AC3 — the phases projection an operator can actually reach, and the
 * restart it has to survive.
 *
 * Folding a plan through `runPhases()` in a unit spec proves the arithmetic; it
 * proves nothing about whether a surface can ask for the answer, and nothing at
 * all about EPIC-28-S22 — *"the daemon killed and restarted … it answers
 * identically, because it is a fold over the ledger rather than in-memory
 * state"*. That sentence is only checkable across two daemon lives over one
 * directory, which is what this file is: a real file-backed ledger, a real
 * DeFlowd bound to a real port, `shutdown()`, and a second DeFlowd over the same
 * bytes.
 *
 * The seeded run ends with `run.completed` on purpose. A run left mid-flight
 * would be picked up by the second daemon's own recovery and drive, and the two
 * bodies would then differ because the *run* moved — which would look exactly
 * like the projection failing to be a fold. An ended run isolates the claim
 * under test.
 *
 * The second assertion is the other half of AC3: `phases` is a **field of the
 * existing run summary**, not a resource of its own. `docs/11-api-and-realtime.md`
 * §6 has one run-scoped rollup and ADR 0012 explains why a second polling
 * endpoint for a projection is the wrong shape.
 *
 * Verifies: EPIC-28-S20, EPIC-28-S22 · KAR-28.5 AC1, AC3
 */
import { appendEvents, type EventDraft, openLedger } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';

const fetch = authorizedFetch();

const RUN = 'run_20260826T090000Z_28c500';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const T0 = 1_787_000_000_000;

const SPEC: Record<string, unknown> = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);
const SPEC_HASH = String(SPEC.specHash);

const RETRY = { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } };

const BASE = {
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: RETRY,
  budget: {},
};

const agent = (id: string, title: string, deps: readonly string[]): Record<string, unknown> => ({
  ...BASE,
  id,
  title,
  deps: [...deps],
  type: 'agent',
  brief: `brief for ${id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

/**
 * One fan-out, one template that never runs, one gate nothing has touched.
 *
 * The three shapes the projection has to keep apart in one plan: a step that is
 * its own work, a step whose work is the children materialised from it, and a
 * step with no recorded work at all.
 */
const PLAN: Record<string, unknown> = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-26T09:00:00.000Z',
  nodes: [
    agent('recon', 'Survey the legacy views', []),
    {
      ...BASE,
      id: 'migrate',
      title: 'Migrate every legacy view',
      deps: ['recon'],
      type: 'map',
      over: { kind: 'fact', key: 'finding/legacy-views' },
      concurrency: 4,
      body: 'migrate-one',
      itemIdFrom: 'value-hash',
    },
    agent('migrate-one', 'Migrate one legacy view', ['recon']),
    agent('migrate--alpha', 'Migrate alpha.vue', ['migrate']),
    agent('migrate--beta', 'Migrate beta.vue', ['migrate']),
    agent('migrate--gamma', 'Migrate gamma.vue', ['migrate']),
    {
      ...BASE,
      id: 'gate-typecheck',
      title: 'The project typechecks',
      deps: ['migrate'],
      type: 'gate',
      gate: { kind: 'deterministic', gateId: 'typecheck' },
      criteria: [],
      independence: { notSessionOf: [], preferDifferentProvider: true },
    },
  ],
  edges: [
    { from: 'recon', to: 'migrate', kind: 'control' },
    { from: 'migrate', to: 'gate-typecheck', kind: 'control' },
  ],
};

const COMPLETED = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.25,
  producedFacts: [],
  artifacts: [],
};

/** The run as a previous daemon left it: two of three children done, then over. */
function seedRun(dataDir: string): void {
  const drafts: EventDraft[] = [];
  const push = (kind: string, v: number, payload: unknown): void => {
    drafts.push({
      runId: RUN as never,
      ts: T0 + drafts.length * 1000,
      kind,
      v,
      epoch: 1,
      payload,
    });
  };

  push('run.created', 1, {
    spec: SPEC,
    cwd: '/tmp/deflow-phases/repo',
    repo: { head: 'a1b2c3d', branch: 'main' },
  });
  push('run.spec.approved', 1, { specHash: SPEC_HASH, by: 'ui' });
  push('plan.proposed', 2, { version: 1, planHash: PLAN_HASH, graph: PLAN, by: 'planner' });
  push('run.started', 1, { planHash: PLAN_HASH });

  for (const node of ['recon', 'migrate--alpha', 'migrate--beta']) {
    push('node.scheduled', 1, { node, provider: 'claude-code', permission: 'read' });
    push('node.started', 2, {
      node,
      attempt: 0,
      ikey: `${RUN}/${node}/0/0`,
      binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: 'd'.repeat(64) },
    });
    push('node.completed', 1, { node, attempt: 0, result: COMPLETED });
  }

  // `migrate--gamma` and the gate never ran, and the run ended anyway. The
  // projection reports what is there, not what was planned to be there.
  push('run.completed', 1, { outcome: 'succeeded', criteriaSatisfied: [] });

  const db = openLedger(dataDir);
  try {
    appendEvents(db, drafts);
  } finally {
    db.close();
  }
}

interface PhaseRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly state: string;
  readonly completed: number;
  readonly total: number;
  readonly nodes: readonly string[];
}

interface SummaryBody {
  readonly phases?: { readonly basis: string; readonly phases: readonly PhaseRow[] };
}

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

async function start(dataDir: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  const daemon = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  booted = daemon;
  const address = daemon.http.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await daemon.shutdown();
      booted = undefined;
    },
  };
}

const summary = async (origin: string): Promise<SummaryBody> =>
  (await (await fetch(`${origin}/api/runs/${RUN}`)).json()) as SummaryBody;

suite('EPIC-28-S20 — the run summary carries the run’s own shape', () => {
  it('answers ordered phases, their state and their counts on GET /api/runs/:id (AC1, AC3)', async ({
    tmp,
  }) => {
    seedRun(tmp);
    const daemon = await start(tmp);

    const body = await summary(daemon.origin);
    expect(body.phases?.basis).toBe('plan');
    expect(body.phases?.phases).toEqual([
      {
        id: 'recon',
        title: 'Survey the legacy views',
        type: 'agent',
        state: 'complete',
        completed: 1,
        total: 1,
        nodes: ['recon'],
      },
      {
        id: 'migrate',
        title: 'Migrate every legacy view',
        type: 'map',
        state: 'running',
        completed: 2,
        total: 3,
        nodes: ['migrate--alpha', 'migrate--beta', 'migrate--gamma'],
      },
      {
        id: 'gate-typecheck',
        title: 'The project typechecks',
        type: 'gate',
        state: 'pending',
        completed: 0,
        total: 1,
        nodes: ['gate-typecheck'],
      },
    ]);
  });

  it('has no endpoint of its own — the projection is a field of the run (AC3)', async ({ tmp }) => {
    seedRun(tmp);
    const daemon = await start(tmp);

    const direct = await fetch(`${daemon.origin}/api/runs/${RUN}/phases`);
    expect(direct.status).toBe(404);
  });
});

suite('EPIC-28-S22 — phases survive a restart', () => {
  it('answers identically after the daemon is stopped and started again (AC3)', async ({ tmp }) => {
    seedRun(tmp);

    const first = await start(tmp);
    const before = await summary(first.origin);
    await first.stop();

    const second = await start(tmp);
    const after = await summary(second.origin);

    expect(after.phases).toEqual(before.phases);
    // And it is not merely equal-because-empty: the run really has phases.
    expect(after.phases?.phases).toHaveLength(3);
  });
});
