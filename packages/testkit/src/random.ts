/**
 * KAR-03.8 — seeded randomness, because a randomised spec that cannot be
 * replayed is a rumour (EPIC-03-S26, AC6).
 *
 * The crash-fuzz suite is random in exactly one dimension — *where* the knife
 * lands — and deterministic in every other. That is what makes a CI failure
 * actionable: the seed is printed, and re-running with it puts the kill in the
 * same place. `Math.random()` would make every failure a story about a run
 * nobody can have again.
 */

/**
 * mulberry32: 32 bits of state, uniform enough for choosing a sleep interval,
 * and short enough to read.
 *
 * Nothing cryptographic depends on it and nothing should. Its only contract is
 * that the same seed produces the same sequence in every process, which a
 * hash-based generator would also give and a `Math.random()` would not.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The environment variable a caller sets to reproduce a specific failure. */
export const CRASH_SEED_ENV = 'DeFlow_CRASH_SEED';

/**
 * CI's run id, which is what makes a failing crash-fuzz run reproducible from
 * the log alone: the number is in the workflow's own URL.
 */
export const CI_RUN_ID_ENV = 'GITHUB_RUN_ID';

export type SeedEnv = Readonly<Record<string, string | undefined>>;

export interface CrashSeed {
  readonly seed: number;
  /** Where the number came from, so a spec can print an honest sentence. */
  readonly source: 'explicit' | 'ci-run-id' | 'clock';
}

/**
 * The seed for one crash-fuzz run (AC6).
 *
 * `$GITHUB_RUN_ID` first, so a CI failure reproduces from the log; an explicit
 * `DeFlow_CRASH_SEED` beats it, because reproducing *that* failure is the next
 * thing anyone does. Falling back to the clock is deliberate rather than
 * apologetic — a local run should explore new kill points — and the caller is
 * told, so it can print the number it will need.
 */
export function crashSeed(env: SeedEnv = process.env): CrashSeed {
  const explicit = Number.parseInt(env[CRASH_SEED_ENV] ?? '', 10);
  if (Number.isFinite(explicit)) return { seed: explicit >>> 0, source: 'explicit' };

  const ci = Number.parseInt(env[CI_RUN_ID_ENV] ?? '', 10);
  if (Number.isFinite(ci)) return { seed: ci >>> 0, source: 'ci-run-id' };

  return { seed: Date.now() >>> 0, source: 'clock' };
}
