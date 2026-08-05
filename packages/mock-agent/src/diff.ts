/**
 * A unified diff, in about eighty lines.
 *
 * `packages/mock-agent` ships with exactly one dependency
 * (docs/07-provider-adapter-layer.md §13), so `diff` and `jest-diff` are both
 * out of reach — and this is the one place in the package where a *readable*
 * failure is the whole feature. "the client frame did not match" sends the
 * reader back to two 3 KB JSON blobs with no starting point; a diff naming the
 * three lines that moved is the difference between a five-minute fix and an
 * afternoon.
 */

/** One row of the diff: context, removal or addition. */
type Marker = ' ' | '-' | '+';

interface Row {
  readonly marker: Marker;
  readonly text: string;
  /** 1-based line number in the left-hand text, or 0 for an addition. */
  readonly left: number;
  /** 1-based line number in the right-hand text, or 0 for a removal. */
  readonly right: number;
}

/**
 * Longest common subsequence, as the classic O(n·m) table.
 *
 * The inputs here are one pretty-printed JSON frame each — hundreds of lines at
 * the very worst — so the table costs nothing worth optimising away, and a
 * heuristic diff that occasionally chose a worse alignment would be a worse
 * bug report.
 */
function rows(left: readonly string[], right: readonly string[]): Row[] {
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let a = left.length - 1; a >= 0; a -= 1) {
    for (let b = right.length - 1; b >= 0; b -= 1) {
      const row = lengths[a] as number[];
      const nextRow = lengths[a + 1] as number[];
      row[b] =
        left[a] === right[b]
          ? (nextRow[b + 1] as number) + 1
          : Math.max(nextRow[b] as number, row[b + 1] as number);
    }
  }

  const out: Row[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) {
      out.push({ marker: ' ', text: left[a] as string, left: a + 1, right: b + 1 });
      a += 1;
      b += 1;
    } else if ((lengths[a + 1]?.[b] ?? 0) >= (lengths[a]?.[b + 1] ?? 0)) {
      out.push({ marker: '-', text: left[a] as string, left: a + 1, right: 0 });
      a += 1;
    } else {
      out.push({ marker: '+', text: right[b] as string, left: 0, right: b + 1 });
      b += 1;
    }
  }
  for (; a < left.length; a += 1) {
    out.push({ marker: '-', text: left[a] as string, left: a + 1, right: 0 });
  }
  for (; b < right.length; b += 1) {
    out.push({ marker: '+', text: right[b] as string, left: 0, right: b + 1 });
  }
  return out;
}

export interface UnifiedDiffOptions {
  readonly fromLabel?: string;
  readonly toLabel?: string;
  /** Unchanged lines kept either side of a change. */
  readonly context?: number;
}

/**
 * Renders `from` and `to` as a unified diff, or `''` when they are identical.
 *
 * Hunks are emitted the way `diff -u` emits them, because that is the format
 * every reader and every terminal highlighter already knows.
 */
export function unifiedDiff(from: string, to: string, options: UnifiedDiffOptions = {}): string {
  const context = options.context ?? 3;
  const left = from.split('\n');
  const right = to.split('\n');
  const all = rows(left, right);
  if (all.every((row) => row.marker === ' ')) return '';

  const kept = all.map(
    (row, index) =>
      row.marker !== ' ' ||
      all.some(
        (other, otherIndex) => other.marker !== ' ' && Math.abs(otherIndex - index) <= context,
      ),
  );

  const out: string[] = [
    `--- ${options.fromLabel ?? 'expected'}`,
    `+++ ${options.toLabel ?? 'actual'}`,
  ];

  let index = 0;
  while (index < all.length) {
    if (kept[index] !== true) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < all.length && kept[end] === true) end += 1;
    const hunk = all.slice(index, end);
    const leftStart = hunk.find((row) => row.left > 0)?.left ?? 0;
    const rightStart = hunk.find((row) => row.right > 0)?.right ?? 0;
    const leftCount = hunk.filter((row) => row.marker !== '+').length;
    const rightCount = hunk.filter((row) => row.marker !== '-').length;
    out.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`);
    for (const row of hunk) out.push(`${row.marker}${row.text}`);
    index = end;
  }

  return `${out.join('\n')}\n`;
}
