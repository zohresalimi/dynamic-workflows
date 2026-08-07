/**
 * KAR-09.10 — FTS5 retrieval over run artifacts (docs/08-context-and-memory.md
 * §10; MET-381).
 *
 * File-backed throughout — `CREATE VIRTUAL TABLE … USING fts5` and `bm25()`
 * are meaningless assertions against a fake, and the whole point of AC2's
 * control scenario is that the *real* tokenizer setting is what is doing the
 * work.
 *
 * Verifies: EPIC-09-S51, EPIC-09-S52, EPIC-09-S53, EPIC-09-S54 · AC1-AC7
 */
import type { Db, DbValue, EventSeq, Handle, NodeId, RunId } from '@DeFlow/core';
import { EventSeqSchema, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  ARTIFACT_FTS_TOKENIZE,
  type ArtifactIndexEntry,
  artifactFtsAvailability,
  createArtifactFtsTables,
  ftsPhraseQuery,
  indexArtifact,
  queryArtifactFts,
  rebuildArtifactFts,
  resolveRetrieval,
} from '../../src/artifact-index.ts';
import { openLedger } from '../../src/index.ts';

/** Every statement passed to `prepare`, so a spec can prove a query was — or
 * was not — issued at all (EPIC-09-S54's "spy on the Db port"). */
class RecordingDb implements Db {
  readonly prepared: string[] = [];
  constructor(private readonly inner: Db) {}
  get open(): boolean {
    return this.inner.open;
  }
  prepare<Row = Record<string, DbValue>>(sql: string) {
    this.prepared.push(sql);
    return this.inner.prepare<Row>(sql);
  }
  exec(sql: string): void {
    this.inner.exec(sql);
  }
  transaction<T>(fn: () => T): T {
    return this.inner.transaction(fn);
  }
  pragma(source: string): unknown {
    return this.inner.pragma(source);
  }
  close(): void {
    this.inner.close();
  }
}

const seq = (value: number): EventSeq => EventSeqSchema.parse(value);
const runId = (value: string): RunId => RunIdSchema.parse(value);
const nodeId = (value: string): NodeId => NodeIdSchema.parse(value);
const handle = (hex: string): Handle => `artifact://${hex.repeat(64).slice(0, 64)}` as Handle;

const RUN = runId('run_20260807T090000Z_1a2b3c');

function entry(overrides: Partial<ArtifactIndexEntry> = {}): ArtifactIndexEntry {
  return {
    title: 'stack trace',
    body: 'TypeError: cannot read property of undefined at get_user_by_id (auth.ts:42)',
    kind: 'tool.output',
    nodeId: nodeId('recon'),
    runId: RUN,
    handle: handle('3f'),
    sourceEvent: seq(12),
    ...overrides,
  };
}

suite('artifact_fts is created exactly as documented (AC1)', () => {
  it('the tokenize string is asserted character for character from sqlite_master', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const row = db
        .prepare<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'artifact_fts'")
        .get();
      expect(row).toBeDefined();
      expect(row?.sql).toContain(`tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"`);
      expect(ARTIFACT_FTS_TOKENIZE).toBe("unicode61 remove_diacritics 2 tokenchars '_-.'");
    } finally {
      db.close();
    }
  });
});

suite(
  'identifier-shaped queries find their documents, because tokenchars is set (AC2, EPIC-09-S51)',
  () => {
    const corpus: readonly ArtifactIndexEntry[] = [
      entry({
        title: 'stack trace',
        body: 'ReferenceError at get_user_by_id (auth.ts:42): user is not defined',
        handle: handle('a1'),
        sourceEvent: seq(1),
      }),
      entry({
        title: 'changelog',
        body: 'bumped vue-flow-core from 1.4.0 to 1.5.2 to fix a rendering regression',
        handle: handle('b2'),
        sourceEvent: seq(2),
      }),
      entry({
        title: 'lockfile diff',
        body: 'pnpm-lock.yaml changed: 3 packages added, 1 removed',
        handle: handle('c3'),
        sourceEvent: seq(3),
      }),
    ];

    const identifierQueries: ReadonlyArray<readonly [string, Handle]> = [
      ['get_user_by_id', handle('a1')],
      ['vue-flow-core', handle('b2')],
      ['pnpm-lock.yaml', handle('c3')],
    ];

    for (const [query, expected] of identifierQueries) {
      it(`MATCH '${query}' returns the expected document as the top hit`, ({ tmp }) => {
        const db = openLedger(tmp);
        try {
          for (const item of corpus) indexArtifact(db, item);
          // Hyphen and dot are not legal in FTS5's *query* grammar (a separate
          // parser from the content tokenizer) — see ftsPhraseQuery's own
          // comment. Phrase-quoting every identifier uniformly, snake_case
          // included, is one rule instead of three.
          const hits = queryArtifactFts(db, ftsPhraseQuery(query));
          expect(hits[0]?.handle).toBe(expected);
        } finally {
          db.close();
        }
      });
    }

    /**
     * **What this control proves, precisely, and what it does not.**
     *
     * Verified 2026-08-07 against `better-sqlite3@13.0.2`: FTS5 tokenizes a
     * *query's* bareword/phrase text with the same tokenizer configured for the
     * table, and — when that tokenization yields more than one token — falls
     * back to an implicit adjacent-phrase match. That fallback means a
     * single-document "does `MATCH '<identifier>'` find the one document
     * containing it" test **passes whether or not `tokenchars` is set**: the
     * identifier is tokenized identically at index time and query time either
     * way, so exact adjacency survives the fragmentation symmetrically. That
     * is *not* the failure mode worth asserting.
     *
     * The failure mode `tokenchars` actually prevents is a **false positive**:
     * without it, `get_user_by_id` is not one token, it is the four ordinary
     * English words "get", "user", "by", "id" in a row — and any document that
     * happens to contain that same four-word sequence as *prose*, with nothing
     * to do with the identifier, becomes indistinguishable from the real
     * match. `tokenchars` is what keeps a compiler symbol and a sentence from
     * colliding.
     */
    it('the control table, built WITHOUT tokenchars, returns a false positive tokenchars prevents', ({
      tmp,
    }) => {
      const db = openLedger(tmp);
      try {
        db.exec(
          `CREATE VIRTUAL TABLE control_fts USING fts5(
           body,
           tokenize = "unicode61 remove_diacritics 2"
         )`,
        );
        const insert = db.prepare('INSERT INTO control_fts (body) VALUES (?)');
        const target = corpus[0]?.body;
        if (target === undefined) throw new Error('fixture corpus lost its first entry');
        const distractor = 'Please get user by id, not by name, when looking up an account.';
        insert.run(target);
        insert.run(distractor);

        const controlHits = db
          .prepare<{ body: string }>(
            'SELECT body FROM control_fts WHERE control_fts MATCH ? ORDER BY rank',
          )
          .all('get_user_by_id')
          .map((row) => row.body);
        expect(controlHits).toContain(distractor);

        // The same query, against the real, correctly configured artifact_fts
        // and the same two documents, does not.
        for (const item of corpus) indexArtifact(db, item);
        indexArtifact(
          db,
          entry({
            body: distractor,
            handle: handle('d4'),
            sourceEvent: seq(4),
          }),
        );
        const productionHits = queryArtifactFts(db, ftsPhraseQuery('get_user_by_id'));
        expect(productionHits.map((hit) => hit.handle)).not.toContain(handle('d4'));
        expect(productionHits.map((hit) => hit.handle)).toContain(handle('a1'));
      } finally {
        db.close();
      }
    });

    it("the tokenize string is what keeps each identifier as one indexed term, verified against sqlite_master's own fts5vocab", ({
      tmp,
    }) => {
      const db = openLedger(tmp);
      try {
        db.exec('CREATE VIRTUAL TABLE artifact_fts_vocab USING fts5vocab(artifact_fts, row)');
        for (const item of corpus) indexArtifact(db, item);
        const terms = new Set(
          db
            .prepare<{ term: string }>('SELECT term FROM artifact_fts_vocab')
            .all()
            .map((r) => r.term),
        );
        // Each identifier survives whole — not fragmented at '_', '-' or '.'.
        expect(terms.has('get_user_by_id')).toBe(true);
        expect(terms.has('vue-flow-core')).toBe(true);
        expect(terms.has('pnpm-lock.yaml')).toBe(true);
        // And none of their punctuation-delimited fragments exist as their own
        // separate terms — confirming they were never split in the first place.
        for (const fragment of ['flow', 'core', 'pnpm', 'lock', 'yaml']) {
          expect(terms.has(fragment)).toBe(false);
        }
      } finally {
        db.close();
      }
    });
  },
);

suite('bm25 weighting, snippet and rank (AC3, EPIC-09-S53)', () => {
  it('a title match outranks an equal body match', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      indexArtifact(
        db,
        entry({
          title: 'merge-tree conflict report',
          body: 'two files could not be automatically combined',
          handle: handle('11'),
          sourceEvent: seq(1),
        }),
      );
      indexArtifact(
        db,
        entry({
          title: 'build log',
          body: 'attempting a merge-tree of the two candidate branches failed',
          handle: handle('22'),
          sourceEvent: seq(2),
        }),
      );

      const hits = queryArtifactFts(db, ftsPhraseQuery('merge-tree'));
      expect(hits).toHaveLength(2);
      expect(hits[0]?.handle).toBe(handle('11'));
    } finally {
      db.close();
    }
  });

  it('the snippet wraps the matched term in brackets, per the documented shape', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      indexArtifact(db, entry({ body: 'a failing test named test_login_flow was observed' }));
      const hits = queryArtifactFts(db, 'test_login_flow');
      expect(hits[0]?.snippet).toContain('[test_login_flow]');
    } finally {
      db.close();
    }
  });

  it('never returns more than 20 rows, and orders by rank', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      for (let index = 0; index < 25; index += 1) {
        indexArtifact(
          db,
          entry({
            title: index === 0 ? 'widget widget widget' : 'unrelated',
            body: `document ${index} mentions widget once`,
            handle: handle(index.toString(16).padStart(2, '0')),
            sourceEvent: seq(index + 1),
          }),
        );
      }
      const hits = queryArtifactFts(db, 'widget');
      expect(hits.length).toBeLessThanOrEqual(20);
      // The title-heavy document (weighted 2x) ranks first.
      expect(hits[0]?.handle).toBe(handle('00'));
    } finally {
      db.close();
    }
  });

  it('results carry provenance: sourceEvent and the artifact handle (AC5)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      indexArtifact(
        db,
        entry({ handle: handle('99'), sourceEvent: seq(42), nodeId: nodeId('triage') }),
      );
      const [hit] = queryArtifactFts(db, 'get_user_by_id');
      expect(hit?.handle).toBe(handle('99'));
      expect(hit?.sourceEvent).toBe(42);
      expect(hit?.nodeId).toBe('triage');
    } finally {
      db.close();
    }
  });
});

suite('retrieval is opt-in per node (AC4, EPIC-09-S54)', () => {
  it('issues zero queries against artifact_fts when there is no declaration', ({ tmp }) => {
    const inner = openLedger(tmp);
    const db = new RecordingDb(inner);
    try {
      indexArtifact(inner, entry());
      const hits = resolveRetrieval(db, undefined);
      expect(hits).toEqual([]);
      expect(db.prepared.some((sql) => sql.includes('artifact_fts'))).toBe(false);
    } finally {
      inner.close();
    }
  });

  it('runs exactly one query when a node declares retrieval', ({ tmp }) => {
    const inner = openLedger(tmp);
    const db = new RecordingDb(inner);
    try {
      indexArtifact(inner, entry());
      const hits = resolveRetrieval(db, { query: 'get_user_by_id' });
      expect(hits).toHaveLength(1);
      expect(db.prepared.filter((sql) => sql.includes('artifact_fts MATCH'))).toHaveLength(1);
    } finally {
      inner.close();
    }
  });

  it('degrades to zero rows, not an error, against a fresh empty index', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(resolveRetrieval(db, { query: 'anything' })).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('the tokenizer cannot be changed in place — a migration rebuilds (AC6, EPIC-09-S52)', () => {
  it('drops and rebuilds artifact_fts rather than altering it, losslessly', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const entries = [
        entry({ handle: handle('a1'), sourceEvent: seq(1) }),
        entry({
          title: 'changelog',
          body: 'bumped vue-flow-core',
          handle: handle('b2'),
          sourceEvent: seq(2),
        }),
        entry({
          title: 'lockfile diff',
          body: 'pnpm-lock.yaml changed',
          handle: handle('c3'),
          sourceEvent: seq(3),
        }),
      ];
      for (const item of entries) indexArtifact(db, item);

      const before = db.prepare<{ n: number }>('SELECT count(*) AS n FROM artifact_fts').get();
      expect(before?.n).toBe(3);

      const rebuild = rebuildArtifactFts(db, entries);
      expect(rebuild.indexed).toBe(3);

      const after = db.prepare<{ n: number }>('SELECT count(*) AS n FROM artifact_fts').get();
      expect(after?.n).toBe(entries.length);

      expect(queryArtifactFts(db, ftsPhraseQuery('get_user_by_id'))[0]?.handle).toBe(handle('a1'));
      expect(queryArtifactFts(db, ftsPhraseQuery('vue-flow-core'))[0]?.handle).toBe(handle('b2'));
      expect(queryArtifactFts(db, ftsPhraseQuery('pnpm-lock.yaml'))[0]?.handle).toBe(handle('c3'));
    } finally {
      db.close();
    }
  });

  it('is idempotent: rebuilding twice yields the same row count', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const entries = [entry()];
      for (const item of entries) indexArtifact(db, item);
      rebuildArtifactFts(db, entries);
      const once = db.prepare<{ n: number }>('SELECT count(*) AS n FROM artifact_fts').get()?.n;
      rebuildArtifactFts(db, entries);
      const twice = db.prepare<{ n: number }>('SELECT count(*) AS n FROM artifact_fts').get()?.n;
      expect(twice).toBe(once);
    } finally {
      db.close();
    }
  });
});

suite('DeFlow doctor: FTS5 availability and the live tokenizer string (AC7)', () => {
  it('reports the table present and the exact tokenize string in force', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const report = artifactFtsAvailability(db);
      expect(report.fts5Compiled).toBe(true);
      expect(report.tableExists).toBe(true);
      expect(report.tokenize).toBe(ARTIFACT_FTS_TOKENIZE);
    } finally {
      db.close();
    }
  });

  it('makes a wrong setting visible, for a table created before this rule was enforced', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      db.exec('DROP TABLE artifact_fts');
      db.exec(
        `CREATE VIRTUAL TABLE artifact_fts USING fts5(
           title, body, kind UNINDEXED, node_id UNINDEXED, run_id UNINDEXED,
           tokenize = "unicode61 remove_diacritics 2"
         )`,
      );
      const report = artifactFtsAvailability(db);
      expect(report.tableExists).toBe(true);
      expect(report.tokenize).not.toBe(ARTIFACT_FTS_TOKENIZE);
    } finally {
      db.close();
    }
  });
});

suite('createArtifactFtsTables / the live schema matches the migration', () => {
  it('rebuilds the identical schema the migration created', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const schemaOf = (): string =>
        JSON.stringify(
          db
            .prepare<{ name: string; sql: string }>(
              "SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('artifact_fts', 'artifact_fts_provenance') ORDER BY name",
            )
            .all(),
        );
      const migrated = schemaOf();
      db.exec('DROP TABLE artifact_fts');
      db.exec('DROP TABLE artifact_fts_provenance');
      createArtifactFtsTables(db);
      expect(schemaOf()).toBe(migrated);
    } finally {
      db.close();
    }
  });
});
