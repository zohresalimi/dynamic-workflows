/**
 * KAR-15.3 test plan #1 and #2 — the topic filter and the frame serialiser.
 *
 * Verifies: EPIC-15-S19 (frame contract), EPIC-15-S18 (`runs=*` membership),
 * EPIC-15-S20 (control frames are named, ledger frames are not) · AC3, AC4,
 * AC5, AC10
 *
 * Both are pure and both are load-bearing. `parseRuns` is the *server-side*
 * topic filter: if `*` resolved to "everything" here and the four lifecycle
 * kinds were selected in the client, an idle tab would still pay for the
 * firehose, which is the entire cost the design exists to avoid. And the frame
 * serialiser is the wire contract — `id: <seq>` on every ledger frame, an
 * unnamed event type, and `data` on exactly one line — which is what makes
 * resume a single `WHERE seq > ?` and what keeps a control frame out of the
 * reducer.
 */
import { RunIdSchema } from '@DeFlow/core';
import type { StoredEvent } from '@DeFlow/ledger';
import { expect, it, describe as suite } from 'vitest';
import {
  controlFrame,
  GLOBAL_TOPIC,
  GLOBAL_TOPIC_KINDS,
  KEEPALIVE_FRAME,
  ledgerFrame,
  parseRuns,
  RETRY_FRAME,
} from './sse.ts';

const RUN_A = RunIdSchema.parse('run_20260810T093000Z_aa0001');
const RUN_B = RunIdSchema.parse('run_20260810T093000Z_bb0002');

const event = (overrides: Partial<StoredEvent> = {}): StoredEvent =>
  ({
    seq: 10_432,
    runId: RUN_A,
    ts: 1_754_140_000_000,
    kind: 'node.started',
    v: 1,
    epoch: 7,
    payload: { node: 'n-impl-3' },
    ...overrides,
  }) as StoredEvent;

suite('parseRuns — the filter is decided on the server (AC10)', () => {
  it('reads a comma-separated list as the runs it names', () => {
    const filter = parseRuns(`${RUN_A},${RUN_B}`);
    expect(filter.runs).toEqual([RUN_A, RUN_B]);
    expect(filter.global).toBe(false);
    // Nothing to filter by kind: a run subscription is every kind of that run.
    expect(filter.kinds).toEqual([]);
  });

  it('maps `*` to the four lifecycle kinds and to no run at all', () => {
    const filter = parseRuns(GLOBAL_TOPIC);
    expect(filter.global).toBe(true);
    expect(filter.runs).toEqual([]);
    expect(filter.kinds).toEqual([
      'run.created',
      'run.completed',
      'run.aborted',
      'human.requested',
    ]);
    expect(filter.kinds).toEqual(GLOBAL_TOPIC_KINDS);
  });

  it('does not admit node.progress or io_chunk into the global topic', () => {
    expect(GLOBAL_TOPIC_KINDS).not.toContain('node.progress');
    expect(GLOBAL_TOPIC_KINDS).not.toContain('io_chunk');
  });

  it('reads `*` beside run ids as both topics on one connection', () => {
    const filter = parseRuns(`${GLOBAL_TOPIC},${RUN_A}`);
    expect(filter.global).toBe(true);
    expect(filter.runs).toEqual([RUN_A]);
  });

  it('subscribes to nothing for an absent, empty or unparseable filter', () => {
    for (const query of [undefined, '', ' , ', 'not-a-run-id']) {
      const filter = parseRuns(query);
      expect(filter.global).toBe(false);
      expect(filter.runs).toEqual([]);
    }
  });

  it('drops a duplicate rather than draining the same run twice', () => {
    expect(parseRuns(`${RUN_A}, ${RUN_A}`).runs).toEqual([RUN_A]);
  });
});

suite('the frame serialiser (AC4)', () => {
  it('carries id: <seq>, no event name, and data on exactly one line', () => {
    const frame = ledgerFrame(event());
    expect(frame).toBe(`id: 10432\ndata: ${JSON.stringify(event())}\n\n`);
    expect(frame).not.toContain('event:');
    // One `data:` line, and the frame ends with the blank line that closes it.
    expect(frame.split('\n').filter((line) => line.startsWith('data:'))).toHaveLength(1);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('never splits an envelope across two data: lines, whatever it contains', () => {
    // A payload with the two characters that would break a naive serialiser:
    // a newline and a carriage return. `JSON.stringify` escapes both, and the
    // assertion is that nothing downstream un-escapes them.
    const frame = ledgerFrame(
      event({ payload: { message: 'line one\nline two\r\nline three', node: 'n_1' } }),
    );
    expect(frame.split('\n').filter((line) => line.startsWith('data:'))).toHaveLength(1);
    expect(frame.split('\n\n')).toHaveLength(2);
  });

  it('round-trips the full envelope, so a client parses one line of JSON', () => {
    const original = event({ nodeId: 'n-impl-3', attempt: 2 } as Partial<StoredEvent>);
    const data = ledgerFrame(original)
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    expect(JSON.parse(data ?? '')).toEqual(original);
  });

  it('names a control frame and gives it no id at all', () => {
    const frame = controlFrame('caught_up', { runId: RUN_A, seq: 400 });
    expect(frame).toBe(`event: caught_up\ndata: {"runId":"${RUN_A}","seq":400}\n\n`);
    // A control frame that set `id:` would poison `Last-Event-ID` with a number
    // from a sequence that is not the ledger's.
    expect(frame).not.toContain('id:');
  });

  it('writes retry: 2000 as its own frame, once', () => {
    expect(RETRY_FRAME).toBe('retry: 2000\n\n');
  });

  it('writes the keepalive as an SSE comment, which every client ignores', () => {
    expect(KEEPALIVE_FRAME).toBe(': keepalive\n\n');
    // A comment carries no field at all, so a reader cannot mistake it for an
    // event with an empty payload — and it costs the 13 bytes docs/11 §3.2
    // rule 3 rounds to a dozen.
    expect(new TextEncoder().encode(KEEPALIVE_FRAME)).toHaveLength(13);
  });
});
