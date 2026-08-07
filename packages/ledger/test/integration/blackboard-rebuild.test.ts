/**
 * KAR-09.8 AC2 / EPIC-09-S42 — the blackboard is a projection, and the way to
 * prove it is to throw it away.
 *
 * > If the blackboard ever becomes independently mutable, NF9 and NF10 are
 * > both gone — this is the constraint, not a preference.
 *
 * The assertion is deliberately a *byte* comparison of a full dump rather than
 * a row count or a spot check on a few columns: the failure this test exists to
 * catch is a column that is set on the live path and not on the replay path,
 * and every cheaper assertion is blind to exactly that.
 *
 * File-backed, and the rebuild runs against a reopened connection, because a
 * rebuild is a recovery operation and recovery happens in a new process.
 *
 * Verifies: EPIC-09-S42 · AC2
 */
import type { Db, RunId } from '@DeFlow/core';
import { canonicalJson, RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  invalidateFact,
  openLedger,
  rebuildBlackboard,
  resolveDeclaredReads,
  writeFact,
} from '../../src/index.ts';
import { fact, factId, fakeRegistry, nodeId } from './support/facts.ts';

const RUN: RunId = RunIdSchema.parse('run_20260807T091500Z_4d5e6f');
const ENV = { runId: RUN, ts: 1_754_557_200_000, epoch: 1 } as const;
const REGISTRY = fakeRegistry({ registered: ['DeFlow.finding.v1'] });

/** Every row of both tables, in a stable order, as one string. */
function dump(db: Db): string {
  const facts = db.prepare('SELECT * FROM fact ORDER BY fact_id').all();
  const edges = db
    .prepare('SELECT * FROM fact_edges ORDER BY event_seq, fact_id, node_id, direction')
    .all();
  return canonicalJson({ fact: facts, fact_edges: edges });
}

/**
 * The ledger EPIC-09-S42 names: 40 `fact.written`, 120 `fact.read` and 3
 * `fact.invalidated`, written through the same API the daemon uses.
 */
function seedRun(db: Db): void {
  const keys = Array.from({ length: 40 }, (_unused, index) => `finding/f${index}`);
  for (const [index, key] of keys.entries()) {
    const written = writeFact(
      db,
      REGISTRY,
      fact({ key, atEvent: index + 1, byNode: `recon-${index % 4}` }),
      ENV,
    );
    if (!written.ok) throw new Error(`fixture fact ${key} was refused`);
  }

  // Three readers, each resolving the whole prefix: 3 × 40 = 120 fact.read.
  for (const reader of ['implement', 'verify', 'document']) {
    const resolved = resolveDeclaredReads(db, {
      ...ENV,
      by: nodeId(reader),
      reads: [{ kind: 'fact', key: 'finding/*' }],
    });
    if (resolved.length !== 40) throw new Error(`${reader} resolved ${resolved.length} facts`);
  }

  for (const index of [3, 17, 29]) {
    invalidateFact(db, {
      ...ENV,
      factId: factId(`finding/f${index}`),
      by: nodeId('recon-2'),
      reason: `finding/f${index} no longer holds`,
    });
  }
}

suite('drop the blackboard, replay the ledger, get it back', () => {
  it('rebuilds both tables byte-identically from seq 0', async ({ tmp }) => {
    const first = openLedger(tmp);
    let before: string;
    try {
      seedRun(first);
      before = dump(first);
      // A dump that is empty would make the comparison below vacuous.
      expect(before.length).toBeGreaterThan(1_000);
    } finally {
      first.close();
    }

    const second = openLedger(tmp);
    try {
      second.exec('DROP TABLE fact');
      second.exec('DROP TABLE fact_edges');

      rebuildBlackboard(second);

      expect(dump(second)).toBe(before);
    } finally {
      second.close();
    }
  });

  it('rebuilds the same schema the migration created', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const schemaOf = (): string =>
        canonicalJson(
          db
            .prepare<{ name: string; sql: string }>(
              "SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('fact', 'fact_edges') ORDER BY name",
            )
            .all(),
        );
      const migrated = schemaOf();

      db.exec('DROP TABLE fact');
      db.exec('DROP TABLE fact_edges');
      rebuildBlackboard(db);

      // The migration's DDL is frozen the day it ships; the rebuild's is live
      // code. This is what stops the two drifting into a projection that can
      // only be rebuilt into a *different* table than the one it came from.
      expect(schemaOf()).toBe(migrated);
    } finally {
      db.close();
    }
  });

  it('is idempotent: rebuilding twice changes nothing', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRun(db);
      rebuildBlackboard(db);
      const once = dump(db);
      rebuildBlackboard(db);
      expect(dump(db)).toBe(once);
    } finally {
      db.close();
    }
  });
});
