/**
 * KAR-14.2 AC8 — the ceiling section of `deflow doctor`.
 *
 * The command itself is EPIC-18 (KAR-18.4); this module holds the policy ahead
 * of it existing, the same split `../tokens/doctor.ts` uses for the calibration
 * section and `../git/version.ts` for the git version floor.
 *
 * It answers a different question from the run summary's `budgetEnforceable`
 * marker, which is why both exist. The summary says *this run's* ceiling will
 * or will not fire, and it says it at approval time. This says which of the
 * providers **installed on this machine** can be held to a cost ceiling at all
 * — which is worth knowing before a plan routes anything, when swapping a
 * provider costs one line of config rather than a re-approval.
 *
 * The rule it exists to make visible is KAR-14.1's: a provider whose manifest
 * says `tokenAccounting: 'none'` contributes a blank cost cell rather than a
 * zero, so a cost ceiling over it is a ceiling that never fires. DeFlow does not
 * pretend otherwise, and this is where it says so out loud.
 */
import type { Ceiling, RunCeilings, TokenAccounting } from '@DeFlow/core';

export interface BudgetCeilingReportInput {
  /** The ceilings in force, as the ledger pinned them. */
  readonly ceilings: RunCeilings;
  /** Every provider installed on this machine, in whatever order. */
  readonly providers: readonly string[];
  /** The capability manifest's accounting fidelity for one provider. */
  readonly accounting: (provider: string) => TokenAccounting;
}

/**
 * One dimension, printed.
 *
 * `no ceiling` rather than `0`: a zero would read as a ceiling of nothing,
 * which is the opposite of what an unset field means, and this report is read
 * by somebody deciding whether they are protected.
 */
const dimension = (name: string, value: number | null): string =>
  value === null ? `${name} no ceiling` : `${name} ${value}`;

const ceilingLine = (label: string, ceiling: Ceiling): string =>
  `${label}: ${dimension('costUsd', ceiling.costUsd)}, ${dimension('wallclockMs', ceiling.wallclockMs)}`;

/** Whether any cost ceiling is configured at all. */
const hasCostCeiling = (ceilings: RunCeilings): boolean =>
  ceilings.run.costUsd !== null ||
  ceilings.node.costUsd !== null ||
  Object.values(ceilings.nodes).some((ceiling) => ceiling.costUsd !== null);

/** The section's lines, one claim each. */
export function budgetCeilingLines(input: BudgetCeilingReportInput): readonly string[] {
  const lines = [
    ceilingLine('run ceiling', input.ceilings.run),
    ceilingLine('node ceiling', input.ceilings.node),
  ];

  for (const [node, ceiling] of Object.entries(input.ceilings.nodes).toSorted(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    lines.push(ceilingLine(`node ${node}`, ceiling));
  }

  // Nothing is unenforceable when nothing is being enforced, and a warning that
  // fires on every workspace is one nobody reads.
  if (!hasCostCeiling(input.ceilings)) return lines;

  const unmeasurable = input.providers
    .filter((provider) => input.accounting(provider) === 'none')
    .toSorted();

  lines.push(
    unmeasurable.length === 0
      ? 'a cost ceiling is enforceable: every installed provider reports usage'
      : `a cost ceiling is unenforceable for providers with no cost accounting: ${unmeasurable.join(', ')} ` +
          '(tokenAccounting "none" — their spend is a blank cell, never a zero, so no rollup will ever reach the ceiling)',
  );
  lines.push(
    'the wallclock ceiling is enforceable regardless: DeFlow measures it on its own clock',
  );

  return lines;
}

/** The whole section, as `deflow doctor` will print it. */
export function renderBudgetCeilingReport(input: BudgetCeilingReportInput): string {
  return ['budget ceilings:', ...budgetCeilingLines(input).map((line) => `  ${line}`)].join('\n');
}
