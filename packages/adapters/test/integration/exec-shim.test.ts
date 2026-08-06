/**
 * EPIC-05-S29 — the CLI fallback, out of a real process.
 *
 * Everything here runs the fake exec-shim agent (KAR-04.6) as a real child,
 * symlinked under the vendor name it is impersonating, and reads a real
 * file-backed ledger afterwards. Nothing is mocked: the `--verbose` guard, the
 * dedup key, the frame cap and the rate-limit wake are all claims about bytes
 * that crossed a pipe.
 *
 * The four claims that need a process to be true at all:
 *
 * - **`--verbose` reaches the child.** A unit test can prove the argv builder
 *   emits it; only a spawn proves the vendor's refusal string never appears.
 * - **The `uuid` is the dedup key.** Feeding the same output twice has to
 *   produce one ledger row per line, or replay-after-crash duplicates a
 *   transcript the ledger keeps for ever (F4.3).
 * - **The frame cap is the same one.** KAR-05.4's guard is a transport-level
 *   byte counter, and a second implementation on this path would drift from it
 *   silently — so the reason must come from the same module.
 * - **A rate limit is scheduled around.** `resetsAt` is a durable `node_wake`
 *   row, never a `setTimeout` and never an immediate retry.
 *
 * Verifies: EPIC-05-S29 · KAR-05.8 AC2, AC3, AC4, AC6, AC7 · test plan #2, #3,
 * #4, #7, #8
 */
import {
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { CLAUDE_VERBOSE_REQUIRED, it, linkFakeAgent, readSideEffectLog } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const RUN: RunId = RunIdSchema.parse('run_20260805T101500Z_ac0508');
const NODE: NodeId = NodeIdSchema.parse('n1');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const COPILOT: ProviderId = ProviderIdSchema.parse('copilot');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const RUN_SHIM_SRC = fileURLToPath(new URL('../../src/run-shim-node.ts', import.meta.url));

/** A clock that answers a fixed instant, so a scheduled wake is comparable. */
const NOW = 1_800_000_000_000;

interface Harness {
  readonly ledger: TestLedger;
  readonly wakes: NodeWakeRow[];
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
  const wakes: NodeWakeRow[] = [];

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
    // KAR-08.5. `darwin` because Seatbelt needs nothing installed, which keeps
    // this file about the shim rather than about the sandbox — the Linux
    // prerequisites have their own spec (`sandbox-injection.test.ts`).
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
      // The fake reads its clock from here, so `resetsAt` is an equality
      // rather than a window — and the equality is what proves the vendor's
      // epoch **seconds** were converted rather than passed through.
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
    wakes: {
      schedule: async (row: NodeWakeRow): Promise<void> => {
        wakes.push(row);
      },
    },
  };

  return {
    ledger,
    wakes,
    run: (overrides = {}, portOverrides = {}) =>
      runShimNode({ ...request, ...overrides }, { ...ports, ...portOverrides }),
  };
}

/** Every `uuid` the ledger's data plane holds for this node, in order. */
function durableUuids(ledger: TestLedger): string[] {
  return ledger
    .chunks()
    .flatMap(({ text }) => text.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { uuid?: string }).uuid)
    .filter((uuid): uuid is string => typeof uuid === 'string');
}

suite('Claude Code’s --verbose requirement is never violated (AC2)', () => {
  it('passes --verbose to the real child and never provokes the vendor error', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-turn');

    const outcome = await test.run();

    expect(outcome.argv).toContain('--verbose');
    expect(outcome.argv.join(' ')).toContain('--output-format stream-json');
    expect(outcome.status).toBe('completed');
    // The exact string the real binary prints when the guard is missing. If it
    // ever appears, the argv builder regressed and the turn produced nothing.
    expect(outcome.stderr).not.toContain(CLAUDE_VERBOSE_REQUIRED);
    test.ledger.close();
  });

  it('records the turn as completed with a vendor-reported usage (AC5)', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-turn');

    const outcome = await test.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(outcome.result.usage.source).toBe('vendor-reported');
    expect(outcome.result.costUsd).toBeCloseTo(0.0123, 6);

    const completed = test.ledger.events().find((event) => event.kind === 'node.completed');
    expect(completed).toBeDefined();
    test.ledger.close();
  });

  it('maps error_max_structured_output_retries to agent.schema-repair-exhausted', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'schema-repair-exhausted');

    const outcome = await test.run();
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failure.reason).toBe('agent.schema-repair-exhausted');
    expect(outcome.failure.class).toBe('permanent');
    test.ledger.close();
  });
});

suite('Copilot has no stream-json, and nothing is spawned (AC3)', () => {
  it('refuses before a process exists, naming the formats it supports', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'copilot');
    const test = await harness(tmp, agent.binary, 'claude-turn', COPILOT);

    const outcome = await test.run({ format: 'stream-json' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failure.message).toMatch(/text\|json/);
    expect(outcome.exit).toBeNull();
    // The fake appends one line per invocation. An empty log is the assertion
    // that the refusal happened at construction and not after a spawn.
    expect(readSideEffectLog(join(tmp, 'side-effects.ndjson')).entries).toEqual([]);
    test.ledger.close();
  });
});

suite('the uuid is the dedup key on this path (AC4)', () => {
  it('replaying the same output produces one ledger row per distinct uuid', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-turn');

    const first = await test.run();
    expect(first.status).toBe('completed');

    const uuids = durableUuids(test.ledger);
    expect(uuids.length).toBeGreaterThan(3);
    expect(new Set(uuids).size).toBe(uuids.length);

    // The same attempt, replayed after a crash: the seed makes the child emit
    // byte-identical lines, and the uuids DeFlow already made durable are what
    // it is told it has.
    const second = await test.run({}, { seenUuids: uuids });
    expect(second.status).toBe('completed');

    const after = durableUuids(test.ledger);
    expect(after).toEqual(uuids);

    const perUuid = new Map<string, number>();
    for (const event of test.ledger.events()) {
      const message = (event.payload as { message?: string }).message;
      const uuid = message?.match(/uuid=([\w-]+)/)?.[1];
      if (uuid !== undefined) perUuid.set(uuid, (perUuid.get(uuid) ?? 0) + 1);
    }
    expect([...perUuid.values()].filter((count) => count !== 1)).toEqual([]);
    expect(perUuid.size).toBe(new Set(uuids).size);
    test.ledger.close();
  });
});

suite('a rate limit is scheduled around, not retried into (AC6)', () => {
  it('appends provider.rate_limited and writes a durable wake for resetsAt', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'rate-limited');

    const outcome = await test.run();
    expect(outcome.status).toBe('completed');

    const limited = test.ledger.events().find((event) => event.kind === 'provider.rate_limited');
    expect(limited).toBeDefined();
    const payload = limited?.payload as { provider: string; resetsAt: number };
    expect(payload.provider).toBe('claude');
    // The scenario scripts 900 seconds ahead of the fake's clock, and the
    // vendor reports epoch **seconds**. A parser that passed them through as
    // milliseconds would schedule this in 1970 — which is a wake that fires
    // immediately, i.e. the blind retry AC6 forbids.
    expect(payload.resetsAt).toBe(NOW + 900_000);

    expect(test.wakes).toHaveLength(1);
    expect(test.wakes[0]).toMatchObject({
      runId: RUN,
      nodeId: NODE,
      wakeAt: payload.resetsAt,
      reason: 'quota',
    });
    test.ledger.close();
  });
});

suite('the frame guard applies here too (AC7)', () => {
  it('a 10 MB line fails the node with adapter.frame-too-large', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'huge-line');

    const outcome = await test.run();

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failure.reason).toBe('adapter.frame-too-large');
    expect(outcome.failure.detail).toMatchObject({ limit: 8 * 1024 * 1024 });
    // The first 4 KiB of the offending line, kept as a handle — the only
    // evidence that says what the agent was sending.
    expect(outcome.failure.evidence.length).toBeGreaterThan(0);
    test.ledger.close();
  });

  it('there is not a second implementation of the cap', async () => {
    const source = readFileSync(RUN_SHIM_SRC, 'utf8');
    expect(source).toContain("from './frame-guard.ts'");
    // No cap of its own: the number lives in frame-guard.ts and nowhere else.
    expect(source).not.toMatch(/=\s*8\s*\*\s*1024\s*\*\s*1024/);
  });
});
