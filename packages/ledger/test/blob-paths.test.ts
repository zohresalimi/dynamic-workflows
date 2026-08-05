/**
 * KAR-03.9 — where a blob and its temp file live, as pure path arithmetic.
 *
 * The sibling-temp-file rule is the reason this is a test rather than a
 * comment. `rename(2)` is atomic only **within one filesystem**, so a temp file
 * in `os.tmpdir()` turns the atomic publish into a copy on any machine where
 * `/tmp` is a separate mount — and it does so silently, on someone else's
 * machine, months later. Two things are asserted: the derived temp path is a
 * sibling of its target, and `src/blobs.ts` contains no reference to a system
 * temp directory at all.
 *
 * The second is a source scan for the same reason `append-only.test.ts` is one:
 * it is a property of the *absence* of code, and a behavioural test can only
 * observe the temp file if it happens to look during the microseconds it
 * exists.
 *
 * Verifies: EPIC-03-S28 (scenario 4) · AC5
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { BLOB_DIR, blobPath, blobTempPath, EXCERPT_BYTES } from '../src/index.ts';

const SHA = 'a'.repeat(63) + 'b';
const DATA_DIR = '/var/data/DeFlow';

suite('blob paths (AC2, AC5)', () => {
  it('shards on the first two hex characters of the sha256', () => {
    expect(blobPath(DATA_DIR, SHA)).toBe(join(DATA_DIR, BLOB_DIR, 'aa', SHA));
  });

  it('puts the temp file in the same directory as its target', () => {
    const target = blobPath(DATA_DIR, SHA);
    expect(dirname(blobTempPath(DATA_DIR, SHA, 'ikey-1'))).toBe(dirname(target));
  });

  it('carries the ikey in the temp filename, so an orphan is attributable', () => {
    expect(blobTempPath(DATA_DIR, SHA, 'run-1/node-a/1/0')).toContain(
      'run-1/node-a/1/0'.replaceAll('/', '_'),
    );
    expect(blobTempPath(DATA_DIR, SHA, 'ikey-1').endsWith('.tmp')).toBe(true);
  });

  it('never derives a path under the system temp directory', () => {
    expect(blobTempPath(DATA_DIR, SHA, 'ikey-1').startsWith(tmpdir())).toBe(false);
  });

  it('excerpts two bounded ends, small enough that a descriptor cannot itself spill', () => {
    expect(EXCERPT_BYTES).toBe(2 * 1024);
  });
});

/**
 * The structural half of AC5: the module that writes blobs must not be able to
 * name a system temp directory, whatever a later refactor thinks it needs.
 */
suite('src/blobs.ts cannot reach os.tmpdir()', () => {
  const source = readFileSync(new URL('../src/blobs.ts', import.meta.url), 'utf8');
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

  it('imports nothing from node:os', () => {
    expect(code).not.toMatch(/from ['"]node:os['"]/);
  });

  it('mentions neither tmpdir() nor TMPDIR outside its prose', () => {
    expect(code).not.toMatch(/tmpdir/i);
    expect(code).not.toMatch(/TMPDIR/);
  });
});
