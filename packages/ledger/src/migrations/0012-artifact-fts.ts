/**
 * Migration 0012 — `artifact_fts`, the FTS5 index over run artifacts
 * (docs/08-context-and-memory.md §10, KAR-09.10).
 *
 * The DDL below is a frozen copy of `ARTIFACT_FTS_SCHEMA` in
 * `../artifact-index.ts`, which is what `rebuildArtifactFts` recreates the
 * tables with. Duplicated rather than imported, for the same reason migration
 * 0011 duplicates `BLACKBOARD_SCHEMA`: a shipped migration must run the same
 * bytes next year that it ran today, and
 * `test/integration/artifact-fts.test.ts` compares `sqlite_master` after this
 * migration against `sqlite_master` after a rebuild, so the two cannot drift
 * silently.
 *
 * **`tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"` is fixed at
 * table creation and cannot be changed in place** — FTS5 does not support
 * `ALTER … tokenize`. A migration that ever needs a different tokenizer ships
 * as a new numbered file that drops `artifact_fts` and calls
 * `rebuildArtifactFts` against the artifact store, never an in-place `ALTER`
 * (AC6).
 *
 * `artifact_fts_provenance` is not part of the documented `fts5(…)` shape —
 * the five documented columns (`title, body, kind, node_id, run_id`) have no
 * room for the artifact's handle or the event that produced it, and adding a
 * sixth column would make the AC1 exact-DDL assertion false. It is an
 * ordinary companion table, keyed by the same integer `rowid` FTS5 assigns
 * `artifact_fts` on insert, and it is what lets a search hit resolve back to
 * `sourceEvent` and `artifact://<sha256>` for the node inspector's
 * click-through (AC5).
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`.
 */
import type { Migration } from '../migrate.ts';

export const migration0012ArtifactFts: Migration = {
  id: 12,
  name: 'artifact-fts',
  up(db) {
    db.exec(`CREATE VIRTUAL TABLE artifact_fts USING fts5(
        title, body, kind UNINDEXED, node_id UNINDEXED, run_id UNINDEXED,
        tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"
      )`);
    db.exec(`CREATE TABLE artifact_fts_provenance (
        id           INTEGER NOT NULL PRIMARY KEY,
        handle       TEXT    NOT NULL,
        source_event INTEGER NOT NULL
      ) STRICT`);
    db.exec(
      'CREATE UNIQUE INDEX artifact_fts_provenance_by_handle ON artifact_fts_provenance(handle)',
    );
  },
};
