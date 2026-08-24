/**
 * KAR-23.5 / KAR-05.9 AC6 — the row and the event that explains it land in one
 * transaction, and `clear` ends the row rather than deleting it.
 *
 * This implementation lived in a test-support file until an execution node
 * needed one and there was no production caller, so the kill switch answered
 * `nothing-running` while three vendor children were alive (2026-08-24). Now
 * that it ships, the two properties the kill switch actually stands on get
 * asserted against a real file-backed ledger: `readProcesses` finds a live row
 * carrying the group, and after `clear` there is no live row left to signal.
 */
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { EVENT_CURRENT_VERSIONS, ikey as makeIkey, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { openLedger, readEpoch, readProcesses, readRange } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { sqliteProcessRegistry } from './process-registry.ts';

const RUN: RunId = RunIdSchema.parse('run_20260824T001500Z_a23060');
const NODE: NodeId = NodeIdSchema.parse('n1');
const TS = 1_800_000_000_000;

async function ledger(tmp: string): Promise<Db> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  return openLedger(dataDir);
}

const startedEvent = (attempt: number) => ({
  kind: 'node.started',
  v: (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)['node.started'] ?? 1,
  ts: TS,
  nodeId: NODE,
  attempt,
  ikey: makeIkey(RUN, NODE, attempt, 0),
  payload: {
    node: NODE,
    attempt,
    ikey: makeIkey(RUN, NODE, attempt, 0),
    binary: { path: '/opt/DeFlow/claude', version: '2.1.220', sha256: 'b'.repeat(64) },
  },
});

const processRow = (attempt: number, pgid: number) => ({
  runId: RUN,
  nodeId: NODE,
  attempt,
  pid: pgid,
  pgid,
  startedAt: '1234',
  binarySha256: 'b'.repeat(64),
  worktree: '/tmp/wt',
  spawnedAt: TS,
});

suite('KAR-23.5 — the process registry DeFlowd ships', () => {
  it('writes the process row and the node.started that explains it together', async ({ tmp }) => {
    const db = await ledger(tmp);
    try {
      const registry = sqliteProcessRegistry({ db, runId: RUN, epoch: readEpoch(db) });
      const seq = await registry.appendWithProcess(startedEvent(0), processRow(0, 4242));

      const events = readRange(db, RUN, 0, 10).events;
      expect(events.map((event) => event.kind)).toEqual(['node.started']);
      expect(events[0]?.seq).toBe(seq);

      const live = readProcesses(db).filter((row) => row.runId === RUN);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ nodeId: NODE, attempt: 0, pgid: 4242, state: 'live' });
    } finally {
      db.close();
    }
  });

  it('leaves no live row for an attempt it has cleared', async ({ tmp }) => {
    const db = await ledger(tmp);
    try {
      const registry = sqliteProcessRegistry({ db, runId: RUN, epoch: readEpoch(db) });
      await registry.appendWithProcess(startedEvent(0), processRow(0, 4242));
      await registry.clear({ runId: RUN, nodeId: NODE, attempt: 0 });

      expect(readProcesses(db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('treats a retry as a different process', async ({ tmp }) => {
    const db = await ledger(tmp);
    try {
      const registry = sqliteProcessRegistry({ db, runId: RUN, epoch: readEpoch(db) });
      await registry.appendWithProcess(startedEvent(0), processRow(0, 4242));
      await registry.appendWithProcess(startedEvent(1), processRow(1, 4343));
      // Clearing the first attempt must not reach the retry that replaced it —
      // the kill switch reads *every* live row, and a `clear` that swept the
      // node would leave the live child unreachable.
      await registry.clear({ runId: RUN, nodeId: NODE, attempt: 0 });

      const live = readProcesses(db).filter((row) => row.state === 'live');
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ attempt: 1, pgid: 4343 });
    } finally {
      db.close();
    }
  });
});
