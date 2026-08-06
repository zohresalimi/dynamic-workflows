/**
 * KAR-07.7 — the merge queue's ordering, as a pure function of the probe
 * table (docs/09-workspace-and-safety.md §7.1; AC2, AC3).
 *
 * §7.1's rule is one sentence — *order completed node branches by ascending
 * merge-tree conflict count against the integration branch* — and the whole
 * value of it is that the number comes from `conflict_probe` (KAR-07.6) and
 * from nowhere else. A queue ordered on declared path scopes would look
 * identical from the outside and be wrong in exactly the case the ordering
 * exists for: two nodes declaring the same directory that edit different
 * functions merge cleanly, and putting them last wastes the cheap merges the
 * order is trying to bank first.
 *
 * Three details that are not tidiness:
 *
 * - **The pair lookup is orientation-agnostic.** `merge-tree` is symmetric and
 *   the ledger canonicalises `(a, b)` on write, so a row for this branch may
 *   have the integration branch on either side. A lookup that assumed one
 *   orientation would find nothing and — worse than failing — could be
 *   "fixed" later by defaulting the missing count to zero, which sorts every
 *   unprobed branch to the front of the queue.
 * - **A probe between two node branches is not an input here.** That number is
 *   the *scheduler's* (KAR-07.6 demotes on it); it says nothing about what
 *   either branch costs against the integration branch.
 * - **An unprobed branch throws.** There is no honest default: zero claims a
 *   clean merge nobody measured, and infinity silently parks real work at the
 *   back of the queue for ever.
 *
 * Recomputed, never remembered: `mergeQueue` takes the probe table as an
 * argument precisely so that "re-probe, re-sort" (AC3) is the *only* way to
 * use it. There is no incremental update path, because a merge changes every
 * remaining branch's count and an incrementally-patched order is stale in a
 * way no test would notice.
 *
 * Verifies: EPIC-07-S26 · AC2, AC3
 */
import type { ProbeVerdict } from './conflict-matrix.ts';

/** A completed node branch waiting to be integrated. */
export interface MergeCandidate {
  readonly nodeId: string;
  /** Composed by KAR-07.3's `nodeBranch`, never here. */
  readonly branch: string;
  /** ms epoch the node completed at — AC2's tie-break, and only that. */
  readonly completedAt: number;
}

/** A candidate with the number it was ordered on, so the order can be read
 * back and explained rather than merely trusted. */
export interface QueuedMerge extends MergeCandidate {
  /** `conflict_probe.path_count` against the integration branch. */
  readonly pathCount: number;
}

/**
 * A branch the queue was asked to order without a probe row against the
 * integration branch.
 *
 * Thrown rather than defaulted: see the module note. The caller's fix is to
 * probe it (KAR-07.6), not to guess a count.
 */
export class UnprobedBranchError extends Error {
  readonly branch: string;
  readonly integrationBranch: string;

  constructor(branch: string, integrationBranch: string) {
    super(
      `no conflict_probe row for ${branch} against ${integrationBranch}: a branch that has not ` +
        'been probed cannot be ordered, and defaulting its conflict count would sort it to one ' +
        'end of the queue on no evidence',
    );
    this.name = 'UnprobedBranchError';
    this.branch = branch;
    this.integrationBranch = integrationBranch;
  }
}

/**
 * The conflict count of `branch` against `integrationBranch` in `probes`, or
 * `null` when the pair is not in the table.
 *
 * Both orientations are accepted, because the ledger canonicalises the pair on
 * write and the caller does not control which side its branch lands on.
 */
export function conflictCountAgainst(
  probes: readonly ProbeVerdict[],
  integrationBranch: string,
  branch: string,
): number | null {
  for (const row of probes) {
    const matches =
      (row.branchA === integrationBranch && row.branchB === branch) ||
      (row.branchB === integrationBranch && row.branchA === branch);
    if (matches) return row.paths.length;
  }
  return null;
}

/**
 * AC2 — the queue, ascending by conflict count, ties broken on completion time
 * and then on node id.
 *
 * The node-id tie-break is not decoration: two daemon lives reducing the same
 * table must produce the same queue, and an equal-timestamp pair left to the
 * input array's order would not.
 */
export function mergeQueue(
  candidates: readonly MergeCandidate[],
  probes: readonly ProbeVerdict[],
  integrationBranch: string,
): QueuedMerge[] {
  const queued = candidates.map((candidate): QueuedMerge => {
    const pathCount = conflictCountAgainst(probes, integrationBranch, candidate.branch);
    if (pathCount === null) throw new UnprobedBranchError(candidate.branch, integrationBranch);
    return { ...candidate, pathCount };
  });

  return queued.toSorted((left, right) => {
    if (left.pathCount !== right.pathCount) return left.pathCount - right.pathCount;
    if (left.completedAt !== right.completedAt) return left.completedAt - right.completedAt;
    return left.nodeId < right.nodeId ? -1 : 1;
  });
}

/** The queue as the ledger records it: node ids, in order. */
export function queueOrder(queue: readonly MergeCandidate[]): string[] {
  return queue.map((entry) => entry.nodeId);
}

/**
 * AC3's payload: the order before the re-probe and the order after it.
 *
 * Emitted after *every* merge, including one that empties the queue, so that
 * "what is left to merge" is answerable from the newest such event alone
 * rather than by replaying merges against a starting order.
 */
export function reorderPayload(
  before: readonly MergeCandidate[],
  after: readonly MergeCandidate[],
): { before: string[]; after: string[] } {
  return { before: queueOrder(before), after: queueOrder(after) };
}
