/**
 * KAR-12.2 AC2, AC4, AC5 — the CLI shim half of independent review, out of a
 * real process.
 *
 * Three claims a unit test cannot make, and all three are about *when* things
 * happened rather than about what a function returned.
 *
 * **The refusal happens before the reviewer sees anything.** On this path
 * DeFlow mints the uuid and passes `--session-id <uuid>`, so the check runs
 * before spawn — and the way to prove that is the absence of a process, not the
 * presence of an error. A refused node here spawns nothing, writes no prompt
 * and leaves no `node.started` in the ledger, so there is no frame for the
 * reviewer to have read.
 *
 * **The uuid DeFlow minted is the one on the wire.** Claude Code and Gemini CLI
 * honour a client-chosen `--session-id` verbatim in every emitted frame
 * (**verified 2026-08-02**), which is what lets DeFlow assert on the id it chose
 * rather than parse one back out and hope.
 *
 * **A frame carrying a different id fails the node.** That is the whole value of
 * the previous paragraph: a claim nobody checks is a claim, and an agent that
 * answered on some other session was not the agent this check cleared.
 *
 * Verifies: EPIC-12-S12, EPIC-12-S17 · AC2, AC4, AC5 · test plan #7, #8
 */
import {
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
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

const RUN: RunId = RunIdSchema.parse('run_20260809T231500Z_ac1202');
const REVIEW: NodeId = NodeIdSchema.parse('design-review');
const PRODUCER: NodeId = NodeIdSchema.parse('implement-1');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');

const PRODUCER_SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3311';
const REVIEW_SESSION = '9a7bfe10-3a0c-4e11-8c2f-1b7f2d5a4412';
const NOW = 1_800_000_000_000;

/** One turn that answers, emitting `session` frames carrying `sessionId`. */
const scenario = (sessionId: string): string =>
  JSON.stringify({
    name: 'review-turn',
    description: 'One turn in which the reviewer judges the diff.',
    sessionId,
    steps: [{ type: 'message', text: 'judged' }],
    result: { subtype: 'success', text: 'judged', totalCostUsd: 0.01 },
  });

interface Harness {
  readonly ledger: TestLedger;
  run(overrides?: Partial<ShimNodeRequest>): Promise<ShimNodeOutcome>;
}

async function harness(tmp: string, binary: string, script: string): Promise<Harness> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const worktree = join(tmp, 'wt');
  await mkdir(worktree, { recursive: true });
  const ledger = openTestLedger(dataDir);
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');

  const request: ShimNodeRequest = {
    runId: RUN,
    nodeId: REVIEW,
    attempt: 0,
    provider: CLAUDE,
    permission: 'read',
    worktree,
    prompt: 'judge the diff against the pinned criteria',
    sessionId: REVIEW_SESSION,
    review: {
      producers: [{ id: PRODUCER, resolvedSessionId: PRODUCER_SESSION }],
    },
    binary: { path: binary, version: '2.1.220', sha256 },
    sandbox: {
      version: '2.1.220',
      platform: 'darwin',
      roots: [join(tmp, 'bin')],
      configDir: join(tmp, 'sandbox'),
    },
    env: {
      ...process.env,
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      DeFlow_FAKE_SCENARIO: script,
      DeFlow_FAKE_SEED: '42',
      DeFlow_FAKE_NOW: String(NOW),
    },
  };

  const ports: ShimPorts = {
    clock: { now: () => NOW, setTimer: () => ({ cancel: () => {} }) },
    ledger: ledger.sink,
    captureEvidence: ledger.captureEvidence,
    capabilityRow: shimCapabilityRow({
      provider: CLAUDE,
      version: '2.1.220',
      binaryPath: binary,
      binarySha256: sha256,
      probedAt: NOW,
    }),
    wakes: { schedule: async (_row: NodeWakeRow): Promise<void> => {} },
  };

  return { ledger, run: (overrides = {}) => runShimNode({ ...request, ...overrides }, ports) };
}

const kinds = (test: Harness): string[] => test.ledger.events().map((event) => event.kind);

suite('the minted uuid is what the reviewer speaks on (AC4, AC5 · EPIC-12-S17)', () => {
  it('passes --session-id with the uuid DeFlow chose', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, scenario(REVIEW_SESSION));

    const outcome = await test.run();

    const at = outcome.argv.indexOf('--session-id');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(outcome.argv[at + 1]).toBe(REVIEW_SESSION);
    expect(outcome.status).toBe('completed');
    test.ledger.close();
  });

  it('journals the resolved session on node.started, as minted', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, scenario(REVIEW_SESSION));

    await test.run();

    const started = test.ledger.events().find((event) => event.kind === 'node.started');
    const payload = started?.payload as { session?: { id: string; origin: string } };
    // AC1's assertion needs this payload and the producer's, and nothing else.
    expect(payload.session).toEqual({ id: REVIEW_SESSION, origin: 'minted' });
    test.ledger.close();
  });

  it('fails the node when a frame carries a different session id', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    // The fake is scripted to answer on a session nobody asked for.
    const test = await harness(tmp, agent.binary, scenario(PRODUCER_SESSION));

    const outcome = await test.run();

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).toBe('adapter.protocol-error');
    // Both ids, because "the session id was wrong" is not a diagnosis.
    expect(outcome.failure.message).toContain(REVIEW_SESSION);
    expect(outcome.failure.message).toContain(PRODUCER_SESSION);
    test.ledger.close();
  });
});

suite('a shared session is refused before the spawn (AC2 · EPIC-12-S12)', () => {
  it('refuses with REVIEW_SESSION_NOT_INDEPENDENT', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, scenario(PRODUCER_SESSION));

    const outcome = await test.run({ sessionId: PRODUCER_SESSION });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.detail?.code).toBe('REVIEW_SESSION_NOT_INDEPENDENT');
    test.ledger.close();
  });

  it('spawns nothing, so no frame can have reached the reviewer', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, scenario(PRODUCER_SESSION));

    const outcome = await test.run({ sessionId: PRODUCER_SESSION });

    expect(outcome.pgid).toBe(0);
    expect(outcome.argv).toEqual([]);
    // No `node.started`: the process the event records never existed.
    expect(kinds(test)).not.toContain('node.started');
    expect(kinds(test)).toContain('node.failed');
    test.ledger.close();
  });

  it('is a gate-class failure, so the run stops rather than retrying', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, scenario(PRODUCER_SESSION));

    const outcome = await test.run({ sessionId: PRODUCER_SESSION });

    expect(outcome.status === 'failed' && outcome.failure.class).toBe('gate');
    test.ledger.close();
  });
});

suite('a fork is refused before the spawn too (AC3 · EPIC-12-S13)', () => {
  it('refuses REVIEW_INHERITS_PRODUCER_CONTEXT and spawns nothing', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, scenario(REVIEW_SESSION));

    const outcome = await test.run({
      review: {
        producers: [{ id: PRODUCER, resolvedSessionId: PRODUCER_SESSION }],
        resume: { kind: 'fork' },
      },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.detail?.code).toBe('REVIEW_INHERITS_PRODUCER_CONTEXT');
    expect(outcome.pgid).toBe(0);
    test.ledger.close();
  });
});

suite('a node that is not a review is untouched (EPIC-12-S13, third scenario)', () => {
  it('runs normally with no review block at all', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, scenario(REVIEW_SESSION));

    // The same session id as the producer's, and it is admitted: the
    // precondition is scoped to review nodes, and forking stays legitimate for
    // continuation work.
    const outcome = await test.run({
      nodeId: PRODUCER,
      sessionId: PRODUCER_SESSION,
      review: undefined,
      env: {
        ...process.env,
        DeFlow_FAKE_DIALECT: 'claude-stream-json',
        DeFlow_FAKE_SCENARIO: scenario(PRODUCER_SESSION),
        DeFlow_FAKE_SEED: '42',
        DeFlow_FAKE_NOW: String(NOW),
      },
    });

    expect(outcome.status).toBe('completed');
    test.ledger.close();
  });
});
