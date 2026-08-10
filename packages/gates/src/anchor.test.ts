/**
 * KAR-12.3 AC6 — the anchor itself: the git object name of the content a
 * finding's range was read from.
 *
 * The equality that matters — that `gitBlobSha` agrees with `git hash-object`
 * on real bytes in a real repository — is asserted against real git in
 * ../test/integration/blob-anchor.test.ts. What is unit-testable here is the
 * algorithm and the anchoring pass over a set of findings.
 *
 * Verifies: EPIC-12-S23 (third scenario) · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { anchorFindings, gitBlobSha } from './anchor.ts';
import type { ParsedFinding } from './finding.ts';

const parsed = (file: string, rule = 'no-floating-promises'): ParsedFinding => ({
  id: `id-${file}-${rule}`,
  severity: 'error',
  file,
  rule,
  message: 'the returned promise is never awaited',
  range: { startLine: 42 },
});

suite('gitBlobSha', () => {
  it('is the sha1 of the git blob object, so it equals git hash-object', () => {
    // `printf '' | git hash-object --stdin` — the empty blob, the one git
    // object name every git user has seen.
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('hashes the bytes, not the text: content decides the name', () => {
    expect(gitBlobSha('hello\n')).toBe(gitBlobSha(Buffer.from('hello\n')));
    expect(gitBlobSha('hello\n')).not.toBe(gitBlobSha('hello'));
  });

  it('is 40 hex characters, which is what the schema will accept', () => {
    expect(gitBlobSha('const x = 1\n')).toMatch(/^[0-9a-f]{40}$/);
  });
});

suite('anchorFindings (AC6)', () => {
  it('stamps each finding with the blob of the file its range refers to', () => {
    const anchored = anchorFindings([parsed('src/a.ts'), parsed('src/b.ts')], (file) =>
      file === 'src/a.ts' ? 'a'.repeat(40) : 'b'.repeat(40),
    );

    expect(anchored.map((finding) => finding.blobSha)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('resolves each file once, however many findings name it', () => {
    const asked: string[] = [];
    anchorFindings([parsed('src/a.ts'), parsed('src/a.ts', 'ts2345')], (file) => {
      asked.push(file);
      return 'a'.repeat(40);
    });

    expect(asked).toEqual(['src/a.ts']);
  });

  it('keeps a finding whose file cannot be read, and leaves it unanchored', () => {
    // A tool reporting a path that no longer exists — a deleted file, or
    // `<stdin>` — has still reported something true. Dropping the finding
    // would hide it; inventing a blob would anchor it to bytes nobody read.
    const anchored = anchorFindings([parsed('gone.ts')], () => undefined);

    expect(anchored.length).toBe(1);
    expect(anchored[0]?.blobSha).toBeUndefined();
    expect(anchored[0]?.message).toContain('never awaited');
  });

  it('changes nothing else about the finding', () => {
    const one = parsed('src/a.ts');
    const [anchored] = anchorFindings([one], () => 'c'.repeat(40));

    expect(anchored).toEqual({ ...one, blobSha: 'c'.repeat(40) });
  });
});
