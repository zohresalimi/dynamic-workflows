/**
 * KAR-09.7 — the whole loop: estimate, measure, correct, persist, report.
 *
 * The unit specs prove the EWMA is the documented EWMA and the ledger specs
 * prove a factor outlives its daemon. What neither proves is that the two ends
 * are actually connected — that the number folded in really is the Tier-2 count
 * of the rendered prompt measured against Tier-1's `modelUsage[m].inputTokens`,
 * and not, say, an estimate compared against itself. So this runs the real
 * tokenizer over real prompts, reads real result envelopes through the real
 * parser, and writes to a real file-backed ledger the daemon is closed and
 * reopened around.
 *
 * The corpus is synthetic but the relationship is not: every node's `actual` is
 * derived from the *measured* Tier-2 count of that node's own prompt, so the
 * ratio the loop converges on is a ratio between two numbers the system really
 * produced.
 *
 * Verifies: EPIC-09-S38 · KAR-09.7 AC6, AC7, AC10 · test plan #7, #10
 */
import { parseShimLine, shimResultReport } from '@DeFlow/adapters';
import { openLedger, readTokenCalibration } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { foldCalibrationSample, preflightBudget } from '../../src/tokens/calibrate.ts';
import { tokenCalibrationReport } from '../../src/tokens/doctor.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const NOW = 1_754_400_000_000;
const MODEL = 'model-under-test';
const PROVIDER = 'claude';
const FAMILY = 'anthropic';
const TRUE_RATIO = 1.18;

/** One node's prompt. Varied in length so the estimate is not a constant. */
const promptFor = (node: number): string =>
  `Node ${node}: ${'refactor the parser and explain the change. '.repeat(3 + (node % 7))}`;

/**
 * The result envelope a vendor would emit for that prompt, with `inputTokens`
 * set to the true ratio of the *measured* Tier-2 count — which is what makes
 * the convergence target a real relationship rather than a constant the test
 * also asserts.
 */
const envelopeFor = (estimated: number): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    // Populated, and never read. A parser that read it would converge on 200 /
    // estimated instead, which is nowhere near 1.18.
    usage: { input_tokens: 200, output_tokens: 200 },
    modelUsage: {
      [MODEL]: {
        inputTokens: Math.round(estimated * TRUE_RATIO),
        outputTokens: 64,
        costUSD: 0.01,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
    session_id: 'sess-1',
    uuid: 'a5cf5c3e-0000-4000-8000-000000000001',
  });

suite('the calibration loop converges on the vendor’s own figure', () => {
  it('lands within ±0.02 of the true ratio by the twentieth node, across restarts', async ({
    tmp,
  }) => {
    const tokenizer = o200kTokenizer();
    const applied: number[] = [];

    for (let node = 0; node < 25; node += 1) {
      // A fresh open per node: the daemon dying between nodes is the only
      // version of this claim that proves the factor lives in the file.
      const db = openLedger(tmp);
      try {
        const prompt = promptFor(node);
        const budget = preflightBudget(db, tokenizer, {
          provider: PROVIDER,
          model: MODEL,
          family: FAMILY,
          text: prompt,
        });
        applied.push(budget.factor);
        expect(budget.method).toBe('gpt-tokenizer/o200k_base');
        expect(budget.calibrated).toBeGreaterThanOrEqual(budget.raw);

        const line = parseShimLine(envelopeFor(budget.raw));
        if (line === null) throw new Error('expected a parsed line');
        const report = shimResultReport(line);
        if (report === null) throw new Error('expected a Tier-1 report');

        foldCalibrationSample(db, {
          provider: PROVIDER,
          model: MODEL,
          family: FAMILY,
          estimated: budget.raw,
          report,
          now: NOW + node,
        });
      } finally {
        db.close();
      }
    }

    const db = openLedger(tmp);
    try {
      const row = readTokenCalibration(db, PROVIDER, MODEL, FAMILY);
      expect(row.samples).toBe(25);
      expect(Math.abs(row.tokenEstimateFactor - TRUE_RATIO)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(row.appliedFactor - TRUE_RATIO)).toBeLessThanOrEqual(0.02);

      // AC10 — the doctor section names both numbers for this pair.
      const report = tokenCalibrationReport(db);
      expect(report).toContain(`${PROVIDER}/${MODEL}`);
      expect(report).toContain('25 samples');
      expect(report).toContain('1.1');
    } finally {
      db.close();
    }

    // AC5 — the first five nodes budgeted against the anthropic seed, and the
    // sixth against something the loop had measured.
    expect(applied.slice(0, 5)).toEqual([1.2, 1.2, 1.2, 1.2, 1.2]);
    expect(applied[5]).not.toBe(1.2);
    // AC7's direction of travel: the correction the budget applies ends closer
    // to the truth than the seed it started from.
    const first = Math.abs((applied[0] ?? 0) - TRUE_RATIO);
    const last = Math.abs((applied.at(-1) ?? 0) - TRUE_RATIO);
    expect(last).toBeLessThan(first);
  });

  it('folds nothing when the vendor reported no input tokens to compare against', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const line = parseShimLine(
        JSON.stringify({
          type: 'result',
          modelUsage: { [MODEL]: { inputTokens: 0, outputTokens: 4 } },
        }),
      );
      if (line === null) throw new Error('expected a parsed line');
      const report = shimResultReport(line);
      if (report === null) throw new Error('expected a Tier-1 report');

      const row = foldCalibrationSample(db, {
        provider: PROVIDER,
        model: MODEL,
        family: FAMILY,
        estimated: 500,
        report,
        now: NOW,
      });
      expect(row).toBeNull();
      expect(readTokenCalibration(db, PROVIDER, MODEL, FAMILY).samples).toBe(0);
      expect(tokenCalibrationReport(db)).toContain('has been calibrated yet');
    } finally {
      db.close();
    }
  });
});
