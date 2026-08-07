/**
 * KAR-08.7 — declared path-scope globs: the matcher, the normalization that
 * keeps it agreeing with KAR-08.2's containment check, and the plan-time
 * check that a write node's `pathScope` is not empty
 * (docs/09-workspace-and-safety.md §6.3, §8.2).
 *
 * D14 demotes F5.3's declared scope to a *prediction*: admission control at
 * plan time, dependent on agent compliance, whose violation is a **warning**
 * — never the thing a merge depends on (`git merge-tree --write-tree` is
 * that, and it is KAR-07.6's). What lives here is the shared vocabulary both
 * enforcement points build on:
 *
 *   - **the matcher**, `pathScopeMatches`, used at *request* time by
 *     ./../../daemon's `permission-ladder.ts` (KAR-08.7 AC2) and at
 *     *completion* time by its `scope-diff.ts` (AC3);
 *   - **the normalizer**, `relativeToWorktree`, so `./src/a.ts`, `src/a.ts`
 *     and `<worktree>/src/a.ts` are one path to both call sites, the same way
 *     they already are to KAR-08.2's `contain()` (AC6);
 *   - **`emptyWriteScopes`**, the one thing AC1 asks for: a write node with no
 *     declared scope is not a plan the ladder can usefully police. Pure and
 *     returning findings, like `scopeCollisions` and `readsAreSatisfiable`
 *     beside it — the full plan validator that turns a finding into a
 *     rejection is KAR-11.2's, not built yet.
 *
 * The glob syntax is `.gitignore`'s, deliberately: a pattern with no `/`
 * (a bare filename, or `*.md`) matches at any depth; a pattern with a `/`
 * other than a trailing one is anchored to the worktree root; `**` spans any
 * number of path segments; a trailing `/` scopes a directory and everything
 * under it; `!` negates, and the *last* matching pattern wins, so a plan can
 * re-include a file under an otherwise-excluded directory. Nothing here reads
 * a filesystem — that is `scope-diff.ts`'s job, on the other side of the
 * package boundary R1 draws.
 *
 * Verifies: KAR-08.7 test plan rows 1, 2, 5 · AC1, AC4 (via KAR-07.6), AC6
 */
import type { NodeId } from './ids.ts';
import type { PlanGraph } from './plan-graph.ts';
import { resolvePosix } from './scope.ts';

// ── normalization (AC6) ─────────────────────────────────────────────────────

/**
 * `path`, resolved against `worktree` exactly the way KAR-08.2's `contain()`
 * resolves a request, then made relative to it: `./src/a.ts`, `src/a.ts` and
 * `<worktree>/src/a.ts` all come out as `src/a.ts`, and the worktree root
 * itself comes out as `''`.
 *
 * A path that resolves *outside* `worktree` is returned resolved but not
 * relativized — it cannot match any declared scope, which is the safe
 * default for a caller that reaches this function with such a path at all.
 */
export function relativeToWorktree(worktree: string, path: string): string {
  const root = resolvePosix('/', worktree);
  const resolved = resolvePosix(root, path);
  if (resolved === root) return '';
  // The same `root === '/'` special case `pathIsInside` (./scope.ts) makes:
  // `${root}/` would otherwise be `//`, which nothing resolved by
  // `resolvePosix` ever starts with.
  const prefix = root === '/' ? '/' : `${root}/`;
  return resolved.startsWith(prefix) ? resolved.slice(prefix.length) : resolved;
}

// ── the matcher ──────────────────────────────────────────────────────────────

/** Regex metacharacters this module does not treat as glob syntax, escaped
 * literally. `*` is handled by the translator below and never reaches this
 * set. */
const ESCAPE = /[.+^${}()|[\]\\?]/g;

/**
 * One glob pattern (no leading `!`, already stripped by the caller), compiled
 * to the anchored regex that decides it.
 *
 * A pattern with no `/` (`README.md`, `*.md`) is unanchored — it matches at
 * any depth, exactly as `.gitignore` reads it — by rewriting it as `** /
 * README.md` before translation. A trailing `/` (`dist/`) scopes a directory:
 * it matches everything *under* the name, never the bare name itself, because
 * every path this module is ever asked about is a file, not a directory
 * entry.
 */
function compilePattern(pattern: string): RegExp {
  const isDir = pattern.endsWith('/');
  const body = isDir ? pattern.slice(0, -1) : pattern;
  const anchored = body.includes('/') ? body : `**/${body}`;

  let out = '';
  let index = 0;
  while (index < anchored.length) {
    if (anchored.startsWith('**/', index)) {
      out += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (anchored.startsWith('**', index)) {
      out += '.*';
      index += 2;
      continue;
    }
    const char = anchored[index] ?? '';
    out += char === '*' ? '[^/]*' : char.replace(ESCAPE, '\\$&');
    index += 1;
  }

  return new RegExp(`^${out}${isDir ? '/.*' : ''}$`);
}

/**
 * Whether `path` — already normalized by `relativeToWorktree` — falls inside
 * the declared scope.
 *
 * `.gitignore` semantics: patterns are evaluated in order, and the *last*
 * pattern that matches decides it, positive or negated. An empty `scopes`
 * matches nothing — an undeclared scope is never silently "anything goes"
 * (that is AC1's plan-validation failure, not a permissive default here).
 */
export function pathScopeMatches(scopes: readonly string[], path: string): boolean {
  let matched = false;
  for (const raw of scopes) {
    const negate = raw.startsWith('!');
    const pattern = negate ? raw.slice(1) : raw;
    if (pattern === '') continue;
    if (compilePattern(pattern).test(path)) matched = !negate;
  }
  return matched;
}

// ── AC1: the plan-time check ────────────────────────────────────────────────

/** One write node whose declared write scope is empty — a plan-validation
 * failure (AC1). */
export interface EmptyWriteScope {
  readonly node: NodeId;
}

/**
 * Every write node (`permission !== 'read'`) in `graph` whose `pathScopes.write`
 * is `[]`, in plan order.
 *
 * A `read` node is exempt: F5.4's ladder already refuses any write it
 * attempts (`level-read`), so an empty write scope on one declares nothing
 * that could ever matter — see ./scope-collision.ts's `soleWritePath` for the
 * same reading.
 *
 * Pure, like `scopeCollisions` and `readsAreSatisfiable` beside it: this
 * returns findings, and the full plan validator that turns them into a
 * rejected plan is KAR-11.2's.
 */
export function emptyWriteScopes(graph: PlanGraph): EmptyWriteScope[] {
  return graph.nodes
    .filter((node) => node.permission !== 'read' && node.pathScopes.write.length === 0)
    .map((node) => ({ node: node.id }));
}
