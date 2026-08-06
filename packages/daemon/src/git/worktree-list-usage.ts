/**
 * KAR-07.2 AC5 — the static check behind "`worktree list` is only ever invoked
 * as `list --porcelain -z`; a grep for `worktree list` without both flags
 * returns zero hits" (docs/09-workspace-and-safety.md §4.3, EPIC-07-S13's
 * third scenario).
 *
 * The non-porcelain form is a **human display format**. It pads path, oid and
 * branch onto one line with spaces, so a user whose home directory is
 * `~/my projects` gets a parse that is wrong rather than one that fails, and
 * `-z` is what additionally makes DeFlow's own multi-word lock reason readable
 * back. This is the sort of rule that survives review and dies six months later
 * when somebody adds a quick `worktree list` to debug something — hence a
 * mechanical check rather than a convention, in the same shape as
 * ./generated-ref-usage.ts.
 *
 * Pure text scanning, not an AST: an argv array is a list of string literals,
 * and the question "are `--porcelain` and `-z` in the same array" is answerable
 * from the source text without pretending to understand the expression.
 */

/** `'worktree'` and `'list'` as adjacent argv elements, in either quote style. */
const WORKTREE_LIST = /(['"`])worktree\1\s*,\s*(['"`])list\2/g;
/** How far past the match to look for the two flags: comfortably more than
 * `, '--porcelain', '-z'` ever needs. The window is additionally cut at the
 * first `]`, so a *later* command's `--porcelain -z` can never vouch for this
 * one. */
const LOOKAHEAD = 80;

export interface UnporcelainedListCall {
  /** 0-based character offset of the `'worktree', 'list'` pair in `source`. */
  readonly offset: number;
  /** 1-based line number, for a readable failure message. */
  readonly line: number;
  /** Which of the two required flags was missing. */
  readonly missing: readonly string[];
}

/**
 * Every `'worktree', 'list'` argv in `source` that is not followed, within the
 * same array, by both `--porcelain` and `-z`.
 */
export function findUnporcelainedWorktreeList(source: string): UnporcelainedListCall[] {
  const offenders: UnporcelainedListCall[] = [];
  WORKTREE_LIST.lastIndex = 0;
  let match: RegExpExecArray | null = WORKTREE_LIST.exec(source);
  while (match !== null) {
    const window = source.slice(match.index, match.index + LOOKAHEAD);
    const closing = window.indexOf(']');
    const after = closing === -1 ? window : window.slice(0, closing);
    const missing = ['--porcelain', '-z'].filter(
      (flag) => !after.includes(`'${flag}'`) && !after.includes(`"${flag}"`),
    );
    if (missing.length > 0) {
      offenders.push({
        offset: match.index,
        line: source.slice(0, match.index).split('\n').length,
        missing,
      });
    }
    match = WORKTREE_LIST.exec(source);
  }
  return offenders;
}
