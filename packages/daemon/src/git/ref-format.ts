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

  /**
   * KAR-11.2 AC7 — the same question asked about a **full ref path** rather
   * than a branch shorthand: `git check-ref-format refs/heads/DeFlow/r1__n1`.
   *
   * A second method rather than a flag on the first, because the two modes are
   * genuinely different rules and 06 §3.3 names this one. `--branch` also
   * resolves shorthands like `@{-1}`, which is meaningful for a name a human
   * typed and meaningless for a name DeFlow composed; the full-ref form asks
   * only whether the string is a legal ref, which is exactly what plan
   * validation wants to know about a node id it has never seen.
   *
   * Cached on the composed ref for the same reason `isValid` is: the answer is
   * a property of the string alone, never of a repository, so it is safe to
   * reuse across every caller in a process.
   */
  async isValidRef(ref: string): Promise<boolean> {
    const key = `ref:${ref}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const result = await this.#git.run(['check-ref-format', ref]);
    const ok = result.exitCode === 0;
    this.#cache.set(key, ok);
    return ok;
  }
}
