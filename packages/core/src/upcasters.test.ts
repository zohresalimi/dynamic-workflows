/**
 * KAR-02.7 — the upcaster registry.
 *
 * Verifies: EPIC-02-S20, EPIC-02-S21, EPIC-02-S22 · AC2, AC4, AC5, AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { z } from 'zod';
import { EVENT_CURRENT_VERSIONS } from './event-payloads.ts';
import {
  assertUpcasterChainsComplete,
  checkUpcasterFixtures,
  checkUpcastersPreserveRequiredFields,
  DuplicateUpcaster,
  eventUpcasters,
  UnknownUpcasterKind,
  UpcasterChainIncomplete,
  UpcasterFutureVersion,
  UpcasterRegistry,
} from './upcasters.ts';

// A toy three-version history, standing in for the real one the ledger does
// not have yet: v1 gains a `phase`, v2 gains a nullable `ioChunkSeq`. Both are
// field-adding changes, which is exactly the class of change a `v` bump is
// allowed to express (EPIC-02-S22 scenario 1).
const V2 = z.strictObject({
  node: z.string(),
  attempt: z.number(),
  phase: z.string(),
});

const V3 = z.strictObject({
  node: z.string(),
  attempt: z.number(),
  phase: z.string(),
  ioChunkSeq: z.union([z.number(), z.null()]),
});

const v1Fixture = { node: 'recon-auth-surface', attempt: 1 };
const v2Fixture = { node: 'recon-auth-surface', attempt: 1, phase: 'unknown' };

function nodeCompletedRegistry(): UpcasterRegistry {
  const registry = new UpcasterRegistry({ 'node.completed': 3 });
  registry.register({
    kind: 'node.completed',
    from: 1,
    to: V2,
    fixture: v1Fixture,
    up: (payload) => ({ ...(payload as object), phase: 'unknown' }),
  });
  registry.register({
    kind: 'node.completed',
    from: 2,
    to: V3,
    fixture: v2Fixture,
    up: (payload) => ({ ...(payload as object), ioChunkSeq: null }),
  });
  return registry;
}

suite('a chain lifts a v1 payload to the current version (AC2, EPIC-02-S20)', () => {
  it('applies both hops, in ascending version order, and the result parses at v3', () => {
    const registry = nodeCompletedRegistry();

    const lifted = registry.upcast('node.completed', 1, v1Fixture);

    // The whole value, asserted at once: the epic's test plan asks for a
    // snapshot of the two-hop result, and an exhaustive `toEqual` is the same
    // assertion without depending on the normalising serializer's whitespace.
    expect(lifted).toEqual({
      node: 'recon-auth-surface',
      attempt: 1,
      phase: 'unknown',
      ioChunkSeq: null,
    });
    expect(V3.safeParse(lifted).success).toBe(true);
  });

  it('runs the hops in ascending order, not registration order', () => {
    const order: number[] = [];
    const registry = new UpcasterRegistry({ 'k.x': 3 });
    registry.register({
      kind: 'k.x',
      from: 2,
      to: z.unknown(),
      fixture: {},
      up: (payload) => {
        order.push(2);
        return payload;
      },
    });
    registry.register({
      kind: 'k.x',
      from: 1,
      to: z.unknown(),
      fixture: {},
      up: (payload) => {
        order.push(1);
        return payload;
      },
    });

    registry.upcast('k.x', 1, {});

    expect(order).toEqual([1, 2]);
  });

  it('is the identity at the current version — nothing to lift', () => {
    const registry = nodeCompletedRegistry();
    const payload = { node: 'a', attempt: 1, phase: 'x', ioChunkSeq: null };

    expect(registry.upcast('node.completed', 3, payload)).toEqual(payload);
  });

  it('refuses to upcast a kind it does not know', () => {
    expect(() => nodeCompletedRegistry().upcast('future.thing', 1, {})).toThrow(
      UnknownUpcasterKind,
    );
  });

  it('refuses to downcast: a future version is never guessed at (AC3)', () => {
    expect(() => nodeCompletedRegistry().upcast('node.completed', 4, {})).toThrow(
      UpcasterFutureVersion,
    );
  });
});

suite('upcasters are pure (AC5, EPIC-02-S20)', () => {
  it('returns deeply-equal results when called twice on the same input', () => {
    const registry = nodeCompletedRegistry();

    const first = registry.upcast('node.completed', 1, v1Fixture);
    const second = registry.upcast('node.completed', 1, v1Fixture);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('does not mutate the caller’s payload, even when an upcaster tries to', () => {
    const registry = new UpcasterRegistry({ 'k.mutating': 2 });
    registry.register({
      kind: 'k.mutating',
      from: 1,
      to: z.strictObject({ node: z.string(), phase: z.string() }),
      fixture: { node: 'a' },
      up: (payload) => {
        // A deliberately badly-written upcaster: the registry has to defend
        // against this, because the on-disk event it came from is immutable
        // and the caller may still be holding the parsed value.
        const mutable = payload as Record<string, unknown>;
        mutable.phase = 'mutated-in-place';
        return mutable;
      },
    });

    const input = { node: 'a' };
    const lifted = registry.upcast('k.mutating', 1, input);

    expect(input).toEqual({ node: 'a' });
    expect(lifted).toEqual({ node: 'a', phase: 'mutated-in-place' });
  });

  it('refuses a second registration for the same (kind, version)', () => {
    const registry = nodeCompletedRegistry();

    let thrown: unknown;
    try {
      registry.register({
        kind: 'node.completed',
        from: 1,
        to: V2,
        fixture: v1Fixture,
        up: (payload) => payload,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateUpcaster);
    expect((thrown as DuplicateUpcaster).message).toContain('duplicate-upcaster');
    expect((thrown as DuplicateUpcaster).message).toContain('node.completed');
    expect((thrown as DuplicateUpcaster).message).toContain('1');
  });

  it('refuses to register an upcaster for a kind it has no current version for', () => {
    const registry = new UpcasterRegistry({ 'k.x': 1 });

    expect(() =>
      registry.register({
        kind: 'k.unknown',
        from: 1,
        to: z.unknown(),
        fixture: {},
        up: (payload) => payload,
      }),
    ).toThrow(UnknownUpcasterKind);
  });
});

suite('chain completeness is checked eagerly (AC4, EPIC-02-S21)', () => {
  it('throws naming the kind and the missing version', () => {
    const registry = new UpcasterRegistry({ 'gate.evaluated': 3 });
    registry.register({
      kind: 'gate.evaluated',
      from: 1,
      to: z.unknown(),
      fixture: {},
      up: (payload) => payload,
    });

    let thrown: unknown;
    try {
      registry.assertChainsComplete();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpcasterChainIncomplete);
    const gap = thrown as UpcasterChainIncomplete;
    expect(gap.kind).toBe('gate.evaluated');
    expect(gap.version).toBe(2);
    expect(gap.message).toContain('gate.evaluated');
    expect(gap.message).toContain('2');
  });

  it('reports every hole, not only the first', () => {
    const registry = new UpcasterRegistry({ 'a.x': 3, 'b.y': 2 });

    expect(registry.missingHops()).toEqual([
      { kind: 'a.x', version: 1 },
      { kind: 'a.x', version: 2 },
      { kind: 'b.y', version: 1 },
    ]);
  });

  it('passes when every hop from 1 to current-1 is registered', () => {
    expect(() => nodeCompletedRegistry().assertChainsComplete()).not.toThrow();
    expect(nodeCompletedRegistry().missingHops()).toEqual([]);
  });

  it('holds over the real event registry', () => {
    // EPIC-02-S21 scenario 2, first clause. Vacuous today — every kind is at
    // v1, so there is no hop to be missing — and deliberately kept, because
    // the first time a kind goes to v2 this is what refuses to let it ship
    // without its upcaster.
    expect(() => assertUpcasterChainsComplete()).not.toThrow();
    expect(eventUpcasters.missingHops()).toEqual([]);
    expect(Object.keys(EVENT_CURRENT_VERSIONS).length).toBeGreaterThanOrEqual(40);
  });
});

suite('an upcaster must satisfy its own target schema (test 6, EPIC-02-S20)', () => {
  it('is clean over the real registry', () => {
    expect(checkUpcasterFixtures(eventUpcasters)).toEqual([]);
  });

  it('is clean over a well-formed chain', () => {
    expect(checkUpcasterFixtures(nodeCompletedRegistry())).toEqual([]);
  });

  it('catches an upcaster whose output its own target rejects', () => {
    const registry = new UpcasterRegistry({ 'k.bad': 2 });
    registry.register({
      kind: 'k.bad',
      from: 1,
      to: z.strictObject({ node: z.string(), phase: z.string() }),
      fixture: { node: 'a' },
      up: (payload) => ({ ...(payload as object), phase: 42 }),
    });

    const violations = checkUpcasterFixtures(registry);

    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('k.bad');
    expect(violations[0]?.from).toBe(1);
  });
});

suite('a lossy change is a new kind, not a new v (AC8, EPIC-02-S22)', () => {
  it('is clean over the real registry', () => {
    expect(checkUpcastersPreserveRequiredFields(eventUpcasters)).toEqual([]);
  });

  it('is clean when the change only adds fields', () => {
    expect(checkUpcastersPreserveRequiredFields(nodeCompletedRegistry())).toEqual([]);
  });

  it('catches an upcaster that drops a field its target marks required', () => {
    const registry = new UpcasterRegistry({ 'k.lossy': 2 });
    registry.register({
      kind: 'k.lossy',
      from: 1,
      to: z.strictObject({ node: z.string(), reason: z.string() }),
      fixture: { node: 'a', reason: 'because' },
      // Drops `reason`, which the target still marks required. No pure
      // function from the old payload to the new one exists, so this change
      // is a new kind — and this is the mechanical half of that rule.
      up: (payload) => ({ node: (payload as { node: string }).node }),
    });

    const violations = checkUpcastersPreserveRequiredFields(registry);

    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('k.lossy');
    expect(violations[0]?.message).toContain('reason');
  });

  it('does not flag an optional field the upcaster leaves out', () => {
    const registry = new UpcasterRegistry({ 'k.optional': 2 });
    registry.register({
      kind: 'k.optional',
      from: 1,
      to: z.strictObject({ node: z.string(), ioChunkSeq: z.number().optional() }),
      fixture: { node: 'a' },
      up: (payload) => ({ ...(payload as object) }),
    });

    expect(checkUpcastersPreserveRequiredFields(registry)).toEqual([]);
  });
});
