/**
 * KAR-14.2 AC8 — the ceiling section of `DeFlow doctor`.
 *
 * EPIC-14-S13's last clause is *"`DeFlow doctor` lists `gemini` under providers
 * with no cost accounting"*, and it is not a duplicate of the run summary: the
 * summary answers "will this run's ceiling fire", and the doctor answers "which
 * of the providers on this machine can be held to one at all" — before a run
 * exists, which is when a different provider is cheapest to choose.
 *
 * The report is a function of the ceilings and the manifest, so it can be
 * asserted without a ledger and without a CLI. The command itself is EPIC-18.
 *
 * Verifies: EPIC-14-S13 · KAR-14.2 AC8
 */
import type { RunCeilings, TokenAccounting } from '@DeFlow/core';
import { initialCeilings } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { budgetCeilingLines, renderBudgetCeilingReport } from '../src/budget/doctor.ts';

const ACCOUNTING: Readonly<Record<string, TokenAccounting>> = {
  claude: 'exact',
  codex: 'exact',
  gemini: 'none',
  copilot: 'none',
};

const installed = ['claude', 'codex', 'gemini', 'copilot'];

const withRunCeiling = (costUsd: number | null, wallclockMs: number | null): RunCeilings => ({
  ...initialCeilings(),
  run: { costUsd, wallclockMs },
});

const report = (ceilings: RunCeilings): string =>
  renderBudgetCeilingReport({
    ceilings,
    providers: installed,
    accounting: (provider) => ACCOUNTING[provider] ?? 'none',
  });

suite('the report says what is in force', () => {
  it('prints both dimensions of the run ceiling', () => {
    const lines = budgetCeilingLines({
      ceilings: withRunCeiling(25, 14_400_000),
      providers: installed,
      accounting: (provider) => ACCOUNTING[provider] ?? 'none',
    });

    expect(lines.join('\n')).toContain('run ceiling: costUsd 25, wallclockMs 14400000');
  });

  it('says "no ceiling" rather than printing a zero', () => {
    // A `0` in this report would read as a ceiling of nothing, which is the
    // opposite of what an unset field means.
    expect(report(initialCeilings())).toContain('no ceiling');
    expect(report(initialCeilings())).not.toContain('costUsd 0');
  });
});

suite('the report names every provider a cost ceiling cannot be measured on', () => {
  it('lists them, in name order, with the reason', () => {
    const text = report(withRunCeiling(25, 14_400_000));

    expect(text).toContain('no cost accounting: copilot, gemini');
    expect(text).toContain('tokenAccounting "none"');
  });

  it('says the wall-clock ceiling is enforceable anyway', () => {
    expect(report(withRunCeiling(25, 14_400_000))).toContain('wallclock ceiling is enforceable');
  });

  it('is silent about enforceability when no cost ceiling is configured', () => {
    // Nothing is unenforceable when nothing is being enforced, and a warning
    // that fires on every workspace is one nobody reads.
    const text = report(withRunCeiling(null, 14_400_000));

    expect(text).not.toContain('no cost accounting');
  });

  it('says so plainly when every installed provider reports figures', () => {
    const text = renderBudgetCeilingReport({
      ceilings: withRunCeiling(25, null),
      providers: ['claude', 'codex'],
      accounting: (provider) => ACCOUNTING[provider] ?? 'none',
    });

    expect(text).toContain('every installed provider reports usage');
  });
});
