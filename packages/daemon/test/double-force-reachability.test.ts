/**
 * KAR-07.2 AC7 — "`remove -f -f` appears only on the reaper code path
 * (KAR-07.8), and a unit test asserts it is unreachable from the normal
 * node-completion path" (EPIC-07-S16's third scenario).
 *
 * Two forces, not one: the first overrides dirtiness, the second overrides the
 * lock. Both are things the node-completion path must never do — a dirty
 * worktree is salvaged to a commit first (KAR-07.4) and a locked one is
 * unlocked first, because forcing either discards an agent's work or deletes a
 * worktree something is still using. The reaper may do it, but only after the
 * pid-and-start-time check has proven the owning process is gone.
 *
 * A prose rule would not survive the first flaky unlock. So this walks the
 * module graph transitively from the node-completion entry point and asserts
 * the double force is not in it — reachability, not a grep of one file, so
 * moving the call one module deeper does not slip past.
 *
 * Verifies: EPIC-07-S16 scenario 3 · AC7
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** The node-completion path's entry point: everything a completing node's
 * worktree removal can reach. */
const ENTRY = resolve(SRC, 'git/worktree-manager.ts');
const FORCE_REMOVE = resolve(SRC, 'git/worktree-force-remove.ts');

const RELATIVE_IMPORT = /from\s+'(\.[^']+)'/g;

/** Every module reachable from `entry` by relative import, `entry` included. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      if (specifier === undefined) continue;
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return seen;
}

suite('the double force is unreachable from the node-completion path', () => {
  const graph = reachable(ENTRY);

  it('walked a real graph, not an empty one', () => {
    expect(graph.has(ENTRY)).toBe(true);
    expect(graph.size).toBeGreaterThan(2);
  });

  it('does not reach worktree-force-remove.ts', () => {
    expect([...graph].filter((file) => file === FORCE_REMOVE)).toEqual([]);
  });

  it('contains no force flag literal anywhere in the graph', () => {
    const offenders = [...graph].filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes(`'-f'`) || source.includes(`'--force'`);
    });

    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});

suite('the reaper-only module says what it is for, and is exactly the double form', () => {
  it('exists, and its argv is remove -f -f', async () => {
    const { reaperForceRemoveArgs } = await import('../src/git/worktree-force-remove.ts');

    expect(reaperForceRemoveArgs('/tmp/wt')).toEqual(['worktree', 'remove', '-f', '-f', '/tmp/wt']);
  });

  it('names the reaper and the pid check in its own documentation', () => {
    const source = readFileSync(FORCE_REMOVE, 'utf8');

    expect(source).toContain('KAR-07.8');
    expect(source).toMatch(/start time|start-time/i);
  });
});
