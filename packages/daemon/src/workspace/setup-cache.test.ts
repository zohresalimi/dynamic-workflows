/**
 * KAR-07.5 — the success marker's key (docs/09-workspace-and-safety.md §5.1
 * Layer 3; EPIC-07-S21).
 *
 * Keyed on **content**, which is the whole design: a timestamp marker calls a
 * lockfile that changed and changed back a miss, and a boolean marker calls a
 * lockfile that changed a hit. Both are wrong in the direction that costs an
 * agent turn.
 *
 * The concatenation is framed — `<path>\0<byteLength>\0<bytes>` per file, in
 * the order `setupCacheKey` declares — rather than a bare `Buffer.concat`.
 * Bare concatenation cannot tell `["a" -> "xy", "b" -> ""]` from
 * `["a" -> "x", "b" -> "y"]`, and the failure mode of that collision is a
 * skipped install on a repository whose dependencies did change.
 *
 * Verifies: EPIC-07-S21 · AC5
 */
import { Buffer } from 'node:buffer';
import { expect, it, describe as suite } from 'vitest';
import { markerFileName, setupCacheKey } from './setup-cache.ts';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

const lock = (contents: string) => [{ path: 'pnpm-lock.yaml', bytes: bytes(contents) }];

suite('the marker key is the sha256 of the setupCacheKey files (AC5)', () => {
  it('is a sha256- prefixed digest, the same shape every other hash in DeFlow has', () => {
    expect(setupCacheKey(lock('lockfileVersion: 9\n'))).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('is stable for the same contents', () => {
    expect(setupCacheKey(lock('same'))).toBe(setupCacheKey(lock('same')));
  });

  it('changes when the lockfile changes — touching it invalidates the marker', () => {
    expect(setupCacheKey(lock('before'))).not.toBe(setupCacheKey(lock('after')));
  });

  it('is a hit again when a lockfile changes and changes back', () => {
    const before = setupCacheKey(lock('original'));
    setupCacheKey(lock('edited'));

    expect(setupCacheKey(lock('original'))).toBe(before);
  });

  it('depends on the order the config declared, not on the filesystem', () => {
    const a = { path: 'a.lock', bytes: bytes('1') };
    const b = { path: 'b.lock', bytes: bytes('2') };

    expect(setupCacheKey([a, b])).not.toBe(setupCacheKey([b, a]));
  });

  it('does not collide when content moves across a file boundary', () => {
    const split = [
      { path: 'a', bytes: bytes('x') },
      { path: 'b', bytes: bytes('y') },
    ];
    const lopsided = [
      { path: 'a', bytes: bytes('xy') },
      { path: 'b', bytes: bytes('') },
    ];

    expect(setupCacheKey(split)).not.toBe(setupCacheKey(lopsided));
  });

  it('distinguishes a missing file from an empty one', () => {
    // A `setupCacheKey` naming a file that does not exist yet is normal — a
    // lockfile is created by the very install being cached — and "absent" must
    // not hash the same as "present and empty".
    expect(setupCacheKey([{ path: 'a', bytes: null }])).not.toBe(
      setupCacheKey([{ path: 'a', bytes: bytes('') }]),
    );
  });

  it('has a distinct key for an empty setupCacheKey list', () => {
    expect(setupCacheKey([])).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(setupCacheKey([])).not.toBe(setupCacheKey(lock('')));
  });
});

suite('the marker file the key names', () => {
  it('is the digest without its algorithm prefix, so it is a safe file name', () => {
    const key = setupCacheKey(lock('x'));

    expect(markerFileName(key)).toBe(key.slice('sha256-'.length));
    expect(markerFileName(key)).not.toContain('/');
  });

  it('refuses a key that is not a sha256 digest rather than writing it as a path', () => {
    expect(() => markerFileName('../../etc/passwd')).toThrow(/sha256/);
  });
});
