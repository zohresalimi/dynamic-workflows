/**
 * EPIC-14-S15 — the operator sees the cost before approving the spec
 * (KAR-14.3 AC2, AC3, AC9).
 *
 * The unit specs prove the estimator is arithmetic and that the summary carries
 * its answer. What neither can prove is the claim the scenario actually makes:
 * that the figure is on **`GET /api/runs/:id` before `run.started` exists**, is
 * produced by the real Tier-2 tokenizer rather than a stub, and carries the
 * factor and sample count that a real `token_calibration` row holds. So this
 * runs the real `o200kTokenizer` over a real plan, against a real file-backed
 * ledger, through the real route.
 *
 * The calibration row is built by folding twenty-four real samples through
 * `recordTokenSample` rather than by writing a row: a hand-written row could
 * hold an `n` and a ratio the EWMA can never produce, and the point of the
 * assertion is that the number an operator reads is the number the loop learned.
 *
 * Verifies: EPIC-14-S15 · KAR-14.3 AC2, AC3, AC9 · test plan #9
 */
import { type RunId, RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger, recordTokenSample } from '@DeFlow/ledger';
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

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ae91c2');
const T0 = 1_754_560_000_000;

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const MODEL = 'claude-sonnet-4-5';
/** The ratio EPIC-14-S15 names, and the one twenty-four samples of it produce. */
const TRUE_RATIO = 1.18;
const SAMPLES = 24;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const node = (id: string, model: string | null): Record<string, unknown> => ({
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
  brief: `investigate the ${id} surface and report what the migration touches`,
  provider: { prefer: ['claude'], requires: [] },
  ...(model === null ? {} : { model }),
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

/** A validated four-node plan and a learned calibration, with nothing started. */
function seed(dataDir: string, model: string | null): void {
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      draft('run.created', {
        spec: taskSpec,
        cwd: '/home/u/proj',
        repo: { head: 'e83c516', branch: 'main' },
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
          createdAt: '2026-08-07T10:15:00.000Z',
          nodes: ['n-recon', 'n-impl', 'n-review', 'n-docs'].map((id) => node(id, model)),
          edges: [],
        },
        by: 'planner',
      }),
    ]);

    // Twenty-four turns whose vendor-reported input count really was 1.18x
    // DeFlow's own estimate. The first seeds, the rest hold it there.
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      recordTokenSample(db, {
        provider: 'claude',
        model: model ?? 'unused',
        family: 'anthropic',
        estimated: 1000,
        actual: 1180,
        now: T0 + sample,
      });
    }
  } finally {
    db.close();
  }
}

interface Served {
  readonly origin: string;
  close(): Promise<void>;
}

async function serve(tmp: string, model: string | null = MODEL): Promise<Served> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  seed(dataDir, model);

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

interface Figure {
  readonly node: string;
  readonly method: string;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly calibration: {
    readonly tokenEstimateFactor: number;
    readonly samples: number;
    readonly seedBased: boolean;
  } | null;
}

interface Summary {
  readonly status: string;
  readonly estimate: {
    readonly costUsd: number | null;
    readonly method: string;
    readonly priceTableVersion: string;
    readonly nodes: readonly Figure[];
  } | null;
  readonly budget: { readonly run: { readonly costUsd: Record<string, number | null> } };
}

const summaryOf = async (served: Served): Promise<Summary> => {
  const response = await fetch(`${served.origin}/api/runs/${RUN}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Summary;
};

suite('the whole-plan estimate is on the spec-approval surface', () => {
  it('is served before run.started exists', async ({ tmp }) => {
    const served = await serve(tmp);
    open.push(served);

    const summary = await summaryOf(served);

    expect(summary.status).toBe('created');
    expect(summary.estimate?.nodes).toHaveLength(4);
    expect(summary.estimate?.costUsd).toBeGreaterThan(0);
  });

  it('carries the real Tier-2 method on every figure (AC2)', async ({ tmp }) => {
    const served = await serve(tmp);
    open.push(served);

    const summary = await summaryOf(served);

    expect(summary.estimate?.method).toBe('gpt-tokenizer/o200k_base');
    for (const figure of summary.estimate?.nodes ?? []) {
      expect(figure.method).toBe('gpt-tokenizer/o200k_base');
      expect(figure.inputTokens).toBeGreaterThan(0);
    }
  });

  it('records the factor and sample count that were actually applied (AC2)', async ({ tmp }) => {
    const served = await serve(tmp);
    open.push(served);

    const summary = await summaryOf(served);

    for (const figure of summary.estimate?.nodes ?? []) {
      expect(figure.calibration?.samples).toBe(SAMPLES);
      expect(figure.calibration?.tokenEstimateFactor).toBeCloseTo(TRUE_RATIO, 6);
      expect(figure.calibration?.seedBased).toBe(false);
    }
  });

  it('names the price table that produced it, so it can be re-derived later', async ({ tmp }) => {
    const served = await serve(tmp);
    open.push(served);

    expect((await summaryOf(served)).estimate?.priceTableVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never renders an estimate as billing truth (AC9)', async ({ tmp }) => {
    const served = await serve(tmp);
    open.push(served);

    const summary = await summaryOf(served);

    // Nothing has run. The rollup says so — all four cells blank — while the
    // estimate beside it says what the plan will cost, in a different key with
    // its own method label. Two figures, two channels, both labelled.
    expect(summary.budget.run.costUsd).toEqual({
      subscription: null,
      apiKey: null,
      vendorReported: null,
      estimated: null,
    });
    expect(summary.estimate?.costUsd).not.toBeNull();
  });

  it('answers null, not a number, for a plan whose model nobody named', async ({ tmp }) => {
    const served = await serve(tmp, null);
    open.push(served);

    const summary = await summaryOf(served);

    expect(summary.estimate?.costUsd).toBeNull();
    for (const figure of summary.estimate?.nodes ?? []) {
      expect(figure.costUsd).toBeNull();
      // …and the tokens are still counted: a blank cost cell is not a blank row.
      expect(figure.inputTokens).toBeGreaterThan(0);
    }
  });
});
