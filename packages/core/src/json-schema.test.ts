/**
 * KAR-02.8 — the pure half of JSON Schema emission: the registry of
 * `(schemaId, zodSchema)` pairs and the conversion to a standalone
 * 2020-12 document. The filesystem half lives in `packages/core/scripts/`
 * and is exercised by
 * `packages/core/test/integration/schemas-emit-check.test.ts`.
 *
 * Verifies: EPIC-02-S25 (dialect and standalone-document halves) · AC1, AC3 ·
 * test plan #1
 */
import { expect, it, describe as suite } from 'vitest';
import { FactSchema } from './fact.ts';
import { SchemaIdSchema } from './ids.ts';
import {
  JSON_SCHEMA_DIALECT,
  REGISTERED_SCHEMA_IDS,
  schemaRegistrationOf,
  serializeSchemaDocument,
  toJsonSchemaDocument,
  UnknownSchemaId,
} from './json-schema.ts';

const EXPECTED_IDS = [
  'DeFlow.contextpacket.v1',
  'DeFlow.fact.v1',
  'DeFlow.finding.v1',
  'DeFlow.plangraph.v1',
  'DeFlow.planpatch.v1',
  'DeFlow.taskspecdraft.v1',
  'DeFlow.taskspec.v1',
  'DeFlow.verdict.v1',
  'DeFlow.verdict.v2',
];

/** Every `$ref` in the document, wherever it appears. */
function refsOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => refsOf(child));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === '$ref' && typeof value === 'string' ? [value] : refsOf(value),
  );
}

suite('the schema registry', () => {
  it('registers exactly the documents shipped, in registry order and unique', () => {
    expect([...REGISTERED_SCHEMA_IDS]).toEqual(EXPECTED_IDS);
    expect(new Set(REGISTERED_SCHEMA_IDS).size).toBe(REGISTERED_SCHEMA_IDS.length);
  });

  it('every registered id is a legal SchemaId', () => {
    for (const id of REGISTERED_SCHEMA_IDS) {
      expect(SchemaIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it('carries the Zod schema itself, so the emitter has one source of truth', () => {
    expect(schemaRegistrationOf('DeFlow.fact.v1').schema).toBe(FactSchema);
  });
});

suite('toJsonSchemaDocument (AC1)', () => {
  it('declares the 2020-12 dialect on every registered id', () => {
    for (const id of REGISTERED_SCHEMA_IDS) {
      const document = toJsonSchemaDocument(id) as Record<string, unknown>;
      expect(document.$schema, id).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(JSON_SCHEMA_DIALECT).toBe(document.$schema);
    }
  });

  it('names itself with a $id and a title, so a vendor CLI error names the document', () => {
    const document = toJsonSchemaDocument('DeFlow.finding.v1') as Record<string, unknown>;
    expect(document.$id).toContain('DeFlow.finding.v1.json');
    expect(document.title).toBe('DeFlow.finding.v1');
  });

  it('is a standalone document: no $ref leaves the file (EPIC-02-S25 scenario 2)', () => {
    for (const id of REGISTERED_SCHEMA_IDS) {
      for (const ref of refsOf(toJsonSchemaDocument(id))) {
        expect(ref.startsWith('#'), `${id} refs ${ref}`).toBe(true);
      }
    }
  });

  it('describes every key it marks required, which Ajv strictRequired demands (AC3)', () => {
    // z.record(SegmentKindSchema, …) emits `required` for all nine kinds with
    // no matching `properties` entry — a record's keys live under
    // `additionalProperties`. Ajv's strictRequired refuses that, so the
    // emitter expands them.
    const at = (document: unknown, ...path: readonly string[]): Record<string, unknown> => {
      let node: unknown = document;
      for (const key of path) {
        expect(typeof node, `${path.join('.')} stops at ${key}`).toBe('object');
        node = (node as Record<string, unknown>)[key];
      }
      return node as Record<string, unknown>;
    };

    const byKind = at(
      toJsonSchemaDocument('DeFlow.contextpacket.v1'),
      'properties',
      'totals',
      'properties',
      'byKind',
    );

    expect(Object.keys(at(byKind, 'properties')).sort()).toEqual(
      [...(byKind.required as string[])].sort(),
    );
    expect(Object.keys(at(byKind, 'properties'))).toContain('pinned.constraints');
  });

  it('refuses an unregistered id by name (AC5 is built on this)', () => {
    expect(() => toJsonSchemaDocument('DeFlow.nope.v1')).toThrow(UnknownSchemaId);
    expect(() => toJsonSchemaDocument('DeFlow.nope.v1')).toThrow(/DeFlow\.nope\.v1/);
  });
});

suite('serializeSchemaDocument', () => {
  it('is byte-stable across calls, so the drift check can compare content', () => {
    expect(serializeSchemaDocument(toJsonSchemaDocument('DeFlow.fact.v1'))).toBe(
      serializeSchemaDocument(toJsonSchemaDocument('DeFlow.fact.v1')),
    );
  });

  it('ends in exactly one newline and indents by two', () => {
    const text = serializeSchemaDocument(toJsonSchemaDocument('DeFlow.fact.v1'));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text.split('\n')[1]).toMatch(/^ {2}"/);
  });

  it('matches the committed file snapshot (test plan #1)', async () => {
    await expect(
      serializeSchemaDocument(toJsonSchemaDocument('DeFlow.taskspec.v1')),
    ).toMatchFileSnapshot('__snapshots__/DeFlow.taskspec.v1.json');
  });
});
