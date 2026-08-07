/**
 * KAR-09.7 — the `Tokenizer` port, and the two rules that make a token figure
 * usable at all.
 *
 * `method` is mandatory and has no default, so a figure whose provenance is
 * unknown **cannot be constructed** (AC1) — the same discipline `TokenUsage`'s
 * `source` already keeps, for the same reason: a budget ceiling computed from a
 * mixed total fires at the wrong time in both directions.
 *
 * `contextFillPercent` exists so nothing has to hardcode a window-size table.
 * The CLI hands the window back on every result envelope
 * (`modelUsage[m].contextWindow`), so fill is a division, and a table would be
 * wrong within a month of a model release.
 *
 * Verifies: EPIC-09-S36, EPIC-09-S37 · KAR-09.7 AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { TokenCountSchema } from './context-packet.ts';
import { contextFillPercent, type Tokenizer } from './tokenizer.ts';

/** A stand-in for the daemon's real implementation: the port is what core
 * owns, and core owns no BPE table. */
const fake: Tokenizer = {
  method: 'gpt-tokenizer/o200k_base',
  count: (text) => ({ estimated: text.length, method: 'gpt-tokenizer/o200k_base' }),
};

suite('a token figure cannot be constructed without its method (AC1)', () => {
  it('refuses a count with no method', () => {
    expect(TokenCountSchema.safeParse({ estimated: 40 }).success).toBe(false);
  });

  it('refuses a method outside the three the system knows', () => {
    expect(TokenCountSchema.safeParse({ estimated: 40, method: 'tiktoken' }).success).toBe(false);
  });

  it('accepts each of the three, and only those', () => {
    for (const method of ['gpt-tokenizer/o200k_base', 'heuristic', 'vendor-reported']) {
      expect(TokenCountSchema.safeParse({ estimated: 40, method }).success).toBe(true);
    }
  });

  it('makes every port implementation label what it produced', () => {
    const counted = fake.count('hello');
    expect(TokenCountSchema.parse(counted).method).toBe(fake.method);
  });
});

suite('fill is computed against the window the vendor reported', () => {
  it('divides the packet by the reported window', () => {
    expect(contextFillPercent(50_000, 200_000)).toBeCloseTo(25, 10);
    expect(contextFillPercent(1, 4)).toBeCloseTo(25, 10);
  });

  it('answers null rather than a number when no window was reported', () => {
    expect(contextFillPercent(50_000, null)).toBeNull();
    expect(contextFillPercent(50_000, 0)).toBeNull();
  });

  it('does not clamp an over-full packet, because overfilling is the thing to see', () => {
    expect(contextFillPercent(250_000, 200_000)).toBeCloseTo(125, 10);
  });
});
