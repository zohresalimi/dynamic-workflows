/**
 * KAR-07.3 AC6 — the static policy check backing "every call site that passes
 * a generated name to git uses either a `--` separator or the
 * `--branch=<value>` long form" (docs/09-workspace-and-safety.md §2.1,
 * EPIC-07-S8's third scenario).
 *
 * `nodeBranch`/`integrationBranch` (./branch-name.ts) can never themselves
 * return a value git would parse as a flag (D13's literal `DeFlow/` prefix
 * guarantees that), but a call site that forwards their result into a bare
 * positional slot — `git branch <name>`, `git push origin <name>` — is one
 * git subcommand release away from that positional colliding with a real
 * flag of its own (§2.1's trap; demonstrated on real `git branch -n` in
 * test/integration/branch-name.test.ts). This module is the mechanical check
 * that no call site in this package does that, reused by
 * test/generated-ref-call-sites.test.ts's repo-wide walk so a future call
 * site (KAR-07.2, KAR-07.6, KAR-07.7) cannot add the hole back unnoticed.
 *
 * Pure text scanning, not an AST: a `nodeBranch(`/`integrationBranch(` call
 * is "guarded" when the source immediately before it — within one array
 * element's width — is either the literal token `'--'`/`"--"` followed by a
 * comma, or a `--branch=` (or `--branch-name=`, `-b=`... no: exactly
 * `--branch=`) template prefix.
 */

const GENERATED_CALL = /\b(?:nodeBranch|integrationBranch)\(/g;
const SEPARATOR_GUARD = /['"]--['"]\s*,\s*$/;
const LONG_FORM_GUARD = /--branch=\$\{\s*$/;
/** How far back to look for a guard, in characters — comfortably more than
 * one array element ever needs (`'--', ` or `` `--branch=${ `` are each well
 * under this). */
const LOOKBEHIND = 24;

export interface UnguardedCall {
  /** 0-based character offset of the call in `source`. */
  readonly offset: number;
  /** 1-based line number, for a readable failure message. */
  readonly line: number;
}

/**
 * Every `nodeBranch(`/`integrationBranch(` call in `source` that is not
 * immediately preceded by a `--` separator or a `--branch=${` long-form
 * prefix.
 */
export function findUnguardedGeneratedRefCalls(source: string): UnguardedCall[] {
  const offenders: UnguardedCall[] = [];
  GENERATED_CALL.lastIndex = 0;
  let match: RegExpExecArray | null = GENERATED_CALL.exec(source);
  while (match !== null) {
    const before = source.slice(Math.max(0, match.index - LOOKBEHIND), match.index);
    if (!SEPARATOR_GUARD.test(before) && !LONG_FORM_GUARD.test(before)) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push({ offset: match.index, line });
    }
    match = GENERATED_CALL.exec(source);
  }
  return offenders;
}
