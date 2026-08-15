/**
 * KAR-09.10 — `artifact_fts`: the FTS5 index over run artifacts, and the one
 * query it is queried with (docs/08-context-and-memory.md §10, MET-381).
 *
 * **M1 is SQLite FTS5 + BM25 and nothing else** (D15). No embeddings, no
 * `sqlite-vec`, no network call — see §10.1/§10.2, and do not add one here
 * before a semantic-recall miss is actually measured.
 *
 * **`tokenchars '_-.'` is the one non-obvious detail and it is load-bearing.**
 * Without it FTS5's default `unicode61` tokenizer splits `get_user_by_id`,
 * `vue-flow-core` and `pnpm-lock.yaml` into fragments at the underscore,
 * hyphen and dot, and recall on exactly the corpus this table exists for —
 * stack traces, diffs, symbol names, file paths — collapses. It **cannot be
 * changed later without rebuilding the index**, which is why
 * `rebuildArtifactFts` exists and why nothing in this module ever issues an
 * `ALTER` against `artifact_fts` (AC6).
 *
 * **The query is exactly docs/08-context-and-memory.md §10's shape:**
 * `bm25(artifact_fts, 2.0, 1.0)` weights the title twice the body,
 * `ORDER BY rank` returns the best matches first, `snippet(artifact_fts, 1,
 * '[', ']', '…', 24)` brackets the matched terms in a ~24-token excerpt of
 * the body, and the result is bounded to
 * `RETRIEVED_ARTIFACT_LIMIT` (`@DeFlow/core`) rows — the same 20 this
 * module's `LIMIT` parameter and `retrievedSegmentsOf`'s ceiling both read,
 * so the two can never silently disagree (AC3).
 *
 * **Why a companion table, and not a sixth FTS5 column.** The five documented
 * columns — `title, body, kind, node_id, run_id` — are AC1's exact,
 * character-for-character asserted shape; a handle or a `sourceEvent` bolted
 * on as a sixth column would make that assertion false. `artifact_fts` is
 * queried by content; `artifact_fts_provenance` is queried by the same
 * integer `rowid` FTS5 already assigns on insert, and is what turns a search
 * hit back into `sourceEvent` and `artifact://<sha256>` for the node
 * inspector's click-through (AC5). It is an ordinary table — not part of the
 * documented shape, and free to gain columns later without touching AC1.
 *
 * **Retrieval is opt-in.** `resolveRetrieval` takes `undefined` for "this
 * node declared no retrieval" and returns `[]` without preparing a single
 * statement — a node that never asks issues no query (AC4).
 *
 * Verifies: EPIC-09-S51, EPIC-09-S52, EPIC-09-S53, EPIC-09-S54 · AC1-AC7
 */
import type { Db, EventSeq, Handle, NodeId, RunId } from '@DeFlow/core';
import {
  EventSeqSchema,
  HandleSchema,
  NodeIdSchema,
  RETRIEVED_ARTIFACT_LIMIT,
  RunIdSchema,
} from '@DeFlow/core';

/**
 * The exact tokenizer configuration docs/08-context-and-memory.md §10
 * specifies, single-sourced so the AC1 assertion, the migration's frozen DDL
 * and `deflow doctor`'s comparison all read the same literal.
 */
export const ARTIFACT_FTS_TOKENIZE = "unicode61 remove_diacritics 2 tokenchars '_-.'";

/**
 * `artifact_fts` itself, plus the companion provenance table and its index —
 * live code. Migration 0012 holds a frozen copy of exactly these statements;
 * `test/integration/artifact-fts.test.ts` compares `sqlite_master` after the
 * migration against `sqlite_master` after `createArtifactFtsTables` so the
 * two cannot drift silently, the same discipline migration 0011 uses for the
 * blackboard.
 */
export const ARTIFACT_FTS_SCHEMA: readonly string[] = [
  `CREATE VIRTUAL TABLE artifact_fts USING fts5(
        title, body, kind UNINDEXED, node_id UNINDEXED, run_id UNINDEXED,
        tokenize = "${ARTIFACT_FTS_TOKENIZE}"
      )`,
  `CREATE TABLE artifact_fts_provenance (
        id           INTEGER NOT NULL PRIMARY KEY,
        handle       TEXT    NOT NULL,
        source_event INTEGER NOT NULL
      ) STRICT`,
  'CREATE UNIQUE INDEX artifact_fts_provenance_by_handle ON artifact_fts_provenance(handle)',
];

/** Creates `artifact_fts` and its provenance table. @see ARTIFACT_FTS_SCHEMA */
export function createArtifactFtsTables(db: Db): void {
  for (const statement of ARTIFACT_FTS_SCHEMA) db.exec(statement);
}

/**
 * One artifact to index: the two FTS5 columns that are actually searched
 * (`title`, `body`), the three that ride along unindexed for filtering and
 * provenance (`kind`, `nodeId`, `runId`), and the two that only
 * `artifact_fts_provenance` carries (`handle`, `sourceEvent`).
 */
export interface ArtifactIndexEntry {
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  readonly nodeId: NodeId;
  readonly runId: RunId;
  readonly handle: Handle;
  readonly sourceEvent: EventSeq;
}

const INSERT_FTS_ROW =
  'INSERT INTO artifact_fts (title, body, kind, node_id, run_id) VALUES (?, ?, ?, ?, ?)';
const INSERT_PROVENANCE =
  'INSERT INTO artifact_fts_provenance (id, handle, source_event) VALUES (?, ?, ?)';
const PROVENANCE_BY_HANDLE = 'SELECT id FROM artifact_fts_provenance WHERE handle = ?';

/**
 * Inserts `entry`'s two statements — the FTS row and its provenance row,
 * linked by the `rowid` FTS5 just assigned — without opening a transaction of
 * its own. Not exported: every caller either wants the single-entry
 * transaction `indexArtifact` provides, or the one transaction
 * `rebuildArtifactFts` wraps around many of these, and `Db.transaction`
 * cannot nest.
 */
function insertEntry(db: Db, entry: ArtifactIndexEntry): void {
  const inserted = db
    .prepare(INSERT_FTS_ROW)
    .run(entry.title, entry.body, entry.kind, entry.nodeId, entry.runId);
  db.prepare(INSERT_PROVENANCE).run(inserted.lastInsertRowid, entry.handle, entry.sourceEvent);
}

/**
 * Indexes `entry`, unless its handle is already indexed.
 *
 * **First writer wins** — the same rule `recordRunArtifact` (./run-artifacts.ts)
 * applies to the run's artifact index: the bytes behind a handle cannot
 * change, so a second offload of identical content has nothing new to say
 * about it, and a second row would only cost `bm25` a duplicate to rank.
 *
 * Returns whether anything was written.
 */
export function indexArtifact(db: Db, entry: ArtifactIndexEntry): boolean {
  const existing = db.prepare<{ id: number }>(PROVENANCE_BY_HANDLE).get(entry.handle);
  if (existing !== undefined) return false;
  db.transaction(() => insertEntry(db, entry));
  return true;
}

/**
 * Escapes `term` as a safe FTS5 phrase query: `"vue-flow-core"`, with any
 * embedded `"` doubled per FTS5's own phrase-escaping rule.
 *
 * **Necessary, and easy to miss.** `tokenchars '_-.'` is what makes the
 * *tokenizer* keep `vue-flow-core` and `pnpm-lock.yaml` whole when indexing
 * content — but FTS5's *query-string grammar* is a separate parser that does
 * not consult `tokenchars` at all, and treats an unquoted `-` or `.` as a
 * syntax error (`fts5: syntax error near "."`) rather than as part of a
 * bareword. **Verified 2026-08-07** against `better-sqlite3@13.0.2`: `MATCH
 * 'pnpm-lock.yaml'` raises that error; `MATCH '"pnpm-lock.yaml"'` finds it.
 * `_` alone does not need this (it is a legal bareword character to the query
 * grammar too), but phrase-quoting every identifier uniformly is one rule
 * instead of three.
 */
export function ftsPhraseQuery(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** One `artifact_fts` search hit, resolved with its provenance joined in —
 * everything `retrievedSegmentsOf` (`@DeFlow/core`) needs to build a
 * `retrieved` segment. */
export interface ArtifactFtsHit {
  readonly nodeId: NodeId;
  readonly runId: RunId;
  /** `snippet(artifact_fts, 1, '[', ']', '…', 24)`. */
  readonly snippet: string;
  /** `bm25(artifact_fts, 2.0, 1.0)` — lower is a better match, per FTS5's
   * convention; callers rely on `ORDER BY rank` rather than resorting this. */
  readonly score: number;
  readonly handle: Handle;
  readonly sourceEvent: EventSeq;
}

/**
 * §10's query, run against `matchQuery`: `bm25(artifact_fts, 2.0, 1.0)`
 * (title weighted 2×), `ORDER BY rank`,
 * `snippet(artifact_fts, 1, '[', ']', '…', 24)`, bounded to
 * `RETRIEVED_ARTIFACT_LIMIT` rows (AC3). `rowid`, `node_id` and `run_id` ride
 * along beside the documented three columns so each hit can be joined back to
 * its provenance and attributed to the node and run that produced it — AC3's
 * "exact shape" is the ranking, ordering, snippet and limit, not a ban on
 * selecting the columns provenance needs.
 *
 * Degrades to `[]` rather than throwing against an empty or non-matching
 * index (EPIC-09-S54's third scenario).
 */
export function queryArtifactFts(db: Db, matchQuery: string): readonly ArtifactFtsHit[] {
  const rows = db
    .prepare<{ rowid: number; node_id: string; run_id: string; snippet: string; score: number }>(
      `SELECT rowid AS rowid, node_id, run_id,
              snippet(artifact_fts, 1, '[', ']', '…', 24) AS snippet,
              bm25(artifact_fts, 2.0, 1.0) AS score
         FROM artifact_fts
        WHERE artifact_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(matchQuery, RETRIEVED_ARTIFACT_LIMIT);

  const provenanceOf = db.prepare<{ handle: string; source_event: number }>(
    'SELECT handle, source_event FROM artifact_fts_provenance WHERE id = ?',
  );

  const hits: ArtifactFtsHit[] = [];
  for (const row of rows) {
    const provenance = provenanceOf.get(row.rowid);
    // A row in artifact_fts with no provenance row is a bug in indexArtifact,
    // not a shape a caller should have to handle — every insert path here
    // writes both rows in the same transaction.
    if (provenance === undefined) {
      throw new Error(
        `artifact_fts row ${row.rowid} has no artifact_fts_provenance entry — indexArtifact and ` +
          'rebuildArtifactFts are the only writers of either table and always write both',
      );
    }
    hits.push({
      nodeId: NodeIdSchema.parse(row.node_id),
      runId: RunIdSchema.parse(row.run_id),
      snippet: row.snippet,
      score: row.score,
      handle: HandleSchema.parse(provenance.handle),
      sourceEvent: EventSeqSchema.parse(provenance.source_event),
    });
  }
  return hits;
}

/** What a node declares when it opts into retrieval (AC4). Absent — the
 * ordinary case — means the node issues no query at all. */
export interface RetrievalDeclaration {
  readonly query: string;
}

/**
 * AC4: retrieval runs only for a node that declares it. `undefined` returns
 * `[]` without preparing a single statement against `Db` — the property
 * EPIC-09-S54 spies on directly.
 */
export function resolveRetrieval(
  db: Db,
  declaration: RetrievalDeclaration | undefined,
): readonly ArtifactFtsHit[] {
  if (declaration === undefined) return [];
  return queryArtifactFts(db, declaration.query);
}

export interface ArtifactFtsRebuild {
  /** How many entries were written — the artifact store's indexable count,
   * for the "the rebuild is lossless" scenario. */
  readonly indexed: number;
}

/**
 * AC6: drops `artifact_fts` and its provenance table and rebuilds both from
 * `entries` — the artifact store, as the caller has already resolved it —
 * rather than issuing an `ALTER`. FTS5 has no `ALTER … tokenize`, so a
 * migration that needs a different tokenizer has no other lever: **the
 * setting cannot be changed in place** and this is the only honest way to
 * change it.
 *
 * One transaction for the whole rebuild, so a reader never observes an empty
 * `artifact_fts` mid-rebuild.
 */
export function rebuildArtifactFts(
  db: Db,
  entries: Iterable<ArtifactIndexEntry>,
): ArtifactFtsRebuild {
  return db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS artifact_fts');
    db.exec('DROP TABLE IF EXISTS artifact_fts_provenance');
    createArtifactFtsTables(db);

    const seen = new Set<string>();
    let indexed = 0;
    for (const entry of entries) {
      // First writer wins here too — a rebuild fed the same handle twice
      // (two runs offloading identical bytes) produces one row, not two.
      if (seen.has(entry.handle)) continue;
      seen.add(entry.handle);
      insertEntry(db, entry);
      indexed += 1;
    }
    return { indexed };
  });
}

/** `deflow doctor`'s whole input for AC7: whether the driver has FTS5 at all,
 * whether `artifact_fts` exists yet, and the exact tokenizer string it was
 * created with — so a table built before this rule was enforced is visible
 * rather than merely underperforming. */
export interface ArtifactFtsAvailability {
  readonly fts5Compiled: boolean;
  readonly tableExists: boolean;
  /** `null` when the table does not exist yet. */
  readonly tokenize: string | null;
}

const TOKENIZE_PATTERN = /tokenize\s*=\s*"([^"]*)"/;

/** The `tokenize = "…"` value `artifact_fts` was actually created with, read
 * from its own DDL rather than assumed — a wrong setting from before this
 * rule was enforced has to be visible, not silently treated as correct. */
function tokenizeOf(sql: string): string | null {
  return TOKENIZE_PATTERN.exec(sql)?.[1] ?? null;
}

/** AC7: `deflow doctor`'s FTS5 section reads this directly. */
export function artifactFtsAvailability(db: Db): ArtifactFtsAvailability {
  const fts5Compiled =
    db
      .prepare<{ name: string }>("SELECT name FROM pragma_module_list WHERE name = 'fts5'")
      .get() !== undefined;

  const table = db
    .prepare<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'artifact_fts'")
    .get();

  return {
    fts5Compiled,
    tableExists: table !== undefined,
    tokenize: table === undefined ? null : tokenizeOf(table.sql),
  };
}
