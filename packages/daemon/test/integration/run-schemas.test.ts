/**
 * KAR-12.3 AC1 — the run's `.DeFlow/schemas/` directory, written on run
 * creation, and the fact that the file handed to a vendor CLI is the same file
 * the daemon validates against.
 *
 * Integration because every claim is about a real directory: which files exist,
 * that Ajv compiles them from disk under `strict: true`, and that one document
 * is addressable by both the name the run directory gives it and the `schemaId`
 * it carries in `title`. A unit test over `toJsonSchemaDocument` proves none of
 * that — the interesting failure is a run directory that has the wrong bytes.
 *
 * Verifies: EPIC-12-S18 (second and third scenarios) · AC1 · test plan #2
 */
import { REGISTERED_SCHEMA_IDS, VERDICT_SCHEMA_FILE, VERDICT_V3_SCHEMA_ID } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { runSchemasDir, writeRunSchemas } from '../../src/run-schemas.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

suite('writeRunSchemas (AC1)', () => {
  it('writes every registered document into the run directory', ({ tmp }) => {
    const dir = writeRunSchemas(tmp);

    expect(dir).toBe(runSchemasDir(tmp));
    expect(readdirSync(dir).length).toBe(REGISTERED_SCHEMA_IDS.length);
  });

  it('writes the verdict under the name the vendor flag is given', ({ tmp }) => {
    const dir = writeRunSchemas(tmp);
    const document = readJson(join(dir, VERDICT_SCHEMA_FILE));

    expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(document.title).toBe(VERDICT_V3_SCHEMA_ID);
  });

  it('writes exactly one copy of it: there is no DeFlow.verdict.v3.json beside it', ({ tmp }) => {
    const dir = writeRunSchemas(tmp);

    expect(readdirSync(dir)).toContain(VERDICT_SCHEMA_FILE);
    expect(readdirSync(dir)).not.toContain(`${VERDICT_V3_SCHEMA_ID}.json`);
  });

  it('is idempotent, so a resumed run does not care whether it ran before', ({ tmp }) => {
    const first = readJson(join(writeRunSchemas(tmp), VERDICT_SCHEMA_FILE));
    const second = readJson(join(writeRunSchemas(tmp), VERDICT_SCHEMA_FILE));

    expect(second).toEqual(first);
  });
});

suite('the file on disk is what validates (AC1, third scenario)', () => {
  it('compiles under Ajv strict, from the bytes in the run directory', ({ tmp }) => {
    // `strict: true` turns a strict-mode warning into a compilation failure, so
    // "zero strict-mode warnings" is exactly "this call did not throw".
    const store = loadSchemaDirectory(writeRunSchemas(tmp));

    expect(store.schemaIds).toContain(VERDICT_V3_SCHEMA_ID);
  });

  it('addresses the verdict by its schemaId as well as by its file name', ({ tmp }) => {
    const store = loadSchemaDirectory(writeRunSchemas(tmp));

    expect(store.has(VERDICT_V3_SCHEMA_ID)).toBe(true);
    expect(store.has('verdict.schema')).toBe(true);
  });

  it('accepts a conforming verdict and rejects one that names no blob', ({ tmp }) => {
    const store = loadSchemaDirectory(writeRunSchemas(tmp));
    const valid = readJson(
      new URL('../../../../fixtures/schemas/DeFlow.verdict.v3.valid.json', import.meta.url)
        .pathname,
    );

    expect(store.validate(VERDICT_V3_SCHEMA_ID, valid)).toEqual([]);

    const unanchored = {
      ...valid,
      findings: [
        {
          id: '9c02f1a4b7d3',
          severity: 'blocker',
          message: 'the guard returns void',
          evidence: [],
          location: { file: 'src/router/guards.ts', line: 88 },
        },
      ],
    };

    expect(store.validate(VERDICT_V3_SCHEMA_ID, unanchored).length).toBeGreaterThan(0);
  });
});
