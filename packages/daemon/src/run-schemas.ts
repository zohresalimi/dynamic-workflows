/**
 * KAR-12.3 AC1 — the run's copy of the contracts, written when the run is
 * created (NF8: every artifact inspectable on disk).
 *
 * `@DeFlow/core` owns the Zod source and converts it; it cannot write a
 * directory (R1). This module is the writer, and it is deliberately the *only*
 * producer of a run's `.DeFlow/schemas/`: a second one would be the second copy
 * AC1 forbids.
 *
 * **One document, one file, two names.** The verdict document is written as
 * `verdict.schema.json` — the path docs/10-verification-gates.md §4 names and
 * the path an `agent` gate node hands a vendor CLI on `--json-schema` /
 * `--output-schema`. It is *not* also written as `DeFlow.verdict.v3.json`:
 * two files with the same `$id` would not compile together, and, more to the
 * point, a reader would then have to ask which of the two the daemon actually
 * validates against. `loadSchemaDirectory` registers each compiled document
 * under its file name *and* under the `schemaId` in its `title`, so a caller
 * holding a `NodeReturns.schemaId` and a caller holding a path arrive at the
 * same validator over the same bytes.
 *
 * Generated rather than copied from the repository's `schemas/`, because a copy
 * would be a copy of whatever happened to be on that machine — `pnpm
 * schemas:check` proves the two agree, and this writes the same function's
 * output directly.
 *
 * Verifies: EPIC-12-S18 · AC1
 */
import { runSchemaFileName, serializeSchemaDocument, toJsonSchemaDocuments } from '@DeFlow/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `<runRoot>/.DeFlow/schemas` — where `deflow init` puts the contracts. */
export function runSchemasDir(runRoot: string): string {
  return join(runRoot, '.DeFlow', 'schemas');
}

/**
 * Writes every registered document into the run's schemas directory and
 * returns it.
 *
 * Idempotent: re-running over an existing directory rewrites the same bytes,
 * which is what a resumed run wants — the daemon that resumes may be a
 * different build from the one that created the directory, and the contracts it
 * is about to enforce should be the ones it understands.
 */
export function writeRunSchemas(runRoot: string): string {
  const dir = runSchemasDir(runRoot);
  mkdirSync(dir, { recursive: true });
  for (const [schemaId, document] of toJsonSchemaDocuments()) {
    writeFileSync(join(dir, runSchemaFileName(schemaId)), serializeSchemaDocument(document));
  }
  return dir;
}
