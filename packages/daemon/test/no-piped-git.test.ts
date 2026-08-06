/**
 * KAR-07.6 / EPIC-07-S24's last scenario — "no code path in
 * `packages/workspace` pipes a git invocation", adapted to this repository's
 * actual layout (docs/16-repo-layout.md has no `packages/workspace`; the git
 * code lives in `packages/daemon/src/git`).
 *
 * The rule exists because the exit code *is* the conflict signal: pipe
 * `merge-tree` through anything and `$?` becomes the pipeline's status, so a
 * conflict is indistinguishable from a clean merge and two agents keep working
 * on branches that have already collided. The integration spec demonstrates
 * that on real git; this asserts nothing in the tree can do it.
 *
 * It is asserted structurally rather than by grepping for `|`, which would
 * match every union type and every regex alternation in the package. A pipe
 * needs a shell, a shell needs a command *string*, and `runGit` — the one
 * place a git child is started at all (./spawn-chokepoint.test.ts) — passes an
 * argv array and never sets `shell`. That is the mechanical guarantee; the
 * second assertion keeps it from being routed around by a second
 * `merge-tree` call site somewhere else.
 *
 * Verifies: EPIC-07-S24 (scenario 4) · KAR-07.6
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const CHOKEPOINT = join(SRC, 'git', 'run-git.ts');
const MERGE_TREE = join(SRC, 'git', 'merge-tree.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

suite('a git invocation cannot be piped', () => {
  it('the git chokepoint passes an argv array and never asks for a shell', () => {
    const source = readFileSync(CHOKEPOINT, 'utf8');

    expect(source).toContain("execa('git', ['-C', cwd, ...args]");
    expect(source).not.toMatch(/\bshell\s*:/);
  });

  it('only ./git/merge-tree.ts spells the merge-tree subcommand', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => path !== MERGE_TREE)
      .filter((path) => readFileSync(path, 'utf8').includes("'merge-tree'"))
      .map((path) => relative(SRC, path));

    expect(offenders).toEqual([]);
    expect(readFileSync(MERGE_TREE, 'utf8')).toContain("'merge-tree'");
  });
});
