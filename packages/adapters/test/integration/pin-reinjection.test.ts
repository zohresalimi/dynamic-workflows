/**
 * KAR-09.4 — interval re-injection, driven end to end against a real agent
 * process.
 *
 * The mechanism only means anything if the bytes arrive, so nothing here
 * inspects the client's intent: the mock agent branches on whether the pinned
 * block is **byte-identically** present in the prompt it was handed
 * (`whenPromptContains` compares bytes, so a paraphrase is an absence), and the
 * count of each branch is the measurement. The ledger's `pin.reinjected`
 * progress rows carry the sha256 of what went out, which the spec recomputes
 * from the pinned segments — two independent readings of the same claim.
 *
 * Whether a re-injection may be delivered at all is read from the **probed
 * capability row** and from nothing else (EPIC-09-S24's outline): the same
 * `agentCapabilities` block is handed to the binary and stored as the row, so
 * "the adapter advertises steering" is one fact rather than two that can drift.
 *
 * Verifies: EPIC-09-S23, EPIC-09-S24 · AC5, AC6, AC7 · test plan #6, #7
 */

import {
  buildPacket,
  buildPinnedSegments,
  contentHash,
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
import { type CapabilityRow, runAcpNode, supportsSteering } from '../../src/index.ts';
import {
  mockAgentBinary,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';
import { approvedSpec } from './support/pinned-packet.ts';

/** The two markers the agent emits. Deliberately not prefixes of one another:
 * "PINNED"/"UNPINNED" would make a substring count silently wrong. */
const PIN_PRESENT = 'PIN-PRESENT';
const PIN_ABSENT = 'PIN-ABSENT';

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

/** The `agentCapabilities` block for a run, and the probed row that mirrors it.
 * `undefined` means the manifest never mentions steering, which is the state of
 * all five measured adapters. */
function manifest(steering: boolean | undefined) {
  const agentCapabilities = {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    ...(steering === undefined ? {} : { _meta: { midSessionSteering: steering } }),
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

interface TurnRun {
  readonly nodeId: string;
  /** Every `pin.reinjected` progress row, in order. */
  readonly reinjections: readonly string[];
  readonly pinPresentTurns: number;
  readonly pinAbsentTurns: number;
  readonly status: string;
  /** sha256 of the pinned block, as the packet builder produced it. */
  readonly pinnedDigest: string;
}

interface RunOptions {
  readonly name: string;
  readonly steering: boolean | undefined;
  readonly maxTurns: number;
  readonly everyTurns: number;
}

/**
 * One node, run over `maxTurns` `session/prompt` continuations.
 *
 * The scenario ends every turn with `max_turn_requests`, which is the ACP stop
 * reason that means the agent has more to do and is the only thing that lets
 * DeFlow continue a session at all — a node that ends with `end_turn` is
 * finished, and re-prompting it would be DeFlow inventing work.
 */
async function runTurns(options: RunOptions): Promise<TurnRun> {
  const nodeId = NodeIdSchema.parse(options.name);
  const { agentCapabilities, row } = manifest(options.steering);

  const pinned = await buildPinnedSegments({
    spec: approvedSpec(),
    node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
    constraints: [{ form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] }],
    sourceEvent: EventSeqSchema.parse(1),
  });
  const brief = await contextSegment({
    id: 'brief',
    kind: 'task.brief',
    text: 'Port CheckoutForm.vue to the Composition API.',
    sourceEvent: EventSeqSchema.parse(2),
  });
  const prompt = renderPacket({ segments: [brief, ...pinned] });
  const pinnedBlock = pinned.map((segment) => segment.text).join('\n\n');

  const scenarioFile = join(scenarioDir, `${nodeId}.json`);
  await writeFile(
    scenarioFile,
    JSON.stringify({
      name: nodeId,
      description: 'a long node that never finishes on its own',
      // Every turn asks to be continued, so the node's length is DeFlow's
      // decision rather than the tape's.
      stopReason: 'max_turn_requests',
      steps: [
        {
          type: 'whenPromptContains',
          text: pinnedBlock,
          present: { steps: [{ type: 'message', text: PIN_PRESENT }] },
          absent: { steps: [{ type: 'message', text: PIN_ABSENT }] },
        },
      ],
    }),
    'utf8',
  );

  const capsFile = join(scenarioDir, `${nodeId}-caps.json`);
  await writeFile(capsFile, JSON.stringify(agentCapabilities), 'utf8');

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
      pins: pinned.map((segment) => ({
        id: segment.id,
        text: segment.text,
        contentHash: segment.contentHash,
        pinned: true as const,
      })),
      turns: { max: options.maxTurns },
      reinject: { everyTurns: options.everyTurns },
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: row,
    },
  );

  const rows = ledger.events().filter((event) => event.payload.node === nodeId);
  const messages = rows
    .filter((event) => event.kind === 'node.progress')
    .map((event) => String(event.payload.message ?? ''));

  return {
    nodeId,
    reinjections: rows
      .filter((event) => event.kind === 'node.progress' && event.payload.phase === 'pin.reinjected')
      .map((event) => String(event.payload.message)),
    pinPresentTurns: messages.filter((message) => message.includes(PIN_PRESENT)).length,
    pinAbsentTurns: messages.filter((message) => message.includes(PIN_ABSENT)).length,
    status: outcome.status,
    pinnedDigest: await contentHash(pinnedBlock),
  };
}

suite('injections land at the configured interval (EPIC-09-S23, test plan #6)', () => {
  it('re-injects after turn 8 and after turn 16 of a 20-turn node', async () => {
    const run = await runTurns({
      name: 'reinject-steered',
      steering: true,
      maxTurns: 20,
      everyTurns: 8,
    });

    expect(run.status).toBe('completed');
    expect(run.reinjections).toHaveLength(2);
    expect(run.reinjections[0]).toContain('turn 8');
    expect(run.reinjections[1]).toContain('turn 16');
    // Byte-identical: the digest in the ledger is the digest of the pinned
    // block the builder produced, not of a re-rendered approximation.
    for (const message of run.reinjections) expect(message).toContain(run.pinnedDigest);
    // And the agent agrees, from the other side of the pipe: the pinned block
    // arrived verbatim on the first prompt and on both injection turns.
    expect(run.pinPresentTurns).toBe(3);
    expect(run.pinAbsentTurns).toBe(19);
  });

  it('honours a per-provider interval of 5 over a 12-turn node', async () => {
    const run = await runTurns({
      name: 'reinject-interval-5',
      steering: true,
      maxTurns: 12,
      everyTurns: 5,
    });

    expect(run.reinjections.map((message) => message.split(' ')[0])).toEqual(['turn', 'turn']);
    expect(run.reinjections[0]).toContain('turn 5');
    expect(run.reinjections[1]).toContain('turn 10');
    expect(run.pinPresentTurns).toBe(3);
  });
});

suite('no steering: warn, never fake a re-injection (EPIC-09-S24, test plan #7)', () => {
  it('attempts zero injection turns and produces no JSON-RPC error', async () => {
    const run = await runTurns({
      name: 'reinject-unsteered',
      steering: false,
      maxTurns: 20,
      everyTurns: 8,
    });

    expect(run.reinjections).toEqual([]);
    // The node still ran its twenty turns, and none of them carried the pinned
    // block except the first: nothing was faked and nothing failed.
    expect(run.status).toBe('completed');
    expect(run.pinPresentTurns).toBe(1);
    expect(run.pinAbsentTurns).toBe(19);
  });

  it('treats an unadvertised capability exactly like a refused one', async () => {
    const run = await runTurns({
      name: 'reinject-unknown-steering',
      steering: undefined,
      maxTurns: 12,
      everyTurns: 5,
    });

    expect(run.reinjections).toEqual([]);
    expect(run.pinPresentTurns).toBe(1);
  });

  it('the packet builder emits exactly one planning warning naming the node', async () => {
    const { row } = manifest(false);

    const build = await buildPacket({
      runId: RUN_ID,
      nodeId: 'reinject-unsteered',
      attempt: 0,
      builtAtEvent: 1,
      target: { provider: 'mock', model: 'mock-1', maxContext: 200_000 },
      pinned: {
        spec: approvedSpec(),
        node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
        sourceEvent: 1,
      },
      reinjection: {
        pinReinjectTurns: 8,
        // The capability, read from the probed row — never a provider name.
        steering: supportsSteering(row),
        expectedTurns: 20,
      },
    });

    expect(build.warnings).toHaveLength(1);
    expect(build.warnings[0]).toContain('reinject-unsteered');
    expect(build.warnings[0]).toContain('20');
    expect(build.warnings[0]).toContain('split');
  });
});
