/**
 * KAR-12.3 AC5, AC6 — what a sequence of attempts looks like to the diff
 * surface and to the repair loop (docs/10-verification-gates.md §4, §8).
 *
 * Two functions, and between them they are the reason the stable id exists.
 *
 * **`findingDelta`** answers *what did this attempt change* — fixed, remaining,
 * introduced — in ids rather than in counts. A repair loop that only knew the
 * count went from 3 to 3 cannot tell a stalled attempt from one that fixed two
 * problems and caused two more; the churn detector needs the difference, and so
 * does anybody reading the run.
 *
 * **`projectFindings`** answers *what should be drawn on this revision*. One
 * annotation per id, taken from the most recent attempt that reported it, and
 * marked `stale` when the blob it was measured against is not the blob being
 * rendered. Without that flag the second repair attempt silently attaches every
 * earlier finding to whatever line now occupies that number, and the reviewer
 * stops trusting the margin within about ten minutes (§8).
 *
 * The margin text — *"stale — from attempt 2"* — is EPIC-17's. `stale` and
 * `fromAttempt` are this story's, and nothing here renders anything.
 */
import type { FindingV2, VerdictV3 } from '@DeFlow/core';

export interface FindingDelta {
  /** In `previous`, not in `current`. */
  readonly fixed: readonly string[];
  /** In both. */
  readonly remaining: readonly string[];
  /** In `current`, not in `previous`. */
  readonly introduced: readonly string[];
}

/**
 * AC5 — the difference between two attempts, by stable id.
 *
 * Order follows `previous` then `current`, so two runs over the same attempts
 * read identically and a snapshot of the result is a snapshot of the fact
 * rather than of a `Set`'s insertion order.
 */
export function findingDelta(
  previous: readonly string[],
  current: readonly string[],
): FindingDelta {
  const before = new Set(previous);
  const after = new Set(current);
  const unique = (ids: readonly string[]): readonly string[] => [...new Set(ids)];

  return {
    fixed: unique(previous).filter((id) => !after.has(id)),
    remaining: unique(previous).filter((id) => after.has(id)),
    introduced: unique(current).filter((id) => !before.has(id)),
  };
}

/** One attempt's verdict, with the attempt number that produced it. */
export interface AttemptVerdict {
  readonly attempt: number;
  readonly verdict: VerdictV3;
}

export interface ProjectedFinding extends FindingV2 {
  /** The finding was measured against a different revision of its file. */
  readonly stale: boolean;
  /** The attempt whose verdict reported it — AC6's `fromAttempt: <n>`. */
  readonly fromAttempt: number;
}

/** The blob name of a file in the revision being rendered, or `undefined`
 * when that revision does not have the file at all. */
export type RenderedBlobSha = (file: string) => string | undefined;

/**
 * AC6 — the findings to draw on one revision, deduplicated by stable id.
 *
 * Three rules, each with a failure it prevents:
 *
 *   * **Newest attempt wins.** The same lint error across four attempts is one
 *     annotation, not four, and the copy that is drawn is the most recent
 *     measurement of it.
 *   * **A different blob is stale.** Including the case where the rendered
 *     revision does not contain the file: an attempt that judged a file this
 *     revision does not have was judging something else.
 *   * **No location, never stale.** A finding about the change as a whole has
 *     no line to be misdrawn against, and marking it stale would tell a
 *     reviewer to discount a judgement that is still exactly as true.
 */
export function projectFindings(
  attempts: readonly AttemptVerdict[],
  renderedBlobSha: RenderedBlobSha,
): readonly ProjectedFinding[] {
  const latest = new Map<string, ProjectedFinding>();

  for (const { attempt, verdict } of attempts) {
    for (const finding of verdict.findings) {
      const previous = latest.get(finding.id);
      if (previous !== undefined && previous.fromAttempt > attempt) continue;
      latest.set(finding.id, {
        ...finding,
        fromAttempt: attempt,
        stale:
          finding.location === undefined
            ? false
            : renderedBlobSha(finding.location.file) !== finding.location.blobSha,
      });
    }
  }

  return [...latest.values()];
}
