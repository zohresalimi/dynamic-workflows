/**
 * KAR-11.5 AC1 — "A CI assertion proves no `DELETE FROM plan` exists"
 * (docs/06-planning-and-replanning.md §5).
 *
 * A behavioural test cannot make this claim: a suite that never calls a
 * pruning function proves nothing about whether one exists to be called from
 * somewhere the suite does not reach. This reads every package's production
 * source instead, the same shape `../../daemon/test/no-plan-extraction.test.ts`
 * already uses for KAR-11.1's absences.
 *
 * Verifies: EPIC-11-S26 (fourth scenario) · AC1
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Every production `.ts` file under any package's `src` directory, tests
 * excluded — the same walk `no-plan-extraction.test.ts` uses. */
function productionSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      files.push({ path: path.slice(repoRoot.length), text: readFileSync(path, 'utf8') });
    }
  };
  for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
    const src = join(repoRoot, 'packages', pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // A package without a src/ directory is not a gap.
    }
  }
  return files;
}

suite('AC1 — nothing prunes, compacts or garbage-collects the plan table', () => {
  const sources = productionSources();

  it('scans a non-trivial number of files', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('deletes from plan nowhere in any package’s production source', () => {
    const offenders = sources.filter(({ text }) => /DELETE\s+FROM\s+plan\b/i.test(text));
    expect(
      offenders.map(({ path }) => path),
      '06 §5: "so nobody is tempted to prune" — every plan version is retained for the ' +
        'life of the run, in both the plan table and plan/vN.json on disk',
    ).toEqual([]);
  });
});
