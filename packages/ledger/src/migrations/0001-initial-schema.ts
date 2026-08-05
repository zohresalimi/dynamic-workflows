/**
 * Migration 0001 — the six tables of docs/05-durable-execution.md §5, with
 * their four indexes: the control-plane `event` log, the data-plane
 * `io_chunk` stream, the `effect` idempotency journal, immutable `plan`
 * documents, the `run` projection cache, and `node_wake`'s durable timers.
 *
 * Append-only and never edited once shipped — the content-hash test in
 * `test/migrations-content-hash.test.ts` enforces it. A later change to this
 * shape is migration 0002, not an edit here.
 */
import type { Migration } from '../migrate.ts';

export const migration0001InitialSchema: Migration = {
  id: 1,
  name: 'initial-schema',
  up(db) {
    // ── CONTROL PLANE ──────────────────────────────────────────────────
    // Small. This is what replay() reads. Every row can change reduced state.
    db.exec(`
      CREATE TABLE event (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        kind       TEXT    NOT NULL,
        v          INTEGER NOT NULL DEFAULT 1,
        node_id    TEXT,
        attempt    INTEGER,
        ikey       TEXT,
        payload    TEXT    NOT NULL
      ) STRICT
    `);
    db.exec('CREATE INDEX event_run_seq ON event(run_id, seq)');

    // ── DATA PLANE ─────────────────────────────────────────────────────
    // Huge. NEVER read by the reducer. Agent stdout/stderr and raw frames.
    db.exec(`
      CREATE TABLE io_chunk (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id   TEXT NOT NULL,
        node_id  TEXT NOT NULL,
        attempt  INTEGER NOT NULL,
        stream   TEXT NOT NULL,
        ts       INTEGER NOT NULL,
        data     BLOB NOT NULL
      ) STRICT
    `);
    db.exec('CREATE INDEX io_run_seq ON io_chunk(run_id, seq)');

    // ── THE IDEMPOTENCY JOURNAL ────────────────────────────────────────
    db.exec(`
      CREATE TABLE effect (
        ikey         TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        attempt      INTEGER NOT NULL,
        ordinal      INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state        TEXT NOT NULL,
        result_json  TEXT,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER
      ) STRICT
    `);
    db.exec('CREATE INDEX effect_run_state ON effect(run_id, state)');

    // ── IMMUTABLE PLAN DOCUMENTS ───────────────────────────────────────
    db.exec(`
      CREATE TABLE plan (
        hash       TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        doc        TEXT NOT NULL
      ) STRICT
    `);

    // ── PROJECTION CACHE — always rebuildable from `event` ─────────────
    db.exec(`
      CREATE TABLE run (
        run_id             TEXT PRIMARY KEY,
        status             TEXT NOT NULL,
        plan_hash          TEXT NOT NULL,
        last_seq           INTEGER NOT NULL,
        state_json         TEXT NOT NULL,
        checkpoint_version INTEGER NOT NULL,
        daemon_epoch       INTEGER NOT NULL
      ) STRICT
    `);

    // ── DURABLE TIMERS — replaces setTimeout entirely ──────────────────
    db.exec(`
      CREATE TABLE node_wake (
        run_id  TEXT NOT NULL,
        node_id TEXT NOT NULL,
        wake_at INTEGER NOT NULL,
        reason  TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id)
      ) STRICT
    `);
    db.exec('CREATE INDEX node_wake_due ON node_wake(wake_at)');
  },
};
