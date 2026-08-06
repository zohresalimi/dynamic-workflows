/**
 * KAR-07.5 Layer 1 — `.worktreeinclude`, Claude Code's convention adopted
 * verbatim (docs/09-workspace-and-safety.md §5.1).
 *
 * A file is copied into a fresh worktree when it **matches a
 * `.worktreeinclude` pattern _and_ is ignored by `.gitignore`**. Both halves,
 * every time. Pattern alone would copy tracked files and leave a second,
 * diverging copy of something git already manages; gitignored alone would copy
 * `node_modules/` and every build artifact in the repository.
 *
 * **The pattern half is git's own.** `ls-files --exclude-from=<file>` applies
 * gitignore syntax — anchoring, `**`, character classes, `!` negation with
 * last-match-wins — using the implementation that wrote the rules, rather than
 * a second matcher here that would agree with git on the four cases someone
 * thought to test and diverge on the fifth. Two invocations, because tracked
 * and untracked files need different flags and the difference between them is
 * load-bearing:
 *
 * - `--others --ignored --exclude-from=X` — untracked files matching X.
 * - `--cached  --ignored --exclude-from=X` — *tracked* files matching X, which
 *   exist only to be reported and skipped. Asking for them is what lets the
 *   refusal be a decision this module makes rather than a side effect of
 *   `--others` never having listed them.
 *
 * `--exclude-standard` is deliberately absent from both: adding it would union
 * `.gitignore` into the pattern half and silently collapse the two conditions
 * into one.
 *
 * The gitignored half is `git check-ignore --no-index`, asked only about the
 * handful of paths the patterns matched.
 *
 * Verifies: EPIC-07-S19 · AC1
 */

/** §5.1: Claude Code's filename, reused so it is zero new concepts. */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** Untracked files matching the include patterns. */
export const INCLUDE_MATCH_ARGS_UNTRACKED = (includePath: string): string[] => [
  'ls-files',
  '-z',
  '--others',
  '--ignored',
  `--exclude-from=${includePath}`,
];

/** Tracked files matching the include patterns — listed so they can be
 * *refused*, which is AC1's second row. */
export const INCLUDE_MATCH_ARGS_TRACKED = (includePath: string): string[] => [
  'ls-files',
  '-z',
  '--cached',
  '--ignored',
  `--exclude-from=${includePath}`,
];

/**
 * Which of `paths` are ignored by the repository's *own* excludes — the second
 * condition, asked only about the handful the patterns already matched.
 *
 * `--exclude-standard` restricted by pathspec, rather than `git check-ignore`,
 * for one reason: `check-ignore` refuses `-z` unless the paths arrive on stdin
 * (`fatal: -z only makes sense with --stdin`, verified on git 2.50.1), and
 * without `-z` git C-quotes any path holding a space or a non-ASCII byte. A
 * `.worktreeinclude` naming `config/my secrets.json` would then be silently
 * skipped. Same answer, NUL-delimited both ways.
 *
 * Each path is wrapped in `:(literal)` pathspec magic, because a pathspec is a
 * glob by default and a real filename containing `[` or `*` would otherwise
 * match the wrong thing — or nothing.
 */
export const GITIGNORED_AMONG_ARGS = (paths: readonly string[]): string[] => [
  'ls-files',
  '-z',
  '--others',
  '--ignored',
  '--exclude-standard',
  '--',
  ...paths.map((path) => `:(literal)${path}`),
];

/** One candidate and the three facts that decide it. */
export interface IncludeCandidate {
  /** Repo-relative, as `git ls-files` printed it. */
  readonly path: string;
  readonly matchesPattern: boolean;
  readonly gitignored: boolean;
  readonly tracked: boolean;
}

/**
 * The conjunction — the one part of this that is not delegated to git.
 *
 * Sorted, so the copy order (and therefore the `workspace.included_file` event
 * order) is a function of the repository rather than of directory iteration.
 */
export function includedFiles(candidates: readonly IncludeCandidate[]): string[] {
  return candidates
    .filter((c) => c.matchesPattern && c.gitignored && !c.tracked)
    .map((c) => c.path)
    .toSorted();
}

/** Splits a `-z` payload — NUL-terminated records, with a trailing empty. */
export function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}
