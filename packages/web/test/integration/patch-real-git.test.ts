/**
 * KAR-17.6 test plan row 2, at the level "a real `git diff`" actually lives at.
 *
 * Verifies: EPIC-17-S24 (scenario 1, the patch half) · AC1
 *
 * `../../src/lib/patch.test.ts` asserts the same parser against the **committed**
 * patch, which is fast and runs in the browser slice beside everything else it
 * feeds. This file spends a real subprocess to answer the question that fixture
 * cannot: *is the committed patch still what this machine's git writes?* A
 * fixture can go stale against a newer git — rename detection defaults, binary
 * delta encoding and the `similarity index` line have all moved before — and a
 * parser tested only against a frozen copy learns about it from a user.
 *
 * Real git into an `fs.mkdtemp` directory with `GIT_CONFIG_GLOBAL=/dev/null`
 * and `GIT_CONFIG_SYSTEM=/dev/null`, through the same builder the fixture is
 * written by, using the daemon's own `worktreePatch` flags.
 */
import { readFile } from 'node:fs/promises';
import { expect, it, describe as suite } from 'vitest';
import { buildReviewPatch, REVIEW_PATCH_FILE } from '../../scripts/build-diff-fixture.ts';
import { splitPatch } from '../../src/lib/patch.ts';

suite('KAR-17.6 — the parser against the git on this machine', () => {
  it('splits a patch git wrote just now into the same six files', async () => {
    const files = splitPatch(await buildReviewPatch());

    expect(files.map((file) => `${file.kind} ${file.path}`)).toEqual([
      'modified assets/logo.png',
      'modified src/api/contract.ts',
      'modified src/date-picker.ts',
      'deleted src/dead-code.ts',
      'renamed src/formatting.ts',
      'added test/days-until.test.ts',
    ]);
    expect(files.find((file) => file.path === 'assets/logo.png')?.binary).toBe(true);
    expect(files.find((file) => file.path === 'src/formatting.ts')?.oldPath).toBe(
      'src/legacy-format.ts',
    );
  });

  it('agrees with the committed fixture, byte for byte', async () => {
    // The fixture is not decoration: the browser slice cannot spawn git, so
    // every assertion over there is made against these bytes. When this fails,
    // rebuild it — `node packages/web/scripts/build-diff-fixture.ts` — and read
    // the diff, because a change here is a change in what the UI receives.
    const committed = await readFile(REVIEW_PATCH_FILE, 'utf8');

    expect(await buildReviewPatch()).toBe(committed);
  });
});
