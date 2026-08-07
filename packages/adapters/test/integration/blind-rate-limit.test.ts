/**
 * KAR-14.4 — EPIC-14-S27: an adapter with no structured rate-limit signal
 * degrades to blind backoff, honestly labelled.
 *
 * The temptation this spec exists to refuse is inventing a plausible reset time
 * so a surface has something to render. A fabricated reset is worse than an
 * honest gap for exactly the reason a fabricated compaction "after" number is:
 * the operator schedules their afternoon around it.
 *
 * `rateLimitExitCodes` is data supplied by the caller and empty by default,
 * which is also a claim rather than an oversight. As of the 2026-08-02 probe no
 * vendor has published an exit code that *means* "rate limited" — so DeFlow
 * ships none and guesses none, and the degradation path is real code with no
 * fabricated table behind it. The fake agent supplies one here because that is
 * what a scenario is for.
 *
 * A real child process, a real file-backed ledger, no mocks.
 *
 * Verifies: EPIC-14-S27 · AC1, AC6, AC9, AC10
 */
import {
  describeRateLimit,
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
  rateLimitOf,
} from '@DeFlow/core';
import { it, linkFakeAgent } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  type NodeWakeRow,
  runShimNode,
  type ShimNodeOutcome,
  type ShimNodeRequest,
  type ShimPorts,
  shimCapabilityRow,
} from '../../src/index.ts';
import { openTestLedger, type TestLedger } from './support/harness.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T101500Z_ac0509');
const NODE: NodeId = NodeIdSchema.parse('n1');
/**
 * EPIC-14-S27 names `opencode`, as an example of an adapter that reports no
 * structured rate-limit frame. The spec runs on `claude`'s shim instead, and
 * the substitution costs nothing: the degradation path in `runShimNode` is
 * provider-independent — it fires on an exit code the *caller* declared, with
 * no vendor named in the code — and `claude` is the one shim provider that
 * carries its own sandbox settings, so a spec about a rate limit stays about a
 * rate limit rather than about installing `srt` on the runner. What makes this
 * the S27 case is the scenario: an agent that writes nothing at all and exits.
 */
const PROVIDER: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const NOW = 1_800_000_000_000;

/** The code this provider's adapter is told means "rate limited". */
const RATE_LIMIT_EXIT = 77;

interface Harness {
  readonly ledger: TestLedger;
  readonly wakes: NodeWakeRow[];
  run(overrides?: Partial<ShimNodeRequest>): Promise<ShimNodeOutcome>;
}

async function harness(tmp: string, binary: string, exitCode: number): Promise<Harness> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const worktree = join(tmp, 'wt');
  await mkdir(worktree, { recursive: true });
  const ledger = openTestLedger(dataDir);
  const wakes: NodeWakeRow[] = [];
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');

  const request: ShimNodeRequest = {
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    provider: PROVIDER,
    permission: 'read',
    worktree,
    prompt: 'say ok',
    sessionId: SESSION,
    binary: { path: binary, version: '2.1.220', sha256 },
    sandbox: {
      version: '2.1.220',
      platform: 'darwin',
      roots: [join(tmp, 'bin')],
      configDir: join(tmp, 'sandbox'),
    },
    rateLimitExitCodes: [RATE_LIMIT_EXIT],
    env: {
      ...process.env,
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      // No output at all, and an exit code the adapter has been told means a
      // rate limit: the vendor said nothing machine-readable, which is the
      // whole premise of the scenario.
      DeFlow_FAKE_SCENARIO: 'no-output',
      DeFlow_FAKE_EXIT_CODE: String(exitCode),
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
      provider: PROVIDER,
      version: '2.1.220',
      binaryPath: binary,
      binarySha256: sha256,
      probedAt: NOW,
    }),
    wakes: {
      schedule: async (row: NodeWakeRow): Promise<void> => {
        wakes.push(row);
      },
    },
  };

  return {
    ledger,
    wakes,
    run: (overrides = {}) => runShimNode({ ...request, ...overrides }, ports),
  };
}

suite('EPIC-14-S27 — a limit signalled only by an exit code', () => {
  it('AC9: is classified transient, not a nonzero-exit and not a permanent failure', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, RATE_LIMIT_EXIT);

    const outcome = await test.run();

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failure.class).toBe('transient');
    expect(outcome.failure.reason).toBe('provider.rate-limited');
    test.ledger.close();
  });

  it('AC1: appends provider.rate_limited with resetsAt absent and the exit code as raw', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, RATE_LIMIT_EXIT);

    await test.run();

    const limited = test.ledger.events().find((event) => event.kind === 'provider.rate_limited');
    expect(limited).toBeDefined();
    const payload = limited?.payload as { provider: string; resetsAt?: number; raw: unknown };
    expect(payload.provider).toBe(PROVIDER);
    // Absent, not zero and not a guess. `resetsAt: 0` would schedule the retry
    // in 1970, which is indistinguishable from retrying immediately — the exact
    // behaviour this whole story exists to prevent.
    expect(payload.resetsAt).toBeUndefined();
    expect(payload.raw).toEqual({ exitCode: RATE_LIMIT_EXIT, signal: null });
    test.ledger.close();
  });

  it('AC6: writes no wake row, so the retry is the full-jitter backoff', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, RATE_LIMIT_EXIT);

    await test.run();

    // A `quota` row would claim DeFlow knows when the vendor lifts the limit.
    // It does not, so the wait is scheduled by the retry ladder instead.
    expect(test.wakes).toEqual([]);
    test.ledger.close();
  });

  it('AC10: the failure says "reset time unknown" rather than a fabricated instant', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, RATE_LIMIT_EXIT);

    const outcome = await test.run();
    if (outcome.status !== 'failed') throw new Error('unreachable');

    const limit = rateLimitOf(outcome.failure);
    expect(limit).not.toBeNull();
    if (limit === null) throw new Error('unreachable');
    expect(limit.resetsAt).toBeNull();
    expect(describeRateLimit(limit)).toBe('rate limited, reset time unknown');
    expect(outcome.failure.message).toContain('reset time unknown');
    // No ISO instant anywhere in the message: nothing here may look like a
    // time an operator could plan around.
    expect(outcome.failure.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    test.ledger.close();
  });
});

suite('EPIC-14-S27 — an exit code nobody claimed is still a nonzero exit', () => {
  it('does not become a rate limit just because it was non-zero', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 3);

    const outcome = await test.run();

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    // The degradation is honest in both directions: DeFlow does not invent a
    // reset time, and it does not invent a rate limit either.
    expect(outcome.failure.reason).toBe('agent.nonzero-exit');
    expect(test.ledger.events().some((event) => event.kind === 'provider.rate_limited')).toBe(
      false,
    );
    test.ledger.close();
  });

  it('and an adapter that declared no codes never takes this path at all', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, RATE_LIMIT_EXIT);

    // The shipped default: no vendor has published a rate-limit exit code, so
    // DeFlow claims none. The same exit is an ordinary failure.
    const outcome = await test.run({ rateLimitExitCodes: [] });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failure.reason).toBe('agent.nonzero-exit');
    test.ledger.close();
  });
});
