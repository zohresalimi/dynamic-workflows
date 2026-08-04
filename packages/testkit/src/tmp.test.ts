/**
 * KAR-01.4 AC4 — the one decision the tmp fixture's teardown makes.
 *
 * The fixture itself is exercised against a real directory in
 * ../test/integration/tmp-fixture.test.ts; this is the predicate on its own, so
 * the "only when DeFlow_KEEP_TMP is unset" wording has a test of its own rather
 * than being inferred from a directory that happened to survive.
 *
 * Verifies: AC4
 */
import { describe as suite, expect, it } from 'vitest';
import { KEEP_TMP_ENV, shouldRemoveTempDir, TMP_PREFIX } from './tmp.ts';

suite('shouldRemoveTempDir', () => {
  it('removes when the variable is unset', () => {
    expect(shouldRemoveTempDir({})).toBe(true);
  });

  it('keeps when the variable is set to anything at all', () => {
    expect(shouldRemoveTempDir({ [KEEP_TMP_ENV]: '1' })).toBe(false);
    expect(shouldRemoveTempDir({ [KEEP_TMP_ENV]: '0' })).toBe(false);
    // Set-but-empty counts as set: the acceptance criterion is worded "only
    // when DeFlow_KEEP_TMP is unset", and someone who exported it at all is
    // asking to inspect the directory.
    expect(shouldRemoveTempDir({ [KEEP_TMP_ENV]: '' })).toBe(false);
  });

  it('names the directories after the tool, so CI can glob them', () => {
    expect(TMP_PREFIX).toBe('DeFlow-');
  });
});
