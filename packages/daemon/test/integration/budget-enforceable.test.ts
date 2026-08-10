/**
 * EPIC-14-S13 — DeFlow does not claim a ceiling it cannot measure (KAR-14.2 AC8).
 *
 * A provider whose capability manifest says `tokenAccounting: 'none'`
 * contributes a **blank** cost cell rather than a zero (KAR-14.1). That is the
 * honest answer, and it has a consequence nobody would guess from the rollup
 * alone: a `costUsd` ceiling over such a provider can never fire, because the
 * figure it is compared against never moves. Refusing to run would be
 * over-strict — the operator may not care, or may be measuring the other four
 * providers — so the answer is to say so **loudly and early**, while swapping
 * the provider is still one edit away.
 *
 * Early is the load-bearing word, and it is why this spec asserts against a
 * response body served before `run.started` exists: a marker that only appeared
 * once the run was under way would be a report of money already spent.
 *
 * Verifies: EPIC-14-S13 · KAR-14.2 AC8 · test plan #11
 */
import { type RunId, RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

/**
 * Every request this spec makes carries the daemon's bearer token (KAR-15.2).
 *
 * Assigned to a local `fetch` so the call sites below read the way they did
 * before the daemon authenticated anything — the token is a property of this
 * whole file, not a decision at each request.
 */
const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260806T120000Z_bd4417');
const T0 = 1_754_474_400_000;

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const CEILING_HASH = `sha256-${'e'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/** One agent node routed at a named provider. */
const node = (id: string, provider: string): Record<string, unknown> => ({
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
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: [provider], requires: [] },
  resume: 'always-replay',
});

const draft = (kind: string, payload: unknown, v = 1): EventDraft => ({
  runId: RUN,
  ts: T0,
  kind,
  v,
  epoch: 1,
  payload,
});

/**
 * A run whose plan is validated and whose ceilings are pinned, with no
 * `run.started` anywhere: this is the spec-approval surface.
 */
function seedValidatedRun(dataDir: string, providers: readonly string[]): void {
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      draft('run.created', {
        spec: taskSpec,
        cwd: '/home/u/proj',
        repo: { head: 'e83c516', branch: 'main' },
      }),
      draft('budget.ceiling.set', {
        scope: 'run',
        costUsd: 25,
        wallclockMs: 14_400_000,
        source: 'request',
        hash: CEILING_HASH,
      }),
      draft('plan.proposed', {
        version: 1,
        planHash: PLAN_HASH,
        graph: {
          schemaId: 'DeFlow.plangraph.v1',
          runId: RUN,
          version: 1,
          planHash: PLAN_HASH,
          parent: null,
          taskSpecHash: SPEC_HASH,
          createdBy: 'planner',
          createdAt: '2026-08-06T12:00:00.000Z',
          nodes: providers.map((provider, index) => node(`n-x${index}`, provider)),
          edges: [],
        },
        by: 'planner',
      }),
    ]);
  } finally {
    db.close();
  }
}

interface Served {
  readonly origin: string;
  close(): Promise<void>;
}

async function serve(tmp: string, providers: readonly string[]): Promise<Served> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  seedValidatedRun(dataDir, providers);

  const view = openLedgerView(dataDir);
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
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
    },
  };
}

const open: Served[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((served) => served.close()));
});

const summaryOf = async (served: Served): Promise<Record<string, unknown>> => {
  const response = await fetch(`${served.origin}/api/runs/${RUN}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

suite('a cost ceiling over a provider that reports nothing', () => {
  it('is reported unenforceable, naming the provider and the node', async ({ tmp }) => {
    // `gemini` is registered with no accounting fidelity at all, which is
    // exactly the situation: DeFlow cannot price its turns.
    const served = await serve(tmp, ['gemini']);
    open.push(served);

    const summary = await summaryOf(served);

    expect(summary.budgetEnforceable).toBe(false);
    expect(summary.budgetEnforceability).toEqual({
      cost: false,
      // The wall-clock ceiling is measured by DeFlow's own clock and is
      // enforceable no matter what a vendor reports.
      wallclock: true,
      unmeasurable: [{ provider: 'gemini', nodes: ['n-x0'] }],
    });
  });

  it('says so before run.started exists, which is the whole point', async ({ tmp }) => {
    const served = await serve(tmp, ['gemini']);
    open.push(served);

    const summary = await summaryOf(served);

    expect(summary.status).toBe('created');
    expect(summary.budgetEnforceable).toBe(false);
  });

  it('is enforceable when every scheduled provider reports exact figures', async ({ tmp }) => {
    const served = await serve(tmp, ['claude', 'codex']);
    open.push(served);

    const summary = await summaryOf(served);

    expect(summary.budgetEnforceable).toBe(true);
    expect(summary.budgetEnforceability).toEqual({
      cost: true,
      wallclock: true,
      unmeasurable: [],
    });
  });
});
