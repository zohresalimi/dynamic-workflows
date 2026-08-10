/**
 * KAR-15.5 AC5 — migration 0015 carries `intake_key` into the `effect` journal
 * rather than discarding it.
 *
 * The claim is a durability one and it is the reason the migration copies at
 * all: a retried `POST /api/runs` that arrives *after* the upgrade must still
 * find the run its key already minted. A migration that only dropped the table
 * would start a second run for a request that already succeeded, which is the
 * one failure the key exists to prevent — and it would do it silently, on the
 * first retry after a deploy.
 *
 * File-backed, and driven by running the shipped migrations up to 14 and then
 * the rest, because a ledger built by the current `openLedger` never has an
 * `intake_key` table to migrate.
 *
 * Verifies: EPIC-15-S35 · AC5
 */
import type { RunId } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { intakeIkey, lookupIntakeKey, MIGRATIONS, migrate, openWrite } from '../../src/index.ts';

const RUN_A = 'run_20260806T090000Z_aaaaaa' as RunId;
const T0 = 1_754_470_000_000;

const upTo = (id: number) => MIGRATIONS.filter((migration) => migration.id <= id);

suite('migration 0015 — the key moves, it is not dropped', () => {
  it('rebuilds the 201 body from the ledger and answers the retry with it', ({ tmp }) => {
    const db = openWrite(join(tmp, 'ledger.db'));
    try {
      migrate(db, upTo(14), tmp);

      // A run created before the upgrade, and the key that minted it.
      db.prepare(
        `INSERT INTO event (run_id, ts, kind, v, epoch, payload) VALUES (?, ?, 'task.submitted', 1, 1, '{}')`,
      ).run(RUN_A, T0);
      const seq = db.prepare<{ seq: number }>('SELECT max(seq) AS seq FROM event').get()
        ?.seq as number;
      db.prepare(
        'INSERT INTO intake_key (idempotency_key, run_id, created_at) VALUES (?, ?, ?)',
      ).run('k-1', RUN_A, T0);

      migrate(db, MIGRATIONS, tmp);

      const found = lookupIntakeKey(db, 'k-1');
      expect(found?.runId).toBe(RUN_A);
      // The same three fields the route returns, with `seq` read as the run's
      // first event — which is exactly what the pre-migration repeat path
      // derived it as, so the retry gets the body it would have got before.
      expect(found?.response).toBe(
        `{"runId":"${RUN_A}","seq":${seq},"status":"awaiting-spec-approval"}`,
      );

      const row = db
        .prepare<{ state: string; kind: string; request_hash: string }>(
          'SELECT state, kind, request_hash FROM effect WHERE ikey = ?',
        )
        .get(intakeIkey('k-1'));
      // Terminal, so the next daemon life does not inherit it as a pending
      // effect — and honest about the hash it cannot reconstruct.
      expect(row).toEqual({ state: 'done', kind: 'intake', request_hash: 'migrated' });

      const tables = db
        .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((one) => one.name);
      expect(tables).not.toContain('intake_key');
    } finally {
      db.close();
    }
  });
});
