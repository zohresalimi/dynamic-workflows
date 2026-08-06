/**
 * A `git` invocation that failed in a way its caller cannot express as a value
 * (docs/09-workspace-and-safety.md §6.1).
 *
 * The `Git` wrapper deliberately does **not** throw on a non-zero exit — exit
 * codes are data, because `merge-tree` uses exit 1 to mean *conflict* and a
 * throwing wrapper destroys that signal before anyone can read it (§1.1). This
 * is what the layer above uses when a particular non-zero exit is genuinely not
 * a result: the command did not run, or ran and answered something no caller
 * asked about.
 *
 * `stderr` is carried rather than summarised. At that point git's own words are
 * the only information there is, and every reading of them is a guess.
 */
import type { GitResult } from './run-git.ts';

export class GitError extends Error {
  /** The argv, without the `-C <cwd>` prefix `runGit` adds. */
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(message: string, args: readonly string[], result: GitResult) {
    super(`${message}: ${result.stderr.trim()}`);
    this.name = 'GitError';
    this.args = [...args];
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}
