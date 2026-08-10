/**
 * KAR-15.3 test plan #4, #7, #9, #11 — the frame contract, the keepalive, the
 * global topic and the data plane, read off a real socket.
 *
 * Verifies: EPIC-15-S19, EPIC-15-S18, EPIC-15-S24, EPIC-15-S25 · AC3, AC4,
 * AC5, AC7, AC8, AC10, AC13, AC15
 *
 * Off the wire rather than through a client, deliberately. Every claim here is
 * about bytes — `id:` on every ledger frame, an *unnamed* event type, `data` on
 * one line, `retry: 2000` exactly once, a `: keepalive` **comment** rather than
 * a named frame — and an `EventSource` hides all five behind `onmessage`.
 *
 * The keepalive is driven by `TestClock`: a minute of Clock time in
 * milliseconds of real time, with no timer faked, so the socket's own I/O still
 * arrives while the clock is being advanced.
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, appendIoChunks, type EventDraft } from '@DeFlow/ledger';
import { it, TEST_DAEMON_TOKEN, TestClock } from '@DeFlow/testkit';
import { connect } from 'node:net';
import { afterEach, expect, describe as suite, vi } from 'vitest';
import { setDaemonAuth } from '../../src/http/auth.ts';
import type { LedgerView } from '../../src/http/ledger-view.ts';
import { resetStreamClock, setStreamClock } from '../../src/http/stream.ts';
import { API_VERSION } from '../../src/meta.ts';
import { setDaemonEpoch } from '../../src/runtime.ts';
import {
  EPOCH,
  helloOf,
  type OpenStream,
  openStream,
  type Served,
  serve,
  T0,
} from './support/stream-daemon.ts';

const RUN_A: RunId = RunIdSchema.parse('run_20260810T093000Z_aa0001');
const RUN_B: RunId = RunIdSchema.parse('run_20260810T093000Z_bb0002');

let served: Served | undefined;
const opened: OpenStream[] = [];
const drainTick = process.env.DeFlow_SSE_DRAIN_TICK_MS;

afterEach(async () => {
  for (const stream of opened.splice(0)) stream.close();
  if (drainTick === undefined) delete process.env.DeFlow_SSE_DRAIN_TICK_MS;
  else process.env.DeFlow_SSE_DRAIN_TICK_MS = drainTick;
  resetStreamClock();
  await served?.close();
  served = undefined;
});

async function open(query: string): Promise<OpenStream> {
  const stream = await openStream(served?.origin ?? '', query);
  opened.push(stream);
  expect(stream.response.status).toBe(200);
  return stream;
}

const draft = (runId: RunId, kind: string, v: number, payload: unknown): EventDraft =>
  ({ runId, ts: T0, kind, v, epoch: EPOCH, payload }) as EventDraft;

const progress = (runId: RunId, count: number): EventDraft[] =>
  Array.from({ length: count }, (_, index) =>
    draft(runId, 'node.progress', 1, {
      node: 'impl',
      attempt: 1,
      phase: 'running',
      message: `still working (${index})`,
    }),
  );

const humanRequested = (runId: RunId): EventDraft =>
  draft(runId, 'human.requested', 4, {
    node: 'approve-migration',
    prompt: 'The codemod changed 41 files. Proceed?',
    options: [{ id: 'yes', label: 'Proceed', effect: 'approve' }],
  });

const runCompleted = (runId: RunId): EventDraft =>
  draft(runId, 'run.completed', 1, { outcome: 'succeeded', criteriaSatisfied: [] });

suite('EPIC-15-S19 — the opening frames and the steady state (AC3, AC4, AC7)', () => {
  it('answers with exactly the documented headers and no compression', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    const headers = stream.response.headers;

    expect(headers.get('content-type')).toContain('text/event-stream');
    expect(headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(headers.get('x-accel-buffering')).toBe('no');
    expect(headers.get('x-DeFlow-api')).toBe(String(API_VERSION));
    expect(headers.get('vary')).toBe('Origin');
    // gzip buffers, and a buffered SSE stream arrives in clumps — a symptom
    // that reads as a backend scheduling bug and is not one.
    expect(headers.get('content-encoding')).toBeNull();
  });

  it('keeps Connection: keep-alive on the raw response, where fetch hides it', async ({ tmp }) => {
    served = await serve(tmp);
    const port = Number(new URL(served.origin).port);
    // `fetch` strips the hop-by-hop headers from what it exposes, so the only
    // way to assert one is to read the response head off the socket.
    const head = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `GET /api/stream?runs=${RUN_A}&since=0 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `Authorization: Bearer ${TEST_DAEMON_TOKEN}\r\nAccept: text/event-stream\r\n\r\n`,
        );
      });
      let text = '';
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(text.slice(0, text.indexOf('\r\n\r\n')));
        }
      });
      socket.on('error', reject);
    });

    expect(head.toLowerCase()).toContain('connection: keep-alive');
    expect(head.toLowerCase()).not.toContain('content-encoding');
  });

  it('opens with hello and writes retry: 2000 exactly once, right after it', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);

    const hello = await helloOf(stream.frames);
    expect(hello.streamId).toMatch(/[0-9a-f-]{36}/);
    expect(hello.apiVersion).toBe(API_VERSION);
    expect(hello.build).toBeTypeOf('string');
    expect(hello.daemonEpoch).toBe(EPOCH);
    expect(hello.headSeq).toBe(0);

    // Two frames, in this order, and the retry never repeated however long the
    // connection lives.
    appendEvents(served.db, [humanRequested(RUN_A)]);
    await stream.frames.until((frame) => frame.event === undefined);
    const raw = stream.frames.raw();
    expect(raw.indexOf('event: hello')).toBeLessThan(raw.indexOf('retry: 2000'));
    expect(raw.split('retry: 2000')).toHaveLength(2);
  });

  it('carries id: <seq> on every ledger frame, unnamed, one line of JSON', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    appendEvents(served.db, [
      ...progress(RUN_A, 3),
      // A payload carrying the one character that would split a naive frame.
      draft(RUN_A, 'node.progress', 1, {
        node: 'impl',
        attempt: 1,
        phase: 'running',
        message: 'a message with no newline but a quote " and a backslash \\',
      }),
    ]);

    await stream.frames.until(
      (frame) => frame.event === undefined && frame.data.includes('backslash'),
    );

    const ledgerFrames = stream.frames.all().filter((frame) => frame.event === undefined);
    expect(ledgerFrames).toHaveLength(4);
    for (const frame of ledgerFrames) {
      expect(frame.id).toBeDefined();
      const envelope = JSON.parse(frame.data) as { seq: number; runId: string; kind: string };
      expect(Number(frame.id)).toBe(envelope.seq);
      expect(envelope.runId).toBe(RUN_A);
    }

    // Not one `data:` line more than there are ledger frames plus control
    // frames: an envelope split across two lines would show up as more.
    const dataLines = stream.frames
      .raw()
      .split('\n')
      .filter((line) => line.startsWith('data:'));
    expect(dataLines).toHaveLength(stream.frames.frameCount());
  });

  it('holds an idle stream open for a minute and writes four keepalives (AC8)', async ({ tmp }) => {
    // The fallback re-drain is set to the keepalive cadence, so one advance is
    // one wake-up and the count is a fact rather than a race.
    process.env.DeFlow_SSE_DRAIN_TICK_MS = '15000';
    const clock = new TestClock(T0);
    setStreamClock(clock);
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    for (let minute = 1; minute <= 4; minute += 1) {
      // The handler has to be parked before the clock moves, or the advance
      // fires nothing and the assertion becomes a race.
      await vi.waitFor(() => expect(clock.pending).toBeGreaterThan(0));
      await clock.advance(15_000);
      await stream.frames.untilKeepalives(minute);
    }

    expect(stream.frames.keepalives()).toBe(4);
    expect(stream.frames.raw()).toContain(': keepalive\n\n');
    // Still open, and no keepalive was mistaken for an event.
    expect(stream.frames.ended()).toBe(false);
    expect(stream.frames.countByKind()).toEqual({});
  });
});

suite('EPIC-15-S18 — the global topic carries lifecycle and nothing else (AC10)', () => {
  it('delivers three lifecycle frames and none of 500 node.progress', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open('runs=*&since=0');
    await helloOf(stream.frames);

    appendEvents(served.db, [humanRequested(RUN_A)]);
    appendEvents(served.db, progress(RUN_B, 500));
    appendIoChunks(
      served.db,
      Array.from({ length: 300 }, (_, index) => ({
        runId: RUN_B,
        nodeId: 'impl',
        attempt: 1,
        stream: 'stdout' as const,
        ts: T0 + index,
        data: new TextEncoder().encode(`chunk ${index}\n`),
      })),
    );
    appendEvents(served.db, [runCompleted(RUN_B)]);

    await stream.frames.until(
      (frame) => frame.event === undefined && frame.data.includes('"run.completed"'),
    );

    const byKind = stream.frames.countByKind();
    expect(byKind['human.requested']).toBe(1);
    expect(byKind['run.completed']).toBe(1);
    expect(byKind['node.progress'] ?? 0).toBe(0);
    expect(Object.keys(byKind).toSorted()).toEqual(['human.requested', 'run.completed']);
  });
});

suite('EPIC-15-S24 — io_chunk is the data plane and never reaches this stream (AC13)', () => {
  it('writes no frame for 5 MB of agent stdout on a subscribed run', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    // 5 MB of stdout, recorded exactly as a node's output is: the data plane
    // stores bytes, never strings.
    const line = new TextEncoder().encode(`${'x'.repeat(5_000)}\n`);
    for (let batch = 0; batch < 10; batch += 1) {
      appendIoChunks(
        served.db,
        Array.from({ length: 100 }, (_, index) => ({
          runId: RUN_A,
          nodeId: 'impl',
          attempt: 1,
          stream: 'stdout' as const,
          ts: T0 + batch * 100 + index,
          data: line,
        })),
      );
    }
    // A control-plane event after all of it, as the marker that the drain has
    // been all the way through the noise.
    appendEvents(served.db, [runCompleted(RUN_A)]);

    await stream.frames.until(
      (frame) => frame.event === undefined && frame.data.includes('"run.completed"'),
    );

    expect(stream.frames.countByKind()).toEqual({ 'run.completed': 1 });
    expect(stream.frames.raw()).not.toContain('xxxxx');
  });
});

suite('EPIC-15-S25 — a fatal condition closes with event: fatal (AC15)', () => {
  it('closes with bad_token when the token is rotated under an open stream', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    const port = Number(new URL(served.origin).port);
    setDaemonAuth({
      token: 'a-rotated-token-not-the-one-this-client-holds',
      port,
      hostname: '127.0.0.1',
    });

    const fatal = await stream.frames.until((frame) => frame.event === 'fatal');
    const envelope = JSON.parse(fatal.data) as { error: { code: string; retryable: boolean } };
    expect(envelope.error.code).toBe('bad_token');
    // A stream never returns an error body mid-flight: the envelope arrives as
    // a frame, and then the connection goes.
    await stream.frames.untilEnd();
    expect(stream.frames.ended()).toBe(true);
  });

  it('closes with epoch_mismatch when the daemon epoch advances', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    setDaemonEpoch(EPOCH + 1);

    const fatal = await stream.frames.until((frame) => frame.event === 'fatal');
    expect((JSON.parse(fatal.data) as { error: { code: string } }).error.code).toBe(
      'epoch_mismatch',
    );
  });

  it('closes with a retryable internal on a transient read failure', async ({ tmp }) => {
    let failNext = false;
    served = await serve(tmp, {
      viewOf: (real): LedgerView => ({
        ...real,
        tail: (runId, afterSeq, limit) => {
          if (failNext) {
            failNext = false;
            throw new Error('SQLITE_IOERR: a transient read failure');
          }
          return real.tail(runId, afterSeq, limit);
        },
      }),
    });

    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);
    failNext = true;
    appendEvents(served.db, [humanRequested(RUN_A)]);

    const fatal = await stream.frames.until((frame) => frame.event === 'fatal');
    const envelope = JSON.parse(fatal.data) as { error: { code: string; retryable: boolean } };
    expect(envelope.error.code).toBe('internal');
    // The client keeps retrying for this one, which is why the envelope has to
    // say so rather than leave the client to hard-code a list.
    expect(envelope.error.retryable).toBe(true);
  });
});
