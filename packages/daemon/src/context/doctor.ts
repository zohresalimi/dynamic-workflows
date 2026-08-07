/**
 * KAR-09.10 AC7 — the FTS5 retrieval section of `DeFlow doctor`.
 *
 * The command itself is EPIC-18 (KAR-18.4); this module holds the policy
 * ahead of it existing, the same split `../tokens/doctor.ts` (calibration)
 * and `../constraints/doctor.ts` (the forbid ratio) already use.
 *
 * **Why the tokenizer string is worth its own line, verbatim.** A wrong
 * `tokenize` setting does not error — it quietly stops finding
 * `snake_case`/`kebab-case`/`file.ext` identifiers, and nobody notices until a
 * retrieval-dependent node produces a worse answer than it should have. A
 * table built before this rule was enforced is otherwise indistinguishable
 * from a correct one until someone reads `sqlite_master` by hand. This report
 * does that reading for them, and flags the mismatch rather than merely
 * printing "FTS5 available".
 */
import type { Db } from '@DeFlow/core';
import {
  ARTIFACT_FTS_TOKENIZE,
  type ArtifactFtsAvailability,
  artifactFtsAvailability,
} from '@DeFlow/ledger';

/** AC7: the whole section, as `DeFlow doctor` will print it. */
export function renderArtifactFtsReport(availability: ArtifactFtsAvailability): string {
  if (!availability.fts5Compiled) {
    return (
      'artifact retrieval (FTS5): not available — this SQLite build was not compiled with ' +
      'ENABLE_FTS5, so F6.7 retrieval cannot run. better-sqlite3@13.0.2 bundles FTS5; a ' +
      'different driver or a system SQLite may not.'
    );
  }
  if (!availability.tableExists) {
    return (
      'artifact retrieval (FTS5): available, but artifact_fts does not exist yet — run the ' +
      'ledger migrations (KAR-09.10, migration 0012).'
    );
  }

  const lines = [
    `artifact retrieval (FTS5): available. artifact_fts tokenize = "${
      availability.tokenize ?? '(unreadable)'
    }"`,
  ];
  if (availability.tokenize !== ARTIFACT_FTS_TOKENIZE) {
    lines.push(
      `  this does not match the documented setting ("${ARTIFACT_FTS_TOKENIZE}") — recall on ` +
        'snake_case, kebab-case and dotted identifiers is degraded until the table is rebuilt. ' +
        'The tokenizer cannot be changed in place: ship a migration that drops artifact_fts and ' +
        'rebuilds it from the artifact store (docs/08-context-and-memory.md §10; KAR-09.10 AC6).',
    );
  }
  return lines.join('\n');
}

/** The same report, read from a ledger. */
export function artifactFtsReport(db: Db): string {
  return renderArtifactFtsReport(artifactFtsAvailability(db));
}
