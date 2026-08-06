/**
 * KAR-07.1 — `execa` is used here and only here (docs/09-workspace-and-safety.md
 * §1.1: "execa is used here and only here"). `packages/daemon/src/git/run-git.ts`
 * is the sole place a `git` child process is spawned, which is what lets the
 * two forbidden-argument assertions in `./git/assertions.ts` guarantee they
 * run before every spawn: a second call site would be a second door.
 *
 * Adapted from EPIC-07-S2's grep scenario ("grepped for execa( outside
 * packages/workspace/src/git.ts") to this repository's actual layout —
 * docs/16-repo-layout.md has no `packages/workspace`; the chokepoint this
 * codebase actually has is `packages/daemon/src/git/run-git.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const CHOKEPOINT = join(SRC, 'git', 'run-git.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

suite('execa is spawned from exactly one place in @DeFlow/daemon', () => {
  const files = sourceFiles(SRC).filter((path) => path !== CHOKEPOINT);

  it('found sources to check at all', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no file other than git/run-git.ts calls execa(', () => {
    const offenders = files.filter((path) => /\bexeca\s*\(/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the chokepoint itself does call execa( — the check is not vacuous', () => {
    expect(/\bexeca\s*\(/.test(readFileSync(CHOKEPOINT, 'utf8'))).toBe(true);
  });
});
