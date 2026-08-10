/**
 * KAR-12.5 AC4 — the fix node's ordering, read off its branch rather than
 * asked for in its brief (docs/10-verification-gates.md §7).
 *
 * *"Regression test first, always. The gate re-run after the fix includes the
 * new test, so 'fixed' is demonstrated rather than asserted."* A prompt cannot
 * carry that guarantee: the brief says "write the failing test first" and the
 * only thing that knows whether it happened is `DeFlow/<runId>__<nodeId>`'s
 * commit list and the gate's answer at each of those commits. So this module
 * takes exactly that — a sequence of `(sha, paths, outcome)` — and answers
 * whether the three steps actually occurred in order.
 *
 * **The interesting arm is the one that looks like success.** A fix node whose
 * first commit already passes the gate has produced a green run and no
 * evidence, which is indistinguishable from a repair that worked unless
 * somebody looks. §7 is explicit that this is *"a signal, not a shortcut"* —
 * a repair that cannot be expressed as a failing test usually means the finding
 * belongs in front of a human — so it is recorded under its own code and routed
 * there, rather than being retried or quietly accepted.
 *
 * Pure. The commit list is produced by whoever holds the worktree; nothing here
 * spawns `git`, and the integration test that does is
 * ../test/integration/repair-loop.test.ts.
 *
 * Verifies: EPIC-12-S29 (ordering half) · AC4
 */
import { pathScopeMatches, type VerdictOutcome } from '@DeFlow/core';

/**
 * The code a repair that skipped its failing test is recorded under, spelled
 * exactly as AC4 spells it. A string constant rather than a message, because
 * the run summary groups on it and the diff view branches on it.
 */
export const REPAIR_NO_FAILING_TEST = 'repair.no_failing_test';

/** The other way a branch is not a completed repair: it never went green. */
export const REPAIR_STILL_FAILING = 'repair.still-failing';

export type RepairOrderingCode = typeof REPAIR_NO_FAILING_TEST | typeof REPAIR_STILL_FAILING;

/**
 * The default answer to "is this a test file", in `.gitignore` glob syntax so
 * it is the same matcher `pathScopes` already uses (`@DeFlow/core`'s
 * `pathScopeMatches`).
 *
 * Deliberately broad and deliberately overridable. Broad, because a repair that
 * added a real regression test and had it classified as production code would
 * be routed to a human for doing exactly the right thing — the expensive
 * direction of this error. Overridable, because "what a test looks like" is a
 * property of the repository, and a `spec/` layout is not a worse repository.
 */
export const DEFAULT_TEST_PATHS: readonly string[] = Object.freeze([
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*_spec.*',
  'test/**',
  'tests/**',
  'e2e/**',
  '**/__tests__/**',
]);

/** Whether `path` is a test, by the default globs or the plan's own. */
export function isTestPath(
  path: string,
  testPaths: readonly string[] = DEFAULT_TEST_PATHS,
): boolean {
  return pathScopeMatches(testPaths, path);
}

/** One commit on the fix node's branch, with what the gate set said at it. */
export interface RepairCommit {
  readonly sha: string;
  /** Repo-relative paths the commit added or modified. */
  readonly paths: readonly string[];
  /** The gate set's outcome at this commit. `needs-human` is neither a pass
   * nor a demonstration, and is treated as neither. */
  readonly outcome: VerdictOutcome;
}

export type RepairOrdering =
  | {
      readonly ok: true;
      /** The commit that added or modified the failing test. */
      readonly testCommit: string;
      /** The commit at which the gate first passed. */
      readonly fixCommit: string;
    }
  | { readonly ok: false; readonly code: RepairOrderingCode; readonly detail: string };

export interface RepairOrderingOptions {
  /** The plan's own idea of where tests live. Defaults to `DEFAULT_TEST_PATHS`. */
  readonly testPaths?: readonly string[];
}

/**
 * AC4 — whether the branch shows a failing test, then a fix.
 *
 * Three refusals, and each is a different thing to do about it:
 *
 *   * **no commits** — nothing happened, so nothing was demonstrated. Refused
 *     rather than read as a vacuous pass, which is the shape an empty array
 *     would otherwise take.
 *   * **the first commit already passes** — `repair.no_failing_test`. This is
 *     the arm §7 cares about, and it goes to a human.
 *   * **the first commit modified no test** — also `repair.no_failing_test`:
 *     a gate that failed before the commit and after it has not been shown to
 *     be *about* anything the fix will address.
 *
 * A branch whose last commit still fails is not a shortcut, it is an
 * unsuccessful attempt, so it gets its own code and feeds the attempt counter
 * rather than the escalation.
 */
export function repairOrdering(
  commits: readonly RepairCommit[],
  options: RepairOrderingOptions = {},
): RepairOrdering {
  const testPaths = options.testPaths ?? DEFAULT_TEST_PATHS;
  const first = commits[0];

  if (first === undefined) {
    return {
      ok: false,
      code: REPAIR_NO_FAILING_TEST,
      detail:
        'the fix node produced no commits at all, so no failing test was written and nothing ' +
        'was demonstrated',
    };
  }

  if (first.outcome === 'pass') {
    return {
      ok: false,
      code: REPAIR_NO_FAILING_TEST,
      detail:
        `the gate already passed at the first commit ${first.sha}, so whatever it added is not ` +
        'a test that reproduces the finding — a repair that cannot be expressed as a failing ' +
        'test is a signal, not a shortcut',
    };
  }

  if (!first.paths.some((path) => isTestPath(path, testPaths))) {
    return {
      ok: false,
      code: REPAIR_NO_FAILING_TEST,
      detail:
        `the first commit ${first.sha} added or modified no test file (${first.paths.join(', ')}), ` +
        'so the gate failing at it says nothing about the finding being reproduced',
    };
  }

  const fix = commits.slice(1).find((commit) => commit.outcome === 'pass');
  if (fix === undefined) {
    return {
      ok: false,
      code: REPAIR_STILL_FAILING,
      detail: `no commit after ${first.sha} made the gate pass`,
    };
  }

  return { ok: true, testCommit: first.sha, fixCommit: fix.sha };
}
