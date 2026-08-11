/**
 * KAR-17.6 test plan row 2 — splitting a unified patch into the files a review
 * surface lists.
 *
 * Verifies: EPIC-17-S24 (scenario 1, the patch half), EPIC-17-S26 · AC1, AC7
 *
 * `Red when: the parser was tested only on a synthetic patch.` So this one is
 * not. `../../../test/fixtures/diffs/review.patch` is the output of a real
 * `git diff --cached --no-color --no-ext-diff --binary` — the daemon's own
 * invocation, flag for flag — over a real repository, written by
 * `../../scripts/build-diff-fixture.ts`. A hand-authored patch has the parts
 * its author remembered and none of the parts they did not: `similarity index`,
 * `rename from` / `rename to` with no hunk at all, `deleted file mode`, and the
 * base85 `GIT binary patch` block that `--binary` emits and that shares no
 * structure with a text hunk.
 *
 * `../../test/integration/patch-real-git.test.ts` runs the same assertions
 * against a patch git writes *during that test run*, so a newer git that
 * changed its output does not sit undetected behind a committed fixture.
 */
import { expect, it, describe as suite } from 'vitest';
import reviewPatch from '../../../../test/fixtures/diffs/review.patch?raw';
import {
  COLLAPSE_ABOVE_CHANGED_LINES,
  isRenderablePatchFile,
  patchSides,
  splitPatch,
  synthesiseAddPatch,
} from './patch.ts';

const files = () => splitPatch(reviewPatch);
const at = (path: string) => files().find((file) => file.path === path);

suite('KAR-17.6 test 2 — a real git patch, split per file (AC1)', () => {
  it('finds every file the patch touches, and no phantom sixth', () => {
    expect(files().map((file) => file.path)).toEqual([
      'assets/logo.png',
      'src/api/contract.ts',
      'src/date-picker.ts',
      'src/dead-code.ts',
      'src/formatting.ts',
      'test/days-until.test.ts',
    ]);
  });

  it('classifies the modification, the addition and the deletion', () => {
    expect(at('src/date-picker.ts')?.kind).toBe('modified');
    expect(at('test/days-until.test.ts')?.kind).toBe('added');
    expect(at('src/dead-code.ts')?.kind).toBe('deleted');
  });

  it('reads a rename as a rename, with both names, and not as an add plus a delete', () => {
    const renamed = at('src/formatting.ts');

    expect(renamed?.kind).toBe('renamed');
    expect(renamed?.oldPath).toBe('src/legacy-format.ts');
    expect(renamed?.newPath).toBe('src/formatting.ts');
    // `similarity index 100%` — git emits no hunk at all for it, and a parser
    // that required one would drop the file from the list entirely.
    expect(renamed?.changedLines).toBe(0);
    expect(renamed?.binary).toBe(false);
  });

  it('marks the binary file binary rather than rendering base85 as source', () => {
    const binary = at('assets/logo.png');

    expect(binary?.binary).toBe(true);
    expect(binary?.kind).toBe('modified');
    // The `GIT binary patch` body is kept — it is what the patch says — but it
    // is never counted as changed lines, because it has none.
    expect(binary?.changedLines).toBe(0);
    expect(isRenderablePatchFile(binary)).toBe(false);
  });

  it('counts additions and deletions from the hunk body only', () => {
    const fix = at('src/date-picker.ts');

    // One line replaced. The `---` and `+++` header lines are not changes, and
    // a counter that included them reports every file as two lines busier.
    expect(fix?.additions).toBe(1);
    expect(fix?.deletions).toBe(1);
    expect(fix?.changedLines).toBe(2);

    const added = at('test/days-until.test.ts');
    expect(added?.additions).toBe(3);
    expect(added?.deletions).toBe(0);
  });

  it('keeps each file’s own section whole, header included, for the renderer', () => {
    const section = at('src/date-picker.ts')?.hunks[0] ?? '';

    expect(section.startsWith('diff --git a/src/date-picker.ts b/src/date-picker.ts')).toBe(true);
    expect(section).toContain('@@ -1,3 +1,3 @@');
    expect(section).toContain('+  return Math.round(target.getTime() / 86_400_000);');
    // One file's section never carries the next file's.
    expect(section).not.toContain('src/dead-code.ts');
  });

  it('carries the blob the finding was anchored to, so a line can be trusted', () => {
    // `gate-failure-repair`'s recorded finding names blob 6d1cddc4… at line 2,
    // and this patch's "before" side is that blob. The two fixtures are the
    // same file on purpose.
    expect(at('src/date-picker.ts')?.oldBlob).toBe('6d1cddc');
  });

  it('returns nothing at all for an empty patch, rather than one empty file', () => {
    expect(splitPatch('')).toEqual([]);
    expect(splitPatch('\n')).toEqual([]);
  });
});

suite('KAR-17.6 — the two sides a magic-move animates between (AC6)', () => {
  it('reconstructs the before and after of the changed region from the hunk', () => {
    const sides = patchSides(at('src/date-picker.ts') as never);

    expect(sides.before).toBe(
      'export function daysUntil(target: Date): number {\n  return target;\n}',
    );
    expect(sides.after).toBe(
      'export function daysUntil(target: Date): number {\n' +
        '  return Math.round(target.getTime() / 86_400_000);\n}',
    );
  });

  it('gives an added file an empty before rather than a copy of its after', () => {
    const sides = patchSides(at('test/days-until.test.ts') as never);

    expect(sides.before).toBe('');
    expect(sides.after).toContain('export const days: number = daysUntil(new Date());');
  });

  it('gives a binary file nothing to animate', () => {
    expect(patchSides(at('assets/logo.png') as never)).toEqual({ before: '', after: '' });
  });
});

suite('KAR-17.6 test 7 — a large file is collapsed before it is rendered (AC7)', () => {
  it('leaves an ordinary file expanded', () => {
    expect(at('src/date-picker.ts')?.collapsed).toBe(false);
  });

  it('collapses a file whose change is larger than the stated threshold', () => {
    const huge = splitPatch(synthesiseAddPatch('src/generated/schema.ts', 5_000))[0];

    expect(huge?.additions).toBe(5_000);
    expect(huge?.collapsed).toBe(true);
    expect(COLLAPSE_ABOVE_CHANGED_LINES).toBeLessThan(5_000);
  });

  it('states the threshold rather than leaving it to a magic number in a template', () => {
    const justUnder = splitPatch(
      synthesiseAddPatch('src/small.ts', COLLAPSE_ABOVE_CHANGED_LINES),
    )[0];
    const justOver = splitPatch(
      synthesiseAddPatch('src/big.ts', COLLAPSE_ABOVE_CHANGED_LINES + 1),
    )[0];

    expect(justUnder?.collapsed).toBe(false);
    expect(justOver?.collapsed).toBe(true);
  });
});
