/**
 * KAR-18.1 AC1, AC3 — merging the gitignored half of `.DeFlow/` into the
 * repository's own `.gitignore`, without duplicating a line a previous
 * `init` already added and without corrupting a file that does not end in a
 * newline.
 *
 * `.DeFlow/daemon.json` holds a 32-byte bearer token
 * (docs/16-repo-layout.md §7.2); the day it is committed instead of ignored,
 * the token in it is compromised. So the merge has to be a **fixpoint**:
 * applying it twice must produce byte-identical output, or a second `init`
 * after a `git pull` would grow the file forever.
 *
 * The bug this guards against is concatenation, not omission: appending
 * `entries.join('\n')` straight onto content that does not end in `\n` glues
 * the first new entry onto the repository's last existing pattern —
 * `node_modules/.DeFlow/daemon.json` — which matches neither pattern and
 * ignores nothing. Splitting into lines first, regardless of whether the
 * input ends in a newline, is what avoids it.
 */

/** AC1 — the three gitignored paths `init` appends, in the order they are
 * written. `.DeFlow/config.yaml`, `gates/`, `templates/`, `memory/` and
 * `.worktreeinclude` are the committed half and never go here. */
export const GITIGNORE_ENTRIES = ['.DeFlow/daemon.json', '.DeFlow/wt/', '.DeFlow/runs/'] as const;

export interface GitignoreMerge {
  /** The full file content to write. Identical to the input when nothing was missing. */
  readonly content: string;
  /** Entries this merge actually added, in the order they were appended. Empty
   * means every entry was already present — the fixpoint case. */
  readonly added: readonly string[];
}

/**
 * Splits into lines regardless of a missing trailing newline, without a
 * spurious trailing empty line when one is present.
 */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split('\n');
}

/**
 * Appends every entry in `entries` not already present as its own line in
 * `existing`, and nothing else. `existing` is `undefined` for a repository
 * with no `.gitignore` yet, which is treated the same as an empty one.
 *
 * The result always ends with a trailing newline — a `.gitignore` missing one
 * is a common, harmless state to *read*, and this function's own output is
 * never in it, so a third `init` sees the same fixpoint as the second.
 */
export function mergeGitignore(
  existing: string | undefined,
  entries: readonly string[] = GITIGNORE_ENTRIES,
): GitignoreMerge {
  const text = existing ?? '';
  const lines = linesOf(text);
  const present = new Set(lines);
  const added = entries.filter((entry) => !present.has(entry));

  if (added.length === 0) return { content: text, added: [] };

  return { content: `${[...lines, ...added].join('\n')}\n`, added };
}
