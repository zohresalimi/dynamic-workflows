/**
 * KAR-09.10 AC7 — the FTS5 retrieval section of `deflow doctor`.
 *
 * The command itself is EPIC-18 (KAR-18.4); this module holds the policy
 * ahead of it existing, the same split `../src/tokens/doctor.ts` and
 * `../src/constraints/doctor.ts` already use.
 *
 * Pure, because everything here is a function of an already-read
 * `ArtifactFtsAvailability`. The half that reads a real ledger is
 * `test/integration/artifact-fts-doctor.test.ts`.
 *
 * Verifies: EPIC-09-S52 (third scenario) · AC7
 */
import { ARTIFACT_FTS_TOKENIZE } from '@DeFlow/ledger';
import { expect, it, describe as suite } from 'vitest';
import { renderArtifactFtsReport } from '../src/context/doctor.ts';

suite('FTS5 not compiled into this SQLite build', () => {
  it('says so, rather than reporting a table it cannot use', () => {
    const report = renderArtifactFtsReport({
      fts5Compiled: false,
      tableExists: false,
      tokenize: null,
    });
    expect(report).toContain('not available');
    expect(report).toMatch(/FTS5/i);
  });
});

suite('artifact_fts does not exist yet', () => {
  it('says the table is missing rather than degraded', () => {
    const report = renderArtifactFtsReport({
      fts5Compiled: true,
      tableExists: false,
      tokenize: null,
    });
    expect(report).toContain('does not exist yet');
  });
});

suite('artifact_fts exists with the documented tokenizer', () => {
  it('reports the live tokenize string and raises no flag', () => {
    const report = renderArtifactFtsReport({
      fts5Compiled: true,
      tableExists: true,
      tokenize: ARTIFACT_FTS_TOKENIZE,
    });
    expect(report).toContain(ARTIFACT_FTS_TOKENIZE);
    expect(report).not.toMatch(/degraded/i);
  });
});

suite('artifact_fts exists with a wrong tokenizer (EPIC-09-S52, third scenario)', () => {
  it('makes the wrong setting visible and flags degraded recall', () => {
    const report = renderArtifactFtsReport({
      fts5Compiled: true,
      tableExists: true,
      tokenize: 'unicode61 remove_diacritics 2',
    });
    expect(report).toContain('unicode61 remove_diacritics 2');
    expect(report).toMatch(/degraded/i);
    expect(report).toMatch(/rebuil/i);
  });
});
