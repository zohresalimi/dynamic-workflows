/**
 * KAR-02.8 — `pnpm schemas:emit`.
 *
 * Writes one JSON Schema 2020-12 document per registered `schemaId` from the
 * Zod source of truth (AC1). Run it whenever a registered schema changes, and
 * commit the result: `pnpm schemas:check` in CI is what proves you did.
 *
 * Usage: `pnpm schemas:emit [--dir <path>]` (default `<repo>/schemas`).
 */
import { generateAll, schemasDirFrom, writeAll } from './schemas-io.ts';

const dir = schemasDirFrom(process.argv.slice(2));
const generated = generateAll();
writeAll(dir, generated);

process.stdout.write(
  `${generated.length} schema${generated.length === 1 ? '' : 's'} written to ${dir}\n` +
    `${generated.map((schema) => `  ${schema.fileName}`).join('\n')}\n`,
);
