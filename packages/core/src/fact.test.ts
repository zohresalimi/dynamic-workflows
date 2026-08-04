/**
 * KAR-02.5 — `Fact`, `Provenance` and the blackboard vocabulary
 * (docs/04-domain-model.md §5).
 *
 * The blackboard is a projection, never a store (§5.1): this module's own
 * "no mutator" grep test is the enforcement for that rule inside the domain
 * package. `atEvent`, not `at`, is the ordering key (§5.2 /
 * docs/05-durable-execution.md §9.6) because the wall clock is not monotonic
 * — laptop sleep and NTP correction both move `Date.now()` backwards.
 *
 * Verifies: EPIC-02-S14 (kind/key grammar), EPIC-02-S16 · AC1–AC7
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { compareFactsByEventOrder, FactSchema } from './fact.ts';
import type { FactId } from './ids.ts';

const factSource = readFileSync(fileURLToPath(new URL('./fact.ts', import.meta.url)), 'utf8');

/** A syntactically valid `FactId`: `fact_` plus 26 lowercase-alnum characters. */
function fid(seed: string): FactId {
  const padded = seed.repeat(26).slice(0, 26).padEnd(26, '0');
  return `fact_${padded}` as FactId;
}

const provenance = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  byNode: 'recon-auth-surface',
  byProvider: 'claude-code',
  byModel: 'claude-sonnet-4-6',
  fromEvidence: [`artifact://${'b'.repeat(64)}`],
  atEvent: 412,
  at: '2026-08-02T14:11:33.000Z',
  confidence: 'verified',
  ...overrides,
});

const fact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: fid('a'),
  key: 'finding/auth-uses-jwt',
  kind: 'finding',
  schemaId: 'DeFlow.finding.v1',
  value: { summary: 'the auth layer issues JWTs' },
  provenance: provenance(),
  ...overrides,
});

suite('Fact key grammar (AC1, AC2, AC3)', () => {
  it.each([
    // core kinds: '<kind>/<slug>' — 6 accept
    ['finding', 'finding/auth-uses-jwt', true],
    ['decision', 'decision/use-pinia-not-vuex', true],
    ['verdict', 'verdict/typecheck-gate', true],
    ['artifact', 'artifact/build-output', true],
    ['scope', 'scope/discovered-paths', true],
    ['ext', 'ext:migration/vue3-incompat-list', true],
    // 4 reject
    ['finding', 'decision/use-pinia-not-vuex', false],
    ['finding', 'ext:migration/vue3-incompat-list', false],
    ['hunch', 'hunch/maybe-its-the-router', false],
    ['risk', 'risk', false],
  ])('kind=%s key=%s -> ok=%s', (kind, key, ok) => {
    expect(FactSchema.safeParse(fact({ kind, key })).success).toBe(ok);
  });

  it('AC1: key "finding/x" is rejected when kind is "decision"', () => {
    expect(FactSchema.safeParse(fact({ kind: 'decision', key: 'finding/x' })).success).toBe(false);
  });

  it('AC2: an ext: key parses only with kind "ext"', () => {
    const key = 'ext:migration/vue3-incompat-list';
    expect(FactSchema.safeParse(fact({ kind: 'ext', key })).success).toBe(true);
    expect(() => FactSchema.parse(fact({ kind: 'finding', key }))).toThrow();
  });

  it('AC3: a kind outside the seven is rejected', () => {
    expect(FactSchema.safeParse(fact({ kind: 'hunch', key: 'hunch/maybe' })).success).toBe(false);
  });
});

suite('No mutator export (AC7)', () => {
  it('fact.ts exports no set/write/update function', () => {
    const exportNames = [...factSource.matchAll(/export\s+(?:function|const)\s+(\w+)/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    expect(exportNames.length).toBeGreaterThan(0);
    const mutators = exportNames.filter((name) => /^(set|write|update)/.test(name));
    expect(mutators).toEqual([]);
  });
});

suite('supersedes (AC5)', () => {
  it('a fact superseding a different FactId is accepted', () => {
    const result = FactSchema.safeParse(fact({ id: fid('b'), supersedes: fid('a') }));
    expect(result.success).toBe(true);
  });

  it('a fact superseding itself is rejected', () => {
    const result = FactSchema.safeParse(fact({ id: fid('a'), supersedes: fid('a') }));
    expect(result.success).toBe(false);
  });
});

suite('invalidatedBy is an EventSeq (AC6)', () => {
  it('accepts a positive integer event sequence', () => {
    const result = FactSchema.safeParse(fact({ invalidatedBy: 500 }));
    expect(result.success).toBe(true);
  });

  it('rejects a non-numeric invalidatedBy', () => {
    const result = FactSchema.safeParse(fact({ invalidatedBy: '2026-08-02T00:00:00Z' }));
    expect(result.success).toBe(false);
  });
});

suite('ordering by atEvent, never by at (AC4)', () => {
  it('sorts a shuffled fact array by atEvent even when `at` timestamps run backwards', () => {
    const early = FactSchema.parse(
      fact({ id: fid('1'), provenance: provenance({ atEvent: 412, at: '2026-08-02T14:11:33Z' }) }),
    );
    const late = FactSchema.parse(
      fact({ id: fid('2'), provenance: provenance({ atEvent: 431, at: '2026-08-02T14:11:19Z' }) }),
    );
    const mid = FactSchema.parse(
      fact({ id: fid('3'), provenance: provenance({ atEvent: 419, at: '2026-08-02T14:11:41Z' }) }),
    );
    // `at` order here would be early(:33) -> late(:19) -> mid(:41): NTP
    // corrected the clock backwards between `late` and `mid`. Only atEvent
    // order (412, 419, 431) is correct.
    const sorted = [late, early, mid].sort(compareFactsByEventOrder);
    expect(sorted.map((f) => f.provenance.atEvent)).toEqual([412, 419, 431]);
  });
});

suite('round trip', () => {
  it('a full Fact survives JSON.stringify/parse unchanged', () => {
    const parsed = FactSchema.parse(fact({ supersedes: fid('z'), invalidatedBy: 500 }));
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });
});
