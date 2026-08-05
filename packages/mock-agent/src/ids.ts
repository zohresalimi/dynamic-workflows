/**
 * Every id the agent puts on the wire, drawn from the seed and from nothing
 * else.
 *
 * `crypto.randomUUID()` is the obvious thing to reach for here and it is
 * exactly what AC4 forbids: with a random id in the first frame, two runs of
 * the same scenario differ in their first hundred bytes, and the crash-fuzz
 * suite loses its only fixed point — everything before the kill has to be
 * identical so that *where the knife lands* is the single variable
 * (docs/14-testing-strategy.md §11).
 *
 * The shape is deliberately not a UUID either. A mock id that looks like a real
 * one invites someone to assert on a UUID pattern and be satisfied by output
 * that is not reproducible at all.
 */
import { mulberry32 } from './random.ts';

export interface IdFactory {
  /** A `session/new` id. */
  session(): string;
  /** A `tool_call` id. Unused until KAR-04.2, seeded from the same stream. */
  toolCall(): string;
}

/** 32 bits of the draw, as fixed-width hex, so ids sort and compare readably. */
function hex(draw: number): string {
  return Math.floor(draw * 0x1_00_00_00_00)
    .toString(16)
    .padStart(8, '0');
}

/**
 * Ids come off one stream, not one stream per kind: the sequence of calls is
 * itself part of what the seed fixes, so a change in the *order* ids are minted
 * in shows up as a diff rather than hiding behind a per-kind counter.
 */
export function createIdFactory(seed: number): IdFactory {
  const next = mulberry32(seed);
  let minted = 0;
  const mint = (prefix: string): string => {
    minted += 1;
    return `mock-${prefix}-${hex(next())}-${minted}`;
  };
  return {
    session: () => mint('session'),
    toolCall: () => mint('tool'),
  };
}
