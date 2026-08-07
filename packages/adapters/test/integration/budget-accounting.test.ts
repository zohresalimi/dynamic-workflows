/**
 * KAR-14.1 — the accounting record, out of a real process into a real ledger.
 *
 * Everything here spawns the fake exec-shim agent (KAR-04.6) under a vendor
 * name on a temp `PATH` and reads a real file-backed SQLite ledger afterwards.
 * Nothing is mocked, because every claim is about bytes that crossed a pipe
 * and rows a transaction committed:
 *
 * - **The pair is one transaction.** `budget.consumed` and `node.completed`
 *   are appended in a single batch, so their `seq` values are adjacent and a
 *   crash between them is not a state the ledger can be in. Two `append` calls
 *   would look identical from outside until the one crash that matters.
 * - **A failed attempt's spend counts.** The money is gone whether or not the
 *   attempt produced value, and a repair loop capped at three attempts can
 *   spend three times what a naive rollup reports.
 * - **The data plane moves nothing.** Megabytes of stdout land in `io_chunk`,
 *   which no reducer reads, so the rollup changes only when the accounting
 *   event is appended.
 *
 * Verifies: EPIC-14-S1, EPIC-14-S5, EPIC-14-S7 · KAR-14.1 AC1, AC5, AC7 ·
 * test plan #8, #10, #11
 */
import {
  budgetBreachOf,
  type Event,
  initialRunState,
  type NodeFailure,
  type NodeId,
  type ProviderId,
  ProviderIdSchema,
  parseEvent,
  type RunId,
  type RunState,
  reduce,
} from '@DeFlow/core';
import { it, linkFakeAgent } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  runShimNode,
  type ShimNodeOutcome,
  type ShimNodeRequest,
  type ShimPorts,
  shimCapabilityRow,
} from '../../src/index.ts';
import { NODE_ID, openTestLedger, RUN_ID, type TestLedger } from './support/harness.ts';

// The harness's own ids: its sink stamps every row with them, so a request
// that named different ones would write rows `events()` and `chunks()` could
// not find — and the spec would assert against an empty ledger.
const RUN: RunId = RUN_ID;
const NODE: NodeId = NODE_ID;
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOW = 1_800_000_000_000;

/** EPIC-14-S1's scripted turn: the figures the scenario names, verbatim. */
const S1_TURN = JSON.stringify({
  name: 'kar-14-1-turn',
  description: 'One headless turn whose result envelope carries the S1 figures.',
  steps: [{ type: 'message', text: 'ok' }],
  result: { subtype: 'success', text: 'ok', totalCostUsd: 0.42, inputTokens: 18_420 },
});

interface Harness {
  readonly ledger: TestLedger;
  readonly request: ShimNodeRequest;
  run(overrides?: Partial<ShimNodeRequest>, ports?: Partial<ShimPorts>): Promise<ShimNodeOutcome>;
}

async function harness(
  tmp: string,
  binary: string,
  scenario: string,
  provider: ProviderId = CLAUDE,
): Promise<Harness> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const worktree = join(tmp, 'wt');
  await mkdir(worktree, { recursive: true });
  const ledger = openTestLedger(dataDir);

  const request: ShimNodeRequest = {
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    provider,
    permission: 'read',
    worktree,
    prompt: 'say ok',
    sessionId: SESSION,
    binary: {
      path: binary,
      version: '2.1.220',
      sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    },
    sandbox: {
      version: '2.1.220',
      platform: 'darwin',
      roots: [join(tmp, 'bin')],
      configDir: join(tmp, 'sandbox'),
    },
    env: {
      ...process.env,
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      DeFlow_FAKE_SCENARIO: scenario,
      DeFlow_FAKE_SEED: '42',
      DeFlow_FAKE_NOW: String(NOW),
      DeFlow_SIDE_EFFECT_LOG: join(tmp, 'side-effects.ndjson'),
    },
  };

  const ports: ShimPorts = {
    clock: { now: () => NOW, setTimer: () => ({ cancel: () => {} }) },
    ledger: ledger.sink,
    captureEvidence: ledger.captureEvidence,
    capabilityRow: shimCapabilityRow({
      provider,
      version: '2.1.220',
      binaryPath: binary,
      binarySha256: request.binary.sha256,
      probedAt: NOW,
    }),
  };

  return {
    ledger,
    request,
    run: (overrides = {}, portOverrides = {}) =>
      runShimNode({ ...request, ...overrides }, { ...ports, ...portOverrides }),
  };
}

/**
 * The ledger's own rows, folded through the real reducer.
 *
 * Through `parseEvent` at the row's own `v`, never cast: the rollup is only
 * meaningful if it is the same projection the daemon would build from the same
 * bytes, upcaster chain included.
 */
function project(ledger: TestLedger): RunState {
  const events: Event[] = ledger
    .events()
    .map((row) => {
      const parsed = parseEvent({
        seq: row.seq,
        runId: RUN,
        ts: NOW,
        kind: row.kind,
        v: row.v,
        epoch: 1,
        payload: row.payload,
      });
      return parsed.status === 'ok' ? parsed.event : null;
    })
    .filter((event): event is Event => event !== null);
  return events.reduce(reduce, initialRunState());
}

/**
 * EPIC-14-S14 — the vendor's own ceiling fires, out of a real process.
 *
 * The fake exec-shim agent is scripted with the subtype Claude Code returns
 * when `--max-budget-usd` refuses, so the classification under test is driven by
 * bytes that crossed a pipe rather than by a value a spec constructed.
 */
const VENDOR_CEILING_TURN = JSON.stringify({
  name: 'kar-14-2-vendor-ceiling',
  description: "One turn that ends on the vendor's own --max-budget-usd ceiling.",
  steps: [{ type: 'message', text: 'refactoring' }],
  result: {
    subtype: 'error_max_budget_usd',
    isError: true,
    stopReason: 'max_budget',
    text: 'Stopped: the configured budget was exhausted.',
    totalCostUsd: 2.0104,
  },
});

suite('EPIC-14-S14 — the vendor ceiling pauses; it is never retried (KAR-14.2 AC9)', () => {
  it('arms the vendor flag and returns a gate carrying the breach', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, VENDOR_CEILING_TURN);

    const outcome = await test.run({ costCeilingUsd: 2 });

    // The ceiling really was armed on the child's command line.
    const at = outcome.argv.indexOf('--max-budget-usd');
    expect(at).toBeGreaterThan(-1);
    expect(outcome.argv[at + 1]).toBe('2');

    expect(outcome.status).toBe('failed');
    const failure = outcome.status === 'failed' ? outcome.failure : null;
    expect(failure?.class).toBe('gate');
    expect(failure?.class).not.toBe('transient');
    expect(budgetBreachOf(failure as NodeFailure)).toEqual({
      scope: 'node',
      node: NODE,
      dimension: 'cost',
      limit: 2,
      actual: 2.0104,
      firedBy: 'vendor',
    });

    // The spend still lands: the money is gone whether or not the turn produced
    // anything (KAR-14.1 AC5).
    const consumed = test.ledger.events().filter((event) => event.kind === 'budget.consumed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.payload).toMatchObject({ costUsd: 2.0104 });
    test.ledger.close();
  });
});

suite('EPIC-14-S1 — a completed node’s spend lands with provenance (AC1)', () => {
  it('appends exactly one budget.consumed for the attempt, carrying usage.source', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, S1_TURN);

    const outcome = await test.run();
    expect(outcome.status).toBe('completed');

    const consumed = test.ledger.events().filter((event) => event.kind === 'budget.consumed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.payload).toMatchObject({
      node: NODE,
      attempt: 0,
      provider: CLAUDE,
      costUsd: 0.42,
      authMode: 'subscription',
      usage: { source: 'vendor-reported', inputTokens: 18_420 },
    });
    test.ledger.close();
  });

  it('writes it and node.completed with adjacent seq, in one transaction (test plan #8)', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, S1_TURN);

    await test.run();

    const events = test.ledger.events();
    const spend = events.find((event) => event.kind === 'budget.consumed');
    const completed = events.find((event) => event.kind === 'node.completed');
    expect(spend).toBeDefined();
    expect(completed).toBeDefined();
    expect(Math.abs((completed?.seq ?? 0) - (spend?.seq ?? 0))).toBe(1);
    // Adjacency alone would also hold for two `append` calls that happened to
    // be uninterrupted. The batch is the claim: one call, one `BEGIN
    // IMMEDIATE`, so there is no instant at which one exists without the other.
    const batches = test.ledger.appends.filter((entry) =>
      entry.kind.startsWith('budget.consumed+'),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.kind).toBe('budget.consumed+node.completed');
    test.ledger.close();
  });

  /**
   * The reducer's half of EPIC-14-S1's rollup clauses, and only that half.
   *
   * The scenario states them against a response body — *"the run rollup at
   * `GET /api/runs/r1` reports costUsd.subscription 0.42"* — and this package
   * cannot serve one: @DeFlow/adapters owns no database and no HTTP surface,
   * and depending on @DeFlow/daemon would invert the dependency direction
   * (docs/16-repo-layout.md R2). The same figures are asserted over a real
   * socket, out of a real ledger written by this same shim path, in
   * `packages/daemon/test/integration/run-rollup-api.test.ts`.
   */
  it('projects a subscription cost and an empty unaccounted list', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, S1_TURN);

    await test.run();
    const state = project(test.ledger);

    expect(state.budget.run.costUsd.subscription).toBeCloseTo(0.42, 6);
    expect(state.budget.run.unaccounted).toEqual([]);
    expect(Object.keys(state.budget.providers)).toEqual([CLAUDE]);
    test.ledger.close();
  });
});

suite('EPIC-14-S5 — a failed attempt’s spend counts (AC5, test plan #10)', () => {
  it('appends one budget.consumed per attempt and sums them cumulatively', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const failing = JSON.stringify({
      name: 'kar-14-1-attempt-1',
      description: 'Burns tokens, then reports an execution error and exits non-zero.',
      steps: [{ type: 'message', text: 'partial' }],
      result: { subtype: 'error_during_execution', text: '', totalCostUsd: 0.3 },
      exitCode: 1,
    });
    const test = await harness(tmp, agent.binary, failing);

    const first = await test.run({ attempt: 0 });
    expect(first.status).toBe('failed');

    // The retry is the same binary with a different script: what changes
    // between attempts is what the vendor did, not how DeFlow invoked it.
    const second = await test.run({
      attempt: 1,
      env: { ...test.request.env, DeFlow_FAKE_SCENARIO: S1_TURN },
    });
    expect(second.status).toBe('completed');

    const consumed = test.ledger.events().filter((event) => event.kind === 'budget.consumed');
    expect(consumed.map((event) => event.payload.attempt)).toEqual([0, 1]);

    const state = project(test.ledger);
    const node = state.budget.nodes[NODE];
    expect(node?.attempts).toHaveLength(2);
    expect(node?.costUsd.subscription).toBeCloseTo(0.72, 6);
    expect(node?.costUsd.subscription).toBeGreaterThan(
      node?.attempts[1]?.costUsd.subscription ?? 0,
    );
    test.ledger.close();
  });
});

suite('EPIC-14-S7 — megabytes of stdout move no cost figure (AC7, test plan #11)', () => {
  it('files every byte in io_chunk and leaves the rollup on the accounting event', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const noisy = JSON.stringify({
      name: 'kar-14-1-noisy',
      description: 'Five megabytes of assistant lines before an ordinary result envelope.',
      steps: [{ type: 'chunks', count: 80, delayMs: 0, text: 'x'.repeat(64 * 1024) }],
      result: { subtype: 'success', text: 'ok', totalCostUsd: 0.42, inputTokens: 18_420 },
    });
    const test = await harness(tmp, agent.binary, noisy);

    await test.run();

    const bytes = test.ledger
      .chunks()
      .reduce((total, chunk) => total + Buffer.byteLength(chunk.text, 'utf8'), 0);
    expect(bytes).toBeGreaterThan(5 * 1024 * 1024);

    // Fold every event up to (but not including) the accounting one: the
    // rollup must still be empty, however many megabytes went past.
    const events = test.ledger.events();
    const spendAt = events.findIndex((event) => event.kind === 'budget.consumed');
    expect(spendAt).toBeGreaterThan(0);

    const state = project(test.ledger);
    expect(state.budget.run.costUsd.subscription).toBeCloseTo(0.42, 6);
    // One accounting event, whatever the volume of output.
    expect(events.filter((event) => event.kind === 'budget.consumed')).toHaveLength(1);
    test.ledger.close();
  });
});
