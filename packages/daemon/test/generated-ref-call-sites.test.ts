/**
 * KAR-07.3 AC6 — "every call site that passes a generated name to git uses
 * either a `--` separator or the `--branch=<value>` long form; a lint or grep
 * check enforces it" (docs/09-workspace-and-safety.md §2.1).
 *
 * Adapted from spawn-chokepoint.test.ts's pattern: walk every non-test source
 * file in @DeFlow/daemon and apply the pure matcher
 * (../src/git/generated-ref-usage.ts, unit-tested directly in its own
 * `.test.ts`) to each one. No call site in this package forwards
 * `nodeBranch(`/`integrationBranch(`'s result into git today — KAR-07.2,
 * KAR-07.6 and KAR-07.7 are what will add them — so this currently finds
 * nothing, and stays wired in so the day one of those stories adds an
 * unguarded call site, this test is what turns red.
 *
 * Verifies: EPIC-07-S8's third scenario · KAR-07.3 AC6.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { findUnguardedGeneratedRefCalls } from '../src/git/generated-ref-usage.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
// Where nodeBranch/integrationBranch are *defined* (their declarations match
// the same regex as a call would), and the analyzer module itself (whose
// regex source text contains the literal strings "nodeBranch(" /
// "integrationBranch(") — both excluded for the same reason
// spawn-chokepoint.test.ts excludes its own chokepoint file: checking a
// definition against "is this a guarded call" is not what AC6 asks for.
const EXCLUDED = new Set(
  ['git/branch-name.ts', 'git/generated-ref-usage.ts'].map((rel) => join(SRC, rel)),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

suite('AC6: generated branch names never reach git in a bare positional slot', () => {
  const files = sourceFiles(SRC).filter((path) => !EXCLUDED.has(path));

  it('found sources to check at all', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no source file has an unguarded nodeBranch(/integrationBranch( call', () => {
    const offenders = files.flatMap((path) =>
      findUnguardedGeneratedRefCalls(readFileSync(path, 'utf8')).map(
        (call) => `${path}:${call.line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
