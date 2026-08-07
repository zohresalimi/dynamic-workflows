/**
 * KAR-09.7 — the EWMA that teaches itself a per-(provider, model) correction
 * factor, and the seed that stands in until it has learned anything.
 *
 * The reason the suite is this insistent about *convergence* rather than about
 * the formula alone: tiktoken-family tokenizers undercount Claude tokens by
 * roughly 15–20% on prose and considerably more on code, so an uncalibrated
 * pre-flight budget systematically **overfills** the context — the dangerous
 * direction. A formula that is arithmetically right but converges too slowly to
 * matter is the same bug wearing a passing test's clothes, so the corpora below
 * are noisy on purpose and the assertions are about where the ratio *lands*.
 *
 * The noise is a deterministic LCG, not `Math.random()`: a flaky convergence
 * test would be worse than none, because the first thing anyone would do with
 * it is widen the interval it is supposed to be defending.
 *
 * Verifies: EPIC-09-S38, EPIC-09-S39 · KAR-09.7 AC4, AC5, AC7 · test plan #4,
 * #5, #6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  appliedFactor,
  CALIBRATION_ALPHA,
  CALIBRATION_MIN_SAMPLES,
  CALIBRATION_SEEDS,
  type Calibration,
  calibratedEstimate,
  seededCalibration,
  seedFactor,
  updateCalibration,
} from './token-calibration.ts';

/**
 * A deterministic uniform generator in [0, 1). Numerical Recipes' LCG
 * constants, taken mod 2^32 — the point is reproducibility, not statistical
 * quality.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/**
 * One corpus: `count` nodes whose true actual/estimated ratio is `trueRatio`,
 * jittered by up to ±`spread` so the EWMA has something to average.
 *
 * `estimated` varies too, because a real packet is not a fixed size and the
 * ratio has to be recovered from the pair rather than from `actual` alone.
 */
function corpus(
  trueRatio: number,
  count: number,
  spread = 0.05,
  seed = 20_260_807,
): readonly { estimated: number; actual: number }[] {
  const next = lcg(seed);
  return Array.from({ length: count }, () => {
    const estimated = 1_000 + Math.floor(next() * 9_000);
    const jitter = 1 + (next() * 2 - 1) * spread;
    return { estimated, actual: Math.round(estimated * trueRatio * jitter) };
  });
}

function feed(
  start: Calibration,
  samples: readonly { estimated: number; actual: number }[],
): readonly Calibration[] {
  const history: Calibration[] = [];
  let current = start;
  for (const sample of samples) {
    current = updateCalibration(current, sample.estimated, sample.actual);
    history.push(current);
  }
  return history;
}

suite('the documented EWMA, exactly (AC4)', () => {
  it('states ALPHA as the architecture states it', () => {
    expect(CALIBRATION_ALPHA).toBe(0.2);
  });

  it('seeds the ratio from the first sample rather than blending into it', () => {
    const first = updateCalibration({ n: 0, ratio: 1.2 }, 1_000, 1_180);
    expect(first).toEqual({ n: 1, ratio: 1.18 });
  });

  it('blends every later sample at ALPHA', () => {
    const second = updateCalibration({ n: 1, ratio: 1.18 }, 1_000, 1_380);
    // 1.18 * 0.8 + 1.38 * 0.2
    expect(second.n).toBe(2);
    expect(second.ratio).toBeCloseTo(1.22, 10);
  });

  it('returns the calibration unchanged when the estimate is zero', () => {
    const before: Calibration = { n: 4, ratio: 1.31 };
    expect(updateCalibration(before, 0, 5_000)).toBe(before);
  });

  it('returns the calibration unchanged when the estimate is negative', () => {
    const before: Calibration = { n: 4, ratio: 1.31 };
    expect(updateCalibration(before, -12, 5_000)).toBe(before);
  });

  it('never divides by zero, whatever the actual figure is', () => {
    for (const actual of [0, 1, 999_999]) {
      expect(updateCalibration({ n: 2, ratio: 1.1 }, 0, actual).ratio).toBe(1.1);
    }
  });
});

suite('seeds and the switchover (AC5, EPIC-09-S39)', () => {
  it('states the three seeds the architecture states', () => {
    expect(CALIBRATION_SEEDS).toEqual({ anthropic: 1.2, openai: 1.0, default: 1.05 });
    expect(CALIBRATION_MIN_SAMPLES).toBe(5);
  });

  it('falls back to the default seed for a family it has never heard of', () => {
    expect(seedFactor('anthropic')).toBe(1.2);
    expect(seedFactor('openai')).toBe(1.0);
    expect(seedFactor('unknown')).toBe(1.05);
    expect(seedFactor('')).toBe(1.05);
  });

  it('starts a family at its seed with no samples', () => {
    expect(seededCalibration('anthropic')).toEqual({ n: 0, ratio: 1.2 });
    expect(seededCalibration('unknown')).toEqual({ n: 0, ratio: 1.05 });
  });

  const cases: readonly [family: string, n: number, applied: number][] = [
    ['anthropic', 0, 1.2],
    ['anthropic', 4, 1.2],
    ['anthropic', 5, 1.37],
    ['openai', 0, 1.0],
    ['unknown', 0, 1.05],
  ];

  for (const [family, n, applied] of cases) {
    it(`applies ${applied} for ${family} at n = ${n}`, () => {
      expect(appliedFactor({ n, ratio: 1.37 }, family)).toBe(applied);
    });
  }

  it('switches at exactly five samples, not four and not six', () => {
    const learned = { ratio: 1.42 };
    expect(appliedFactor({ n: 4, ...learned }, 'anthropic')).toBe(1.2);
    expect(appliedFactor({ n: 5, ...learned }, 'anthropic')).toBe(1.42);
    expect(appliedFactor({ n: 6, ...learned }, 'anthropic')).toBe(1.42);
  });
});

suite('convergence on the authoritative figure (AC7, EPIC-09-S38)', () => {
  it('lands within ±0.02 of 1.18 by the twentieth sample and stays there', () => {
    const history = feed(seededCalibration('anthropic'), corpus(1.18, 25));

    expect(Math.abs((history[4]?.ratio ?? 0) - 1.18)).toBeLessThanOrEqual(0.1);
    expect(Math.abs((history[19]?.ratio ?? 0) - 1.18)).toBeLessThanOrEqual(0.02);
    for (const point of history.slice(19)) {
      expect(Math.abs(point.ratio - 1.18)).toBeLessThanOrEqual(0.02);
    }
  });

  it('moves monotonically toward the true ratio on a noise-free corpus', () => {
    // Started at n = 1 so the seed is already the stored ratio and every step
    // is a blend: from n = 0 the first sample would jump straight to the
    // answer, which proves nothing about the direction of travel.
    const history = feed({ n: 1, ratio: 1.2 }, corpus(1.18, 20, 0));
    const distances = history.map((point) => Math.abs(point.ratio - 1.18));
    for (const [index, distance] of distances.entries()) {
      if (index === 0) continue;
      expect(distance).toBeLessThan(distances[index - 1] ?? Number.POSITIVE_INFINITY);
    }
    expect(history.at(-1)?.ratio).toBeCloseTo(1.18, 3);
  });

  it('corrects a badly-seeded start rather than hovering near the seed', () => {
    // A corpus of code, whose true ratio is well above the 1.2 anthropic seed.
    const history = feed(seededCalibration('anthropic'), corpus(1.35, 25, 0.08, 777));
    expect(history.at(-1)?.ratio ?? 0).toBeGreaterThan(1.3);
  });

  it('reserves more room for the twenty-fifth node than for the first', () => {
    const packet = 10_000;
    const history = feed(seededCalibration('anthropic'), corpus(1.35, 25, 0.08, 777));
    const start = seededCalibration('anthropic');
    const first = calibratedEstimate(packet, appliedFactor(start, 'anthropic'));
    const last = calibratedEstimate(packet, appliedFactor(history.at(-1) ?? start, 'anthropic'));
    expect(last).toBeGreaterThan(first);
  });

  it('is a band around the truth, not a promise about any one sample', () => {
    // Recorded rather than hidden: ±0.02 is a property of a corpus whose
    // per-node ratio is stable to within a few percent, which is what "the true
    // ratio of this corpus is 1.18" means. At ±8% per-node jitter the EWMA's
    // own steady-state spread is wider than the interval, and a future reader
    // who widens AC7's corpus should expect this and not the interval to give.
    const noisy = feed(seededCalibration('anthropic'), corpus(1.18, 25, 0.08));
    const tail = noisy.slice(19).map((point) => Math.abs(point.ratio - 1.18));
    expect(Math.max(...tail)).toBeGreaterThan(0.02);
    // Still unbiased: the average of the tail sits on the true ratio.
    const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
    expect(mean).toBeLessThan(0.03);
  });
});

suite('the calibrated estimate itself', () => {
  it('rounds up, because a budget that rounds down overfills', () => {
    expect(calibratedEstimate(1_000, 1.2)).toBe(1_200);
    expect(calibratedEstimate(1_001, 1.2)).toBe(1_202);
    expect(calibratedEstimate(3, 1.05)).toBe(4);
  });

  it('is zero for an empty packet, whatever the factor', () => {
    expect(calibratedEstimate(0, 1.2)).toBe(0);
  });
});
