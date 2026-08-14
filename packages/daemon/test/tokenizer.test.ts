/**
 * KAR-09.7 Tier 2 — the daemon's `Tokenizer`, and the doctor row it feeds.
 *
 * The count itself is `gpt-tokenizer`'s, so what is worth asserting here is the
 * two things DeFlow adds: the **label**, without which a figure is not a usable
 * number, and the **calibrated** figure, which is what a pre-flight budget
 * actually reserves against.
 *
 * Verifies: EPIC-09-S37, EPIC-09-S38 (scenario 4) · KAR-09.7 AC1, AC3, AC10 ·
 * test plan #1
 */
import { TokenCountSchema } from '@DeFlow/core';
import type { TokenCalibrationRow } from '@DeFlow/ledger';
import { expect, it, describe as suite } from 'vitest';
import { renderTokenCalibrationReport } from '../src/tokens/doctor.ts';
import { o200kTokenizer } from '../src/tokens/tokenizer.ts';

const FIXTURE =
  'The quick brown fox jumps over the lazy dog, then writes a TypeScript module about it.';

suite('the Tier-2 tokenizer counts and says how (AC1, test plan #1)', () => {
  const tokenizer = o200kTokenizer();

  it('labels every count with the encoding that produced it', () => {
    expect(tokenizer.method).toBe('gpt-tokenizer/o200k_base');
    expect(tokenizer.count(FIXTURE).method).toBe('gpt-tokenizer/o200k_base');
  });

  it('returns a figure the domain schema accepts', () => {
    const counted = tokenizer.count(FIXTURE);
    expect(TokenCountSchema.parse(counted)).toEqual(counted);
  });

  it('is stable for the same input', () => {
    expect(tokenizer.count(FIXTURE)).toEqual(tokenizer.count(FIXTURE));
  });

  it('counts fewer tokens than characters, and more than none', () => {
    const counted = tokenizer.count(FIXTURE).estimated;
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThan(FIXTURE.length);
  });

  it('counts an empty string as zero rather than refusing it', () => {
    expect(tokenizer.count('').estimated).toBe(0);
  });

  it('counts code, which is where the undercount is worst, without throwing', () => {
    const code = 'const x: Record<string, number> = { a: 1 };\n'.repeat(20);
    expect(tokenizer.count(code).estimated).toBeGreaterThan(100);
  });
});

suite('deflow doctor prints the factor and the sample count (AC10)', () => {
  const rows: readonly TokenCalibrationRow[] = [
    {
      provider: 'claude',
      model: 'model-a',
      family: 'anthropic',
      samples: 3,
      tokenEstimateFactor: 1.31,
      appliedFactor: 1.2,
      updatedAt: 1_754_400_000_000,
    },
    {
      provider: 'codex',
      model: 'model-b',
      family: 'openai',
      samples: 22,
      tokenEstimateFactor: 1.0234,
      appliedFactor: 1.0234,
      updatedAt: 1_754_400_000_000,
    },
  ];

  it('names every (provider, model) with its factor and its sample count', () => {
    const report = renderTokenCalibrationReport(rows);
    expect(report).toContain('claude');
    expect(report).toContain('model-a');
    expect(report).toContain('1.31');
    expect(report).toContain('3 samples');
    expect(report).toContain('codex');
    expect(report).toContain('1.023');
    expect(report).toContain('22 samples');
  });

  it('says which factor is actually being applied while the seed still is', () => {
    // Three samples is below the switchover, so the learned 1.31 is recorded
    // and the seed 1.2 is what a budget multiplies by. Printing only one of
    // them is how an operator concludes the estimator is broken.
    const report = renderTokenCalibrationReport(rows);
    expect(report).toContain('1.2');
    expect(report).toContain('seed');
  });

  it('says so plainly when nothing has been calibrated yet', () => {
    const report = renderTokenCalibrationReport([]);
    expect(report).toContain('has been calibrated yet');
    expect(report).toContain('family seed');
  });
});
