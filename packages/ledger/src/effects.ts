/**
 * KAR-06.3 — reading and writing the `effect` journal: the storage half of
 * docs/05-durable-execution.md §8.2's "intent first, then act, then record".
 *
 * Three functions carry the story, and each is a transaction for the same
 * reason `appendEventsWithProcess` is:
 *
 * - **`journalEffect`** writes the intent row and `effect.started` *together*,
 *   before the caller performs anything. A crash between them is impossible by
 *   construction rather than unlikely, which is what makes AC2's "a test that
 *   crashes between them is impossible" a statement about the code and not
 *   about timing. The insert is `ON CONFLICT (ikey) DO NOTHING` followed by a
 *   `SELECT`, so two callers racing on the same ikey read the *same* row and
 *   can agree on which of them created it — and only the creator appends the
 *   event, so `effect.started` stays one per effect.
 * - **`markEffectDone`** records the memoised result with `effect.completed`.
 * - **`markEffectFailed`** records the classified `NodeFailure` with
 *   `effect.failed`.
 *
 * `nextOrdinal` is the fourth, and the subtlest thing in the file. It answers
 * "what ordinal does the next effect of this `(runId, nodeId, attempt)` get?"
 * by **counting rows in this table**, never by incrementing anything held in a
 * process. A runtime counter resets to zero when the daemon restarts, so the
 * second effect of an interrupted attempt comes back as ordinal 0, collides
 * with the first through `ON CONFLICT DO NOTHING`, reads that first effect's
 * `done` row and memoises *the wrong result* — silently. Counting rows is
 * counting the `effect.started` events already reduced for that triple: the row
 * and the event are written in one transaction and exactly one event exists per
 * row, so the two counts cannot disagree. The row count is the one used because
 * `ikey` is that table's primary key, which makes "exactly one" a constraint
 * rather than a convention.
 *
 * What is *not* here: any way to reopen a terminal row. Migration 0006's
 * triggers refuse it at the database, and there is deliberately no helper that
 * would tempt someone to try. `result_json` on a `failed` row holds the
 * `NodeFailure` — the row records the outcome, and for a failure the outcome is
 * the failure.
 */
import type { Db, EffectKind, EventSeq, NodeFailure } from '@DeFlow/core';
import { canonicalJson } from '@DeFlow/core';
import { type AppendOptions, appendEvents, type EventDraft } from './append.ts';

/** `pending` is the only non-terminal state, and the only state a row is born in. */
export const EFFECT_STATES = ['pending', 'done', 'failed'] as const;

export type EffectState = (typeof EFFECT_STATES)[number];

/** The intent, as it is known *before* the side effect is attempted. */
export interface EffectRowDraft {
  /** `${runId}/${nodeId}/${attempt}/${ordinal}` — see `ikey()` in @DeFlow/core. */
  readonly ikey: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  /** 0-based within the attempt, derived by `nextOrdinal`, never counted. */
  readonly ordinal: number;
  readonly kind: EffectKind;
  /** `sha256-<64 hex>` over what was asked for — see `requestHash` in @DeFlow/core. */
  readonly requestHash: string;
  /** ms epoch, from the injected `Clock`. Compared against the daemon's start
   * instant to tell a concurrent effect from one this daemon inherited. */
  readonly startedAt: number;
}

export interface EffectRow extends EffectRowDraft {
  readonly state: EffectState;
  /** The memoised result on a `done` row, the `NodeFailure` on a `failed` one. */
  readonly resultJson: string | null;
  readonly endedAt: number | null;
}

/** What `journalEffect` returns: the row every caller must agree on, and
 * whether *this* call is the one that created it. */
export interface JournalledEffect {
  readonly row: EffectRow;
  /**
   * True only for the caller whose insert actually wrote the row.
   *
   * This is what makes "exactly one of them performs" decidable without a lock:
   * `ON CONFLICT DO NOTHING` reports zero changes to everybody who lost, and a
   * loser then has to decide what to do about a row it did not create rather
   * than assuming it is looking at its own.
   */
  readonly created: boolean;
}

/** Which `(runId, nodeId, attempt)` a caller means. A retry is a different triple. */
export interface EffectAttemptKey {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

/**
 * `DO NOTHING`, not `DO UPDATE`. The row already there is the truth about that
 * ikey — it may be `done`, with a result somebody is about to memoise — and an
 * upsert here would overwrite the answer with a fresh intent, which is the
 * precise failure the journal exists to prevent.
 */
const INSERT_SQL = `
  INSERT INTO effect
    (ikey, run_id, node_id, attempt, ordinal, kind, request_hash, state, started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  ON CONFLICT (ikey) DO NOTHING
`;

const COLUMNS =
  'ikey, run_id, node_id, attempt, ordinal, kind, request_hash, state, result_json, started_at, ended_at';

const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM effect WHERE ikey = ?`;

const SELECT_RUN_SQL = `
  SELECT ${COLUMNS} FROM effect WHERE run_id = ? ORDER BY node_id, attempt, ordinal
`;

/**
 * The whole of ordinal derivation. `count(*)` over a triple returns one row,
 * holds no cursor and hands nobody a `seq` to resume from.
 */
const COUNT_SQL = `
  SELECT count(*) AS intents FROM effect WHERE run_id = ? AND node_id = ? AND attempt = ?
`;

/** `WHERE state = 'pending'` as well as by key: the trigger would refuse a
 * second transition anyway, and refusing here turns a silent no-op into the
 * loud error a double-completion deserves. */
const COMPLETE_SQL = `
  UPDATE effect SET state = ?, result_json = ?, ended_at = ? WHERE ikey = ? AND state = 'pending'
`;

interface EffectDbRow {
  readonly ikey: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly attempt: number;
  readonly ordinal: number;
  readonly kind: string;
  readonly request_hash: string;
  readonly state: string;
  readonly result_json: string | null;
  readonly started_at: number;
  readonly ended_at: number | null;
}

const toRow = (stored: EffectDbRow): EffectRow => ({
  ikey: stored.ikey,
  runId: stored.run_id,
  nodeId: stored.node_id,
  attempt: stored.attempt,
  ordinal: stored.ordinal,
  kind: stored.kind as EffectKind,
  requestHash: stored.request_hash,
  state: stored.state as EffectState,
  resultJson: stored.result_json,
  startedAt: stored.started_at,
  endedAt: stored.ended_at,
});

/** The journalled effect for `ikey`, or `undefined` when none was ever written. */
export function readEffect(db: Db, ikey: string): EffectRow | undefined {
  const stored = db.prepare<EffectDbRow>(SELECT_ONE_SQL).get(ikey);
  return stored === undefined ? undefined : toRow(stored);
}

/** Every journalled effect of one run, in node/attempt/ordinal order. */
export function readEffects(db: Db, runId: string): readonly EffectRow[] {
  return db.prepare<EffectDbRow>(SELECT_RUN_SQL).all(runId).map(toRow);
}

/**
 * The ordinal the next effect of this attempt must use: the number of effect
 * intents already journalled for the triple (AC6).
 *
 * Derived on every call and stored nowhere. Read after a restart it returns
 * what it returned before the restart, because the rows it counts outlived the
 * process — which is the entire reason the ordinal is not a counter.
 */
export function nextOrdinal(db: Db, key: EffectAttemptKey): number {
  const counted = db
    .prepare<{ intents: number }>(COUNT_SQL)
    .get(key.runId, key.nodeId, key.attempt);
  return counted?.intents ?? 0;
}

/**
 * Writes the intent row and its `effect.started` event in **one** transaction,
 * and returns the row every caller for this ikey must agree on (AC2, AC3).
 *
 * The event is appended only by the caller that created the row. Appending one
 * per call would put N `effect.started` events in the ledger for one effect,
 * and the timeline would show an effect starting repeatedly while the world saw
 * it start once.
 *
 * The event goes first, for the reason `appendEventsWithProcess` gives: a
 * refused envelope takes the row with it, and what must never exist is an
 * intent row that no event records.
 */
export function journalEffect(
  db: Db,
  draft: EffectRowDraft,
  started: EventDraft,
  options: AppendOptions = {},
): JournalledEffect {
  return db.transaction(() => {
    const inserted = db
      .prepare(INSERT_SQL)
      .run(
        draft.ikey,
        draft.runId,
        draft.nodeId,
        draft.attempt,
        draft.ordinal,
        draft.kind,
        draft.requestHash,
        draft.startedAt,
      );
    const created = inserted.changes === 1;
    if (created) appendEvents(db, [started], options);

    const row = readEffect(db, draft.ikey);
    if (row === undefined) {
      throw new Error(
        `effect ${draft.ikey} vanished between its INSERT and the SELECT in the same transaction`,
      );
    }
    return { row, created };
  });
}

/**
 * The one edit migration 0007 added to a `pending` row: its `result_json`
 * scaffold (KAR-06.4 AC5).
 *
 * A `mutating` shell effect journals the hash of `git status --porcelain`
 * here **before** it spawns the command, and completes it with the after-hash
 * the instant the command returns. Both writes have to land while the row is
 * still `pending`, because the crash they exist to survive is exactly the one
 * that happens before the row goes terminal: without the before-hash a restart
 * cannot tell "the command never ran" from "it half-ran", and without the
 * after-hash it cannot tell "it finished" from either.
 *
 * No event is appended. A scaffold is a note this effect leaves for the next
 * daemon's probe, not something that happened to the run — putting it in the
 * timeline would add a mechanical row per mutating command that no reducer
 * reads and every reader has to scroll past.
 *
 * `WHERE state = 'pending'` as well as by key, for the reason `COMPLETE_SQL`
 * has it: the trigger would refuse a terminal row anyway, and refusing here
 * turns a silent no-op into a loud error.
 */
const SCAFFOLD_SQL = `
  UPDATE effect SET result_json = ? WHERE ikey = ? AND state = 'pending'
`;

export function scaffoldEffect(db: Db, ikey: string, scaffold: unknown): void {
  const changed = db.prepare(SCAFFOLD_SQL).run(canonicalJson(scaffold), ikey).changes;
  if (changed !== 1) throw new EffectNotPending(ikey, readEffect(db, ikey)?.state ?? 'absent');
}

/** Thrown when a completion names an ikey with no `pending` row — a result for
 * an effect nothing recorded intending to perform. */
export class EffectNotPending extends Error {
  readonly ikey: string;

  constructor(ikey: string, state: EffectState | 'absent') {
    super(
      `cannot record an outcome for effect ${ikey}: it is ${state === 'absent' ? 'never journalled' : `already ${state}`}. ` +
        'The journal is written intent-first — an outcome without a pending intent is a result for work ' +
        'no row says was attempted, and a second outcome would overwrite the first.',
    );
    this.name = 'EffectNotPending';
    this.ikey = ikey;
  }
}

function complete(
  db: Db,
  ikey: string,
  state: Exclude<EffectState, 'pending'>,
  payload: unknown,
  endedAt: number,
  event: EventDraft,
  options: AppendOptions,
): EventSeq[] {
  return db.transaction(() => {
    const seqs = appendEvents(db, [event], options);
    const changed = db
      .prepare(COMPLETE_SQL)
      .run(state, canonicalJson(payload), endedAt, ikey).changes;
    if (changed !== 1) throw new EffectNotPending(ikey, readEffect(db, ikey)?.state ?? 'absent');
    return seqs;
  });
}

/**
 * Moves a `pending` row to `done` with its memoised result, and appends
 * `effect.completed`, in one transaction.
 *
 * `result` is encoded with `canonicalJson` rather than `JSON.stringify` for the
 * same reason the event payload is: the stored bytes are compared and replayed
 * across daemon versions, and a `Date` or a `NaN` silently coerced into them is
 * a memoised result that comes back as something else.
 */
export function markEffectDone(
  db: Db,
  ikey: string,
  result: unknown,
  endedAt: number,
  completed: EventDraft,
  options: AppendOptions = {},
): EventSeq[] {
  return complete(db, ikey, 'done', result, endedAt, completed, options);
}

/**
 * Moves a `pending` row to `failed` carrying the classified `NodeFailure`, and
 * appends `effect.failed`, in one transaction.
 *
 * The failure is stored verbatim because the runner rethrows it unchanged on a
 * later entry and the **scheduler** — not the runner — reads its `class` to
 * decide between a retry and a failed node.
 */
export function markEffectFailed(
  db: Db,
  ikey: string,
  failure: NodeFailure,
  endedAt: number,
  failed: EventDraft,
  options: AppendOptions = {},
): EventSeq[] {
  return complete(db, ikey, 'failed', failure, endedAt, failed, options);
}

/**
 * KAR-06.7 AC9 — closes a `pending` row whose attempt was cancelled, and
 * appends `effect.cancelled`, in one transaction.
 *
 * The state is `failed` because the journal has three of them and this is not a
 * success. What `result_json` holds is the **`NodeResult`** — `{ status:
 * 'cancelled', by }` — rather than a `NodeFailure`, because the reason vocabulary
 * describes ways work goes wrong and an operator pressing stop is not one of
 * them (docs/04-domain-model.md §8).
 *
 * The row exists to be *terminal*, not to be memoised. A cancelled attempt is
 * over: `decide()` never re-admits a node whose reduced status is `cancelled`,
 * so nothing re-enters this ikey, and no caller of `durable()` ever reads this
 * `result_json` back. What closing it buys is that the next daemon life does not
 * inherit a `pending` row from a prior epoch and ask a human to reconcile an
 * effect nobody is confused about (AC9's "does not reconcile them as ambiguous").
 */
export function markEffectCancelled(
  db: Db,
  ikey: string,
  result: { readonly status: 'cancelled'; readonly by: string },
  endedAt: number,
  cancelled: EventDraft,
  options: AppendOptions = {},
): EventSeq[] {
  return complete(db, ikey, 'failed', result, endedAt, cancelled, options);
}
