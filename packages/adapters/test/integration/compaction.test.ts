/**
 * KAR-09.6 — a vendor compaction, out of a real process and into a real ledger.
 *
 * The fake exec-shim agent replays the committed compaction stream
 * (`test/fixtures/streams/compact-boundary.stream-json.jsonl`, whose provenance
 * is written down beside it) as a real child, and what is asserted is what
 * ended up durable: one `context.compacted`, scope `vendor.session`, fidelity
 * `partial`, `before` from `compact_metadata.pre_tokens`, and `after` still
 * null — *after the result envelope has been read*. The recovered figure is a
 * property of the projection, never of the row, because the ledger is
 * append-only and what the vendor said is what it said.
 *
 * The three failure-shaped scenarios matter more than the happy one:
 *
 * - the `system` / `status` `compacting` frame is a spinner, and appending a
 *   second compaction for it would double every chart;
 * - a missing transcript is `originalHandle: null` and a node that keeps
 *   running — §6.3's path is Unverified, so absence is normal;
 * - a `read` node's `DISABLE_AUTO_COMPACT` opt-in has to be visible *after the
 *   fact*, on the scheduling event, or a hard mid-node exhaustion is
 *   unattributable.
 *
 * Verifies: EPIC-09-S31, EPIC-09-S32 (ledger half), EPIC-09-S34 · AC2, AC3,
 * AC4, AC6, AC7, AC8 · test plan #4, #7, #9
 */
import {
  compactionView,
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
  vendorCompaction,
} from '@DeFlow/core';
import { readRunArtifact, snapshotTranscript } from '@DeFlow/ledger';
import { it, linkFakeAgent } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { openTestLedger, type TestLedger } from './support/harness.ts';

const RUN: RunId = RunIdSchema.parse('run_20260806T101500Z_ac0906');
const NODE: NodeId = NodeIdSchema.parse('n1');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '8f1b0a3c-2d4e-4f60-9a71-5c3e2b8d0f11';
const NOW = 1_800_000_000_000;

/** The `pre_tokens` the committed fixture and the fake both carry. */
const PRE_TOKENS = 167_000;
/** The `modelUsage[model].inputTokens` of the turn that follows it. */
const AFTER_INPUT_TOKENS = 84_210;

interface Harness {
  readonly ledger: TestLedger;
  readonly runDir: string;
  readonly dataDir: string;
  run(overrides?: Partial<ShimNodeRequest>, ports?: Partial<ShimPorts>): Promise<ShimNodeOutcome>;
}

async function harness(tmp: string, binary: string, scenario: string): Promise<Harness> {
  const dataDir = join(tmp, 'data');
  const runDir = join(tmp, 'runs', RUN);
  const worktree = join(tmp, 'wt');
  await mkdir(dataDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  const ledger = openTestLedger(dataDir);

  const request: ShimNodeRequest = {
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    provider: CLAUDE,
    permission: 'read',
    worktree,
    prompt: 'summarise the checkout module',
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
      binarySha256: request.binary.sha256,
      probedAt: NOW,
    }),
  };

  return {
    ledger,
    runDir,
    dataDir,
    run: (overrides = {}, portOverrides = {}) =>
      runShimNode({ ...request, ...overrides }, { ...ports, ...portOverrides }),
  };
}

const compactions = (ledger: TestLedger): { seq: number; payload: Record<string, unknown> }[] =>
  ledger.events().filter((event) => event.kind === 'context.compacted');

const scheduled = (ledger: TestLedger): Record<string, unknown> => {
  const event = ledger.events().find((row) => row.kind === 'node.scheduled');
  if (event === undefined) throw new Error('no node.scheduled event was appended');
  return event.payload;
};

suite('AC2, AC3 — the vendor’s compaction, as recorded (EPIC-09-S31)', () => {
  it('appends exactly one partial compaction for one boundary frame', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction');

    const outcome = await test.run();

    expect(outcome.status).toBe('completed');
    const events = compactions(test.ledger);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      node: NODE,
      scope: 'vendor.session',
      fidelity: 'partial',
      trigger: 'vendor.auto',
      before: PRE_TOKENS,
      after: null,
      droppedSegments: [],
      demotedToHandles: [],
      originalHandle: null,
    });
    test.ledger.close();
  });

  it('AC4 — the later envelope fills the projection, never the row', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction');

    const outcome = await test.run();

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    // The row still says null — the vendor reported one number and the ledger
    // holds one number.
    expect(compactions(test.ledger)[0]?.payload.after).toBeNull();

    const view = compactionView(vendorCompaction({ trigger: 'auto', preTokens: PRE_TOKENS }), {
      inputTokens: outcome.result.usage.inputTokens,
    });
    expect(view.after).toBe(AFTER_INPUT_TOKENS);
    expect(view.inferred).toBe(true);
    expect(view.fidelity).toBe('partial');
    test.ledger.close();
  });
});

suite('AC6 — the transcript snapshot, and its absence (EPIC-09-S34)', () => {
  it('copies the JSONL into the run’s artifact store and points at it', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction');
    const transcript = join(tmp, `${SESSION}.jsonl`);
    writeFileSync(transcript, '{"type":"user","content":"synthetic transcript line"}\n', 'utf8');

    const outcome = await test.run(
      {},
      {
        transcripts: {
          snapshot: async () =>
            snapshotTranscript({
              dataDir: test.dataDir,
              runDir: test.runDir,
              sourcePath: transcript,
              node: NODE,
              sessionId: SESSION,
            }),
        },
      },
    );

    expect(outcome.status).toBe('completed');
    const handle = compactions(test.ledger)[0]?.payload.originalHandle;
    expect(typeof handle).toBe('string');

    // Third scenario: the stored artifact is marked a raw transcript, so F5.9's
    // redaction pass can find it before anything is ever exported.
    const digest = String(handle).slice('artifact://'.length);
    const entry = readRunArtifact(test.runDir, digest);
    expect(entry?.sensitivity).toBe('raw-transcript');
    test.ledger.close();
  });

  it('records originalHandle: null and keeps running when the file is absent', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction');

    const outcome = await test.run(
      {},
      {
        transcripts: {
          snapshot: async () =>
            snapshotTranscript({
              dataDir: test.dataDir,
              runDir: test.runDir,
              sourcePath: join(tmp, 'nothing-here', `${SESSION}.jsonl`),
              node: NODE,
              sessionId: SESSION,
            }),
        },
      },
    );

    expect(outcome.status).toBe('completed');
    expect(compactions(test.ledger)[0]?.payload.originalHandle).toBeNull();
    // "No error event" is the assertion, not "no thrown error": a node that
    // failed for a missing snapshot would have appended one.
    expect(test.ledger.events().map((event) => event.kind)).not.toContain('node.failed');
    test.ledger.close();
  });
});

suite('AC7, AC8 — the lever the node ran with, recorded and delivered', () => {
  it('records a read node’s opt-out on the scheduling event and sets it', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction-env');

    const outcome = await test.run({ compaction: { disableAutoCompact: true } });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(scheduled(test.ledger).compaction).toEqual({
      autocompactPct: null,
      autoCompactDisabled: true,
    });
    // The child echoes what it was given, so "the variable reached the
    // process" is an observation rather than an inference from the overlay.
    expect(outcome.result.output).toMatchObject({
      text: expect.stringContaining('DISABLE_AUTO_COMPACT=1'),
    });
    test.ledger.close();
  });

  it('records the 70% default for a write-capable node before admission refuses it', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction-env');

    // The shim path admits nothing above `read` — it advertises
    // `mediatedExecution: false` about itself and KAR-05.8 AC8 refuses the
    // rest — so this is as far as a write-capable node gets *here*. The
    // scheduling record is still written first, which is the point: the lever
    // is resolved and recorded before anything can refuse or fail, so the row
    // exists whatever happens next.
    const outcome = await test.run({ permission: 'worktree' });

    expect(outcome.status).toBe('failed');
    expect(scheduled(test.ledger).compaction).toEqual({
      autocompactPct: 70,
      autoCompactDisabled: false,
    });
    test.ledger.close();
  });

  it('refuses a write-capable node that asked to disable auto-compaction', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction-env');

    const outcome = await test.run({
      permission: 'worktree',
      compaction: { disableAutoCompact: true },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    // A node that exhausts its context mid-turn with auto-compaction off loses
    // work already on disk, so the opt-in is scoped to `read` and the refusal
    // happens before a process exists rather than three hours in.
    expect(outcome.failure.message).toContain('DISABLE_AUTO_COMPACT');
    expect(scheduled(test.ledger)).not.toHaveProperty('compaction');
    test.ledger.close();
  });

  it('leaves a read node that asked for nothing at the vendor’s own default', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary, 'claude-compaction-env');

    const outcome = await test.run();

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(scheduled(test.ledger).compaction).toEqual({
      autocompactPct: null,
      autoCompactDisabled: false,
    });
    expect(outcome.result.output).toMatchObject({
      text: expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='),
    });
    expect(outcome.result.output).not.toMatchObject({
      text: expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70'),
    });
    test.ledger.close();
  });
});
