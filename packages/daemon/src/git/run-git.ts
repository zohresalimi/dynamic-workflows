/**
 * The one place a `git` child process is started in DeFlowd.
 *
 * **Scope note.** The full wrapper is KAR-07.1 (`docs/09-workspace-and-safety.md`
 * §1.1): a `Git` class that also refuses `worktree add --force`, refuses every
 * write to the default branch, resolves that branch once per repository, and
 * gates on git ≥ 2.38 because `merge-tree --write-tree` does not exist below
 * it. None of that is here. KAR-06.4 needs a git child process to reconcile
 * against and cannot wait for EPIC-07 without stalling the critical path, so
 * this module is the **spawn half only**, written where KAR-07.1's assertions
 * will be added rather than in a corner they would have to be moved out of.
 * It deliberately implements no policy: a caller that needs a refusal must not
 * find a half-built one here and believe it.
 *
 * What it does hold is the three decisions that would otherwise be made
 * differently at each call site:
 *
 * 1. **`reject: false` — exit codes are data.** `git merge-tree` uses exit
 *    code 1 to mean *conflict*, a normal expected result, and `git log --grep`
 *    exits 0 with no output when nothing matched. An exception-throwing
 *    wrapper destroys both signals before the caller can read them.
 * 2. **`LC_ALL=C`.** Git is built with gettext on most distributions, and this
 *    module's callers read its messages — `already exists` versus `already
 *    used by worktree at` is the difference between an idempotent worktree and
 *    two nodes writing one branch. A localized message would turn a correct
 *    reconcile into a wrong one on a French developer's laptop, silently.
 * 3. **`SSH_AUTH_SOCK` survives.** The git wrapper is the only thing in DeFlow
 *    that will ever push, and it needs the user's forwarded agent
 *    (docs/15-security-model.md §4.1). `GIT_TERMINAL_PROMPT=0` goes with it:
 *    a credential prompt on a daemon's stdin is a hang, not a question.
 *
 * `execa` is used here and only here; agent processes use raw
 * `node:child_process` because three execa options do not do what their names
 * suggest for detached process groups (docs/09-workspace-and-safety.md §11.4).
 */

import process from 'node:process';
import { execa } from 'execa';

/** Long enough for a real `git worktree add` on a large repository, short
 * enough that a hung credential helper is a failure rather than a wedged run. */
export const GIT_TIMEOUT_MS = 60_000;

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunGitOptions {
  /** Merged over `gitChildEnv()`. A hermetic test passes `GIT_ENV` here. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * The environment a `git` child gets: the daemon's own, plus the three
 * variables that must be set, minus nothing.
 *
 * Nothing is stripped, deliberately. A user's `GIT_SSH_COMMAND`,
 * `GIT_CONFIG_GLOBAL` or credential helper is how their repository actually
 * works, and a daemon that discards it produces a clone that only DeFlow can
 * fail to push. Hermetic *tests* override through `RunGitOptions.env`.
 */
export function gitChildEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return {
    ...base,
    // Parseable messages. See the header: `already exists` is load-bearing.
    LC_ALL: 'C',
    LANG: 'C',
    // A prompt DeFlowd cannot answer is a hang, and a hang inside an effect is
    // the worst failure mode this system has.
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Runs `git -C <cwd> <args…>` and resolves with its exit code, whatever it is.
 *
 * `-C` *and* `cwd`: the option is what git itself uses to resolve the
 * repository, and the process working directory matters for the relative paths
 * a caller may pass.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const result = await execa('git', ['-C', cwd, ...args], {
    cwd,
    env: { ...gitChildEnv(), ...options.env },
    extendEnv: false,
    reject: false,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    stripFinalNewline: true,
  });

  return {
    // `undefined` when the child was killed by a signal: not zero, because
    // "the timeout fired" must never read as success.
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
