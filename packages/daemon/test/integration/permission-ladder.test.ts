/**
 * KAR-08.1 — the ladder answering a real agent over a real pipe.
 *
 * The unit suite (../../src/services/permission-ladder.test.ts) proves the
 * decider decides. What only a process boundary can prove is that the answer
 * is a *shape the agent accepts*: the frame goes out over stdio, the agent
 * parses it, and it takes the branch DeFlow intended. A decider that returns a
 * perfectly correct object the SDK cannot serialise wedges the node, and no
 * amount of unit testing sees it.
 *
 * A real mock agent, a real worktree on disk, a real ledger, no vendor CLI, no
 * credential and no network — which is the whole ACP-first argument in one
 * test file.
 *
 * Verifies: EPIC-08-S5, EPIC-08-S6 · AC6, AC7
 */

import type { EventRecord, IoRecord, LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  type EventSeq,
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type PermissionScope,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  blobHandle,
  openLedger,
  readEpoch,
  readRange,
  spillBytes,
} from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpPermissionHandlers,
  createPermissionService,
  type GatedPermissionRequest,
  type LadderDecision,
  ladderDecider,
} from '../../src/index.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260806T101500Z_ac0801');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

let dir = '';
let worktree = '';
let db: ReturnType<typeof openLedger>;
let sink: LedgerSink;
let captureEvidence: (text: string) => Handle;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(join(worktree, 'src'), { recursive: true });
  db = openLedger(dir);
  const epoch = readEpoch(db);
  sink = {
    append: (event: EventRecord) =>
      Promise.resolve(
        appendEvents(db, [
          {
            runId: RUN_ID,
            ts: event.ts,
            kind: event.kind,
            v: event.v,
            epoch,
            nodeId: event.nodeId,
            attempt: event.attempt,
            ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
            payload: event.payload,
          },
        ])[0] as EventSeq,
      ),
    appendIo: (chunk: IoRecord) =>
      Promise.resolve(
        appendIoChunk(db, {
          runId: RUN_ID,
          nodeId: chunk.nodeId,
          attempt: chunk.attempt + 1,
          stream: chunk.stream,
          ts: chunk.ts,
          data: chunk.data,
        }),
      ),
  };
  captureEvidence = (text: string): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(dir, Buffer.from(text, 'utf8'), 'text/plain').sha256));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

const scopeFor = (): PermissionScope => ({
  worktree,
  allowlist: ['git', 'pnpm', 'node', 'eslint'],
  readOnlyCommands: ['git status', 'git log', 'ls', 'cat'],
  allowedDomains: ['registry.npmjs.org'],
  scrubbedEnv: [],
});

const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
];

/** One permission round trip per entry, each with its own three branches, so
 * the transcript says which way every one of them went. */
async function scenario(
  requests: readonly { readonly toolKind: string; readonly path: string }[],
): Promise<string> {
  const path = join(dir, 'ladder.json');
  await writeFile(
    path,
    JSON.stringify({
      name: 'ladder',
      steps: requests.map((request, index) => ({
        type: 'permission',
        title: `Request ${index}`,
        toolKind: request.toolKind,
        path: request.path,
        options: OPTIONS,
        // No `stopReason` on the two continuing branches: the turn carries on
        // with the rest of the script, which is what lets one scenario hold 42
        // round trips.
        onAllowed: { steps: [{ type: 'message', text: `allowed:${index}` }] },
        onRejected: { steps: [{ type: 'message', text: `rejected:${index}` }] },
        onCancelled: {
          steps: [{ type: 'message', text: `cancelled:${index}` }],
          stopReason: 'cancelled',
        },
      })),
      stopReason: 'end_turn',
    }),
  );
  return path;
}

async function runWith(
  decide: Parameters<typeof createPermissionService>[0],
  scenarioPath: string,
  permission: 'read' | 'worktree' | 'worktree+net' | 'full' = 'worktree',
): Promise<Awaited<ReturnType<typeof runAcpNode>>> {
  return runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission,
      worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'b'.repeat(64) },
      argv: ['--seed', '42', '--scenario', scenarioPath],
      mcpServers: [],
      prompt: 'go',
    },
    {
      clock: new TestClock(),
      ledger: sink,
      captureEvidence,
      handlers: acpPermissionHandlers(createPermissionService(decide)),
    },
  );
}

/** Every control-plane event kind appended for this run, in `seq` order. */
const kinds = (): string[] => readRange(db, RUN_ID, 0, 500).events.map((event) => event.kind);

const transcript = (outcome: Awaited<ReturnType<typeof runAcpNode>>): string =>
  outcome.status === 'completed' ? ((outcome.result.output as { text: string }).text ?? '') : '';

suite('EPIC-08-S5 — routine requests are auto-answered without a human', () => {
  it('approves an in-scope edit within the same turn, and asks nobody', async () => {
    const escalations: GatedPermissionRequest[] = [];
    const outcome = await runWith(
      ladderDecider({
        level: 'worktree',
        scope: scopeFor(),
        escalate: (gated) => {
          escalations.push(gated);
          return Promise.resolve(null);
        },
      }),
      await scenario([{ toolKind: 'edit', path: join(worktree, 'src', 'a.ts') }]),
    );

    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).toContain('allowed:0');
    expect(escalations).toEqual([]);
    // "And the operator's approval queue is unchanged."
    expect(kinds()).not.toContain('human.requested');
  });

  it('emits zero escalations across 30 in-scope edits and 12 in-scope reads', async () => {
    // The gate budget, on the wire rather than in a loop over the decider:
    // 42 round trips through a real agent, and nobody is interrupted.
    const requests = [
      ...Array.from({ length: 30 }, (_unused, index) => ({
        toolKind: 'edit',
        path: join(worktree, 'src', `f${index}.ts`),
      })),
      ...Array.from({ length: 12 }, (_unused, index) => ({
        toolKind: 'read',
        path: join(worktree, 'src', `r${index}.ts`),
      })),
    ];
    const decisions: LadderDecision[] = [];
    let escalated = 0;

    const outcome = await runWith(
      ladderDecider({
        level: 'worktree',
        scope: scopeFor(),
        escalate: () => {
          escalated += 1;
          return Promise.resolve(null);
        },
        record: (decision) => decisions.push(decision),
      }),
      await scenario(requests),
    );

    expect(outcome.status).toBe('completed');
    expect(decisions).toHaveLength(42);
    expect(decisions.every((decision) => decision.answered === 'allow')).toBe(true);
    expect(escalated).toBe(0);
    expect(kinds()).not.toContain('human.requested');
  });

  it('rejects an out-of-worktree write and the agent carries on with its turn', async () => {
    const outcome = await runWith(
      ladderDecider({ level: 'worktree', scope: scopeFor() }),
      await scenario([
        { toolKind: 'edit', path: join(dir, 'elsewhere.ts') },
        { toolKind: 'edit', path: join(worktree, 'src', 'b.ts') },
      ]),
    );

    expect(outcome.status).toBe('completed');
    // A denial is not a teardown: the agent got its rejection and kept going.
    expect(transcript(outcome)).toContain('rejected:0');
    expect(transcript(outcome)).toContain('allowed:1');
  });
});

suite('EPIC-08-S6 — cancelled is an outcome, not an error', () => {
  it('answers cancelled, and the node ends cancelled rather than failed', async () => {
    const outcome = await runWith(
      ladderDecider({
        level: 'worktree+net',
        scope: scopeFor(),
        // The run is cancelled while the request is outstanding: nobody is
        // ever going to answer it.
        escalate: () => Promise.resolve(null),
      }),
      await scenario([{ toolKind: 'fetch', path: 'https://evil.example/payload' }]),
    );

    expect(outcome.status).toBe('cancelled');
    if (outcome.status !== 'cancelled') return;
    expect(outcome.stopReason).toBe('cancelled');
    // The process ended of its own accord — the harness did not kill it — and
    // nothing on the path built a failure.
    expect(outcome.exit).toEqual({ code: 0, signal: null });
    expect(kinds()).not.toContain('node.failed');
  });

  it('records the cancellation as its own outcome rather than as a denial', async () => {
    const decisions: LadderDecision[] = [];
    await runWith(
      ladderDecider({
        level: 'worktree+net',
        scope: scopeFor(),
        escalate: () => Promise.resolve(null),
        record: (decision) => decisions.push(decision),
      }),
      await scenario([{ toolKind: 'fetch', path: 'https://evil.example/payload' }]),
    );

    expect(decisions.map((decision) => decision.answered)).toEqual(['cancelled']);
    expect(decisions[0]?.outcome).toBe('gate');
    expect(decisions[0]?.reason).toEqual({
      code: 'domain-not-allowlisted',
      detail: 'evil.example',
    });
  });
});
