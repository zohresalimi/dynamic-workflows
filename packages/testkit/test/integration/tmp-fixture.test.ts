/**
 * KAR-01.4 AC4 — the tmp fixture against a real directory.
 *
 * The two suites read as an odd shape until you see what they are doing: a
 * fixture's teardown runs between the test that used it and the next test in
 * the file, so the *next* test is the only place from which the teardown's
 * effect can be observed. Deliberately failing the first test (as the story's
 * test plan phrases it) would exercise exactly the same teardown while also
 * failing the run, so the assertion is made from the following test instead.
 *
 * Verifies: AC4
 */
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, describe as suite } from 'vitest';
import { it, KEEP_TMP_ENV } from '../../src/index.ts';

const withKeepTmp = (value: string | undefined) => {
  const previous = process.env[KEEP_TMP_ENV];
  if (value === undefined) delete process.env[KEEP_TMP_ENV];
  else process.env[KEEP_TMP_ENV] = value;
  return () => {
    if (previous === undefined) delete process.env[KEEP_TMP_ENV];
    else process.env[KEEP_TMP_ENV] = previous;
  };
};

suite('with DeFlow_KEEP_TMP set', () => {
  let restore = () => {};
  let kept = '';

  beforeAll(() => {
    restore = withKeepTmp('1');
  });
  afterAll(async () => {
    restore();
    await rm(kept, { recursive: true, force: true });
  });

  it('hands the test a fresh directory under the OS tmpdir, named DeFlow-*', async ({ tmp }) => {
    kept = tmp;
    expect(dirname(tmp)).toBe(tmpdir());
    expect(tmp.startsWith(join(tmpdir(), 'DeFlow-'))).toBe(true);
    await writeFile(join(tmp, 'evidence.txt'), 'a broken worktree worth looking at');
  });

  it('left the directory in place for the post-mortem', () => {
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(join(kept, 'evidence.txt'))).toBe(true);
  });
});

suite('with DeFlow_KEEP_TMP unset', () => {
  let restore = () => {};
  let removed = '';

  beforeAll(() => {
    restore = withKeepTmp(undefined);
  });
  afterAll(() => {
    restore();
  });

  it('hands the test a directory', async ({ tmp }) => {
    removed = tmp;
    await writeFile(join(tmp, 'evidence.txt'), 'nothing worth keeping');
  });

  it('removed it, contents and all, on teardown', () => {
    expect(existsSync(removed)).toBe(false);
  });
});

suite('two tests never share a directory', () => {
  const seen: string[] = [];

  it('first', ({ tmp }) => {
    seen.push(tmp);
  });

  it('second', ({ tmp }) => {
    seen.push(tmp);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
