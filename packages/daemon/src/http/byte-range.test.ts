/**
 * KAR-15.6 AC7 — `Range: bytes=…` over a content-addressed artifact.
 *
 * Parsing lives here rather than in the route because every interesting case is
 * a boundary and none of them needs a socket: an open-ended range, a suffix
 * range (`bytes=-1024`, which means *the last 1024 bytes* and not *from -1024*),
 * a range that starts past the end (416, not an empty 206) and a multi-range
 * header, which this daemon answers whole rather than as `multipart/byteranges`.
 *
 * Verifies: EPIC-15-S41 · AC7 · test plan #6
 */
import { expect, it, describe as suite } from 'vitest';
import { parseByteRange } from './byte-range.ts';

const SIZE = 2048;

suite('parseByteRange (AC7)', () => {
  it('reads a closed range inclusively, as RFC 9110 defines it', () => {
    // `bytes=0-1023` is 1024 bytes, not 1023: both ends are inclusive, and the
    // off-by-one here is a truncated file rather than a test failure.
    expect(parseByteRange('bytes=0-1023', SIZE)).toEqual({
      kind: 'range',
      start: 0,
      end: 1023,
      length: 1024,
    });
  });

  it('reads an open-ended range as everything from the offset', () => {
    expect(parseByteRange('bytes=2000-', SIZE)).toEqual({
      kind: 'range',
      start: 2000,
      end: 2047,
      length: 48,
    });
  });

  it('reads a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({
      kind: 'range',
      start: 1948,
      end: 2047,
      length: 100,
    });
  });

  it('clamps an end past the last byte rather than refusing it', () => {
    expect(parseByteRange('bytes=1024-99999', SIZE)).toEqual({
      kind: 'range',
      start: 1024,
      end: 2047,
      length: 1024,
    });
    expect(parseByteRange('bytes=-99999', SIZE)).toEqual({
      kind: 'range',
      start: 0,
      end: 2047,
      length: 2048,
    });
  });

  it('reports a range that starts past the end as unsatisfiable', () => {
    expect(parseByteRange('bytes=2048-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('serves the whole blob for an absent, malformed or multi-range header', () => {
    // RFC 9110 permits ignoring a Range we do not support, and answering 200
    // with the whole representation is always correct. A partial answer to a
    // multi-range request that pretended to be the whole one would not be.
    expect(parseByteRange(undefined, SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('items=0-1', SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('bytes=abc-def', SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('bytes=', SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('bytes=100-0', SIZE)).toEqual({ kind: 'whole' });
  });

  it('treats a zero-length blob as having nothing satisfiable in it', () => {
    expect(parseByteRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange(undefined, 0)).toEqual({ kind: 'whole' });
  });
});
