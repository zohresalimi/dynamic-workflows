/**
 * KAR-10.1 AC4 — resolving a `{ kind: 'file' }` path against `cwd`, refusing
 * anything that escapes the repository root after `realpath`.
 *
 * "Same rule as the fs mediation boundary" (../services/path-mediation.ts),
 * applied here on a smaller surface: intake runs before any permission level
 * exists for the run, so there is no `PermissionLevel`, no worktree scope and
 * no case-folding probe to thread through — only the four escape routes
 * docs/14-testing-strategy.md §10 names, checked the same way path-mediation.ts
 * checks them: lexically first, then against the deepest existing ancestor's
 * `realpath`, because route 4 (lexically inside, really somewhere else) is
 * invisible to a resolve()-only check.
 */
import { pathIsInside } from '@DeFlow/core';
import { realpath as fsRealpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export type PathEscapeRoute = 'traversal' | 'absolute' | 'symlink' | 'invalid';

export type RepoPathResolution =
  | { readonly outcome: 'inside'; readonly path: string }
  | { readonly outcome: 'outside'; readonly route: PathEscapeRoute };

/** The filesystem, as containment needs to see it — a seam for a unit test to
 * construct route 4 without a real symlink; the shipped default is real `fs`. */
export interface RepoPathFs {
  realpath(path: string): Promise<string>;
}

export const nodeRepoPathFs: RepoPathFs = {
  realpath: (path) => fsRealpath(path),
};

function resolveLexically(
  requested: string,
  root: string,
): { readonly path: string; readonly route: PathEscapeRoute } {
  if (requested === '' || requested.includes('\0')) return { path: '', route: 'invalid' };
  const path = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  return { path, route: requested.split('/').includes('..') ? 'traversal' : 'absolute' };
}

/**
 * The real path of the deepest ancestor that exists, with the not-yet-existing
 * tail put back on. Mirrors `../services/path-mediation.ts`'s function of the
 * same name — see that file for why the tail can contain neither a symlink
 * (it does not exist) nor `..` (the input is already lexically normalised).
 */
async function realpathDeepest(fs: RepoPathFs, path: string): Promise<string> {
  const tail: string[] = [];
  let head = path;
  for (;;) {
    try {
      const real = await fs.realpath(head);
      return tail.length === 0
        ? real
        : `${real === '/' ? '' : real}/${tail.toReversed().join('/')}`;
    } catch {
      const at = head.lastIndexOf('/');
      if (at <= 0) return path;
      tail.push(head.slice(at + 1));
      head = head.slice(0, at);
    }
  }
}

/**
 * Resolves `requested` against `cwd` — the repository root, per AC4 — and
 * decides whether it stays inside.
 *
 * Returns the *lexical* resolution on `'inside'`, not its `realpath`: the
 * caller reads an existing file at this path, and for an existing file the
 * two coincide, but the lexical form is the one that stays a path under `cwd`
 * rather than one rewritten through every symlink `cwd` itself sits behind.
 */
export async function resolveWithinRepo(
  cwd: string,
  requested: string,
  fs: RepoPathFs = nodeRepoPathFs,
): Promise<RepoPathResolution> {
  const root = resolve(cwd);
  const lexical = resolveLexically(requested, root);
  if (lexical.path === '') return { outcome: 'outside', route: lexical.route };
  if (!pathIsInside(root, lexical.path)) return { outcome: 'outside', route: lexical.route };

  // Route 3 and route 4: lexically inside, really somewhere else. The root is
  // realpath'd too, for the same reason path-mediation.ts's does: `/var` is a
  // symlink to `/private/var` on macOS, and comparing a resolved target
  // against an unresolved root would deny every read under a repo checked out
  // there.
  const [rootReal, targetReal] = await Promise.all([
    realpathDeepest(fs, root),
    realpathDeepest(fs, lexical.path),
  ]);
  if (!pathIsInside(rootReal, targetReal)) return { outcome: 'outside', route: 'symlink' };

  return { outcome: 'inside', path: lexical.path };
}
