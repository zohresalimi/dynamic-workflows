/**
 * KAR-02.10 — the "one line, safe to render" rule, in one place.
 *
 * `NodeFailure.message` and `Verdict.summary` are both rendered in a board
 * cell and in a log line. A newline in either is not a cosmetic problem: it
 * breaks the line-oriented log, and it is the shape a raw stack trace takes
 * when someone pastes one in — which is exactly what §8 says must never reach
 * the ledger as a message.
 */
import { z } from 'zod';

/** Longest single-line string the domain accepts. Wide enough for a real
 * sentence, short enough that it cannot become an accidental evidence blob. */
export const SINGLE_LINE_MAX = 400;

/** Every character that ends a line for a renderer: CR, LF and the two
 * Unicode line separators, which `\n` alone does not cover. */
const LINE_BREAKS = /\r|\n|\u2028|\u2029/u;

/** A non-empty string of at most `SINGLE_LINE_MAX` characters, with no line
 * break of any kind. */
export const singleLine = (): z.ZodType<string, string> =>
  z
    .string()
    .min(1)
    .max(SINGLE_LINE_MAX)
    .refine((value) => !LINE_BREAKS.test(value), 'must be a single line');

/** Collapses `text` onto one line and clamps it to `SINGLE_LINE_MAX`. The
 * inverse direction of `singleLine()`: used at the boundary where arbitrary
 * text (a thrown value's message) becomes a domain value. */
export function toSingleLine(text: string): string {
  const collapsed = text.replaceAll(/\s+/gu, ' ').trim();
  return collapsed.length > SINGLE_LINE_MAX
    ? `${collapsed.slice(0, SINGLE_LINE_MAX - 1)}…`
    : collapsed;
}
