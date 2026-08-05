/**
 * The synthetic clock.
 *
 * A wall clock in the output would defeat `--seed` on its own: the ids could be
 * perfectly reproducible and the bytes would still differ on every run. So the
 * agent has no access to `Date.now()` — time advances by a fixed step each time
 * it is read, from a base the seed decides.
 *
 * That the base moves with the seed is not decoration. It means "did the
 * timestamps come from the seed?" is answerable by running twice at different
 * seeds and comparing, rather than by reading the source and believing it.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch, synthetic. */
  now(): number;
}

/** 2026-01-01T00:00:00Z — inside the project's own lifetime, and obviously fake. */
export const MOCK_EPOCH_MS = 1_767_225_600_000;

/** Milliseconds between two consecutive reads. */
export const MOCK_CLOCK_STEP_MS = 1_000;

export function createSyntheticClock(seed: number, stepMs: number = MOCK_CLOCK_STEP_MS): Clock {
  const base = MOCK_EPOCH_MS + seed * stepMs;
  let reads = 0;
  return {
    now: () => {
      const at = base + reads * stepMs;
      reads += 1;
      return at;
    },
  };
}
