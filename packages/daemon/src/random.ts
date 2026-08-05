/**
 * Where the seed comes from (KAR-06.5 AC5).
 *
 * `@DeFlow/core` owns the generator because a seeded PRNG is arithmetic over a
 * number and stays deterministic; what it cannot own is the *seed*, which is
 * the one genuinely nondeterministic input. R1 puts that here, in the
 * imperative shell, exactly as it puts `SystemClock` here.
 *
 * `randomInt` from `node:crypto` rather than `Math.random()` for the seed:
 * `Math.random()` is seeded per V8 isolate from a source that is not documented
 * to differ between two processes started in the same millisecond, and two
 * daemons that draw the same backoff sequence would defeat the whole purpose of
 * jitter — which is that correlated failures do *not* retry in lockstep.
 *
 * Every backoff in one daemon life is drawn from **one** generator. That is
 * deliberate: twenty nodes failing at the same instant take twenty consecutive
 * draws, so they cannot collide the way twenty independently-seeded generators
 * created in the same millisecond could.
 */
import type { Random } from '@DeFlow/core';
import { seededRandom } from '@DeFlow/core';
import { randomInt } from 'node:crypto';

/** The environment variable that pins the seed, so a run can be reproduced. */
export const RANDOM_SEED_ENV = 'DeFlow_RANDOM_SEED';

export type SeedEnv = Readonly<Record<string, string | undefined>>;

export interface DaemonSeed {
  readonly seed: number;
  /** Where the number came from, so boot can log an honest sentence. */
  readonly source: 'explicit' | 'crypto';
}

/**
 * The seed for one daemon life.
 *
 * An explicit `DeFlow_RANDOM_SEED` wins, because reproducing a specific
 * retry-timing failure is the next thing anyone does after seeing one. Absent
 * that, 32 bits from the CSPRNG.
 */
export function daemonSeed(env: SeedEnv = process.env): DaemonSeed {
  const explicit = Number.parseInt(env[RANDOM_SEED_ENV] ?? '', 10);
  if (Number.isFinite(explicit)) return { seed: explicit >>> 0, source: 'explicit' };
  return { seed: randomInt(0, 2 ** 32), source: 'crypto' };
}

/** The generator this daemon life draws every backoff delay from. */
export function daemonRandom(env: SeedEnv = process.env): Random {
  return seededRandom(daemonSeed(env).seed);
}
