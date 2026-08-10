/**
 * KAR-10.1 AC6 / KAR-15.5 AC5 — the API-level `Idempotency-Key`, as a row in
 * the **effect journal**.
 *
 * `docs/11-api-and-realtime.md` §11.3 is explicit about where it lives: *"a
 * repeat with the same key returns the original `201` body rather than starting
 * a second run … and it is stored in the `effect` journal alongside
 * engine-level idempotency keys, not in a separate table."* KAR-10.1 shipped it
 * as a dedicated `intake_key` table; migration 0015 moves those rows here and
 * drops it.
 *
 * The journal is the right home rather than a convenient one, because a run
 * creation *is* an effect in the sense §8.2 means: an intent recorded before
 * the work, a result memoised after it, and a retry that reads the result back
 * instead of performing the work again. What is memoised is the **201 body
 * verbatim**, which is what makes a repeat byte-identical rather than merely
 * equivalent — the body carries a `seq`, and one re-derived on the retry would
 * report whatever the ledger looks like now.
 *
 * Three details are load-bearing:
 *
 * **The ikey is namespaced `intake:`.** The engine's own keys are
 * `<runId>/<nodeId>/<attempt>/<ordinal>` (`ikey()` in @DeFlow/core), and
 * `intake:` cannot be produced by that function for any input. So a client
 * sending an `Idempotency-Key` that *looks* like an engine key still cannot
 * address an engine row, which is precisely the invariant KAR-15.5 AC8 is
 * about: conflating the two would let a client reach into the effect journal.
 *
 * **`node_id` is `:intake`, which is not a `NodeId`.** `NODE_ID_PATTERN`
 * requires an alphanumeric first character, so no plan can ever name a node
 * this row would collide with — and `nextOrdinal`, which counts rows per
 * `(runId, nodeId, attempt)`, therefore never counts an intake row into a real
 * node's ordinal sequence.
 *
 * **The row is born `pending` and completed in the same transaction, with no
 * event.** A `pending` row is how the next daemon life recognises "we died
 * mid-effect" and hands it to `reconcile()`; an intake row that stayed pending
 * would be reconciled as an ambiguous inherited effect for a node that does not
 * exist. And no `effect.started` / `effect.completed` pair is appended, for the
 * same reason `scaffoldEffect` appends none: the run's timeline records the
 * submission as `task.submitted`, and a mechanical pair beside it would be two
 * more rows no reducer reads. The write is atomic with the `task.submitted`
 * append at the call site (`submitTask` in @DeFlow/daemon), so a crash between
 * the two is impossible rather than unlikely.
 */
import type { Db, RunId } from '@DeFlow/core';
import { NON_NODE_EFFECT_PREFIX } from './effects.ts';

/**
 * The namespace an API-level key is journalled under.
 *
 * A prefix rather than a separate column, so the journal's primary key stays
 * one text column and `ON CONFLICT (ikey)` is still what makes a repeat cheap.
 */
export const INTAKE_IKEY_PREFIX = 'intake:';

/**
 * The `node_id` every intake row carries.
 *
 * Under `NON_NODE_EFFECT_PREFIX` (./effects.ts), so it is a value
 * `NodeIdSchema` can never produce: no plan can name a node this row collides
 * with, `nextOrdinal` never counts it into a real node's ordinal sequence, and
 * `readEffects` — which answers questions about attempts — leaves it out.
 */
export const INTAKE_NODE_ID = `${NON_NODE_EFFECT_PREFIX}intake`;

/** The `effect.kind` every intake row carries. */
export const INTAKE_EFFECT_KIND = 'intake';

/** `key` as the ikey it is journalled under. */
export function intakeIkey(key: string): string {
  return `${INTAKE_IKEY_PREFIX}${key}`;
}

const INSERT_SQL = `
  INSERT INTO effect
    (ikey, run_id, node_id, attempt, ordinal, kind, request_hash, state, started_at)
  VALUES (?, ?, '${INTAKE_NODE_ID}', 0, 0, '${INTAKE_EFFECT_KIND}', ?, 'pending', ?)
`;

const COMPLETE_SQL = `
  UPDATE effect SET state = 'done', result_json = ?, ended_at = ? WHERE ikey = ? AND state = 'pending'
`;

const LOOKUP_SQL = `SELECT run_id, result_json FROM effect WHERE ikey = ?`;

interface IntakeRow {
  readonly run_id: string;
  readonly result_json: string | null;
}

export interface IntakeKeyRecord {
  /** The header value, verbatim. */
  readonly key: string;
  readonly runId: RunId;
  /** `sha256-<64 hex>` over the canonical encoding of the request body. */
  readonly requestHash: string;
  /** The `201` body, already serialised. Returned verbatim on a repeat. */
  readonly response: string;
  /** ms epoch, from the injected `Clock`. */
  readonly at: number;
}

/**
 * Records that `key` minted a run, with the response a repeat will be answered
 * with.
 *
 * Throws on a key already journalled — the primary key refuses it — because a
 * second record for a key already present is a bug in the caller: it would
 * silently remap a key to a different run.
 */
export function recordIntakeKey(db: Db, record: IntakeKeyRecord): void {
  const ikey = intakeIkey(record.key);
  db.transaction(() => {
    db.prepare(INSERT_SQL).run(ikey, record.runId, record.requestHash, record.at);
    // Terminal immediately: an intake row that stayed `pending` would be
    // inherited by the next daemon life and reconciled as an ambiguous effect.
    const changed = db.prepare(COMPLETE_SQL).run(record.response, record.at, ikey).changes;
    if (changed !== 1) {
      throw new Error(`could not complete the intake journal row for key '${record.key}'`);
    }
  });
}

/** What `key` already minted, or `null` when this is the first time it has been
 * seen. `response` is the `201` body the original call returned, verbatim. */
export function lookupIntakeKey(
  db: Db,
  key: string,
): { readonly runId: RunId; readonly response: string | null } | null {
  const row = db.prepare<IntakeRow>(LOOKUP_SQL).get(intakeIkey(key));
  return row === undefined ? null : { runId: row.run_id as RunId, response: row.result_json };
}
