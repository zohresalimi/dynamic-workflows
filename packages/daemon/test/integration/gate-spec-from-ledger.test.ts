/**
 * KAR-09.4 AC8 / §4.3 — a gate evaluates against the ledger's spec even when
 * the agent's context no longer contains it.
 *
 * The setup is the failure it guards. A real file-backed ledger holds a real
 * approved `TaskSpec`; a real agent process is then driven with a prompt from
 * which the goal and every acceptance criterion have been **removed**, which is
 * what a compaction that took the spec with it leaves behind. The agent's whole
 * transcript is therefore free of the criteria, and the gate still names them —
 * because it never asked the agent.
 *
 * The second scenario is Security-Recall Divergence stated directly: a run whose
 * criteria are all satisfiable is not evidence that a pinned prohibition was
 * honoured. The violating tool call is in the ledger either way, and resolving
 * the gate's criteria does not touch it.
 *
 * Verifies: EPIC-09-S25 · AC8 · test plan #9
 */

import { runAcpNode } from '@DeFlow/adapters';
import {
  type Event,
  gateSpecFromLedger,
  parseEvent,
  specHash,
  type TaskSpec,
  TaskSpecSchema,
} from '@DeFlow/core';
import { appendEvents, openLedger, readEpoch, readRange } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { sqliteLedgerSink } from './support/ledger.ts';

/** The workspace mock agent, absolute — never a bare name looked up on PATH. */
const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const mockAgentBinary = () => ({
  path: MOCK_AGENT_BIN,
  version: '0.0.0',
  sha256: createHash('sha256').update(readFileSync(MOCK_AGENT_BIN)).digest('hex'),
});

const RUN_ID = 'run_20260806T090000Z_5c1d2e';
const CRITERION = 'checkout-tests-pass';
const CRITERION_TEXT = 'Every existing checkout unit test passes unmodified.';
const GOAL = 'Migrate the checkout module from Vue 2 to Vue 3 without changing its public API.';

let dir = '';
let worktree = '';

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt');
  await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
  await removeTempDir(dir);
});

async function approvedSpec(): Promise<TaskSpec> {
  const draft = {
    schemaId: 'DeFlow.taskspec.v1',
    goal: GOAL,
    scope: { included: ['src/checkout/**'] },
    nonGoals: [],
    constraints: ['must not change the public API of the checkout package'],
    priorDecisions: [],
    acceptanceCriteria: [
      {
        id: CRITERION,
        statement: CRITERION_TEXT,
        check: { kind: 'command', run: 'pnpm test', expect: 'exit-zero' },
        coveredByGates: [],
      },
    ],
    knownFailureModes: [],
    approvedBy: { at: '2026-08-06T09:00:00Z', via: 'ui' },
  };
  return TaskSpecSchema.parse({ ...draft, specHash: await specHash(draft) });
}

/** The run's ledger, with the spec created and approved exactly as F1.3 records
 * it. `openLedger` is the real one and the file is on disk. */
function openRunLedger(spec: TaskSpec) {
  const db = openLedger(dir);
  const epoch = readEpoch(db);
  appendEvents(db, [
    {
      runId: RUN_ID,
      ts: 1_754_470_000_000,
      kind: 'run.created',
      v: 1,
      epoch,
      payload: { spec, cwd: worktree, repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: RUN_ID,
      ts: 1_754_470_001_000,
      kind: 'run.spec.approved',
      v: 1,
      epoch,
      payload: { specHash: spec.specHash, by: 'ui' },
    },
  ]);
  return { db, epoch };
}

/** Every event of the run, parsed. */
function ledgerEvents(db: ReturnType<typeof openLedger>): Event[] {
  return readRange(db, RUN_ID as never, 0, 500).events.flatMap((stored) => {
    const parsed = parseEvent(stored);
    return parsed.status === 'ok' ? [parsed.event] : [];
  });
}

/**
 * A gate node's agent turn, run with a prompt the spec was stripped out of.
 *
 * Returns the whole transcript the agent produced, so the spec's absence from
 * the agent's world is asserted rather than assumed.
 */
async function runStrippedGateNode(db: ReturnType<typeof openLedger>, epoch: number) {
  const chunks: string[] = [];
  const scenarioFile = join(dir, 'gate.json');
  await writeFile(
    scenarioFile,
    JSON.stringify({
      name: 'gate-with-no-spec',
      description: 'the criteria were compacted away',
      stopReason: 'end_turn',
      steps: [{ type: 'message', text: 'I no longer recall what I was asked to check.' }],
    }),
    'utf8',
  );

  // What a compaction that took the spec with it leaves behind: no goal, no
  // criterion id, no criterion text.
  const prompt = 'Earlier turns were compacted. Continue from the summary above.';
  expect(prompt).not.toContain(CRITERION);
  expect(prompt).not.toContain(CRITERION_TEXT);
  expect(prompt).not.toContain(GOAL);

  await runAcpNode(
    {
      runId: RUN_ID as never,
      nodeId: 'gate' as never,
      attempt: 0,
      provider: 'mock' as never,
      permission: 'read',
      worktree,
      binary: mockAgentBinary(),
      argv: ['--seed', '42', '--scenario', scenarioFile],
      env: { PATH: process.env.PATH ?? '' },
      mcpServers: [],
      prompt,
    },
    {
      clock: new TestClock(),
      ledger: {
        ...sqliteLedgerSink({ db, runId: RUN_ID, epoch }),
        async appendIo(chunk) {
          chunks.push(Buffer.from(chunk.data).toString('utf8'));
          return 0 as never;
        },
      },
      captureEvidence: () => `artifact://${'f'.repeat(64)}` as never,
    },
  );

  return { transcript: chunks.join('') };
}

suite('a gate reads its criteria from the ledger (EPIC-09-S25, test plan #9)', () => {
  it("names the criterion the agent's context no longer contains", async () => {
    const spec = await approvedSpec();
    const { db, epoch } = openRunLedger(spec);

    const { transcript } = await runStrippedGateNode(db, epoch);
    // The agent really did lose it: nothing in what it received or said names
    // the criterion.
    expect(transcript).not.toContain(CRITERION);
    expect(transcript).not.toContain(CRITERION_TEXT);

    const resolved = await gateSpecFromLedger(ledgerEvents(db));

    expect(resolved.specHash).toBe(spec.specHash);
    expect(resolved.criteria.map((criterion) => criterion.id)).toEqual([CRITERION]);
    expect(resolved.criteria[0]?.statement).toBe(CRITERION_TEXT);
    db.close();
  });

  it('needs no vendor CLI and no credentials to say so', () => {
    expect(mockAgentBinary().path).toBe(MOCK_AGENT_BIN);
  });
});

suite('a passing gate is not evidence a prohibition was honoured (EPIC-09-S25)', () => {
  it('the violating tool call stays in the ledger, and resolving the spec does not touch it', async () => {
    const spec = await approvedSpec();
    const { db, epoch } = openRunLedger(spec);

    // A prohibition that was violated by a tool call mid-run. Recorded as the
    // node runner records one, so the ConstraintRot grading — which reads tool
    // calls and nothing else — still sees it.
    appendEvents(db, [
      {
        runId: RUN_ID,
        ts: 1_754_470_002_000,
        kind: 'node.progress',
        v: 1,
        epoch,
        nodeId: 'implement',
        attempt: 0,
        payload: {
          node: 'implement',
          attempt: 0,
          phase: 'tool_call',
          message: 'edit the shared helper · src/shared/money.ts',
        },
      },
    ]);

    const resolved = await gateSpecFromLedger(ledgerEvents(db));
    const toolCalls = ledgerEvents(db).filter(
      (event) => event.kind === 'node.progress' && event.payload.phase === 'tool_call',
    );

    // The criteria resolve cleanly — a green board — and the violation is
    // still there, in a different reading of the same ledger. Neither
    // suppresses the other, which is the whole of §4.2's warning.
    expect(resolved.criteria).toHaveLength(1);
    expect(toolCalls).toHaveLength(1);
    db.close();
  });
});
