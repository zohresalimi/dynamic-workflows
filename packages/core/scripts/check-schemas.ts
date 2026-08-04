/**
 * KAR-02.8 — `pnpm schemas:check`.
 *
 * Regenerates every registered schema from the Zod source and fails on any
 * divergence from the committed files (AC2), and on any document Ajv2020
 * refuses in strict mode (AC3). It is a **CI job, not a git hook**:
 * docs/14-testing-strategy.md §14.1 keeps pre-commit under about two seconds,
 * and this loads the whole domain package.
 *
 * Content is compared, never mtimes and never file counts alone — a check
 * that compares timestamps is green on a fresh clone and green on a stale
 * tree, which is the failure this story exists to make impossible.
 *
 * Usage: `pnpm schemas:check [--dir <path>]` (default `<repo>/schemas`).
 * Exit 0 and silence on success; exit 1 with the differing `schemaId` and a
 * unified diff otherwise.
 */

import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { AJV_2020_OPTIONS } from '../src/json-schema.ts';
import { generateAll, readSchemaDir, schemasDirFrom, unifiedDiff } from './schemas-io.ts';

// ajv and ajv-formats are CommonJS with a `default` export, which Node's ESM
// interop hands over as `.default` under some resolutions and as the module
// itself under others. Normalising here beats discovering it in CI.
type Interop<T> = T & { default?: T };
const Ajv2020 = (Ajv2020Module as Interop<typeof Ajv2020Module>).default ?? Ajv2020Module;
const addFormats =
  (addFormatsModule as Interop<typeof addFormatsModule>).default ?? addFormatsModule;

const dir = schemasDirFrom(process.argv.slice(2));
const generated = generateAll();
const onDisk = readSchemaDir(dir);
const problems: string[] = [];

for (const schema of generated) {
  // AC3: a Zod construct that emits something Ajv-strict rejects — an unknown
  // keyword, a `required` naming a property the schema never describes — is a
  // failed check here rather than a validator that throws at fact acceptance.
  const ajv = new Ajv2020(AJV_2020_OPTIONS);
  addFormats(ajv);
  try {
    ajv.compile(schema.document);
  } catch (thrown) {
    problems.push(
      `${schema.schemaId}: does not compile under Ajv2020 { strict: true } — ` +
        (thrown instanceof Error ? thrown.message : String(thrown)),
    );
    continue;
  }

  const current = onDisk.get(schema.fileName);
  if (current === undefined) {
    problems.push(`${schema.schemaId}: ${schema.fileName} is missing from ${dir}`);
    continue;
  }
  if (current !== schema.text) {
    problems.push(
      `${schema.schemaId}: ${schema.fileName} does not match the Zod source\n` +
        unifiedDiff(current, schema.text, `${schema.fileName} (on disk)`, 'generated from Zod'),
    );
  }
}

const registeredFiles = new Set(generated.map((schema) => schema.fileName));
for (const fileName of onDisk.keys()) {
  if (registeredFiles.has(fileName)) continue;
  problems.push(
    `${fileName.replace(/\.json$/, '')}: ${fileName} is in ${dir} but no schemaId is registered ` +
      'for it — remove it, or add it to SCHEMA_REGISTRY in packages/core/src/json-schema.ts',
  );
}

if (problems.length > 0) {
  process.stderr.write(
    `${problems.join('\n\n')}\n\n` +
      'The Zod schemas and the emitted JSON Schemas have drifted. Run "pnpm schemas:emit" ' +
      'and commit the result — and if the changed file is an already-shipped .v1, publish a ' +
      '.v2 instead: schemaId versioning is append-only (schemas/CHANGELOG.md).\n',
  );
  process.exitCode = 1;
}
