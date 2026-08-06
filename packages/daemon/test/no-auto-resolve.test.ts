/**
 * KAR-07.7 — EPIC-07-S27's second scenario, as a repo-wide grep:
 * *"no code path merges with a strategy option that resolves conflicts
 * automatically"* (docs/09-workspace-and-safety.md §7.2).
 *
 * Adapted from generated-ref-call-sites.test.ts's pattern: walk every non-test
 * source file in @DeFlow/daemon and apply the pure matcher
 * (../src/workspace/auto-resolve-usage.ts, unit-tested directly in its own
 * `.test.ts`) to each one.
 *
 * This finds nothing today and is wired in so that it cannot start finding
 * nothing for the wrong reason: `-X ours` is the one-line "fix" that turns a
 * red conflict test green by discarding one agent's work silently, and the
 * only defence against it at 6pm is a test that says no.
 *
 * Verifies: EPIC-07-S27's second scenario · AC5.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { findAutoResolveStrategies } from '../src/workspace/auto-resolve-usage.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
// The analyzer itself, whose regex source text contains the very literals it
// looks for — excluded for the same reason generated-ref-call-sites.test.ts
// excludes its own matcher.
const EXCLUDED = new Set([join(SRC, 'workspace/auto-resolve-usage.ts')]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

suite('§7.2: nothing in the daemon can auto-resolve a merge conflict', () => {
  const files = sourceFiles(SRC).filter((path) => !EXCLUDED.has(path));

  it('found sources to check at all', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('includes the integration loop, which is where the temptation lives', () => {
    expect(files).toContain(join(SRC, 'workspace/integration-loop.ts'));
    expect(files).toContain(join(SRC, 'effects/reconcile/git.ts'));
  });

  it('no source file names a conflict-resolving merge strategy', () => {
    const offenders = files.flatMap((path) =>
      findAutoResolveStrategies(readFileSync(path, 'utf8')).map(
        (use) => `${path}:${use.line}: ${use.text}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
