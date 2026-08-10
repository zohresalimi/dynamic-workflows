/**
 * KAR-06.6 — the `node_wake` table: reading and writing the durable timers
 * that replace `setTimeout` for every wait in the system
 * (docs/05-durable-execution.md §10.1).
 *
 * Two verified facts put this table here rather than in a `Map` of timers, and
 * the alarming one is first. **Verified 2026-08-02:** Node's maximum timer
 * delay is `2**31 - 1` ms = 24.9 days. Passing `2**31` does not throw and does
 * not clamp — it fires the callback after **1 ms**, with only a
 * `TimeoutOverflowWarning` on stderr. A 30-day human gate written as a timer
 * fires instantly and nothing in the logs says "durability failure". And below
 * that ceiling it is no better: timers do not fire during laptop sleep and do
 * not survive a restart at all.
 *
 * A row has neither problem. `wake_at` is a plain integer ms epoch — an
 * *instant*, never a duration, because a duration is only meaningful relative
 * to a process that is still running and the whole point of the row is to
 * outlive one that is not.
 *
 * The payoff is that four problems that look unrelated collapse into one
 * mechanism: a six-hour human gate, laptop sleep across that gate,
 * crash-and-restart mid-wait, and retry backoff are all *a row in this table*.
 * One code path exercised constantly instead of four exercised rarely.
 *
 * `appendEventsConsumingWakes` is the load-bearing function, for the same
 * reason `appendEventsWithProcess` is in ./processes.ts: the delete and the
 * event are **one transaction**. Split them and a crash in between either fires
 * a wake whose event was lost, or loses a wake whose event landed — and the
 * second is the one nobody notices, because the run simply never comes back.
 */
import type { Db, EventSeq, WakeReason } from '@DeFlow/core';
import { WAKE_REASONS } from '@DeFlow/core';
import { type AppendOptions, appendEvents, type EventDraft } from './append.ts';

/** Which sleeping node a caller means. One wait per node, by primary key. */
export interface NodeWakeKey {
  readonly runId: string;
  readonly nodeId: string;
}

/** One row of `node_wake` — the whole of a wait. */
export interface NodeWakeRow extends NodeWakeKey {
  /**
   * ms epoch, from the injected `Clock`. Absolute, so a restart reads the
   * instant the wait was set for rather than recomputing a delay from a clock
   * that has moved.
   */
  readonly wakeAt: number;
  readonly reason: WakeReason;
}

export class InvalidWakeReason extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(
      `node_wake.reason must be one of ${WAKE_REASONS.join(', ')}; got ${JSON.stringify(reason)}. ` +
        'The column is what answers "why is this node asleep" in the timeline, so a value ' +
        'outside the closed set is a row whose reason has to be guessed from code.',
    );
    this.name = 'InvalidWakeReason';
    this.reason = reason;
  }
}

/**
 * The upsert §10.1 writes out. `ON CONFLICT` rather than delete-then-insert
 * because `decide()` restates every pending wake on every tick: an idempotent
 * restatement is what makes the row survive a crash between the event that
 * scheduled it and the row that records it.
 */
const SCHEDULE_SQL = `
  INSERT INTO node_wake (run_id, node_id, wake_at, reason) VALUES (?, ?, ?, ?)
  ON CONFLICT (run_id, node_id) DO UPDATE SET
    wake_at = excluded.wake_at,
    reason = excluded.reason
`;

const COLUMNS = 'run_id, node_id, wake_at, reason';

/**
 * The ticker's whole query, served by the `node_wake_due` index. `<=` rather
 * than `<` because the ticker fires on a due row and hands `decide()` that same
 * instant, and a strict comparison would make every 2-second backoff take
 * three seconds.
 *
 * The `ORDER BY` is for determinism of the *list*, not of the schedule: two
 * daemons reading the same table get the same array, and what runs first is
 * then decided by `decide()`, which orders by the `seq` of the event that
 * enabled each node. Nothing here compares two timestamps to each other (AC8).
 */
const DUE_SQL = `
  SELECT ${COLUMNS} FROM node_wake
   WHERE wake_at <= ?
   ORDER BY wake_at, run_id, node_id
`;

const NEXT_SQL = 'SELECT MIN(wake_at) AS next FROM node_wake';

const ALL_SQL = `SELECT ${COLUMNS} FROM node_wake ORDER BY wake_at, run_id, node_id`;

const BY_RUN_SQL = `
  SELECT ${COLUMNS} FROM node_wake WHERE run_id = ? ORDER BY wake_at, node_id
`;

const DELETE_SQL = 'DELETE FROM node_wake WHERE run_id = ? AND node_id = ?';

interface WakeDbRow {
  readonly run_id: string;
  readonly node_id: string;
  readonly wake_at: number;
  readonly reason: string;
}

const toRow = (stored: WakeDbRow): NodeWakeRow => ({
  runId: stored.run_id,
  nodeId: stored.node_id,
  wakeAt: stored.wake_at,
  reason: stored.reason as WakeReason,
});

/**
 * Writes — or moves — the one wait this node has.
 *
 * `wakeAt` is validated as an integer for the same reason the column is
 * `INTEGER` in a `STRICT` table: a float here is a wait that compares
 * *almost* correctly, and "the gate fired 0.4 ms early" is not a failure
 * anybody would ever debug.
 */
export function scheduleWake(db: Db, row: NodeWakeRow): void {
  if (!(WAKE_REASONS as readonly string[]).includes(row.reason)) {
    throw new InvalidWakeReason(row.reason);
  }
  if (!Number.isSafeInteger(row.wakeAt)) {
    throw new TypeError(
      `node_wake.wake_at must be a whole number of milliseconds since the epoch; got ${String(row.wakeAt)}. ` +
        'It is an instant rather than a duration, so that a daemon which starts six hours later ' +
        'reads the same answer the one that scheduled it would have.',
    );
  }
  db.prepare(SCHEDULE_SQL).run(row.runId, row.nodeId, row.wakeAt, row.reason);
}

const ONE_SQL = `SELECT ${COLUMNS} FROM node_wake WHERE run_id = ? AND node_id = ?`;

/**
 * The one wait a node has, or `null` when it has none.
 *
 * Read by primary key, and the reason it is exported rather than kept private
 * is KAR-06.5 AC7: when a failure is recorded for a node that already has a
 * `backoff` row outstanding, the deadline is read off the row rather than drawn
 * again. A wait that gets pushed forward every time it is restated is not a
 * wait, it is a treadmill.
 */
export function readWake(db: Db, key: NodeWakeKey): NodeWakeRow | null {
  const row = db.prepare<WakeDbRow>(ONE_SQL).get(key.runId, key.nodeId);
  return row === undefined ? null : toRow(row);
}

/**
 * The same upsert, skipped when the row already says exactly this. Returns
 * whether it wrote.
 *
 * This is what makes "one row and zero CPU" literally true (AC6). `decide()`
 * restates every pending wake on every tick — that idempotent restatement is
 * deliberate, and it is what makes the row survive a crash between the event
 * that scheduled it and the row that records it — but a six-hour gate is
 * 21,600 ticks, and taking each restatement literally is 21,600 WAL commits
 * and 21,600 fsyncs for a run that is, by construction, doing nothing.
 *
 * The read is by primary key and costs nothing measurable beside the tick's
 * own due-row query.
 */
export function scheduleWakeIfChanged(db: Db, row: NodeWakeRow): boolean {
  if (!(WAKE_REASONS as readonly string[]).includes(row.reason)) {
    throw new InvalidWakeReason(row.reason);
  }
  const current = db.prepare<WakeDbRow>(ONE_SQL).get(row.runId, row.nodeId);
  if (current !== undefined && current.wake_at === row.wakeAt && current.reason === row.reason) {
    return false;
  }
  scheduleWake(db, row);
  return true;
}

/**
 * Every wait that has come due at `now`, oldest first.
 *
 * This is the ~1 Hz ticker's entire input and its only per-tick cost: one
 * indexed `SELECT`, measured at ~0.2 ms in this schema. A run with nothing due
 * and nothing ready costs that and no more.
 */
export function dueWakes(db: Db, now: number): readonly NodeWakeRow[] {
  return db.prepare<WakeDbRow>(DUE_SQL).all(now).map(toRow);
}

/**
 * The earliest instant any run is waiting for, or `null` when nothing is.
 *
 * The ticker's sleep *hint* is computed from this — `min(nextWakeAt - now,
 * 1000)` — and it is a hint rather than the wait: being wrong about it costs
 * at most one extra second of latency, never a missed wake, because the answer
 * always comes from re-querying `dueWakes` against the clock.
 */
export function nextWakeAt(db: Db): number | null {
  const row = db.prepare<{ next: number | null }>(NEXT_SQL).get();
  return row?.next ?? null;
}

/** Every wait, for one run or for all of them — the audit view. */
export function readWakes(db: Db, runId?: string): readonly NodeWakeRow[] {
  const statement =
    runId === undefined ? db.prepare<WakeDbRow>(ALL_SQL) : db.prepare<WakeDbRow>(BY_RUN_SQL);
  const rows = runId === undefined ? statement.all() : statement.all(runId);
  return rows.map(toRow);
}

/**
 * Deletes a wait with no event to go with it. Silent when there is no row, so
 * cancelling a run does not have to know which of its nodes were asleep.
 *
 * This is *not* how a due wake is consumed — see below.
 */
export function clearWake(db: Db, key: NodeWakeKey): void {
  db.prepare(DELETE_SQL).run(key.runId, key.nodeId);
}

/**
 * Appends `drafts` and deletes `keys` in **one** transaction (AC3).
 *
 * The event goes first so that a refused envelope takes the deletes with it:
 * an append-only table cannot be repaired, so the boundary refuses rather than
 * writes, and a wake deleted beside a refused event would be a wait that fired
 * into nothing. The reverse — a crash after the `SELECT` and before this call
 * — leaves the row exactly where it was, and the next tick finds it due again.
 * Firing a wake twice is impossible because the delete commits with the event;
 * losing one is impossible because it does not commit without it.
 */
export function appendEventsConsumingWakes(
  db: Db,
  drafts: readonly EventDraft[],
  keys: readonly NodeWakeKey[],
  options: AppendOptions = {},
): EventSeq[] {
  return db.transaction(() => {
    const seqs = appendEvents(db, drafts, options);
    const remove = db.prepare(DELETE_SQL);
    for (const key of keys) remove.run(key.runId, key.nodeId);
    return seqs;
  });
}

/**
 * KAR-13.1 AC1 — appends `drafts` and writes `rows` in **one** transaction: the
 * opening half of the rule `appendEventsConsumingWakes` closes.
 *
 * Admitting a `human` node appends `human.requested`, appends `node.suspended`
 * and writes the `node_wake` row. Split them and a crash in the window leaves
 * one of two states, both silent: a request nothing will ever wake up to
 * notice, or a wait for a question nobody asked. Neither logs a durability
 * failure; the run simply never comes back.
 *
 * The events go first for the same reason they do next door — a refused
 * envelope takes the rows with it, and an append-only table cannot be repaired
 * afterwards. The rows go through `scheduleWake`, so an out-of-vocabulary
 * `reason` or a fractional `wake_at` rolls the whole transaction back rather
 * than landing a row nothing can explain.
 */
export function appendEventsSchedulingWakes(
  db: Db,
  drafts: readonly EventDraft[],
  rows: readonly NodeWakeRow[],
  options: AppendOptions = {},
): EventSeq[] {
  return db.transaction(() => {
    const seqs = appendEvents(db, drafts, options);
    for (const row of rows) scheduleWake(db, row);
    return seqs;
  });
}
