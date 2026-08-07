/**
 * KAR-02.8 — the Ajv2020 validator over the emitted schema directory, and the
 * conformance corpus every emitted document is held to.
 *
 * This is where "the emitted files are usable by the one validator we ship"
 * stops being a claim: every registered document is compiled under
 * `{ strict: true }`, then run against a hand-written conforming fixture and a
 * counter-fixture. A schema that compiles but accepts anything passes the
 * first half and fails the second.
 *
 * Verifies: EPIC-02-S25, EPIC-02-S14 (Ajv half), EPIC-02-S15 (real directory
 * half) · AC3, AC4, AC5 · test plan #4, #5
 */

import { acceptFact, REGISTERED_SCHEMA_IDS } from '@DeFlow/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { loadSchemaDirectory, makeValidator } from './schema-store.ts';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const schemasDir = join(repoRoot, 'schemas');
const corpus = join(repoRoot, 'fixtures/schemas');

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/**
 * One conforming document and one counter-document per registered schemaId.
 * The three that already have a hand-written fixture in `@DeFlow/core`'s test
 * corpus reuse it rather than growing a second copy that can drift.
 */
const CONFORMING: Record<string, string> = {
  'DeFlow.contextpacket.v1': join(corpus, 'DeFlow.contextpacket.v1.valid.json'),
  'DeFlow.fact.v1': join(corpus, 'DeFlow.fact.v1.valid.json'),
  'DeFlow.finding.v1': join(corpus, 'DeFlow.finding.v1.valid.json'),
  'DeFlow.plangraph.v1': join(repoRoot, 'packages/core/test/fixtures/plans/seven-types.json'),
  'DeFlow.planpatch.v1': join(repoRoot, 'packages/core/test/fixtures/patches/three-ops.json'),
  'DeFlow.reconfact.v1': join(corpus, 'DeFlow.reconfact.v1.valid.json'),
  'DeFlow.reconsurvey.v1': join(corpus, 'DeFlow.reconsurvey.v1.valid.json'),
  'DeFlow.taskspec.v1': join(repoRoot, 'packages/core/test/fixtures/specs/vue3-migration.json'),
  'DeFlow.taskspecdraft.v1': join(
    repoRoot,
    'packages/core/test/fixtures/specs/vue3-migration.framed.json',
  ),
  'DeFlow.verdict.v1': join(corpus, 'DeFlow.verdict.v1.valid.json'),
  'DeFlow.verdict.v2': join(corpus, 'DeFlow.verdict.v2.valid.json'),
};

suite('the emitted directory loads (AC3, test plan #4)', () => {
  it('has a file for every registered schemaId and nothing else', () => {
    const store = loadSchemaDirectory(schemasDir);
    expect([...store.schemaIds].sort()).toEqual([...REGISTERED_SCHEMA_IDS].sort());
  });

  it('reports the directory it read, which is what a rejection names', () => {
    expect(loadSchemaDirectory(schemasDir).location).toContain('schemas');
  });
});

suite('every emitted schema compiles under Ajv2020 strict (EPIC-02-S25)', () => {
  for (const schemaId of REGISTERED_SCHEMA_IDS) {
    it(`${schemaId} compiles, accepts its fixture and rejects its counter-fixture`, () => {
      // Compiling is loadSchemaDirectory's job and it throws on a strict-mode
      // violation; reaching makeValidator at all is half the assertion.
      const validate = makeValidator(schemaId, { dir: schemasDir });

      const conformingPath = CONFORMING[schemaId];
      expect(conformingPath, `no conforming fixture for ${schemaId}`).toBeDefined();
      if (conformingPath === undefined) throw new Error('unreachable');
      expect(existsSync(conformingPath), conformingPath).toBe(true);
      expect(validate(readJson(conformingPath)), conformingPath).toEqual([]);

      const counterPath = join(corpus, `${schemaId}.counter.json`);
      expect(existsSync(counterPath), counterPath).toBe(true);
      expect(validate(readJson(counterPath)).length, counterPath).toBeGreaterThan(0);
    });
  }

  it('declares the 2020-12 dialect in the file on disk', () => {
    for (const schemaId of REGISTERED_SCHEMA_IDS) {
      const document = readJson(join(schemasDir, `${schemaId}.json`)) as Record<string, unknown>;
      expect(document.$schema, schemaId).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });
});

suite('makeValidator (AC4, test plan #5)', () => {
  it('accepts a conforming finding value', () => {
    const validate = makeValidator('DeFlow.finding.v1', { dir: schemasDir });
    expect(validate(readJson(CONFORMING['DeFlow.finding.v1'] as string))).toEqual([]);
  });

  it('returns every error with a JSON Pointer, not just the first', () => {
    const validate = makeValidator('DeFlow.finding.v1', { dir: schemasDir });

    // Two independent violations: a severity outside the enum and an empty
    // message. allErrors: false would report one and stop.
    const issues = validate({ id: 'x', severity: 'catastrophic', message: '', evidence: [] });

    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.map((issue) => issue.pointer)).toContain('/severity');
    expect(issues.map((issue) => issue.pointer)).toContain('/message');
    for (const issue of issues) expect(issue.message.length).toBeGreaterThan(0);
  });

  it('refuses an unregistered id by name', () => {
    expect(() => makeValidator('ext.migration.vue3-incompat.v1', { dir: schemasDir })).toThrow(
      /ext\.migration\.vue3-incompat\.v1/,
    );
  });
});

suite('acceptFact over the real directory (EPIC-02-S14, EPIC-02-S15, AC5)', () => {
  const store = () => loadSchemaDirectory(schemasDir);

  it('accepts a conforming fact', () => {
    const result = acceptFact(readJson(join(corpus, 'DeFlow.fact.v1.valid.json')), store());
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("refuses an ext: fact whose schema is not in the directory, with 'unknown-schema-id'", () => {
    const fact = readJson(join(corpus, 'DeFlow.fact.v1.valid.json')) as Record<string, unknown>;
    const result = acceptFact(
      {
        ...fact,
        kind: 'ext',
        key: 'ext:migration/vue3-incompat-list',
        schemaId: 'ext.migration.vue3-incompat.v1',
      },
      store(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('unknown-schema-id');
    expect(result.error.message).toContain('ext.migration.vue3-incompat.v1');
    expect(result.error.message).toContain('schemas');
  });

  it("refuses a non-conforming value with 'schema-invalid' and every issue", () => {
    const fact = readJson(join(corpus, 'DeFlow.fact.v1.valid.json')) as Record<string, unknown>;
    const result = acceptFact(
      { ...fact, value: { id: 'x', severity: 'catastrophic', message: '', evidence: [] } },
      store(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('schema-invalid');
    expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
  });
});
