/**
 * KAR-07.2 AC5 — "a grep for `worktree list` without both flags returns zero
 * hits" (docs/09-workspace-and-safety.md §4.3, EPIC-07-S13's third scenario).
 *
 * The acceptance criterion names `packages/workspace`, which is the
 * architecture document's illustrative package name; this repository's nine
 * packages are fixed by docs/16-repo-layout.md and the workspace code lives in
 * `@DeFlow/daemon` (see the note at the top of src/git/git.ts). So the walk is
 * over **every package's sources**, which is strictly wider than the criterion
 * asks for and cannot be dodged by putting the offending call in a different
 * package.
 *
 * Same shape as ./generated-ref-call-sites.test.ts and
 * ./spawn-chokepoint.test.ts: a pure matcher, unit-tested in its own file,
 * applied here to real source text.
 *
 * Verifies: EPIC-07-S13 scenario 3 · AC5
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { findUnporcelainedWorktreeList } from '../src/git/worktree-list-usage.ts';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

/** The matcher module itself: its regex source text contains the very literals
 * it looks for, the same self-exclusion ./generated-ref-call-sites.test.ts
 * makes for its own analyzer. */
const EXCLUDED = new Set([join(PACKAGES, 'daemon', 'src', 'git', 'worktree-list-usage.ts')]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

suite('AC5: worktree list is only ever invoked as list --porcelain -z', () => {
  const files = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return sourceFiles(join(PACKAGES, entry.name, 'src'));
      } catch {
        return [];
      }
    })
    .filter((path) => !EXCLUDED.has(path));

  it('found the workspace sources to check at all', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((path) => path.endsWith(join('git', 'worktree-args.ts')))).toBe(true);
  });

  it('has zero hits without both --porcelain and -z', () => {
    const offenders = files.flatMap((path) =>
      findUnporcelainedWorktreeList(readFileSync(path, 'utf8')).map(
        (hit) => `${path}:${hit.line} (missing ${hit.missing.join(', ')})`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});
