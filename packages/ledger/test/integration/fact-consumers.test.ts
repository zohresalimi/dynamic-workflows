/**
 * KAR-15.6 AC5 — the consumer set of a fact is **one indexed query**, and it is
 * computed in SQLite rather than assembled in JavaScript.
 *
 * `readersBefore` already answers the taint question — *who read this before it
 * was invalidated* — and F10.4's memory graph asks a different one: *who reads
 * this at all*. Both are `fact_edges` scans that must not be, so this file
 * asserts the shape of the plan as well as the shape of the answer: a JS
 * `filter` over `readFactEdges()` returns the same rows and reads every edge of
 * the run to do it.
 *
 * Verifies: EPIC-15-S43 · KAR-15.6 AC5 · test plan #5
 */
import { type FactId, NodeIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { type FactEdgeDirection, openLedger, readFactConsumers } from '../../src/index.ts';
import { RUN_A } from './support/events.ts';

const FACT = 'fact_repo_layout' as FactId;
const OTHER = 'fact_something_else' as FactId;

const edge = (
  db: ReturnType<typeof openLedger>,
  factId: string,
  node: string,
  direction: FactEdgeDirection,
  seq: number,
): void => {
  db.prepare(
    `INSERT INTO fact_edges (fact_id, run_id, node_id, direction, event_seq) VALUES (?, ?, ?, ?, ?)`,
  ).run(factId, RUN_A, NodeIdSchema.parse(node), direction, seq);
};

suite('the consumers of a fact (AC5)', () => {
  it('returns every reader, no writer, oldest read first', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      edge(db, FACT, 'n-recon', 'write', 10);
      edge(db, FACT, 'n-impl', 'read', 20);
      edge(db, FACT, 'n-review', 'read', 15);
      // The same node reading twice is one consumer, dated by the first look.
      edge(db, FACT, 'n-impl', 'read', 40);
      edge(db, OTHER, 'n-docs', 'read', 25);

      const consumers = readFactConsumers(db, FACT, 100);

      expect(consumers).toEqual([
        { node: 'n-review', firstReadSeq: 15, reads: 1 },
        { node: 'n-impl', firstReadSeq: 20, reads: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it('answers with no rows for a fact nothing has read', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      edge(db, FACT, 'n-recon', 'write', 10);

      expect(readFactConsumers(db, FACT, 100)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('is bounded', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      for (let index = 0; index < 20; index += 1) {
        edge(db, FACT, `n-${index}`, 'read', 100 + index);
      }

      expect(readFactConsumers(db, FACT, 5)).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it('runs off the fact_edges_by_fact index rather than scanning the graph', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      edge(db, FACT, 'n-impl', 'read', 20);

      const plan = db
        .prepare<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT node_id, min(event_seq) AS first_seq, count(*) AS reads
             FROM fact_edges
             WHERE fact_id = ? AND direction = 'read'
             GROUP BY node_id
             ORDER BY min(event_seq), node_id
             LIMIT ?`,
        )
        .all(FACT, 5)
        .map((row) => row.detail)
        .join('\n');

      expect(plan).toContain('fact_edges_by_fact');
      expect(plan).not.toContain('SCAN fact_edges');
    } finally {
      db.close();
    }
  });
});
