/**
 * KAR-15.6 AC4, AC11 — the `io_chunk` NDJSON framing.
 *
 * One chunk per line, `{seq, stream, ts, data}`, and `data` is text: the rows
 * are bytes, and a client writing them into xterm wants a string. The two
 * things that can go wrong are both invisible until a terminal renders wrongly:
 * a newline inside `data` that was not escaped (which turns one chunk into two
 * lines and desynchronises every reader after it), and a multi-byte character
 * split across two chunks by the pipe.
 *
 * AC11: this framing is **not** part of the versioned contract, and the module
 * says so in a constant the client module re-exports, so nobody builds a
 * persistence layer on it.
 *
 * Verifies: EPIC-15-S40 · AC4, AC11
 */
import type { StoredIoChunk } from '@DeFlow/ledger';
import { expect, it, describe as suite } from 'vitest';
import { IO_NDJSON_MEDIA_TYPE, IO_NDJSON_UNVERSIONED, ioChunkLine } from './io-ndjson.ts';

const chunk = (text: string, over: Partial<StoredIoChunk> = {}): StoredIoChunk =>
  ({
    seq: 88_120,
    runId: 'run_20260802T141133Z_9f2a1c',
    nodeId: 'n7',
    attempt: 1,
    stream: 'stdout',
    ts: 1_754_140_012_345,
    data: new TextEncoder().encode(text),
    ...over,
  }) as StoredIoChunk;

suite('the io_chunk NDJSON line (AC4)', () => {
  it('is one JSON object per line, in the documented shape', () => {
    const line = ioChunkLine(chunk('…42 tests passed\r\n'));

    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({
      seq: 88_120,
      stream: 'stdout',
      ts: 1_754_140_012_345,
      data: '…42 tests passed\r\n',
    });
  });

  it('escapes the newlines inside a chunk rather than emitting them', () => {
    // The failure this prevents: one chunk read back as three, with every
    // subsequent line attributed to the wrong seq.
    const line = ioChunkLine(chunk('one\ntwo\nthree\n'));

    expect(line.split('\n')).toHaveLength(2);
    expect((JSON.parse(line) as { data: string }).data).toBe('one\ntwo\nthree\n');
  });

  it('carries the stream so stderr is not rendered as stdout', () => {
    const line = ioChunkLine(chunk('boom', { stream: 'stderr' }));
    expect((JSON.parse(line) as { stream: string }).stream).toBe('stderr');
  });

  it('keeps invalid bytes as replacement characters rather than throwing', () => {
    // A pipe splits UTF-8 wherever the kernel felt like it, so a chunk really
    // can begin or end mid-character. A tail that threw would take the whole
    // response down for one broken byte.
    const line = ioChunkLine(chunk('', { data: new Uint8Array([0xe2, 0x82]) }));
    // One truncated sequence, one replacement character — and, crucially, a
    // line that still parses.
    expect((JSON.parse(line) as { data: string }).data).toBe('\uFFFD');
  });
});

suite('the framing is outside the versioned contract (AC11)', () => {
  it('says so, in a constant a client can render', () => {
    expect(IO_NDJSON_MEDIA_TYPE).toBe('application/x-ndjson');
    expect(IO_NDJSON_UNVERSIONED).toMatch(/not part of the versioned contract/i);
  });
});
