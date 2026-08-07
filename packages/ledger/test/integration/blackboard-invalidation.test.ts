/**
 * KAR-09.8 AC7, AC8 / EPIC-09-S44 — invalidation taints earlier readers and
 * re-runs nothing (docs/08-context-and-memory.md §8.2).
 *
 * > Auto-re-running on invalidation is how you build a system that loops
 * > forever for reasons no human can reconstruct — and it interacts badly with
 * > F4.6 budget ceilings.
 *
 * Two claims, and the second is the one worth the integration cost. The first
 * is arithmetic — `event_seq < invalidation seq`, off by one in either
 * direction taints everything or nothing. The second is an *absence*: after the
 * invalidation, `decide()` must still produce no command for the node, which
 * can only be asserted against a state folded from a real ledger that holds
 * both the run's events and the fact events beside them.
 *
 * Verifies: EPIC-09-S44 · AC7, AC8
 */
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { decide, foldEvents, RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  drainEvents,
  invalidateFact,
  openLedger,
  readFacts,
  readTaintedNodes,
  rebuildBlackboard,
  resolveDeclaredReads,
  writeFact,
} from '../../src/index.ts';
import { fact, factId, fakeRegistry, nodeId } from './support/facts.ts';

const RUN: RunId = RunIdSchema.parse('run_20260807T093000Z_7a8b9c');
const NOW = 1_754_557_200_000;
const ENV = { runId: RUN, ts: NOW, epoch: 1 } as const;
const REGISTRY = fakeRegistry({ registered: ['DeFlow.finding.v1'] });
const KEY = 'finding/db-uses-postgres';
const FACT_ID = factId(KEY);

const MIGRATE = nodeId('migrate');
const VERIFY = nodeId('verify');

const read = (db: Db, by: NodeId): void => {
  const resolved = resolveDeclaredReads(db, { ...ENV, by, reads: [{ kind: 'fact', key: KEY }] });
  if (resolved.length !== 1) throw new Error(`${by} resolved ${resolved.length} facts`);
};

/**
 * The EPIC-09-S44 background: "migrate" reads the fact, the fact is
 * invalidated, and only *then* does "verify" read it. The scenario names seqs
 * 10, 30 and 40; what matters is the order, and the order is what a ledger
 * assigns rather than what a fixture asserts.
 */
function seedInvalidation(db: Db): { readonly invalidatedAt: number } {
  const written = writeFact(db, REGISTRY, fact({ key: KEY, byNode: 'recon' }), ENV);
  if (!written.ok) throw new Error('fixture fact was refused');

  read(db, MIGRATE);
  const invalidation = invalidateFact(db, {
    ...ENV,
    factId: FACT_ID,
    by: nodeId('recon-2'),
    reason: 'the database is mysql after all',
  });
  read(db, VERIFY);

  return { invalidatedAt: invalidation.seq };
}

suite('only readers strictly earlier than the invalidation are tainted (AC7)', () => {
  it('taints the earlier reader and leaves the later one alone', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedInvalidation(db);

      expect(readTaintedNodes(db, RUN).map((item) => item.node)).toEqual([MIGRATE]);
    } finally {
      db.close();
    }
  });

  it('puts exactly that list on the fact.invalidated event', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const written = writeFact(db, REGISTRY, fact({ key: KEY }), ENV);
      expect(written.ok).toBe(true);
      read(db, MIGRATE);

      const invalidation = invalidateFact(db, {
        ...ENV,
        factId: FACT_ID,
        by: nodeId('recon-2'),
        reason: 'the database is mysql after all',
      });

      expect(invalidation.taints).toEqual([MIGRATE]);
      const event = [...drainEvents(db, RUN)].find((row) => row.seq === invalidation.seq);
      expect((event?.payload as { taints: string[] }).taints).toEqual(['migrate']);
    } finally {
      db.close();
    }
  });

  it('marks the fact invalidated without removing it', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const { invalidatedAt } = seedInvalidation(db);

      const [stored] = readFacts(db, RUN);
      expect(stored?.fact.invalidatedBy).toBe(invalidatedAt);
      expect(stored?.fact.value).toEqual({ claim: 'auth uses jwt' });
    } finally {
      db.close();
    }
  });

  it('survives a rebuild: the seq comparison is in the projection, not the append', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedInvalidation(db);
      db.exec('DROP TABLE fact');
      db.exec('DROP TABLE fact_edges');

      rebuildBlackboard(db);

      // Replay sees "verify"'s read *after* the invalidation exactly as the
      // live path did, because both read the same `< seq` rule off the same
      // rows. A projection that recorded the taint at append time instead
      // would come back from a rebuild with both nodes tainted.
      expect(readTaintedNodes(db, RUN).map((item) => item.node)).toEqual([MIGRATE]);
    } finally {
      db.close();
    }
  });

  it('carries the reason and the creating seq, for the approval queue', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const { invalidatedAt } = seedInvalidation(db);

      expect(readTaintedNodes(db, RUN)).toEqual([
        {
          kind: 'tainted',
          runId: RUN,
          node: MIGRATE,
          taint: 'stale-input',
          factId: FACT_ID,
          key: KEY,
          reason: 'the database is mysql after all',
          seq: invalidatedAt,
          readAtSeq: expect.any(Number),
        },
      ]);
    } finally {
      db.close();
    }
  });
});

suite('nothing is re-run automatically (AC8)', () => {
  /** The smallest plan `decide` will schedule from: one completed agent node. */
  const agentNode = (id: string) => ({
    id,
    title: `do ${id}`,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [{ kind: 'fact', key: KEY }],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    brief: `brief for ${id}`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'always-replay',
  });

  const PLAN_HASH = `sha256-${'a'.repeat(64)}`;

  function startedRun(db: Db): void {
    appendEvents(db, [
      {
        runId: RUN,
        ts: NOW,
        kind: 'plan.proposed',
        v: 1,
        epoch: 1,
        payload: {
          version: 1,
          planHash: PLAN_HASH,
          by: 'planner',
          graph: {
            schemaId: 'DeFlow.plangraph.v1',
            runId: RUN,
            version: 1,
            planHash: PLAN_HASH,
            parent: null,
            taskSpecHash: `sha256-${'c'.repeat(64)}`,
            createdBy: 'planner',
            createdAt: '2026-08-07T09:30:00.000Z',
            nodes: [agentNode('migrate')],
            edges: [],
          },
        },
      },
      {
        runId: RUN,
        ts: NOW,
        kind: 'run.started',
        v: 1,
        epoch: 1,
        payload: { planHash: PLAN_HASH },
      },
      {
        runId: RUN,
        ts: NOW,
        kind: 'node.completed',
        v: 1,
        epoch: 1,
        payload: {
          node: 'migrate',
          attempt: 0,
          result: {
            status: 'completed',
            output: { summary: 'migrated' },
            outputSchemaId: 'DeFlow.artifact.v1',
            usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
            costUsd: 0.42,
            producedFacts: [],
            artifacts: [],
          },
        },
      },
    ]);
  }

  it('produces no StartNode for the tainted node after the invalidation', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      startedRun(db);
      seedInvalidation(db);

      const { state } = foldEvents(drainEvents(db, RUN));
      const commands = decide(state, NOW + 1000);

      expect(readTaintedNodes(db, RUN).map((item) => item.node)).toEqual([MIGRATE]);
      expect(commands.filter((command) => command.kind === 'StartNode')).toEqual([]);
      // Not even a wake: a tainted node is a question for a human, and a timer
      // is how "flag it" quietly becomes "retry it" three releases later.
      expect(commands.some((command) => command.kind === 'ScheduleWake')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('leaves the node completed rather than reopening the attempt', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      startedRun(db);
      seedInvalidation(db);

      const { state } = foldEvents(drainEvents(db, RUN));
      expect(state.nodes.migrate?.status).toBe('completed');
      expect(state.nodes.migrate?.attempt).toBe(0);
    } finally {
      db.close();
    }
  });
});
