/**
 * KAR-02.8 — fact acceptance: shape, then registration, then value.
 *
 * The registry is a port here and a real Ajv-over-`.DeFlow/schemas/` in
 * `@DeFlow/daemon` (packages/daemon/src/schema-store.ts), which is what keeps
 * these scenarios at the unit level the flows file asks for while the same
 * code path runs against real emitted files in the daemon's own spec.
 *
 * Verifies: EPIC-02-S14, EPIC-02-S15 · AC4, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { acceptFact, type FactSchemaRegistry, type SchemaIssue } from './accept-fact.ts';
import { FactWrittenSchema } from './event-payloads.ts';

const conformingValue = {
  claim: 'the API authenticates with a JWT bearer token',
  where: 'src/http/auth.ts',
};

/**
 * A registry that knows one schema and refuses everything else, so these
 * specs exercise `acceptFact`'s branching rather than Ajv's.
 */
function fakeRegistry(issuesFor: (value: unknown) => readonly SchemaIssue[]): FactSchemaRegistry {
  return {
    location: '.DeFlow/schemas/',
    has: (schemaId) => schemaId === 'DeFlow.finding.v1',
    validate: (schemaId, value) => {
      if (schemaId !== 'DeFlow.finding.v1') throw new Error('validate called for unknown id');
      return issuesFor(value);
    },
  };
}

const alwaysValid = fakeRegistry(() => []);

const factWith = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'fact_01hq5m9z00000000000000000a',
  key: 'finding/auth-uses-jwt',
  kind: 'finding',
  schemaId: 'DeFlow.finding.v1',
  value: conformingValue,
  provenance: {
    byNode: 'recon-auth-surface',
    byProvider: 'claude-code',
    byModel: 'claude-sonnet-4-6',
    fromEvidence: [`artifact://${'9f'.repeat(32)}`],
    atEvent: 412,
    at: '2026-08-02T14:11:33.000Z',
    confidence: 'verified',
  },
  ...overrides,
});

suite('a conforming fact is accepted (EPIC-02-S14 scenario 1)', () => {
  it('returns ok and yields a Fact a fact.written event can carry', () => {
    const result = acceptFact(factWith(), alwaysValid);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(FactWrittenSchema.safeParse({ fact: result.fact }).success).toBe(true);
  });
});

suite('a non-conforming value is rejected with every error (EPIC-02-S14 scenario 2)', () => {
  const twoViolations = fakeRegistry(() => [
    { pointer: '/claim', message: 'must be string' },
    { pointer: '/where', message: 'must match format "uri-reference"' },
  ]);

  it("returns 'schema-invalid' carrying both issues, each with a JSON Pointer", () => {
    const result = acceptFact(factWith({ value: { claim: 7 } }), twoViolations);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('schema-invalid');
    expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of result.error.issues) expect(issue.pointer.startsWith('/')).toBe(true);
    expect(result.error.message).toContain('DeFlow.finding.v1');
  });
});

suite('an unregistered schema id is refused by name (EPIC-02-S15, AC5)', () => {
  it("returns 'unknown-schema-id' naming the id and the directory", () => {
    const result = acceptFact(
      factWith({
        kind: 'ext',
        key: 'ext:migration/vue3-incompat-list',
        schemaId: 'ext.migration.vue3-incompat.v1',
      }),
      alwaysValid,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('unknown-schema-id');
    expect(result.error.message).toContain('ext.migration.vue3-incompat.v1');
    expect(result.error.message).toContain('.DeFlow/schemas/');
  });

  it('never asks the registry to validate against a schema it does not have', () => {
    // fakeRegistry throws if validate() is reached for an unknown id: the
    // order of the checks is the assertion.
    expect(() =>
      acceptFact(
        factWith({ kind: 'decision', key: 'decision/use-pinia-not-vuex', schemaId: 'ext.x.v1' }),
        alwaysValid,
      ),
    ).not.toThrow();
  });

  it('registering the schema makes the same fact acceptable (EPIC-02-S15 scenario 2)', () => {
    const candidate = factWith({
      kind: 'ext',
      key: 'ext:migration/vue3-incompat-list',
      schemaId: 'ext.migration.vue3-incompat.v1',
    });
    const withExtRegistered: FactSchemaRegistry = {
      location: '.DeFlow/schemas/',
      has: () => true,
      validate: () => [],
    };

    expect(acceptFact(candidate, withExtRegistered).ok).toBe(true);
  });
});

suite('kind and key prefix must agree (EPIC-02-S14 scenario outline)', () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['finding', 'finding/auth-uses-jwt', true],
    ['decision', 'decision/use-pinia-not-vuex', true],
    ['verdict', 'verdict/typecheck-gate', true],
    ['finding', 'decision/use-pinia-not-vuex', false],
    ['ext', 'ext:migration/vue3-incompat-list', true],
    ['finding', 'ext:migration/vue3-incompat-list', false],
    ['hunch', 'hunch/maybe-its-the-router', false],
  ];

  for (const [kind, key, ok] of cases) {
    it(`${kind} + ${key} -> ${ok}`, () => {
      const registry: FactSchemaRegistry = {
        location: '.DeFlow/schemas/',
        has: () => true,
        validate: () => [],
      };
      expect(acceptFact(factWith({ kind, key }), registry).ok).toBe(ok);
    });
  }

  it("a malformed fact is 'malformed-fact', with a JSON Pointer into the fact", () => {
    const result = acceptFact(factWith({ kind: 'finding', key: 'decision/x' }), alwaysValid);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('malformed-fact');
    expect(result.error.issues.map((issue) => issue.pointer)).toContain('/key');
  });
});
