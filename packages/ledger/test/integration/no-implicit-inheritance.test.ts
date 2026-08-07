/**
 * KAR-09.2 AC9 / EPIC-09-S10 — F6.1: a node receives what the engine
 * constructs and nothing else.
 *
 * The parent's transcript is written into `io_chunk` for real, at the size a
 * real recon node produces, because the leak this spec exists to catch is a
 * convenience read — "while we are here, give the child what its parent saw" —
 * and that read only exists where the transcript really is. The assertion is a
 * **content-hash set intersection** rather than a substring scan, as the
 * scenario demands: eyeballing a 100k-token prompt for a fragment of another
 * one is how a leak survives review.
 *
 * Verifies: EPIC-09-S10 · AC9 · test plan #9
 */
import type { RunId, Segment, TaskSpec } from '@DeFlow/core';
import {
  buildPacket,
  contentHash,
  contextSegment,
  RunIdSchema,
  TaskSpecSchema,
} from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  appendIoChunks,
  openLedger,
  readIoChunks,
  resolveDeclaredReads,
  writeFact,
} from '../../src/index.ts';
import { fact, fakeRegistry } from './support/facts.ts';

const specFixture = fileURLToPath(
  new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
);

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(specFixture, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const RUN: RunId = RunIdSchema.parse('run_20260807T091500Z_4d5e6f');
const ENV = { runId: RUN, ts: 1_754_557_200_000, epoch: 1 } as const;
const REGISTRY = fakeRegistry({ registered: ['DeFlow.finding.v1'] });

/**
 * ~100,000 tokens of recon transcript, in the 8 KiB chunks a real stdout pump
 * emits. `heuristicTokens` is four characters per token, so 400,000 characters
 * is the figure the scenario names.
 */
const TRANSCRIPT_CHUNKS = 50;
const CHUNK_CHARS = 8000;

function seedParentTranscript(db: ReturnType<typeof openLedger>): void {
  appendIoChunks(
    db,
    Array.from({ length: TRANSCRIPT_CHUNKS }, (_unused, index) => ({
      runId: RUN,
      nodeId: 'recon',
      attempt: 1,
      stream: 'stdout' as const,
      ts: ENV.ts + index,
      data: Buffer.from(`recon chunk ${index}: ${'y'.repeat(CHUNK_CHARS)}`, 'utf8'),
    })),
  );
}

/** Every content hash of the parent's recorded transcript. */
async function transcriptHashes(db: ReturnType<typeof openLedger>): Promise<Set<string>> {
  const page = readIoChunks(db, { runId: RUN, nodeId: 'recon', attempt: 1 }, 0, 1000);
  const hashes = new Set<string>();
  for (const chunk of page.chunks) {
    hashes.add(await contentHash(Buffer.from(chunk.data).toString('utf8')));
  }
  return hashes;
}

/** The `implement` packet, built from its declared reads and nothing else. */
async function implementPacket(db: ReturnType<typeof openLedger>, attempt: number) {
  const resolved = resolveDeclaredReads(db, {
    ...ENV,
    by: 'implement',
    reads: [{ kind: 'fact', key: 'finding/*' }],
  });
  const segments: Segment[] = [
    await contextSegment({
      id: 'brief',
      kind: 'task.brief',
      text: 'Port CheckoutForm to <script setup>.',
      sourceEvent: 20,
    }),
  ];
  for (const [index, entry] of resolved.entries()) {
    segments.push(
      await contextSegment({
        id: `fact-${index}`,
        kind: 'fact',
        text: `${entry.fact.key} = ${JSON.stringify(entry.fact.value)}`,
        sourceEvent: entry.sourceEvent,
      }),
    );
  }
  const built = await buildPacket({
    runId: RUN,
    nodeId: 'implement',
    attempt,
    builtAtEvent: 60,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
      sourceEvent: 9,
    },
    segments,
  });
  return built.packet;
}

suite('the child packet shares no content with the parent transcript (EPIC-09-S10)', () => {
  it('has a contentHash set disjoint from the recon transcript', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedParentTranscript(db);
    const written = writeFact(db, REGISTRY, fact({ key: 'finding/auth-uses-jwt' }), ENV);
    expect(written.ok).toBe(true);

    const packet = await implementPacket(db, 0);

    const parent = await transcriptHashes(db);
    expect(parent.size).toBe(TRANSCRIPT_CHUNKS);
    const child = new Set(packet.segments.map((segment) => segment.contentHash));
    expect([...child].filter((hash) => parent.has(hash))).toEqual([]);
    expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
    db.close();
  });

  it('does not leak a previous attempt into the retry', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedParentTranscript(db);
    writeFact(db, REGISTRY, fact({ key: 'finding/auth-uses-jwt' }), ENV);

    const first = await implementPacket(db, 0);
    // Attempt 0 produced 20,000 tokens of its own output before it failed.
    appendIoChunks(db, [
      {
        runId: RUN,
        nodeId: 'implement',
        attempt: 1,
        stream: 'stdout',
        ts: ENV.ts,
        data: Buffer.from('z'.repeat(80_000), 'utf8'),
      },
    ]);
    const retry = await implementPacket(db, 1);

    expect(retry.attempt).toBe(1);
    expect({ ...retry, attempt: 0 }).toEqual({ ...first, attempt: 0 });
    // The pinned block is re-injected byte-identically, not re-derived.
    expect(retry.pinnedDigests).toEqual(first.pinnedDigests);
    db.close();
  });
});
