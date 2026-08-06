/**
 * KAR-07.3 AC3 — the second, git-verified layer of ref-name validation
 * (docs/09-workspace-and-safety.md §2.1): every name `nodeBranch`/
 * `integrationBranch` compose is additionally passed through real
 * `git check-ref-format --branch <name>`, and the boolean is cached per name
 * so a repeated check for the same name spawns no process (EPIC-07-S5).
 *
 * `check-ref-format --branch` is necessary and not sufficient on its own
 * (EPIC-07-S8) — it is stricter than DeFlow needs in one direction (it
 * refuses a leading `-` itself, on this git version — see the module comment
 * in ./branch-name.ts) but its answer is a property of the *string* alone,
 * never of a repository: it runs from any `cwd`, git repository or not. That
 * is what makes a cache keyed on the name, rather than scoped per repo, both
 * correct and safe to reuse across every caller in a process.
 *
 * Unlike ./branch-name.ts's synchronous domain-layer gate, this layer needs a
 * real `git` child process, so it is not part of `nodeBranch`/
 * `integrationBranch` themselves — a caller composes the name first (which
 * can throw `UnsafeRefError` with no process spawned at all, AC2), then
 * verifies it here before using it.
 */

export interface RefFormatRunner {
  run(args: readonly string[]): Promise<{ readonly exitCode: number }>;
}

/**
 * Wraps a `Git`-shaped `run()` (or anything with the same shape — a test
 * double included) and caches `git check-ref-format --branch <name>`'s
 * verdict per name, for the lifetime of this instance.
 */
export class RefFormatChecker {
  readonly #git: RefFormatRunner;
  readonly #cache = new Map<string, boolean>();

  constructor(git: RefFormatRunner) {
    this.#git = git;
  }

  /**
   * Resolves `true` when `name` is a valid branch name by git's own rules.
   * The first call for a given `name` spawns `git check-ref-format --branch
   * <name>`; every later call for that same `name` reads the cached boolean
   * and spawns nothing (AC3).
   */
  async isValid(name: string): Promise<boolean> {
    const cached = this.#cache.get(name);
    if (cached !== undefined) return cached;
    const result = await this.#git.run(['check-ref-format', '--branch', name]);
    const ok = result.exitCode === 0;
    this.#cache.set(name, ok);
    return ok;
  }
}
