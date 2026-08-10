/**
 * KAR-15.6 AC4, AC11 — the `io_chunk` tail format.
 *
 * One JSON object per line, `{seq, stream, ts, data}`, `application/x-ndjson`.
 * A terminal reattach then *streams*: the client parses and paints each line as
 * it arrives instead of waiting for a JSON array to close, which is the whole
 * reason this endpoint is not `application/json`.
 *
 * `JSON.stringify` is what makes a line a line. A chunk's bytes routinely
 * contain newlines — that is what agent output is — and emitting them raw would
 * turn one chunk into three lines, desynchronise every reader after it, and
 * attribute output to the wrong `seq`. The escaping is not cosmetic.
 *
 * Decoding is lossy **on purpose**: a pipe splits UTF-8 wherever the kernel
 * felt like it, so a chunk can begin or end mid-character, and `TextDecoder`'s
 * replacement character is the right answer to that. A decoder that threw would
 * take a whole response down for one broken byte in the middle of a 200 MB log.
 *
 * ## AC11 — this framing is not part of the versioned contract
 *
 * It is a tail format and it may change. `IO_NDJSON_UNVERSIONED` is that
 * sentence as a value, re-exported by the client module and rendered in the
 * emitted schema, so nobody builds a persistence layer on the shape of these
 * lines. The archive that *is* stable is the file on disk at
 * `runs/<runId>/nodes/<nodeId>/stdout.log`.
 */
import type { StoredIoChunk } from '@DeFlow/ledger';

export const IO_NDJSON_MEDIA_TYPE = 'application/x-ndjson';

/** AC11's marker, in the words the schema and the client types carry. */
export const IO_NDJSON_UNVERSIONED =
  'The io_chunk NDJSON framing is not part of the versioned contract: it is a ' +
  'tail format for reattaching a terminal and may change without an apiVersion ' +
  'bump. The stable archive is runs/<runId>/nodes/<nodeId>/stdout.log.';

/** One `io_chunk` as it goes on the wire. */
export interface IoChunkLine {
  readonly seq: number;
  readonly stream: string;
  readonly ts: number;
  readonly data: string;
}

// `fatal: false` is the default and is stated anyway: it is the difference
// between a replacement character and a thrown TypeError halfway through a
// response whose headers have already been sent.
const decoder = new TextDecoder('utf-8', { fatal: false });

export function ioChunkLine(chunk: StoredIoChunk): string {
  const line: IoChunkLine = {
    seq: chunk.seq,
    stream: chunk.stream,
    ts: chunk.ts,
    data: decoder.decode(chunk.data),
  };
  return `${JSON.stringify(line)}\n`;
}
