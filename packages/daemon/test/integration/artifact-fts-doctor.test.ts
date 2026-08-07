/**
 * KAR-09.10 AC7 — `artifactFtsReport` against a real ledger.
 *
 * File-backed, because `artifactFtsAvailability` reads `sqlite_master` and
 * `pragma_module_list`, both meaningless against a fake `Db`.
 *
 * Verifies: EPIC-09-S52 (third scenario) · AC7
 */
import { ARTIFACT_FTS_TOKENIZE, openLedger } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { artifactFtsReport } from '../../src/context/doctor.ts';

suite('artifactFtsReport reads a freshly migrated ledger', () => {
  it('reports FTS5 available and the documented tokenize string', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const report = artifactFtsReport(db);
      expect(report).toContain(ARTIFACT_FTS_TOKENIZE);
      expect(report).not.toMatch(/degraded/i);
    } finally {
      db.close();
    }
  });

  it('flags a table created before this rule was enforced', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      db.exec('DROP TABLE artifact_fts');
      db.exec(
        `CREATE VIRTUAL TABLE artifact_fts USING fts5(
           title, body, kind UNINDEXED, node_id UNINDEXED, run_id UNINDEXED,
           tokenize = "unicode61 remove_diacritics 2"
         )`,
      );
      const report = artifactFtsReport(db);
      expect(report).toMatch(/degraded/i);
      expect(report).toContain('unicode61 remove_diacritics 2');
    } finally {
      db.close();
    }
  });
});
