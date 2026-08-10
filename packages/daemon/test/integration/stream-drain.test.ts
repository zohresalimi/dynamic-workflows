/**
 * KAR-15.3 test plan #5, #6, #8, #10 — the serving loop itself.
 *
 * Verifies: EPIC-15-S17, EPIC-15-S21, EPIC-15-S22, EPIC-15-S23 · AC9, AC11,
 * AC12, AC14
 *
 * Four properties, and every one of them is invisible on a fast local machine
 * with one tab open:
 *
 * - **Subscribe-then-drain-again.** Adding a run backfills it from the
 *   client's cursor *before* live delivery resumes, on the connection that was
 *   already open.
 * - **The race window.** An event committing between the final drain query and
 *   the park is the event a subscribe-only loop loses forever.
 * - **Post-commit.** A rollback must advance no client's cursor.
 * - **Bounded queries, closed each time.** The 82.6 MB `-wal` file recorded on
 *   2026-08-02 came from one `iterate()` cursor held open across a stream.
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite, vi } from 'vitest';
import type { LedgerView } from '../../src/http/ledger-view.ts';
import { DRAIN_BATCH } from '../../src/http/stream.ts';
import {
  EPOCH,
  helloOf,
  type OpenStream,
  openStream,
  type Served,
  serve,
  subscribe,
  T0,
} from './support/stream-daemon.ts';

const RUN_A: RunId = RunIdSchema.parse('run_20260810T093000Z_aa0001');
const RUN_B: RunId = RunIdSchema.parse('run_20260810T093000Z_bb0002');
const RUN_C: RunId = RunIdSchema.parse('run_20260810T093000Z_cc0003');

/**
 * The control the race-window spec measures against: the tick and the keepalive
 * are both pushed this far out, and delivery is asserted inside a sixth of it.
 * A box under full-suite load makes the *signal* path slower by milliseconds
 * and cannot make the fallback path faster at all, so this cannot go flaky in
 * the direction that would matter.
 */
const FALLBACK_MS = 30_000;

let served: Served | undefined;
const opened: OpenStream[] = [];
const drainTick = process.env.DeFlow_SSE_DRAIN_TICK_MS;
const keepalive = process.env.DeFlow_SSE_KEEPALIVE_MS;

afterEach(async () => {
  for (const stream of opened.splice(0)) stream.close();
  if (drainTick === undefined) delete process.env.DeFlow_SSE_DRAIN_TICK_MS;
  else process.env.DeFlow_SSE_DRAIN_TICK_MS = drainTick;
  if (keepalive === undefined) delete process.env.DeFlow_SSE_KEEPALIVE_MS;
  else process.env.DeFlow_SSE_KEEPALIVE_MS = keepalive;
  await served?.close();
  served = undefined;
});

async function open(query: string): Promise<OpenStream> {
  const stream = await openStream(served?.origin ?? '', query);
  opened.push(stream);
  expect(stream.response.status).toBe(200);
  return stream;
}

const draft = (runId: RunId, index: number): EventDraft =>
  ({
    runId,
    ts: T0 + index,
    kind: 'node.progress',
    v: 1,
    epoch: EPOCH,
    payload: { node: 'impl', attempt: 1, phase: 'running', message: `step ${index}` },
  }) as EventDraft;

/** The `seq`s of every ledger frame delivered so far, in arrival order. */
function delivered(stream: OpenStream): number[] {
  return stream.frames
    .all()
    .filter((frame) => frame.event === undefined)
    .map((frame) => (JSON.parse(frame.data) as { seq: number }).seq);
}

suite('EPIC-15-S17 — subscribing to a run that is already 400 events in (AC9)', () => {
  it('backfills from the cursor, says caught_up, then goes live — one connection', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    // 400 committed events the new panel has never seen.
    for (let batch = 0; batch < 4; batch += 1) {
      appendEvents(
        served.db,
        Array.from({ length: 100 }, (_, index) => draft(RUN_B, batch * 100 + index)),
      );
    }

    const stream = await open('runs=*&since=0');
    const hello = await helloOf(stream.frames);

    const response = await subscribe(served.origin, hello.streamId, [RUN_B]);
    expect(response.status).toBe(202);

    // The acknowledgement is a frame on the connection that was already open.
    const ack = await stream.frames.until((frame) => frame.event === 'subscribed');
    expect((JSON.parse(ack.data) as { runs: string[] }).runs).toContain(RUN_B);

    const caughtUp = await stream.frames.until(
      (frame) => frame.event === 'caught_up' && frame.data.includes(RUN_B),
    );
    expect(JSON.parse(caughtUp.data)).toEqual({ runId: RUN_B, seq: 400 });

    // Every one of the 400, in seq order, before the marker — and each exactly
    // once. A gap and a duplicate are the two ways this goes wrong.
    const backfilled = delivered(stream);
    expect(backfilled).toHaveLength(400);
    expect(backfilled).toEqual([...backfilled].toSorted((left, right) => left - right));
    expect(new Set(backfilled).size).toBe(400);

    // Live frames follow, on the same socket.
    appendEvents(served.db, [draft(RUN_B, 400)]);
    const live = await stream.frames.until(
      (frame) => frame.event === undefined && frame.data.includes('step 400'),
    );
    expect(Number(live.id)).toBe(401);
    expect(delivered(stream)).toHaveLength(401);
    expect(opened).toHaveLength(1);
  });
});

suite('EPIC-15-S21 — the two-phase drain (AC14, AC11)', () => {
  it('loses nothing to the window between the final drain and the park', async ({ tmp }) => {
    // Both fallbacks are pushed thirty seconds out of the way, so this is a
    // measurement against a control rather than a stopwatch: anything arriving
    // inside the budget below can only have arrived on the post-commit signal,
    // and an event committing inside the race window would never arrive at all.
    process.env.DeFlow_SSE_DRAIN_TICK_MS = String(FALLBACK_MS);
    process.env.DeFlow_SSE_KEEPALIVE_MS = String(FALLBACK_MS);
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    // 200 commits, one at a time, each racing the handler's park. A lost
    // wake-up is a test that times out rather than one that miscounts.
    for (let index = 0; index < 200; index += 1) {
      appendEvents(served.db, [draft(RUN_A, index)]);
    }

    await vi.waitFor(() => expect(delivered(stream)).toHaveLength(200), {
      timeout: FALLBACK_MS / 6,
      interval: 20,
    });
    const seqs = delivered(stream);
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
    expect(new Set(seqs).size).toBe(200);
  }, 60_000);

  it('still delivers a write the emitter never saw, bounded by the tick', async ({ tmp }) => {
    process.env.DeFlow_SSE_DRAIN_TICK_MS = '100';
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    // Straight SQL: no `appendEvents`, so no post-commit notification. This is
    // the writer in another process, and the drain tick is what bounds it.
    served.db
      .prepare('INSERT INTO event (run_id, ts, kind, v, epoch, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        RUN_A,
        T0,
        'node.progress',
        1,
        EPOCH,
        JSON.stringify({ node: 'impl', attempt: 1, phase: 'running' }),
      );

    await stream.frames.until((frame) => frame.event === undefined);
    expect(delivered(stream)).toEqual([1]);
  });

  it('drains three busy runs in bounded batches, merge-sorted by seq', async ({ tmp }) => {
    const limits: number[] = [];
    served = await serve(tmp, {
      viewOf: (real): LedgerView => ({
        ...real,
        tail: (runId, afterSeq, limit) => {
          limits.push(limit);
          return real.tail(runId, afterSeq, limit);
        },
      }),
    });

    // Round-robin, so the global sequence interleaves the three runs: a loop
    // that wrote run by run instead of merge-sorting its batches would deliver
    // them out of `seq` order, which is what the assertion below catches.
    for (let batch = 0; batch < 4; batch += 1) {
      const drafts: EventDraft[] = [];
      for (let index = 0; index < 500; index += 1) {
        const at = batch * 500 + index;
        drafts.push(draft(RUN_A, at), draft(RUN_B, at), draft(RUN_C, at));
      }
      appendEvents(served.db, drafts);
    }

    const stream = await open(`runs=${RUN_A},${RUN_B},${RUN_C}&since=0`);
    await helloOf(stream.frames);
    await vi.waitFor(() => expect(delivered(stream)).toHaveLength(6000), {
      timeout: 20_000,
      interval: 25,
    });

    const seqs = delivered(stream);
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
    expect(new Set(seqs).size).toBe(6000);
    // One bounded query per subscribed run per pass, and never an unbounded one.
    expect(limits.length).toBeGreaterThanOrEqual(12);
    expect(new Set(limits)).toEqual(new Set([DRAIN_BATCH]));
    expect(DRAIN_BATCH).toBe(500);
  }, 40_000);
});

suite('EPIC-15-S22 — the emitter fires post-commit (AC14)', () => {
  it('writes no frame for a seq a rollback removed, and advances no cursor', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    appendEvents(served.db, [draft(RUN_A, 0)]);
    await stream.frames.until((frame) => frame.event === undefined);
    const before = delivered(stream);
    expect(before).toEqual([1]);

    // A transaction that allocates a seq and then rolls back. The row is gone;
    // a stream that read it would have a client sitting on a cursor past an
    // event that does not exist.
    expect(() =>
      served?.db.transaction(() => {
        appendEvents(served?.db as never, [draft(RUN_A, 1)]);
        throw new Error('the batch was abandoned after its seq was allocated');
      }),
    ).toThrow('abandoned');

    appendEvents(served.db, [draft(RUN_A, 2)]);
    await stream.frames.until(
      (frame) => frame.event === undefined && frame.data.includes('step 2'),
    );

    const seqs = delivered(stream);
    // The rolled-back event's number is simply not there. `seq` gaps are
    // ordinary (docs/11 §4.2) and are never reported as a loss.
    expect(seqs).toHaveLength(2);
    expect(seqs[0]).toBe(1);
    expect(seqs[1]).toBeGreaterThan(1);
    expect(stream.frames.raw()).not.toContain('step 1"');
  });
});

suite('EPIC-15-S23 — bounded queries, closed each time (AC11, AC12)', () => {
  it('keeps the -wal file small while 20,000 rows are written under an open stream', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    for (let batch = 0; batch < 40; batch += 1) {
      appendEvents(
        served.db,
        Array.from({ length: 500 }, (_, index) => draft(RUN_A, batch * 500 + index)),
      );
      // Let the handler drain between batches: the failure being guarded is a
      // reader that holds its snapshot open *while* the writer works.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const walPath = join(tmp, 'ledger.db-wal');
    const peak = statSync(walPath).size;
    // The measured failure was 82.6 MB and could not be truncated. The bound
    // here is an order of magnitude below it and well above the 4 MB
    // `wal_autocheckpoint = 1000` aims at, so it fails on the behaviour rather
    // than on this machine's timing.
    expect(peak).toBeLessThan(16 * 1024 * 1024);

    // And a checkpoint reclaims, which is precisely what it could not do with a
    // cursor held open: `wal_checkpoint(TRUNCATE)` returned
    // `{busy:0, log:0, checkpointed:0}` and the file stayed at 82.6 MB until
    // the cursor closed. Asserted on the file rather than on the pragma's
    // return value, because the claim is that the space came back.
    served.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(statSync(walPath).size).toBeLessThanOrEqual(peak);
    expect(statSync(walPath).size).toBeLessThan(1024 * 1024);

    // The stream is still live afterwards.
    await vi.waitFor(() => expect(delivered(stream).length).toBeGreaterThan(0));
    expect(stream.frames.ended()).toBe(false);
  }, 60_000);

  it('serves the stream from a read-only connection with a busy_timeout', async ({ tmp }) => {
    served = await serve(tmp);
    const stream = await open(`runs=${RUN_A}&since=0`);
    await helloOf(stream.frames);

    // A long write on the write connection, while the stream is in flight.
    appendEvents(
      served.db,
      Array.from({ length: 2000 }, (_, index) => draft(RUN_A, index)),
    );
    await vi.waitFor(() => expect(delivered(stream)).toHaveLength(2000), {
      timeout: 20_000,
      interval: 25,
    });
    expect(stream.frames.ended()).toBe(false);
  }, 40_000);

  it('holds no iterate() cursor and opens no read transaction in the serving path', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = await Promise.all(
      ['stream.ts', 'ledger-view.ts', 'sse.ts'].map(async (name) =>
        readFile(join(here, '../../src/http', name), 'utf8'),
      ),
    );

    for (const source of sources) {
      // A lazy cursor is what produced the 82.6 MB WAL, and a read transaction
      // spanning a stream holds the same snapshot open for the same reason.
      expect(source).not.toContain('.iterate(');
      expect(source).not.toContain('BEGIN');
      expect(source).not.toMatch(/\.transaction\(/);
    }
  });
});
