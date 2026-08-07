/**
 * KAR-09.8 — the blackboard's shape, its acceptance gate and the read edges
 * that exist because a packet was built (docs/08-context-and-memory.md §8,
 * docs/04-domain-model.md §5).
 *
 * File-backed through `openLedger` rather than `:memory:`, even though the
 * projection itself is pure: the claims under test are that migration 0011
 * created a particular schema and that a rejected fact leaves *no row behind*,
 * and neither can be observed against a table a spec created for itself.
 *
 * Verifies: EPIC-09-S43, EPIC-09-S45 · AC1, AC4, AC5, AC6, AC9
 */
import type { Db, EventSeq, RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  invalidateFact,
  openLedger,
  readFactByKey,
  readFactEdges,
  readFacts,
  readRange,
  resolveDeclaredReads,
  writeFact,
} from '../../src/index.ts';
import { fact, factId, fakeRegistry, nodeId } from './support/facts.ts';

const RUN: RunId = RunIdSchema.parse('run_20260807T090000Z_1a2b3c');
const TS = 1_754_557_200_000;
const ENV = { runId: RUN, ts: TS, epoch: 1 } as const;

const REGISTRY = fakeRegistry({
  registered: [
    'DeFlow.finding.v1',
    'DeFlow.verdict.v1',
    'DeFlow.scope.v1',
    'ext.migration.vue3incompat.v1',
  ],
  // A `verdict` value is legal here only when it carries a `status`; that is
  // the whole of the "value violates its schema" case, expressed as data.
  rejects: (schemaId, value) =>
    schemaId === 'DeFlow.verdict.v1' &&
    (typeof value !== 'object' || value === null || !('status' in value))
      ? [{ pointer: '/status', message: "must have required property 'status'" }]
      : [],
});

const factEvents = (db: Db): string[] =>
  readRange(db, RUN, 0, 500)
    .events.filter((event) => event.kind.startsWith('fact.'))
    .map((event) => event.kind);

suite('the migration creates the documented shape (AC1, EPIC-09-S42 scenario 3)', () => {
  it('gives fact_edges the four documented columns', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const columns = db
        .prepare<{ name: string }>("SELECT name FROM pragma_table_info('fact_edges')")
        .all()
        .map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(['fact_id', 'node_id', 'direction', 'event_seq']),
      );
    } finally {
      db.close();
    }
  });

  it('constrains direction to read or write', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const sql = db
        .prepare<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'fact_edges'")
        .get()?.sql;
      expect(sql).toContain("CHECK (direction IN ('read','write'))");
    } finally {
      db.close();
    }
  });

  it('creates both documented indexes', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const indexes = db
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fact_edges'",
        )
        .all()
        .map((row) => row.name)
        .sort();
      expect(indexes).toEqual(expect.arrayContaining(['fact_edges_by_fact', 'fact_edges_by_node']));
    } finally {
      db.close();
    }
  });
});

suite('acceptance by kind and schema (AC4, AC5, EPIC-09-S43)', () => {
  it('accepts a core-kind fact whose value satisfies its schema', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const written = writeFact(db, REGISTRY, fact(), ENV);
      expect(written.ok).toBe(true);
      expect(readFacts(db, RUN).map((stored) => stored.fact.key)).toEqual([
        'finding/auth-uses-jwt',
      ]);
      // The write edge exists because the fact was written, not because a
      // second call remembered to record it.
      expect(readFactEdges(db, RUN)).toEqual([
        {
          runId: RUN,
          factId: factId('finding/auth-uses-jwt'),
          node: nodeId('recon'),
          direction: 'write',
          eventSeq: 1,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects a verdict whose value violates its schema before anything is appended', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const written = writeFact(
        db,
        REGISTRY,
        fact({ key: 'verdict/typecheck', schemaId: 'DeFlow.verdict.v1', value: { findings: [] } }),
        ENV,
      );

      expect(written.ok).toBe(false);
      if (written.ok) return;
      expect(written.error.kind).toBe('schema-invalid');
      expect(written.error.message).toContain('DeFlow.verdict.v1');
      // "Rejected before the event is appended" is the claim, and an empty
      // ledger is the only thing that can witness it.
      expect(factEvents(db)).toEqual([]);
      expect(readFacts(db, RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rejects an ext fact whose schemaId is not registered, naming the schema', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const written = writeFact(
        db,
        REGISTRY,
        fact({
          key: 'ext:migration/vue3-incompat-list',
          schemaId: 'ext.migration.unregistered.v1',
          value: { files: [] },
        }),
        ENV,
      );

      expect(written.ok).toBe(false);
      if (written.ok) return;
      expect(written.error.kind).toBe('unknown-schema-id');
      expect(written.error.message).toContain('ext.migration.unregistered.v1');
      expect(written.error.message).toContain('.DeFlow/schemas');
      expect(factEvents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('accepts a registered ext fact without knowing what the namespace means', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const written = writeFact(
        db,
        REGISTRY,
        fact({
          key: 'ext:migration/vue3-incompat-list',
          schemaId: 'ext.migration.vue3incompat.v1',
          value: { anything: ['at', 'all'] },
        }),
        ENV,
      );

      expect(written.ok).toBe(true);
      const [stored] = readFacts(db, RUN);
      expect(stored?.fact.kind).toBe('ext');
      expect(stored?.fact.value).toEqual({ anything: ['at', 'all'] });
    } finally {
      db.close();
    }
  });

  it('rejects a key whose kind is not one of the six, with nothing appended', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const written = writeFact(
        db,
        REGISTRY,
        { ...fact(), key: 'nonsense/thing', kind: 'nonsense' },
        ENV,
      );

      expect(written.ok).toBe(false);
      if (written.ok) return;
      expect(written.error.kind).toBe('malformed-fact');
      expect(factEvents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps every field of provenance verbatim, including the model string', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      writeFact(db, REGISTRY, fact(), ENV);
      const [stored] = readFacts(db, RUN);
      expect(stored?.fact.provenance).toEqual({
        byNode: 'recon',
        byProvider: 'claude-code',
        byModel: 'claude-sonnet-4-6-20260514',
        fromEvidence: [`artifact://${'b'.repeat(64)}`],
        atEvent: 7,
        at: '2026-08-07T09:00:00.000Z',
        confidence: 'asserted',
      });
    } finally {
      db.close();
    }
  });

  it('orders facts by atEvent, not by the display timestamp', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // Written in the same millisecond, in the opposite order to atEvent.
      writeFact(db, REGISTRY, fact({ key: 'finding/second', atEvent: 40 }), ENV);
      writeFact(db, REGISTRY, fact({ key: 'finding/first', atEvent: 12 }), ENV);

      expect(readFacts(db, RUN).map((stored) => stored.fact.key)).toEqual([
        'finding/first',
        'finding/second',
      ]);
    } finally {
      db.close();
    }
  });
});

suite('resolving a declared read writes the edge (AC6, EPIC-09-S45)', () => {
  const threeFindings = (db: Db): EventSeq[] =>
    ['finding/a', 'finding/b', 'finding/c'].map((key) => {
      const written = writeFact(db, REGISTRY, fact({ key, atEvent: 5 }), ENV);
      if (!written.ok) throw new Error(`fixture fact ${key} was refused`);
      return written.seq;
    });

  it('appends one fact.read per resolved fact, by the reading node', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      threeFindings(db);
      // One unrelated fact the prefix must not pull in.
      writeFact(db, REGISTRY, fact({ key: 'scope/touched', schemaId: 'DeFlow.scope.v1' }), ENV);

      const resolved = resolveDeclaredReads(db, {
        ...ENV,
        by: nodeId('implement'),
        reads: [{ kind: 'fact', key: 'finding/*' }],
      });

      expect(resolved.map((entry) => entry.fact.key)).toEqual([
        'finding/a',
        'finding/b',
        'finding/c',
      ]);
      expect(factEvents(db)).toEqual([
        'fact.written',
        'fact.written',
        'fact.written',
        'fact.written',
        'fact.read',
        'fact.read',
        'fact.read',
      ]);
      const reads = readFactEdges(db, RUN).filter((edge) => edge.direction === 'read');
      expect(reads.map((edge) => edge.node)).toEqual([
        nodeId('implement'),
        nodeId('implement'),
        nodeId('implement'),
      ]);
    } finally {
      db.close();
    }
  });

  it("points each resolution's sourceEvent at the fact.written event", ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const writtenSeqs = threeFindings(db);

      const resolved = resolveDeclaredReads(db, {
        ...ENV,
        by: nodeId('implement'),
        reads: [{ kind: 'fact', key: 'finding/*' }],
      });

      expect(resolved.map((entry) => entry.sourceEvent)).toEqual(writtenSeqs);
      // …and never at the fact.read event, which is the mistake that would
      // make every segment claim it came from the node that consumed it.
      expect(resolved.every((entry) => entry.sourceEvent < entry.readSeq)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('records the read even for a fact the budget later demotes to a handle', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      threeFindings(db);

      const resolved = resolveDeclaredReads(db, {
        ...ENV,
        by: nodeId('implement'),
        reads: [{ kind: 'fact', key: 'finding/*' }],
      });

      // Demotion is the packet builder's decision, taken *after* resolution:
      // an offloaded fact was read — the agent can pull it — so the graph must
      // not under-report it. Nothing the builder does afterwards can remove
      // the edge, because the edge is already in the ledger.
      expect(resolved).toHaveLength(3);
      expect(readFactEdges(db, RUN).filter((edge) => edge.direction === 'read')).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('resolves an exact key and a spec read side by side, touching only the fact', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      writeFact(db, REGISTRY, fact({ key: 'scope/touched', schemaId: 'DeFlow.scope.v1' }), ENV);

      const resolved = resolveDeclaredReads(db, {
        ...ENV,
        by: nodeId('gate-typecheck'),
        reads: [
          { kind: 'fact', key: 'scope/touched' },
          { kind: 'spec', section: 'criteria' },
        ],
      });

      expect(resolved.map((entry) => entry.fact.key)).toEqual(['scope/touched']);
    } finally {
      db.close();
    }
  });

  it('resolves nothing, and appends nothing, when no fact matches', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const resolved = resolveDeclaredReads(db, {
        ...ENV,
        by: nodeId('implement'),
        reads: [{ kind: 'fact', key: 'finding/*' }],
      });

      expect(resolved).toEqual([]);
      expect(factEvents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('a superseded fact stays readable (AC9, EPIC-09-S44 scenario 4)', () => {
  it('keeps both facts in the projection, ordered by atEvent', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const original = writeFact(db, REGISTRY, fact({ key: 'finding/db', atEvent: 10 }), ENV);
      if (!original.ok) throw new Error('fixture fact was refused');
      invalidateFact(db, {
        ...ENV,
        factId: original.fact.id,
        by: nodeId('recon-2'),
        reason: 'the database moved to postgres',
      });
      const replacement = writeFact(
        db,
        REGISTRY,
        fact({
          id: factId('finding-db-v2'),
          key: 'finding/db',
          atEvent: 60,
          supersedes: original.fact.id,
        }),
        ENV,
      );
      expect(replacement.ok).toBe(true);

      const stored = readFacts(db, RUN);
      expect(stored.map((entry) => entry.fact.id)).toEqual([
        original.fact.id,
        factId('finding-db-v2'),
      ]);
      // History is not rewritten: the original's own value is still there.
      expect(stored[0]?.fact.supersedes).toBeUndefined();
      // The supersede edge the memory graph draws is a field, not a deletion.
      expect(stored[1]?.fact.supersedes).toBe(original.fact.id);
    } finally {
      db.close();
    }
  });

  it('resolves the key to the superseding fact, not the one it replaced', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const original = writeFact(db, REGISTRY, fact({ key: 'finding/db', atEvent: 10 }), ENV);
      if (!original.ok) throw new Error('fixture fact was refused');
      writeFact(
        db,
        REGISTRY,
        fact({
          id: factId('finding-db-v2'),
          key: 'finding/db',
          atEvent: 60,
          supersedes: original.fact.id,
        }),
        ENV,
      );

      expect(readFactByKey(db, RUN, 'finding/db')?.fact.id).toBe(factId('finding-db-v2'));

      const resolved = resolveDeclaredReads(db, {
        ...ENV,
        by: nodeId('implement'),
        reads: [{ kind: 'fact', key: 'finding/db' }],
      });
      expect(resolved.map((entry) => entry.fact.id)).toEqual([factId('finding-db-v2')]);
    } finally {
      db.close();
    }
  });
});

suite('the fact projection is scoped to its run', () => {
  it('does not resolve the facts of another run', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const other = RunIdSchema.parse('run_20260807T090001Z_9e8d7c');
      writeFact(db, REGISTRY, fact({ key: 'finding/a' }), { ...ENV, runId: other });

      expect(readFacts(db, RUN)).toEqual([]);
      expect(
        resolveDeclaredReads(db, {
          ...ENV,
          by: nodeId('implement'),
          reads: [{ kind: 'fact', key: 'finding/*' }],
        }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
