/**
 * KAR-06.5 — the `Random` port (EPIC-06-S19, third scenario).
 *
 * The architecture writes the backoff formula with `Math.random()` as
 * shorthand. Copying that literally into @DeFlow/core breaks NF9 and makes the
 * golden-sequence assertion impossible to write, which is exactly why the
 * scenario asks for the port by name.
 *
 * Verifies: EPIC-06-S19 (scenario 3) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { seededRandom } from './random.ts';

suite('seededRandom is a generator, not a clock', () => {
  it('produces the same sequence for the same seed, in any process', () => {
    const first = seededRandom(42);
    const second = seededRandom(42);
    const drawn = Array.from({ length: 16 }, () => first.next());
    expect(Array.from({ length: 16 }, () => second.next())).toEqual(drawn);
  });

  it('produces a different sequence for a different seed', () => {
    const forty2 = seededRandom(42);
    const forty3 = seededRandom(43);
    expect(Array.from({ length: 8 }, () => forty3.next())).not.toEqual(
      Array.from({ length: 8 }, () => forty2.next()),
    );
  });

  it('draws uniformly in [0, 1) — never 1, never negative', () => {
    const random = seededRandom(2026);
    for (let index = 0; index < 5_000; index += 1) {
      const drawn = random.next();
      expect(drawn).toBeGreaterThanOrEqual(0);
      expect(drawn).toBeLessThan(1);
    }
  });

  it('spreads across the unit interval rather than clustering', () => {
    const random = seededRandom(7);
    const buckets = Array.from({ length: 10 }, () => 0);
    for (let index = 0; index < 10_000; index += 1) {
      const bucket = Math.floor(random.next() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    // A uniform draw puts 1,000 in each; the bound is loose because this is a
    // sanity check on the generator, not a statistics exam.
    for (const count of buckets) expect(count).toBeGreaterThan(800);
  });

  it('is unaffected by an interleaved generator: each holds its own state', () => {
    const alone = seededRandom(99);
    const expected = [alone.next(), alone.next(), alone.next()];

    const interleaved = seededRandom(99);
    const noise = seededRandom(1);
    const observed: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      noise.next();
      observed.push(interleaved.next());
    }
    expect(observed).toEqual(expected);
  });
});
