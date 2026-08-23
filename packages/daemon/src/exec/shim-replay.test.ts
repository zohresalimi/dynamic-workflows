/**
 * KAR-23.5 — `seenShimUuids` reads back exactly what `runShimNode` wrote.
 *
 * The port it feeds is what stops a crash-replay appending a whole transcript
 * a second time (KAR-05.8 AC4), and the only thing standing between the two is
 * the shape of one `node.progress` message. So the rows here are written in
 * that shape — `phase: shim.<type>`, `message: uuid=<id>[ · N bytes spilled to
 * …]` — and the ledger is real: the claim is about rows that survived a
 * transaction, not about a map this file also built.
 *
 * The `uuid=none` row is not decoration either. A line the vendor emitted
 * without a uuid is genuinely undedupable, and remembering it under the string
 * `"none"` would make the *next* uuid-less line look already-durable and drop
 * it from the transcript for ever.
 */
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { EVENT_CURRENT_VERSIONS, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger, readEpoch } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { seenShimUuids } from './shim-replay.ts';

const RUN: RunId = RunIdSchema.parse('run_20260824T001500Z_a23050');
const NODE: NodeId = NodeIdSchema.parse('n1');
const OTHER: NodeId = NodeIdSchema.parse('n2');

const version = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

async function ledger(tmp: string): Promise<Db> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  return openLedger(dataDir);
}

/** One row in the exact shape `runShimNode`'s `fileLine` appends. */
function progress(
  db: Db,
  epoch: number,
  input: {
    readonly nodeId: NodeId;
    readonly attempt: number;
    readonly phase: string;
    readonly message: string;
  },
): void {
  appendEvents(db, [
    {
      runId: RUN,
      ts: 1_800_000_000_000,
      kind: 'node.progress',
      v: version('node.progress'),
      epoch,
      nodeId: input.nodeId,
      attempt: input.attempt,
      payload: {
        node: input.nodeId,
        attempt: input.attempt,
        phase: input.phase,
        message: input.message,
      },
    },
  ]);
}

suite('KAR-23.5 — the uuids a shim attempt has already made durable', () => {
  it('reads the uuid out of every shim progress row for this attempt', async ({ tmp }) => {
    const db = await ledger(tmp);
    const epoch = readEpoch(db);
    try {
      progress(db, epoch, {
        nodeId: NODE,
        attempt: 0,
        phase: 'shim.assistant',
        message: 'uuid=6f0b5f7e-1111-4111-8111-111111111111',
      });
      progress(db, epoch, {
        nodeId: NODE,
        attempt: 0,
        phase: 'shim.result',
        message: 'uuid=6f0b5f7e-2222-4222-8222-222222222222',
      });

      expect([...seenShimUuids(db, RUN, NODE, 0)]).toEqual([
        '6f0b5f7e-1111-4111-8111-111111111111',
        '6f0b5f7e-2222-4222-8222-222222222222',
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps the uuid of a spilled line, whose message carries a handle after it', async ({
    tmp,
  }) => {
    const db = await ledger(tmp);
    const epoch = readEpoch(db);
    try {
      progress(db, epoch, {
        nodeId: NODE,
        attempt: 0,
        phase: 'shim.assistant',
        message: `uuid=6f0b5f7e-3333-4333-8333-333333333333 · 262144 bytes spilled to blob:sha256-${'a'.repeat(64)}`,
      });

      expect([...seenShimUuids(db, RUN, NODE, 0)]).toEqual([
        '6f0b5f7e-3333-4333-8333-333333333333',
      ]);
    } finally {
      db.close();
    }
  });

  it('remembers nothing for a line the vendor emitted without a uuid', async ({ tmp }) => {
    const db = await ledger(tmp);
    const epoch = readEpoch(db);
    try {
      progress(db, epoch, {
        nodeId: NODE,
        attempt: 0,
        phase: 'shim.line',
        message: 'uuid=none',
      });

      expect([...seenShimUuids(db, RUN, NODE, 0)]).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not let one attempt, node or phase inherit another', async ({ tmp }) => {
    const db = await ledger(tmp);
    const epoch = readEpoch(db);
    try {
      progress(db, epoch, {
        nodeId: NODE,
        attempt: 0,
        phase: 'shim.assistant',
        message: 'uuid=first-attempt',
      });
      progress(db, epoch, {
        nodeId: OTHER,
        attempt: 1,
        phase: 'shim.assistant',
        message: 'uuid=other-node',
      });
      // The ACP path writes `node.progress` too; its rows are a different
      // dialect and must not be read as shim line ids.
      progress(db, epoch, {
        nodeId: NODE,
        attempt: 1,
        phase: 'acp.thought',
        message: 'uuid=not-a-shim-line',
      });

      // A retry is a different turn: it inherits nothing.
      expect([...seenShimUuids(db, RUN, NODE, 1)]).toEqual([]);
      expect([...seenShimUuids(db, RUN, NODE, 0)]).toEqual(['first-attempt']);
    } finally {
      db.close();
    }
  });

  it('answers an empty set for a first attempt with nothing behind it', async ({ tmp }) => {
    const db = await ledger(tmp);
    try {
      expect(seenShimUuids(db, RUN, NODE, 0).size).toBe(0);
    } finally {
      db.close();
    }
  });
});
