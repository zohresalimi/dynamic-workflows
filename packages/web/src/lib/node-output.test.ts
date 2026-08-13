/**
 * KAR-17.5 test plan row 2 — the `/io` tail request builder, and the renderer
 * the chunks it brings back deserve.
 *
 * Verifies: EPIC-17-S20 (scenarios 1 and 4), EPIC-17-S21 (scenarios 1 and 3),
 * EPIC-17-S23 (scenario 3) · AC6, AC10
 *
 * The row's red is *"the client asks for the whole log"*, and that failure is
 * silent on a small run and fatal on a large one — the endpoint answers either
 * way. `fromSeq` **omitted** plus `limit` **set** is what the daemon reads as
 * "the tail" (`packages/daemon/src/http/api.ts`); paging forward from zero to
 * reach the end reads every row to answer *"what are the last few hundred
 * lines"*. So the assertion is on the absence of a key, not on its value: a
 * builder emitting `fromSeq: undefined` serialises to `?fromSeq=undefined`
 * through most query helpers, which the daemon parses as `0` and turns into the
 * whole-log read this row exists to prevent.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  IO_TAIL_CHUNKS,
  type IoChunkLine,
  ioFollowQuery,
  ioTailQuery,
  mergeIoChunks,
  NO_OUTPUT_AT_ALL,
  outputRendererFor,
  parseIoNdjson,
} from './node-output.ts';

const chunk = (over: Partial<ReturnType<typeof parseIoNdjson>[number]> = {}) => ({
  seq: 1,
  stream: 'stdout' as const,
  ts: 1_754_812_800_000,
  data: 'hello\r\n',
  ...over,
});

suite('KAR-17.5 row 2 — the tail request', () => {
  it('sets limit and omits fromSeq entirely, not as undefined', () => {
    const query = ioTailQuery();

    expect(Object.keys(query)).toEqual(['limit']);
    expect('fromSeq' in query).toBe(false);
    expect(query.limit).toBe(String(IO_TAIL_CHUNKS));
  });

  it('stays inside the endpoint’s own cap, so the clamp is never the thing that saves it', () => {
    // `READ_LIMITS.io` is { fallback: 500, cap: 2000 }. A client asking for
    // more is clamped rather than refused, which means an over-large ask is
    // invisible — the response just quietly is not what was requested.
    expect(IO_TAIL_CHUNKS).toBeGreaterThan(0);
    expect(IO_TAIL_CHUNKS).toBeLessThanOrEqual(2_000);

    expect(ioTailQuery(9_999).limit).toBe('2000');
    expect(ioTailQuery(0).limit).toBe(String(IO_TAIL_CHUNKS));
    expect(ioTailQuery(-1).limit).toBe(String(IO_TAIL_CHUNKS));
  });

  it('carries fromSeq only when following on from a cursor', () => {
    const follow = ioFollowQuery(88_120);

    expect(Object.keys(follow).toSorted()).toEqual(['fromSeq', 'limit']);
    expect(follow.fromSeq).toBe('88120');
    // `seq > fromSeq`, never `>=`: io_chunk.seq is AUTOINCREMENT and pruning
    // leaves permanent gaps, so a client resuming at `cursor + 1` skips a frame
    // the day one is pruned.
    expect(follow.fromSeq).not.toBe('88121');
  });
});

suite('KAR-17.5 — NDJSON in, chunks out', () => {
  it('parses one chunk per line and keeps the newlines that were inside them', () => {
    const body =
      `${JSON.stringify(chunk({ seq: 10, data: 'one\ntwo\n' }))}\n` +
      `${JSON.stringify(chunk({ seq: 11, stream: 'stderr', data: 'boom\n' }))}\n`;

    const parsed = parseIoNdjson(body);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.data).toBe('one\ntwo\n');
    expect(parsed[1]?.stream).toBe('stderr');
  });

  it('drops a torn trailing line rather than throwing mid-stream', () => {
    // The response is streamed and painted as it arrives, so the last line of
    // any given read is routinely half an object. A parser that threw would
    // take the panel down for a chunk boundary.
    const body = `${JSON.stringify(chunk({ seq: 10 }))}\n{"seq":11,"stream":"std`;

    expect(parseIoNdjson(body).map((one) => one.seq)).toEqual([10]);
  });
});

suite('EPIC-17-S21 — the right renderer for the right stream', () => {
  it('sends agent_json to the typed message list, because ACP updates are not a TTY', () => {
    expect(outputRendererFor([chunk({ stream: 'agent_json', data: '{}' })])).toBe('structured');
  });

  it('sends stdout and stderr to xterm, because that output really is ANSI', () => {
    expect(outputRendererFor([chunk({ stream: 'stdout' })])).toBe('terminal');
    expect(outputRendererFor([chunk({ stream: 'stderr' })])).toBe('terminal');
  });

  it('prefers the typed list when a shim node also logged raw frames', () => {
    // An ACP adapter's stderr carries the bridge's own diagnostics. One line of
    // those must not demote a whole typed transcript to a terminal.
    expect(
      outputRendererFor([
        chunk({ seq: 1, stream: 'stderr', data: 'bridge ready\n' }),
        chunk({ seq: 2, stream: 'agent_json', data: '{}' }),
      ]),
    ).toBe('structured');
  });

  it('reports emptiness as emptiness (AC10)', () => {
    expect(outputRendererFor([])).toBe('none');
    expect(NO_OUTPUT_AT_ALL).toMatch(/no output/i);
  });
});

suite('EPIC-19-S26 — a reconnect backfills with no gap and no duplicate (KAR-19.4 AC4)', () => {
  const at = (seq: number): IoChunkLine => chunk({ seq, data: `line ${String(seq)}\n` });

  it('appends what is new and keeps what was already on screen', () => {
    expect(mergeIoChunks([at(1), at(2)], [at(3), at(4)]).map((one) => one.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('drops a re-delivered chunk rather than painting it twice', () => {
    // The easy implementation of a reconnect re-fetches from zero, and on a
    // long node that duplicates everything already on screen — which is worse
    // than losing the connection, because the operator cannot tell which of the
    // two copies is the live one.
    const held = [at(1), at(2), at(3)];
    expect(mergeIoChunks(held, [at(2), at(3), at(4)]).map((one) => one.seq)).toEqual([1, 2, 3, 4]);
    expect(mergeIoChunks(held, held).map((one) => one.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the produced order even when a page arrives out of order', () => {
    expect(mergeIoChunks([at(5)], [at(2), at(9), at(7)]).map((one) => one.seq)).toEqual([
      2, 5, 7, 9,
    ]);
  });

  it('leaves a gap a gap: seqs are AUTOINCREMENT and pruning is permanent', () => {
    // `seq > fromSeq` is the cursor contract, so a missing 3 is a pruned row
    // rather than a frame to wait for. A merge that tried to close the hole
    // would be inventing output.
    expect(mergeIoChunks([at(1)], [at(2), at(4)]).map((one) => one.seq)).toEqual([1, 2, 4]);
  });

  it('follows on from the highest seq seen, never from that plus one', () => {
    const seen = mergeIoChunks([], [at(1), at(9)]);
    expect(ioFollowQuery(seen.at(-1)?.seq ?? 0).fromSeq).toBe('9');
  });
});
