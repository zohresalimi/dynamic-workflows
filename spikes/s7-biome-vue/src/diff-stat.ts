/**
 * Turns `git diff --stat`'s trailing summary line into numbers, so "bounded"
 * (AC2) is a comparison against a real threshold rather than a feeling from
 * skimming scrollback.
 */

export interface DiffStatTotal {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

const SUMMARY_LINE =
  /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/**
 * Parses the last non-blank line of `git diff --stat` output, e.g.
 * ` 2 files changed, 14 insertions(+), 6 deletions(-)`. Throws if no summary
 * line is present — an empty diff has no such line, and treating "found
 * nothing" as "zero changes" would hide the difference between "no diff
 * happened" and "the diff had no summary line", the two AC1 must tell apart.
 */
export function parseDiffStatSummary(output: string): DiffStatTotal {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  const summary = lines.at(-1);
  const match = summary === undefined ? null : SUMMARY_LINE.exec(summary);
  if (match === null) {
    throw new Error(`no "files changed" summary line in git diff --stat output: ${output}`);
  }
  return {
    filesChanged: Number(match[1]),
    insertions: match[2] === undefined ? 0 : Number(match[2]),
    deletions: match[3] === undefined ? 0 : Number(match[3]),
  };
}

/** Whether a diff's total changed-line count sits at or under a threshold. */
export function isBounded(total: DiffStatTotal, maxChangedLines: number): boolean {
  return total.insertions + total.deletions <= maxChangedLines;
}
