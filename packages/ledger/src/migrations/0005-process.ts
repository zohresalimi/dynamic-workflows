/**
 * Migration 0005 — `process`, the row that makes orphan reaping possible
 * (docs/07-provider-adapter-layer.md §9.5, KAR-05.9).
 *
 * Every agent is spawned `detached: true`, which is what makes a wedged agent
 * and everything it started reachable with one signal — and which also means
 * **the agent outlives DeFlowd**. A daemon that dies mid-run leaves real
 * processes editing a real worktree with nobody supervising them, and this
 * table is the only handle the next daemon has on them.
 *
 * Four things about the shape are deliberate:
 *
 * - **`pgid` is stored, not derived.** It equals `pid` for every tree DeFlow
 *   spawns today, but the pgid is what a signal is sent to, and after the
 *   leader dies it is the *only* handle left on the descendants — they are
 *   reparented to init and their pgid is all that still names them together.
 * - **`started_at` is TEXT, verbatim, unparsed.** It is the guard against PID
 *   reuse, and it is compared for equality against the same source on the same
 *   machine and nothing else. `ps -o lstart=` has second resolution and
 *   `/proc/<pid>/stat` field 22 counts ticks from a boot that may itself have
 *   changed; normalising either into a timestamp would invent precision the
 *   source does not have, and a comparison that is nearly right is what kills
 *   an unrelated user process.
 * - **The primary key is `(run_id, node_id, attempt)`.** A retry is a different
 *   process and gets its own row, so a reaper booting after a crash mid-retry
 *   sees both and can decide about each.
 * - **`state` is a closed set with a CHECK.** `live` is the only non-terminal
 *   value; `exited`, `reaped` and `discarded` record which of the three answers
 *   in AC7 the row got. An unconstrained column here would let a typo hide a
 *   running agent from every future reaper.
 */
import type { Migration } from '../migrate.ts';

export const migration0005Process: Migration = {
  id: 5,
  name: 'process',
  up(db) {
    db.exec(`
      CREATE TABLE process (
        run_id        TEXT    NOT NULL,
        node_id       TEXT    NOT NULL,
        attempt       INTEGER NOT NULL,
        pid           INTEGER NOT NULL,
        pgid          INTEGER NOT NULL,
        started_at    TEXT,
        binary_sha256 TEXT    NOT NULL,
        worktree      TEXT,
        spawned_at    INTEGER NOT NULL,
        state         TEXT    NOT NULL
          CHECK (state IN ('live', 'exited', 'reaped', 'discarded')),
        PRIMARY KEY (run_id, node_id, attempt)
      ) STRICT
    `);
    // The reaper's only query: every row still claiming to describe a running
    // process. Partial, because a long-lived data directory holds one terminal
    // row per node attempt for ever and none of them is ever read again.
    db.exec(`CREATE INDEX process_live ON process (pid) WHERE state = 'live'`);
  },
};
