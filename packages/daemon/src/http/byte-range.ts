/**
 * KAR-15.6 AC7 — `Range: bytes=…`, as RFC 9110 §14 defines it.
 *
 * An artifact is content-addressed, so a range over it is safe in a way a range
 * over a mutable resource is not: the bytes cannot change under a client that
 * is fetching them in pieces, which is the same property that makes
 * `Cache-Control: immutable` honest here.
 *
 * Three details that are easy to get wrong and invisible when you do:
 *
 * - **Both ends are inclusive.** `bytes=0-1023` is 1,024 bytes. An exclusive
 *   read is a file one byte short, which for a tarball or an image is a
 *   corrupt download rather than an error.
 * - **`bytes=-100` is a suffix**, meaning *the last hundred bytes*, not *from
 *   offset -100*. It is how a client reads the end of a log without knowing
 *   the length.
 * - **A range starting at or past the end is 416**, not an empty 206. A 206
 *   with nothing in it reads to a client as "this file is empty".
 *
 * Anything this daemon does not implement — a multi-range header, a unit other
 * than `bytes`, a malformed spec — is answered with the **whole** blob and a
 * 200, which RFC 9110 explicitly permits and which is always a correct answer.
 * The alternative, a partial response pretending to be the whole one, is not.
 */

/** What to do with a request, once the header has been read. */
export type ByteRange =
  | { readonly kind: 'whole' }
  | { readonly kind: 'unsatisfiable' }
  | {
      readonly kind: 'range';
      /** Inclusive. */
      readonly start: number;
      /** Inclusive. */
      readonly end: number;
      readonly length: number;
    };

const BYTES_PREFIX = 'bytes=';

/** A closed or open-ended range: `0-1023`, `2000-`. */
const CLOSED = /^(\d+)-(\d*)$/;
/** A suffix range: `-1024`. */
const SUFFIX = /^-(\d+)$/;

export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return { kind: 'whole' };

  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith(BYTES_PREFIX)) return { kind: 'whole' };

  const spec = trimmed.slice(BYTES_PREFIX.length).trim();
  // A multi-range request is legal and would need `multipart/byteranges`. The
  // whole representation is the correct simple answer, and the one a browser
  // handles without any of that machinery.
  if (spec === '' || spec.includes(',')) return { kind: 'whole' };

  const suffix = SUFFIX.exec(spec);
  if (suffix !== null) {
    const wanted = Number(suffix[1]);
    // `bytes=-0` asks for the last zero bytes, which is unsatisfiable by name.
    if (wanted === 0 || size === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - wanted);
    return { kind: 'range', start, end: size - 1, length: size - start };
  }

  const closed = CLOSED.exec(spec);
  if (closed === null) return { kind: 'whole' };

  const start = Number(closed[1]);
  if (start >= size) return { kind: 'unsatisfiable' };

  const rawEnd = closed[2];
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  // A backwards range is not a range. Serving the whole blob rather than
  // refusing keeps a confused client working.
  if (end < start) return { kind: 'whole' };

  return { kind: 'range', start, end, length: end - start + 1 };
}
