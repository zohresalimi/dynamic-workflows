/**
 * KAR-02.9 — the canonical JSON encoder.
 *
 * Verifies: EPIC-02-S8 · AC1, AC2, AC3, AC4, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { CanonicalJsonCycle, CanonicalJsonUnsupported, canonicalJson } from './canonical-json.ts';

/** A tiny, deterministic PRNG (mulberry32) so the 200-object property test
 * is reproducible without pulling in a property-testing dependency — this
 * package's only runtime dependency is zod (R1). */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const WORDS = ['goal', 'scope', 'nodeId', 'planHash', 'edges', 'nonGoals', 'a', 'zz', 'mid'];

function randomKey(rng: () => number): string {
  return WORDS[Math.floor(rng() * WORDS.length)] ?? 'k';
}

function randomScalar(rng: () => number): Json {
  const pick = rng();
  if (pick < 0.2) return null;
  if (pick < 0.4) return rng() < 0.5;
  if (pick < 0.7) return Math.round((rng() - 0.5) * 2000) / (rng() < 0.5 ? 1 : 100);
  return `s-${Math.floor(rng() * 100_000)}`;
}

/** Generates a random JSON value up to `depth` levels deep, including
 * arrays of objects, as EPIC-02-S8's first scenario requires. */
function randomJson(rng: () => number, depth: number): Json {
  if (depth <= 0 || rng() < 0.35) return randomScalar(rng);

  if (rng() < 0.5) {
    const length = Math.floor(rng() * 4);
    return Array.from({ length }, () => randomJson(rng, depth - 1));
  }

  const size = 1 + Math.floor(rng() * 4);
  const obj: Record<string, Json> = {};
  for (let i = 0; i < size; i += 1) {
    obj[randomKey(rng)] = randomJson(rng, depth - 1);
  }
  return obj;
}

/** Rebuilds `value` with every object's own keys re-inserted in a shuffled
 * order at every nesting depth, recursing through arrays too. The result is
 * deep-equal to `value` but was never built by inserting keys in the same
 * sequence — this is what "sorting is shallow" would fail on. */
function shuffleKeysDeep(value: Json, rng: () => number): Json {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => shuffleKeysDeep(item, rng));
  }

  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = entries[i];
    const b = entries[j];
    if (a === undefined || b === undefined) continue; // unreachable: i, j are always in bounds
    entries[i] = b;
    entries[j] = a;
  }
  const shuffled: Record<string, Json> = {};
  for (const [key, val] of entries) shuffled[key] = shuffleKeysDeep(val, rng);
  return shuffled;
}

suite('canonicalJson — key-order invariance', () => {
  it('is byte-identical for 200 generated objects and their key-shuffled twin, up to depth 6', () => {
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 200; i += 1) {
      const original = randomJson(rng, 6);
      const shuffled = shuffleKeysDeep(original, rng);
      expect(canonicalJson(shuffled)).toBe(canonicalJson(original));
    }
  });

  it('sorts keys at nested depth, not just the top level (a shallow sort would fail this)', () => {
    const nestedA = { outer: { z: 1, a: 2 }, list: [{ y: 1, b: 2 }] };
    const nestedB = { list: [{ b: 2, y: 1 }], outer: { a: 2, z: 1 } };
    expect(canonicalJson(nestedA)).toBe(canonicalJson(nestedB));
    expect(canonicalJson(nestedA)).toBe('{"list":[{"b":2,"y":1}],"outer":{"a":2,"z":1}}');
  });
});

suite('canonicalJson — undefined vs null', () => {
  it('omits undefined properties and preserves null ones', () => {
    expect(canonicalJson({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  it('does not conflate the two: an object with only a null key differs from one with none', () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({})).toBe('{}');
  });
});

suite('canonicalJson — refuses lossy values instead of coercing them', () => {
  it.each([
    ['a Date', { at: new Date('2026-08-02T00:00:00Z') }, '/at'],
    ['a Map', { m: new Map() }, '/m'],
    ['a Set', { s: new Set() }, '/s'],
    ['NaN', { n: Number.NaN }, '/n'],
    ['Infinity', { i: Number.POSITIVE_INFINITY }, '/i'],
    ['a BigInt', { b: 1n }, '/b'],
  ])('throws CanonicalJsonUnsupported naming the path for %s', (_label, value, expectedPath) => {
    let caught: unknown;
    try {
      canonicalJson(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonicalJsonUnsupported);
    expect((caught as CanonicalJsonUnsupported).path).toBe(expectedPath);
  });

  it('throws CanonicalJsonCycle, not a RangeError, on a self-referencing object', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    let caught: unknown;
    try {
      canonicalJson(cyclic);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonicalJsonCycle);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as CanonicalJsonCycle).path).toBe('/self');
  });

  it('does not mistake the same object reached twice (not cyclically) for a cycle', () => {
    const shared = { id: 1 };
    expect(() => canonicalJson({ left: shared, right: shared })).not.toThrow();
    expect(canonicalJson({ left: shared, right: shared })).toBe(
      '{"left":{"id":1},"right":{"id":1}}',
    );
  });

  it('refuses undefined inside an array rather than rewriting it to null', () => {
    expect(() => canonicalJson([1, undefined, 2])).toThrow(CanonicalJsonUnsupported);
  });
});

suite('canonicalJson — number round-tripping (AC4)', () => {
  it('gives 1.0 and 1 the same encoding', () => {
    expect(canonicalJson({ a: 1.0 })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: 1.0 })).toBe('{"a":1}');
  });

  it('never reformats a float in a way that changes its JSON.parse value', () => {
    const values = [0, -0, 1, -1, 0.1, 1e21, 1e-7, 123_456_789.987_654_3, Number.MIN_VALUE];
    for (const n of values) {
      const encoded = canonicalJson({ n });
      const parsed = JSON.parse(encoded) as { n: number };
      // -0 and 0 both parse back to a value that === 0; canonicalJson does
      // not promise to distinguish them and JSON has no way to either.
      expect(parsed.n).toBe(n === 0 ? 0 : n);
    }
  });
});

suite('canonicalJson — Unicode is never normalised (AC5)', () => {
  it('emits an NFC string and its NFD form as different byte sequences, unchanged', () => {
    const nfc = 'café'; // "café", precomposed é (U+00E9)
    const nfd = 'café'; // "café", e + combining acute (U+0065 U+0301)
    expect(nfc.normalize('NFC')).not.toBe(nfd); // sanity: the two inputs really do differ
    expect(canonicalJson(nfc)).toBe(JSON.stringify(nfc));
    expect(canonicalJson(nfd)).toBe(JSON.stringify(nfd));
    expect(canonicalJson(nfc)).not.toBe(canonicalJson(nfd));
  });
});
