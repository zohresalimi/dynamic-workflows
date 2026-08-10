/**
 * KAR-15.6 AC9 — every list endpoint is bounded, and no request can widen it.
 *
 * The rule is one sentence — *"no endpoint can be made to return an unbounded
 * result set"* — and it has exactly two failure modes, both of which look
 * harmless in a route:
 *
 *   * an absent `limit` read as "no limit", which is how `GET /runs/:id/facts`
 *     on a nine-hour run becomes a 400 MB response nobody asked for; and
 *   * an oversized `limit` **honoured**, which is the same thing with a
 *     deliberate caller.
 *
 * So a limit is never read straight off the query string, and the cap is
 * applied by *clamping* rather than by refusing: a client that asks for a
 * million rows gets the cap and a header saying so, because a 400 there would
 * make a UI paging bug indistinguishable from a network failure.
 *
 * Verifies: EPIC-15-S44 (second scenario) · AC9
 */
import { expect, it, describe as suite } from 'vitest';
import { boundedLimit, READ_LIMITS } from './read-limits.ts';

const FACTS = READ_LIMITS.facts;

suite('boundedLimit (AC9)', () => {
  it('applies the documented default when the caller names none', () => {
    expect(boundedLimit(undefined, FACTS)).toBe(FACTS.fallback);
    expect(boundedLimit('', FACTS)).toBe(FACTS.fallback);
  });

  it('honours a limit inside the cap', () => {
    expect(boundedLimit('7', FACTS)).toBe(7);
    expect(boundedLimit(String(FACTS.cap), FACTS)).toBe(FACTS.cap);
  });

  it('caps an oversized limit rather than honouring it', () => {
    expect(boundedLimit(String(FACTS.cap + 1), FACTS)).toBe(FACTS.cap);
    expect(boundedLimit('1000000', FACTS)).toBe(FACTS.cap);
    // The classic one: `Infinity` parses as a number and is not an integer.
    expect(boundedLimit('Infinity', FACTS)).toBe(FACTS.fallback);
  });

  it('falls back for anything that is not a positive integer', () => {
    for (const raw of ['0', '-1', '1.5', 'abc', 'NaN', ' ', '1e999']) {
      expect(boundedLimit(raw, FACTS)).toBe(FACTS.fallback);
    }
  });

  it('gives every list endpoint a default at or below its cap', () => {
    // A table whose default exceeds its cap would silently clamp every
    // unparameterised request, which is a documented default that is not the
    // default.
    for (const [name, limit] of Object.entries(READ_LIMITS)) {
      expect(limit.fallback, name).toBeGreaterThan(0);
      expect(limit.cap, name).toBeGreaterThanOrEqual(limit.fallback);
    }
  });
});
