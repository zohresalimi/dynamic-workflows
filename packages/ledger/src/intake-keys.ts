/**
 * KAR-10.1 AC6 — `intake_key`: whether a submitted `Idempotency-Key` has
 * already minted a run.
 *
 * `recordIntakeKey` is called once, inside the same transaction as the
 * `task.submitted` append it accompanies (`submitTask` in @DeFlow/daemon), so
 * a crash between the two is impossible rather than merely unlikely. The
 * primary key is the idempotency key itself, so a second `recordIntakeKey`
 * for a key already present is a bug in the caller — it throws rather than
 * silently overwriting a mapping to a different run.
 */
import type { Db, RunId } from '@DeFlow/core';

const INSERT_SQL = `INSERT INTO intake_key (idempotency_key, run_id, created_at) VALUES (?, ?, ?)`;

const LOOKUP_SQL = `SELECT run_id FROM intake_key WHERE idempotency_key = ?`;

interface IntakeKeyRow {
  readonly run_id: string;
}

/** Records that `key` minted `runId`, at `createdAt` (ms epoch). */
export function recordIntakeKey(db: Db, key: string, runId: RunId, createdAt: number): void {
  db.prepare(INSERT_SQL).run(key, runId, createdAt);
}

/** The `RunId` `key` already minted, or `null` when this is the first time
 * it has been seen. */
export function lookupIntakeKey(db: Db, key: string): RunId | null {
  const row = db.prepare<IntakeKeyRow>(LOOKUP_SQL).get(key);
  return row === undefined ? null : (row.run_id as RunId);
}
