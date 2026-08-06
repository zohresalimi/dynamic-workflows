/**
 * The `Random` port (docs/14-testing-strategy.md §8, KAR-06.5 AC5).
 *
 * NF9 asks for a deterministic core, and the retry backoff is where that gets
 * tested for real: 05-durable-execution §10.3 writes the delay as
 *
 *     delay = Math.random() * min(cap, base * 2 ** (attempt - 1))
 *
 * and `Math.random()` there is **shorthand**. Copied literally into
 * @DeFlow/core it would make two calls with the same `(state, now)` disagree,
 * in a run nobody can reproduce — and it would make EPIC-06-S19's golden
 * sequence impossible to write, which is precisely why that scenario exists.
 * `packages/core/test/purity.test.ts` fails the build if `Math.random` appears
 * anywhere under `packages/core/src`, this file included.
 *
 * So randomness enters through a port, the same way time does. Unlike `Clock`,
 * the implementation lives here rather than outside core: a seeded generator is
 * arithmetic over a number, deterministic by construction, and the only
 * nondeterministic thing about it — where the seed comes from — stays in the
 * imperative shell (`@DeFlow/daemon`'s `src/random.ts`), which is exactly the
 * boundary R1 draws.
 */

/** A uniform draw in `[0, 1)`. One method, because one is all the ladder needs. */
export interface Random {
  /** The next draw: `0 <= next() < 1`. */
  next(): number;
}

/**
 * mulberry32: 32 bits of state, uniform enough to choose a backoff delay, and
 * short enough to read in full.
 *
 * Nothing cryptographic depends on it and nothing should. Its only contract is
 * the one the specs rest on: the same seed produces the same sequence in this
 * process, in a replay, and on another machine.
 *
 * Each call to this function returns a generator with **its own** state, so two
 * seeded generators in one process never interfere — and one generator shared
 * by twenty nodes failing at the same instant hands each of them a different
 * draw, which is the whole of full jitter.
 */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d_2b_79_f5) >>> 0;
      let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
      drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
      return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
}
