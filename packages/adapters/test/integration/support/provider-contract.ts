/**
 * KAR-05.7 AC3 — `providerContract(adapterFactory)`: the whole battery, one
 * call site per adapter.
 *
 * Deliberately a thin registrar over `runProviderConformance`. The engine has
 * no idea vitest exists, because the other caller is `DeFlow doctor` (EPIC-18,
 * KAR-18.4) running the same eight assertions against whatever versions are
 * installed on a user's machine — and an assertion that only exists as a test
 * body cannot be run there.
 *
 * The battery runs **once** per adapter, in `beforeAll`, and each `it` reads
 * one result out of the report. That ordering is the reason a skip is visible:
 * `it.skip` reports "skipped" without a reason, so a capability-absent
 * assertion is registered as a real `it` that asserts *the reason it was
 * skipped* — a passing spec whose name and body both say it did not run.
 * Silence is what this layer exists not to produce.
 */
import { beforeAll, expect, it, describe as suite } from 'vitest';
import type {
  AdapterFactory,
  ConformancePorts,
  ConformanceReport,
  ConformanceResult,
} from '../../../src/index.ts';
import { describeConformance, runProviderConformance } from '../../../src/index.ts';

export interface ProviderContractOptions {
  /** Assembles the ports. Called once, inside `beforeAll`. */
  readonly ports: () => Promise<ConformancePorts> | ConformancePorts;
  /** Names the suite; defaults to the adapter's own name. */
  readonly label?: string;
  /**
   * How long the whole battery may take, on the `beforeAll` that runs it.
   *
   * It is on the hook rather than on the specs because the battery is one
   * unit of work: seven staged subprocesses, one after another. A real CLI
   * needs minutes where the mock needs seconds, which is why the `@live`
   * call site raises it.
   */
  readonly timeoutMs?: number;
}

const title = (result: ConformanceResult): string =>
  `#${result.assertion}${result.subject === undefined ? '' : ` [${result.subject}]`} ${result.name}`;

/**
 * Registers the eight assertions for one adapter.
 *
 * Adding an adapter is one call to this function — that is AC3, and it is the
 * property that keeps five adapters from becoming five bespoke test files that
 * drift.
 */
export function providerContract(factory: AdapterFactory, options: ProviderContractOptions): void {
  let report: ConformanceReport | null = null;

  suite(`provider contract — ${options.label ?? 'adapter'}`, () => {
    beforeAll(async () => {
      report = await runProviderConformance(factory, await options.ports());
    }, options.timeoutMs ?? 120_000);

    const resultsFor = (): readonly ConformanceResult[] => {
      if (report === null) throw new Error('the conformance battery did not run');
      return report.results;
    };

    it('produced a result for every one of the eight assertions', () => {
      const covered = new Set(resultsFor().map((result) => result.assertion));
      // A battery that quietly dropped an assertion would report a clean run
      // over seven of them, which is the failure mode this whole file exists
      // to prevent one level up.
      expect([...covered].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('holds every assertion it ran, and records a reason for every one it did not', () => {
      const failed = resultsFor().filter((result) => result.status === 'failed');
      expect(
        failed.length === 0
          ? ''
          : describeConformance({ ...(report as ConformanceReport), results: failed }),
      ).toBe('');

      for (const skipped of resultsFor().filter((result) => result.status === 'skipped')) {
        // AC4 — "reported as skipped with the reason", never as passed. An
        // empty reason is the silent skip this rule exists to forbid.
        expect(skipped.detail, title(skipped)).not.toBe('');
      }
    });

    it('reports each assertion individually, so a skip is not mistaken for a pass', () => {
      const summary = resultsFor().map(
        (result) =>
          `${result.status} ${title(result)}${result.status === 'skipped' ? ` — ${result.detail}` : ''}`,
      );
      expect(
        summary.every((line) => /^(passed|skipped) /.test(line)),
        summary.join('\n'),
      ).toBe(true);
    });
  });
}
