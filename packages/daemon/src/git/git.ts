/**
 * KAR-07.1 — the `Git` wrapper, completing the chokepoint `run-git.ts` left
 * open on purpose (docs/09-workspace-and-safety.md §1.1).
 *
 * Everything that touches git in DeFlow goes through `Git.run()`, so the two
 * assertions below cannot be bypassed by a caller in a hurry: both run
 * *before* `runGit` ever spawns `execa`. `assertNotDefaultBranchWrite` needs
 * the repository's resolved default branch to judge a `push`/`branch`/
 * `update-ref`, so that resolution — itself real `git` calls, through the
 * same `runGit` chokepoint — happens first, and is cached for the lifetime
 * of this instance (AC5: at most once per repository per run).
 *
 * The architecture doc's illustrative path is `packages/workspace/src/git.ts`
 * (docs/09-workspace-and-safety.md §1.1) — this repository has no
 * `packages/workspace` (docs/16-repo-layout.md, enforced by
 * test/workspace-structure.test.ts's exact nine-package list). KAR-06.4 left
 * the seam here deliberately: "this module is the spawn half only, written
 * where KAR-07.1's assertions will be added rather than in a corner they
 * would have to be moved out of" (./run-git.ts). This file is that addition.
 */
import {
  assertNoForcedWorktreeAdd,
  assertNotDefaultBranchWrite,
  isDefaultBranchWriteShaped,
} from './assertions.ts';
import { resolveDefaultBranchUncached } from './default-branch.ts';
import { type GitResult, type RunGitOptions, runGit } from './run-git.ts';

export type GitOptions = RunGitOptions;

export interface GitRunOptions {
  /** Defaults to the repo root this `Git` was constructed with. */
  readonly cwd?: string;
  /** Defaults to `GIT_TIMEOUT_MS`, or this instance's own `GitOptions.timeoutMs`. */
  readonly timeoutMs?: number;
}

/** Builds a `RunGitOptions` with only the keys that are actually set.
 * `exactOptionalPropertyTypes` treats an explicit `undefined` on an optional
 * property as a type error, so an `env`/`timeoutMs` this instance never
 * received must be omitted from the object entirely, not passed through. */
function runOptionsFor(env: RunGitOptions['env'], timeoutMs: number | undefined): RunGitOptions {
  return {
    ...(env === undefined ? {} : { env }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * One chokepoint per repository. Construct once per repo root and reuse it —
 * that reuse is what makes `resolveDefaultBranch()`'s cache actually cache
 * anything.
 */
export class Git {
  readonly #repoRoot: string;
  readonly #options: GitOptions;
  #defaultBranch: Promise<string> | undefined;

  constructor(repoRoot: string, options: GitOptions = {}) {
    this.#repoRoot = repoRoot;
    this.#options = options;
  }

  /**
   * `git -C <cwd> <args…>`, exit codes as data (`runGit`'s `reject: false`).
   * Throws synchronously-in-effect — before any process is spawned — for
   * either forbidden argument shape (§3.3, §10.6).
   */
  async run(args: readonly string[], opts: GitRunOptions = {}): Promise<GitResult> {
    assertNoForcedWorktreeAdd(args);
    if (isDefaultBranchWriteShaped(args)) {
      assertNotDefaultBranchWrite(args, await this.resolveDefaultBranch());
    }
    return runGit(
      opts.cwd ?? this.#repoRoot,
      args,
      runOptionsFor(this.#options.env, opts.timeoutMs ?? this.#options.timeoutMs),
    );
  }

  /**
   * §10.6: resolved from `origin/HEAD`, falling back to the local `HEAD`
   * symref, and cached on this instance (AC5) — a second call, however many
   * callers ask, returns the exact same in-flight (or settled) promise, so
   * the resolution body runs at most once.
   */
  resolveDefaultBranch(): Promise<string> {
    this.#defaultBranch ??= resolveDefaultBranchUncached(
      this.#repoRoot,
      runOptionsFor(this.#options.env, undefined),
    );
    return this.#defaultBranch;
  }
}
