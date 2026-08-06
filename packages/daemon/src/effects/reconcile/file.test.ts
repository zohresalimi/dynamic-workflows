/**
 * KAR-06.4 — where the atomic write's temp file goes, and why it is not a
 * detail (docs/05-durable-execution.md §8.3).
 *
 * `rename` is atomic only **within one filesystem**. A temp file in
 * `os.tmpdir()` is on a different filesystem on a very ordinary Linux box, and
 * the rename silently degrades to copy-then-unlink — which is exactly the
 * non-atomic write the whole design is avoiding. "Move the temp files to the
 * temp directory" is a plausible-sounding tidy-up, so the property is asserted
 * rather than commented.
 *
 * A unit test, with an absolute target that is deliberately **not** under
 * `os.tmpdir()`: a fixture directory would be, and `expect(tmp).not.toMatch(
 * tmpdir())` would then be a test of the fixture rather than of the function.
 * The sibling property against a real file on disk is
 * `test/integration/reconcile-file.test.ts`.
 *
 * Verifies: EPIC-06-S14 · AC8
 */
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { TMP_SUFFIX, tmpPathFor } from './file.ts';

const IKEY_HASH = '9f2a1c4b7e01';

suite('tmpPathFor (EPIC-06-S14, AC8)', () => {
  it('is the target plus the ikey hash plus .tmp', () => {
    expect(tmpPathFor('/srv/project/dist/report.json', IKEY_HASH)).toBe(
      `/srv/project/dist/report.json.DeFlow-${IKEY_HASH}.tmp`,
    );
  });

  it('shares a directory with the target', () => {
    const target = '/srv/project/dist/report.json';
    expect(dirname(tmpPathFor(target, IKEY_HASH))).toBe(dirname(target));
  });

  it('never lands under os.tmpdir(), because rename is only atomic within a filesystem', () => {
    expect(tmpPathFor('/srv/project/dist/report.json', IKEY_HASH).startsWith(tmpdir())).toBe(false);
  });

  it('carries the ikey hash, so one target written by two effects has two temp files', () => {
    expect(tmpPathFor('/srv/a.txt', 'aaaaaaaaaaaa')).not.toBe(
      tmpPathFor('/srv/a.txt', 'bbbbbbbbbbbb'),
    );
  });

  it('ends in the suffix the orphan sweep globs for', () => {
    expect(tmpPathFor('/srv/a.txt', IKEY_HASH).endsWith(TMP_SUFFIX)).toBe(true);
  });

  it('refuses a hash that is not the 12 hex characters shortIkeyHash produces', () => {
    // The name is written by one daemon life and rebuilt by the next. A
    // caller passing the raw ikey — which contains `/` — would name a file in
    // a directory that does not exist, and the orphan would be invisible.
    expect(() => tmpPathFor('/srv/a.txt', 'run_x/implement/0/0')).toThrow(/hex/i);
    expect(() => tmpPathFor('/srv/a.txt', 'abc')).toThrow(/hex/i);
  });
});
