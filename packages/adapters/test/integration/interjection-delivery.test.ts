/**
 * KAR-13.3 — an interjection reaching a live session, driven end to end against
 * a real agent process.
 *
 * The mechanism only means anything if the bytes arrive, so nothing here
 * inspects the client's intent: the mock agent branches on whether the
 * Operator's text is **byte-identically** present in the prompt it was handed
 * (`whenPromptContains` compares bytes, so a paraphrase is an absence), and the
 * count of each branch is the measurement. The `human.interjection.delivered`
 * events are the ledger's own reading of the same claim — two independent
 * observations, and only when both agree is the guidance "delivered".
 *
 * Whether anything may be delivered at all is read from the **probed capability
 * row** and from nothing else: the same `agentCapabilities` block is handed to
 * the binary and stored as the row, so "the adapter advertises steering" is one
 * fact rather than two that can drift.
 *
 * Verifies: EPIC-13-S17 (second scenario), EPIC-13-S18 · AC2, AC8, AC9 · test
 * plan #4, #5
 */
import {
  buildPinnedSegments,
  contextSegment,
  EventSeqSchema,
  NodeIdSchema,
  ProviderIdSchema,
  renderPacket,
} from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { type CapabilityRow, runAcpNode } from '../../src/index.ts';
import {
  mockAgentBinary,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';
import { approvedSpec } from './support/pinned-packet.ts';

/** The two markers the agent emits. Deliberately not prefixes of one another. */
const SAW_GUIDANCE = 'GUIDANCE-PRESENT';
const NO_GUIDANCE = 'GUIDANCE-ABSENT';

const FIRST = "Use the existing useToast composable, don't add a new one.";
const SECOND = 'And keep the props readonly.';

let dir = '';
let worktree = '';
let scenarioDir = '';
let ledger: TestLedger;

beforeAll(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt');
  scenarioDir = join(dir, 'scenarios');
  await mkdir(worktree, { recursive: true });
  await mkdir(scenarioDir, { recursive: true });
  ledger = openTestLedger(dir);
});

afterAll(async () => {
  ledger.close();
  await removeTempDir(dir);
});

/** The `agentCapabilities` block for a run, and the probed row that mirrors it. */
function manifest(steering: boolean) {
  const agentCapabilities = {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    _meta: { midSessionSteering: steering },
  };
  const row: CapabilityRow = {
    provider: ProviderIdSchema.parse('mock'),
    version: '0.0.0',
    binarySha256: 'a'.repeat(64),
    binaryPath: mockAgentBinary().path,
    capsJson: JSON.stringify({ protocolVersion: 1, agentCapabilities, authMethods: [] }),
    probedAt: 1_754_313_093_000,
  };
  return { agentCapabilities, row };
}

interface DeliveryRun {
  readonly status: string;
  /** The `interjectedSeq` of every receipt appended, in order. */
  readonly receipts: readonly number[];
  /** Turns whose prompt carried each guidance string, by text. */
  readonly sawText: Readonly<Record<string, number>>;
  readonly sawNothing: number;
}

interface RunOptions {
  readonly name: string;
  readonly steering: boolean;
  /** `{ seq, text }` pairs the daemon has queued for this node. */
  readonly pending: readonly { readonly seq: number; readonly text: string }[];
  readonly maxTurns: number;
}

/**
 * One node run over `maxTurns` continuations, with the queue offered at every
 * turn boundary and drained as it is delivered — which is what the daemon does
 * with a projection that folds each receipt.
 */
async function deliver(options: RunOptions): Promise<DeliveryRun> {
  const nodeId = NodeIdSchema.parse(options.name);
  const { agentCapabilities, row } = manifest(options.steering);

  const pinned = await buildPinnedSegments({
    spec: approvedSpec(),
    node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
    sourceEvent: EventSeqSchema.parse(1),
  });
  const brief = await contextSegment({
    id: 'brief',
    kind: 'task.brief',
    text: 'Port CheckoutForm.vue to the Composition API.',
    sourceEvent: EventSeqSchema.parse(2),
  });
  const prompt = renderPacket({ segments: [brief, ...pinned] });

  const scenarioFile = join(scenarioDir, `${nodeId}.json`);
  await writeFile(
    scenarioFile,
    JSON.stringify({
      name: nodeId,
      description: 'a long node that never finishes on its own',
      stopReason: 'max_turn_requests',
      steps: options.pending.map((one) => ({
        type: 'whenPromptContains',
        text: one.text,
        present: { steps: [{ type: 'message', text: `${SAW_GUIDANCE} ${one.seq}` }] },
        absent: { steps: [{ type: 'message', text: NO_GUIDANCE }] },
      })),
    }),
    'utf8',
  );

  const capsFile = join(scenarioDir, `${nodeId}-caps.json`);
  await writeFile(capsFile, JSON.stringify(agentCapabilities), 'utf8');

  /**
   * The queue as the projection holds it, read back out of the **ledger** on
   * every ask — which is what the daemon does, and the reason the adapter needs
   * no "mark as sent" callback: the receipt it appends is what retires the
   * item. A `Set` held here instead would let the adapter pass this spec while
   * re-delivering after a restart.
   */
  const alreadyDelivered = (): ReadonlySet<number> =>
    new Set(
      ledger
        .events()
        .filter(
          (event) => event.kind === 'human.interjection.delivered' && event.payload.node === nodeId,
        )
        .map((event) => Number((event.payload as { interjectedSeq: number }).interjectedSeq)),
    );

  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: mockAgentBinary(),
      argv: ['--seed', '42', '--scenario', scenarioFile, '--capabilities-file', capsFile],
      env: { PATH: process.env.PATH ?? '' },
      mcpServers: [],
      prompt,
      turns: { max: options.maxTurns },
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: row,
      pendingInterjections: () => {
        const done = alreadyDelivered();
        return options.pending
          .filter((one) => !done.has(one.seq))
          .map((one) => ({ seq: EventSeqSchema.parse(one.seq), text: one.text }));
      },
    },
  );

  const rows = ledger.events().filter((event) => event.payload.node === nodeId);
  const messages = rows
    .filter((event) => event.kind === 'node.progress')
    .map((event) => String(event.payload.message ?? ''));

  const sawText: Record<string, number> = {};
  for (const one of options.pending) {
    sawText[one.text] = messages.filter((message) =>
      message.includes(`${SAW_GUIDANCE} ${one.seq}`),
    ).length;
  }

  return {
    status: outcome.status,
    receipts: rows
      .filter((event) => event.kind === 'human.interjection.delivered')
      .map((event) => Number((event.payload as { interjectedSeq: number }).interjectedSeq)),
    sawText,
    sawNothing: messages.filter((message) => message.includes(NO_GUIDANCE)).length,
  };
}

suite('EPIC-13-S17 — it reaches the agent (AC2, test plan #4)', () => {
  it('sends the guidance on the next turn and records one receipt for it', async () => {
    const run = await deliver({
      name: 'interject-steered',
      steering: true,
      pending: [{ seq: 10_892, text: FIRST }],
      maxTurns: 3,
    });

    expect(run.status).toBe('completed');
    // The receipt is the ledger's word that it went out.
    expect(run.receipts).toEqual([10_892]);
    // And the agent's, from the other side of the pipe: exactly one turn
    // carried the Operator's bytes, and it was not the packet turn.
    expect(run.sawText[FIRST]).toBe(1);
    expect(run.sawNothing).toBeGreaterThan(0);
  });

  it('delivers several corrections in seq order, dropping and coalescing none (AC8)', async () => {
    const run = await deliver({
      name: 'interject-two',
      steering: true,
      pending: [
        { seq: 10_892, text: FIRST },
        { seq: 10_894, text: SECOND },
      ],
      maxTurns: 4,
    });

    expect(run.receipts).toEqual([10_892, 10_894]);
    expect(run.sawText[FIRST]).toBe(1);
    expect(run.sawText[SECOND]).toBe(1);
  });
});

suite('EPIC-13-S18 — no steering means no frame, never a fabricated one (test plan #5)', () => {
  it('sends nothing to an adapter that says it cannot be steered', async () => {
    const run = await deliver({
      name: 'interject-unsteered',
      steering: false,
      pending: [{ seq: 10_892, text: FIRST }],
      maxTurns: 3,
    });

    // The node still ran its turns; nothing was faked and nothing failed.
    expect(run.status).toBe('completed');
    expect(run.receipts).toEqual([]);
    expect(run.sawText[FIRST]).toBe(0);
    expect(run.sawNothing).toBeGreaterThan(0);
  });
});
