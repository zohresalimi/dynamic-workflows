/**
 * KAR-18.1 test plan #1 (unit) — the `.gitignore` merge function appends only
 * missing lines, preserves a file with no trailing newline, and is a
 * fixpoint on second application.
 *
 * Verifies: EPIC-18-S4 · AC1, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { GITIGNORE_ENTRIES, mergeGitignore } from './gitignore-merge.ts';

suite('mergeGitignore', () => {
  it('appends every entry to an absent .gitignore', () => {
    const result = mergeGitignore(undefined);
    expect(result.added).toEqual([...GITIGNORE_ENTRIES]);
    expect(result.content).toBe(`${GITIGNORE_ENTRIES.join('\n')}\n`);
  });

  it('is a fixpoint on second application: nothing added, content unchanged', () => {
    const first = mergeGitignore(undefined);
    const second = mergeGitignore(first.content);
    expect(second.added).toEqual([]);
    expect(second.content).toBe(first.content);
    for (const entry of GITIGNORE_ENTRIES) {
      expect(second.content.split('\n').filter((line) => line === entry)).toHaveLength(1);
    }
  });

  it('preserves a file with no trailing newline instead of concatenating onto its last line', () => {
    const result = mergeGitignore('node_modules/');
    expect(result.content.split('\n')).toContain('node_modules/');
    expect(result.content).not.toContain('node_modules/.DeFlow');
    expect(result.content.startsWith('node_modules/\n')).toBe(true);
  });

  it('adds only the entries a partially-populated file is missing', () => {
    const result = mergeGitignore('node_modules/\n.DeFlow/wt/\n');
    expect(result.added).toEqual(['.DeFlow/daemon.json', '.DeFlow/runs/']);
    expect(result.content.split('\n').filter((line) => line === '.DeFlow/wt/')).toHaveLength(1);
    expect(
      result.content.split('\n').filter((line) => line === '.DeFlow/daemon.json'),
    ).toHaveLength(1);
  });

  it('is a no-op when every entry is already present, with no trailing newline on the input', () => {
    const withAll = GITIGNORE_ENTRIES.join('\n'); // deliberately no trailing newline
    const result = mergeGitignore(withAll);
    expect(result.added).toEqual([]);
    expect(result.content).toBe(withAll);
  });
});
