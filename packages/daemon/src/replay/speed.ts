/**
 * KAR-16.5 AC4 — `--speed`, and the schedule it turns a recording into.
 *
 * Two decisions are worth stating, because both are the difference between a
 * harness that reproduces a run and one that merely emits its events.
 *
 * **The schedule is offsets from the first recorded event, never gap-by-gap.**
 * Dividing each gap in turn accumulates rounding: a fixture whose gaps are a
 * few milliseconds each has every individual gap look correct at 20x while the
 * end of the timeline drifts seconds away from where the recording put it. An
 * offset is computed once against `ts[0]`, so error never compounds.
 *
 * **`max` is the absence of a schedule, not a large divisor.** A very large
 * factor still walks the timeline and still pays a timer per event; `max`
 * yields zero delay throughout and the fixture is delivered as fast as the
 * socket drains. That is what makes EPIC-16-S27's six-hour soak and
 * KAR-16.6's 400-node measurement practical at all.
 *
 * Nothing here reads a clock. The schedule is a pure function of the recorded
 * timestamps, and the harness is what turns an offset into a wait through the
 * injected `Clock` port (docs/14-testing-strategy.md §8).
 */

/** The four `--speed` values AC4 names, in the order the CLI's help lists them. */
export const SPEEDS = ['1x', '20x', '50x', 'max'] as const;

/**
 * A parsed `--speed`.
 *
 * `max` is its own variant rather than `factor: Infinity` so that every caller
 * has to decide what it means; an infinity that flows into an arithmetic
 * expression produces `NaN` delays, which `setTimeout` treats as `0` — the
 * right answer reached by an accident that would hold until it did not.
 */
export type Speed = { readonly kind: 'rate'; readonly factor: number } | { readonly kind: 'max' };

/** A `--speed` this harness will not guess at. */
export class BadSpeed extends Error {
  constructor(given: string) {
    super(
      `--speed ${JSON.stringify(given)} is not a speed: use ${SPEEDS.join(', ')}, ` +
        'or any positive multiplier such as "2x" or "0.5x". There is deliberately no ' +
        'default for an unparseable value — a silent fallback to 1x is how a typo becomes ' +
        '"the harness hangs", forty recorded minutes at a time.',
    );
    this.name = 'BadSpeed';
  }
}

/** Parses `--speed`: `max`, `20x`, or a bare positive multiplier. */
export function parseSpeed(given: string): Speed {
  const text = given.trim().toLowerCase();
  if (text === 'max') return { kind: 'max' };

  const match = /^(\d+(?:\.\d+)?)x?$/.exec(text);
  if (match === null) throw new BadSpeed(given);

  const factor = Number(match[1]);
  if (!Number.isFinite(factor) || factor <= 0) throw new BadSpeed(given);
  return { kind: 'rate', factor };
}

/** All the scheduler needs off an event: when it was recorded. */
export interface RecordedAt {
  readonly ts: number;
}

/**
 * When each event is emitted, in milliseconds after playback starts.
 *
 * Monotonic by construction: `seq` is the order of the system and `ts` is a
 * measurement, so a recorder that wrote two events out of timestamp order must
 * not make the harness emit the ledger's order backwards. The offset of such
 * an event is held at its predecessor's rather than allowed to go negative.
 */
export function emissionOffsets(events: readonly RecordedAt[], speed: Speed): number[] {
  if (speed.kind === 'max') return events.map(() => 0);

  const first = events[0];
  if (first === undefined) return [];

  let highest = 0;
  return events.map((event) => {
    const offset = (event.ts - first.ts) / speed.factor;
    highest = Math.max(highest, offset);
    return highest;
  });
}
