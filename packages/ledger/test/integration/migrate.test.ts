/**
 * KAR-03.2 — the migration runner over `PRAGMA user_version`: migration 0001's
 * six tables, the pre-migration backup, all-or-nothing failure, and the
 * downgrade-safety refusal.
 *
 * File-backed throughout, in a real tmpdir — `VACUUM INTO` and
 * `PRAGMA integrity_check` are both meaningless against `:memory:`.
 *
 * Verifies: EPIC-03-S1 (migration portion), EPIC-03-S5, EPIC-03-S6, EPIC-03-S7
 * · AC1–AC6
 */

import type { Db, DbValue } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, describe as suite } from 'vitest';
import type { Migration } from '../../src/index.ts';
import { LedgerTooNew, MIGRATIONS, migrate, openLedger, openWrite } from '../../src/index.ts';

const ledgerFile = (tmp: string): string => join(tmp, 'ledger.db');

/** Every statement passed to `exec` or `prepare(...).run(...)`, in order. */
class RecordingDb implements Db {
  readonly calls: string[] = [];
  constructor(private readonly inner: Db) {}
  get open(): boolean {
    return this.inner.open;
  }
  prepare<Row = Record<string, DbValue>>(sql: string) {
    this.calls.push(`prepare:${sql}`);
    const statement = this.inner.prepare<Row>(sql);
    return {
      run: (...parameters: DbValue[]) => {
        this.calls.push(`run:${sql}`);
        return statement.run(...parameters);
      },
      get: (...parameters: DbValue[]) => statement.get(...parameters),
      all: (...parameters: DbValue[]) => statement.all(...parameters),
    };
  }
  exec(sql: string): void {
    this.calls.push(`exec:${sql}`);
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

suite('migration 0001 — the real shipped schema (AC1)', () => {
  it('runs every migration ascending and leaves user_version at the highest id', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(db.pragma('user_version')).toBe(MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0));

      const tables = db
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      // `daemon` is migration 0003's single-row epoch counter (KAR-03.7);
      // `provider_capabilities` is migration 0004's probed manifest (KAR-05.2);
      // `process` is migration 0005's orphan-reaping handle (KAR-05.9);
      // `worktrees` is migration 0008's projection over git (KAR-07.2);
      // `conflict_probe` is migration 0009's live merge-tree matrix (KAR-07.6);
      // `token_calibration` is migration 0010's learned tokenEstimateFactor
      // per (provider, model) (KAR-09.7); `fact` and `fact_edges` are
      // migration 0011's blackboard, the one pair here that may be dropped
      // and rebuilt from the ledger (KAR-09.8); `artifact_fts` is migration
      // 0012's FTS5 index (KAR-09.10) — `artifact_fts_config`,
      // `_content`, `_data`, `_docsize` and `_idx` are the shadow tables FTS5
      // itself creates and are not this migration's own DDL, and
      // `artifact_fts_provenance` is the companion table that maps a search
      // hit back to its handle and sourceEvent; `project` is migration 0016's
      // map from a name to a repository, with the realpath unique (KAR-22.1);
      // `connector` is migration 0017's record of which services a project may
      // use — three columns and no credential among them (KAR-22.4, ADR-0003
      // as amended 2026-08-16).
      expect(tables).toEqual([
        'artifact_fts',
        'artifact_fts_config',
        'artifact_fts_content',
        'artifact_fts_data',
        'artifact_fts_docsize',
        'artifact_fts_idx',
        'artifact_fts_provenance',
        'conflict_probe',
        'connector',
        'daemon',
        'effect',
        'event',
        'fact',
        'fact_edges',
        'io_chunk',
        'node_wake',
        'plan',
        'process',
        'project',
        'provider_capabilities',
        'run',
        'token_calibration',
        'worktrees',
      ]);

      const sqlByTable = new Map(
        db
          .prepare<{ name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => [row.name, row.sql]),
      );
      // `artifact_fts` is a virtual table (FTS5's own storage, not ordinary
      // STRICT DDL) and its shadow tables are SQLite-internal, not this
      // migration's own schema — everything else here is STRICT.
      const nonStrict = new Set([
        'artifact_fts',
        'artifact_fts_config',
        'artifact_fts_content',
        'artifact_fts_data',
        'artifact_fts_docsize',
        'artifact_fts_idx',
      ]);
      for (const table of tables) {
        if (nonStrict.has(table)) continue;
        expect(sqlByTable.get(table)).toMatch(/STRICT\s*$/);
      }

      const indexes = db
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual([
        // Migration 0012's lookup for "is this handle already indexed" —
        // `indexArtifact`'s first-writer-wins check (KAR-09.10).
        'artifact_fts_provenance_by_handle',
        'effect_run_state',
        // Migration 0013's partial index over the one event kind `DeFlow
        // doctor` queries without a run_id (KAR-14.4 AC10). Partial for the
        // same reason `process_live` is: an ordinary index on `kind` would
        // carry a row for every append the system has ever made, paid for on
        // the write path where it buys nothing.
        'event_rate_limited',
        'event_run_seq',
        // The blackboard's three (KAR-09.8): one to resolve a declared read
        // against a run's facts, and two for the directions F10.4's memory
        // graph is walked in — "who touched this fact" and "what did this node
        // touch". §8.2's taint query is the first of those two, filtered.
        'fact_by_run_key',
        'fact_edges_by_fact',
        'fact_edges_by_node',
        'io_run_seq',
        'node_wake_due',
        // Partial, on state = 'live': a long-lived data directory keeps one
        // terminal row per node attempt for ever, and the reaper reads none of
        // them (KAR-05.9).
        'process_live',
        // Migration 0016's most-recently-touched order (KAR-22.1). The primary
        // key already sorts projects by creation — `prj_<timestamp>_<hex>` —
        // so this index buys the *other* order, which is the one a machine
        // with more projects than fit on a screen actually wants.
        'project_updated',
      ]);
    } finally {
      db.close();
    }
  });

  it('reopening the same directory runs no further migration', ({ tmp }) => {
    openLedger(tmp).close();
    const backupsAfterFirstOpen = readdirSync(tmp)
      .filter((name) => name.startsWith('pre-migrate-'))
      .sort();

    const db = openLedger(tmp);
    try {
      expect(db.pragma('user_version')).toBe(MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0));
      // No new backup — the second open finds nothing pending to back up for.
      const backupsAfterSecondOpen = readdirSync(tmp)
        .filter((name) => name.startsWith('pre-migrate-'))
        .sort();
      expect(backupsAfterSecondOpen).toEqual(backupsAfterFirstOpen);
    } finally {
      db.close();
    }
  });
});

suite('idempotence: a second migrate() writes nothing (AC2)', () => {
  it('performs no exec or write once already current', ({ tmp }) => {
    const raw = openWrite(ledgerFile(tmp));
    try {
      migrate(raw, MIGRATIONS, tmp);

      const recording = new RecordingDb(raw);
      migrate(recording, MIGRATIONS, tmp);
      expect(recording.calls).toEqual([]);
      expect(existsSync(join(tmp, `pre-migrate-${MIGRATIONS[0]?.id}.db`))).toBe(false);
    } finally {
      raw.close();
    }
  });
});

suite('the pre-migration backup (AC3)', () => {
  it('exists, and passes integrity_check, before the next up() runs', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const db = openWrite(file);
    try {
      const seedMigration: Migration = {
        id: 1,
        name: 'seed-fixture',
        up(inner) {
          inner.exec(
            'CREATE TABLE fixture (n INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT) STRICT',
          );
        },
      };
      migrate(db, [seedMigration], tmp);

      const insert = db.prepare('INSERT INTO fixture (label) VALUES (?)');
      db.transaction(() => {
        for (let i = 0; i < 50_000; i += 1) insert.run(`row-${i}`);
      });

      let backupSeenBeforeUp = false;
      let backupIntegrityOk = false;
      const followOn: Migration = {
        id: 2,
        name: 'add-marker',
        up(inner) {
          const backupPath = join(tmp, 'pre-migrate-1.db');
          backupSeenBeforeUp = existsSync(backupPath);
          if (backupSeenBeforeUp) {
            const check = new Database(backupPath, { readonly: true, fileMustExist: true }).pragma(
              'integrity_check',
              { simple: true },
            );
            backupIntegrityOk = check === 'ok';
          }
          inner.exec('CREATE TABLE marker (n INTEGER) STRICT');
        },
      };
      migrate(db, [seedMigration, followOn], tmp);

      expect(backupSeenBeforeUp).toBe(true);
      expect(backupIntegrityOk).toBe(true);
      expect(statSync(join(tmp, 'pre-migrate-1.db')).size).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('takes no backup when already current', ({ tmp }) => {
    const db = openWrite(ledgerFile(tmp));
    try {
      migrate(db, MIGRATIONS, tmp);
      migrate(db, MIGRATIONS, tmp);
      expect(existsSync(join(tmp, `pre-migrate-${MIGRATIONS[0]?.id}.db`))).toBe(false);
    } finally {
      db.close();
    }
  });
});

suite('a failing migration is all-or-nothing (AC4)', () => {
  it('leaves user_version and schema unchanged, and raises the documented message', ({ tmp }) => {
    const db = openWrite(ledgerFile(tmp));
    try {
      const broken: Migration = {
        id: 2,
        name: 'add-broken-table',
        up(inner) {
          inner.exec('CREATE TABLE half_built (n INTEGER) STRICT');
          throw new Error('boom');
        },
      };
      const before = db.pragma('user_version');

      let caught: unknown;
      try {
        migrate(db, [broken], tmp);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('migration 2 (add-broken-table) failed');
      expect((caught as Error).cause).toBeInstanceOf(Error);
      expect(((caught as Error).cause as Error).message).toBe('boom');

      expect(db.pragma('user_version')).toBe(before);
      const table = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'half_built'")
        .get();
      expect(table).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

suite('foreign_keys is restored even after a failure (AC5)', () => {
  it('reads ON after a failed run', ({ tmp }) => {
    const db = openWrite(ledgerFile(tmp));
    try {
      const broken: Migration = {
        id: 1,
        name: 'always-throws',
        up() {
          throw new Error('nope');
        },
      };
      expect(() => migrate(db, [broken], tmp)).toThrow();
      expect(db.pragma('foreign_keys')).toBe(1);
    } finally {
      db.close();
    }
  });
});

suite('a ledger newer than the binary refuses to open (AC6)', () => {
  it('throws LedgerTooNew, names both versions, and alters nothing', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const setup = openWrite(file);
    setup.exec('PRAGMA user_version = 9999');
    setup.close();

    expect(() => openLedger(tmp)).toThrow(LedgerTooNew);
    let error: LedgerTooNew | undefined;
    try {
      openLedger(tmp);
    } catch (caught) {
      error = caught as LedgerTooNew;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('9999');
    expect(error?.message).toContain(String(MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0)));
    expect(error?.message).toMatch(/pre-migrate/);

    // No migration ran forward or backward, and no table was created.
    const inspect = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(9999);
      const tables = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all();
      expect(tables).toEqual([]);
    } finally {
      inspect.close();
    }
  });
});
