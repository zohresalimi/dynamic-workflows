/**
 * KAR-07.6 — the pure half of the live conflict matrix
 * (docs/09-workspace-and-safety.md §6.2, §7.3).
 *
 * Three decisions, none of which touches git or SQLite, so all three are
 * decidable from plain values and testable without either:
 *
 * - **which pairs to probe** after a write node commits — the integration
 *   branch and every *other* in-flight node branch, which is what keeps the
 *   matrix live rather than a merge-time discovery;
 * - **whether a stored row may still be believed** — a comparison against both
 *   tips, which is the entire reason `conflict_probe` stores both. Without
 *   them "is this cached answer still true?" is unanswerable, and the table
 *   becomes a source of confidently wrong scheduling decisions the moment a
 *   node commits again;
 * - **who gets demoted** when a pair does conflict — the later *starter*. Not
 *   the smaller node, not the lower-priority one, and above all not whichever
 *   the branch names happen to sort first: the node that has been running
 *   longest has the most work to lose, and start time is the one ordering a
 *   scheduler and a human reading the timeline both agree on.
 *
 * Verifies: EPIC-07-S25, EPIC-07-S30 · AC4, AC5, AC6
 */

/** A node the scheduler currently considers running, and its branch. */
export interface InFlightBranch {
  readonly nodeId: string;
  readonly branch: string;
  /** ms epoch the node started at — the only input the demotion turns on. */
  readonly startedAt: number;
}

/** One probe's answer about a branch pair, however it was obtained. */
export interface ProbeVerdict {
  readonly branchA: string;
  readonly branchB: string;
  readonly clean: boolean;
  readonly paths: readonly string[];
}

/** A node the scheduler must stop admitting, and why. */
export interface Demotion {
  readonly node: string;
  /** The counterpart that keeps running. */
  readonly conflictsWith: string;
  readonly branch: string;
  readonly otherBranch: string;
  readonly paths: readonly string[];
}

/**
 * AC4 — the fan-out after `subject` commits: the run's integration branch
 * first, then every other in-flight branch in the order the scheduler listed
 * them. `subject` itself is excluded, because a branch never conflicts with
 * itself and the pair key could not express it if it did.
 */
export function probeTargets(
  subject: InFlightBranch,
  inFlight: readonly InFlightBranch[],
  integrationBranch: string,
): string[] {
  return [
    integrationBranch,
    ...inFlight.filter((node) => node.branch !== subject.branch).map((node) => node.branch),
  ];
}

/** The two tips a stored row was probed at. */
export interface ProbedTips {
  readonly branchA: string;
  readonly branchB: string;
  readonly aCommit: string;
  readonly bCommit: string;
}

/**
 * AC5 — whether a stored row still describes the branches as they are now.
 *
 * A tip the caller does not know is stale, not fresh: the question "has this
 * branch moved?" has no answer, and an unanswerable question must never
 * resolve to "the cache is good".
 */
export function isProbeStale(row: ProbedTips, tips: ReadonlyMap<string, string>): boolean {
  return tips.get(row.branchA) !== row.aCommit || tips.get(row.branchB) !== row.bCommit;
}

/** Later start wins the demotion; an exact tie falls back to the node id, so
 * two daemons reducing the same matrix name the same victim. */
function laterStarter(left: InFlightBranch, right: InFlightBranch): InFlightBranch {
  if (left.startedAt !== right.startedAt) return left.startedAt > right.startedAt ? left : right;
  return left.nodeId > right.nodeId ? left : right;
}

/**
 * AC6 — the probe matrix reduced to the nodes the scheduler must stop
 * admitting.
 *
 * A verdict against a branch no in-flight node owns — the integration branch,
 * above all — never demotes anyone: that conflict is the merge queue's input
 * (KAR-07.7), not a reason to stop a running node. And a node already demoted
 * by an earlier pair is not demoted twice; "the first detected conflict" is
 * one blocking, naming one counterpart.
 */
export function demotions(
  inFlight: readonly InFlightBranch[],
  verdicts: readonly ProbeVerdict[],
): Demotion[] {
  const byBranch = new Map(inFlight.map((node) => [node.branch, node]));
  const blocked = new Set<string>();
  const result: Demotion[] = [];

  for (const verdict of verdicts) {
    if (verdict.clean) continue;
    const left = byBranch.get(verdict.branchA);
    const right = byBranch.get(verdict.branchB);
    if (left === undefined || right === undefined) continue;

    const loser = laterStarter(left, right);
    const winner = loser === left ? right : left;
    if (blocked.has(loser.nodeId)) continue;

    blocked.add(loser.nodeId);
    result.push({
      node: loser.nodeId,
      conflictsWith: winner.nodeId,
      branch: loser.branch,
      otherBranch: winner.branch,
      paths: verdict.paths,
    });
  }
  return result;
}
