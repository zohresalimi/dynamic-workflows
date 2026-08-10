/**
 * KAR-15.4 test plan #4, #5 and #9 — both resume paths and the epoch skew, read
 * off a real socket over a real file-backed ledger.
 *
 * Verifies: EPIC-15-S26, EPIC-15-S27, EPIC-15-S28 (the head half),
 * EPIC-15-S32 · AC1, AC2, AC3, AC7
 *
 * Off the wire rather than through a client, because the header path is the
 * *browser's* mechanism and no client of ours ever sends it: `Last-Event-ID` is
 * what a native `EventSource` reconnect carries, and the only honest way to
 * exercise it is to send the header ourselves. The `?since=` path is the one
 * DeFlow's own client and CLI use, and both must land on the same rows.
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { afterEach, expect, describe as suite } from 'vitest';
import { setDaemonEpoch } from '../../src/runtime.ts';
import {
  EPOCH,
  fetch,
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

afterEach(async () => {
  for (const stream of opened.splice(0)) stream.close();
  setDaemonEpoch(EPOCH);
  await served?.close();
  served = undefined;
});

async function open(query: string, init: RequestInit = {}): Promise<OpenStream> {
  const stream = await openStream(served?.origin ?? '', query, init);
  opened.push(stream);
  expect(stream.response.status).toBe(200);
  return stream;
}

const progress = (runId: RunId, count: number, from = 0): EventDraft[] =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        runId,
        ts: T0 + from + index,
        kind: 'node.progress',
        v: 1,
        epoch: EPOCH,
        payload: { node: 'impl', attempt: 1, phase: 'running', message: `step ${from + index}` },
      }) as EventDraft,
  );

/** The `seq`s of the ledger frames this stream has delivered, in arrival order. */
function delivered(stream: OpenStream): number[] {
  return stream.frames
    .all()
    .filter((frame) => frame.event === undefined)
    .map((frame) => (JSON.parse(frame.data) as { seq: number }).seq);
}

suite('EPIC-15-S26 — resume by Last-Event-ID, the browser’s own reconnect (AC1)', () => {
  it('delivers every event after the header’s seq, exactly once, in order', async ({ tmp }) => {
    served = await serve(tmp);
    // The events this client already applied before its socket died, and the
    // ones that committed while it was down.
    const applied = appendEvents(served.db, progress(RUN_A, 10));
    const lastApplied = applied.at(-1) ?? 0;
    const later = appendEvents(served.db, progress(RUN_A, 40, 10));

    const stream = await open(`runs=${RUN_A}`, {
      headers: { 'Last-Event-ID': String(lastApplied) },
    });
    await helloOf(stream.frames);
    await stream.frames.until((frame) => frame.event === 'caught_up');

    expect(delivered(stream)).toEqual([...later]);
    expect(delivered(stream)).toHaveLength(40);
    // Exactly once: no `seq` twice, and nothing at or below the cursor.
    expect(new Set(delivered(stream)).size).toBe(40);
    expect(Math.min(...delivered(stream))).toBeGreaterThan(lastApplied);
  });
});

suite('EPIC-15-S27 — resume by ?since=, the page-reload path (AC2)', () => {
  it('resumes identically with no Last-Event-ID header at all', async ({ tmp }) => {
    served = await serve(tmp);
    const applied = appendEvents(served.db, progress(RUN_A, 10));
    const cursor = applied.at(-1) ?? 0;
    const later = appendEvents(served.db, progress(RUN_A, 40, 10));

    const stream = await open(`runs=${RUN_A}&since=${cursor}`);
    await helloOf(stream.frames);
    await stream.frames.until((frame) => frame.event === 'caught_up');

    expect(delivered(stream)).toEqual([...later]);
  });

  it('misses nothing committed while the daemon was down', async ({ tmp }) => {
    // The third case of §4.1, and the common one in development: the tab's
    // first connection never opened, so the browser has no cursor to send —
    // only the client's own persisted one exists.
    served = await serve(tmp);
    const before = appendEvents(served.db, progress(RUN_A, 5));
    const cursor = before.at(-1) ?? 0;
    await served.close();

    // A second daemon life over the same directory, with events appended while
    // no daemon was serving them.
    served = await serve(tmp);
    const whileDown = appendEvents(served.db, progress(RUN_A, 7, 5));

    const stream = await open(`runs=${RUN_A}&since=${cursor}`);
    await helloOf(stream.frames);
    await stream.frames.until((frame) => frame.event === 'caught_up');

    expect(delivered(stream)).toEqual([...whileDown]);
  });
});

suite('EPIC-15-S28 — a request carrying neither cursor starts at head (AC3)', () => {
  it('announces the head it started from and replays nothing before it', async ({ tmp }) => {
    served = await serve(tmp);
    appendEvents(served.db, progress(RUN_A, 12));
    const head = served.view.headSeq();

    const stream = await open(`runs=${RUN_A}`);
    const hello = await helloOf(stream.frames);
    // What it skipped, stated: a client that wanted the history now knows the
    // number to hydrate up to rather than having to guess it.
    expect(hello.headSeq).toBe(head);

    await stream.frames.until((frame) => frame.event === 'caught_up');
    expect(delivered(stream)).toEqual([]);

    // And live delivery continues from there, so "head" is a starting point
    // rather than a subscription that never fires.
    const next = appendEvents(served.db, progress(RUN_A, 1, 12));
    await stream.frames.until((frame) => frame.event === undefined);
    expect(delivered(stream)).toEqual([next[0]]);
  });

  it('prefers ?since= over a disagreeing Last-Event-ID', async ({ tmp }) => {
    served = await serve(tmp);
    const events = appendEvents(served.db, progress(RUN_A, 6));
    const since = events[1] ?? 0;
    const header = events[4] ?? 0;

    const stream = await open(`runs=${RUN_A}&since=${since}`, {
      headers: { 'Last-Event-ID': String(header) },
    });
    await helloOf(stream.frames);
    await stream.frames.until((frame) => frame.event === 'caught_up');

    expect(delivered(stream)).toEqual(events.slice(2));
  });

  it('honours since=0 rather than treating the zero as absent', async ({ tmp }) => {
    served = await serve(tmp);
    const events = appendEvents(served.db, progress(RUN_A, 4));

    const stream = await open(`runs=${RUN_A}&since=0`, {
      headers: { 'Last-Event-ID': String(events.at(-1) ?? 0) },
    });
    await helloOf(stream.frames);
    await stream.frames.until((frame) => frame.event === 'caught_up');

    expect(delivered(stream)).toEqual([...events]);
  });

  it('starts a global-topic connection at head too, not at zero', async ({ tmp }) => {
    served = await serve(tmp);
    appendEvents(served.db, [
      {
        runId: RUN_B,
        ts: T0,
        kind: 'run.created',
        v: 1,
        epoch: EPOCH,
        payload: { input: { kind: 'text', text: 'ship it' }, cwd: '/tmp/repo' },
      } as EventDraft,
    ]);

    const stream = await open('runs=*');
    await helloOf(stream.frames);
    await stream.frames.until((frame) => frame.event === 'caught_up');
    expect(delivered(stream)).toEqual([]);
  });
});

suite('EPIC-15-S32 — the daemon restarted under the tab (AC7)', () => {
  it('carries a different daemonEpoch on the next hello', async ({ tmp }) => {
    served = await serve(tmp);
    const first = await open(`runs=${RUN_A}&since=0`);
    const before = await helloOf(first.frames);
    expect(before.daemonEpoch).toBe(EPOCH);
    first.close();

    // A restart, as the ledger sees one: a new daemon life takes the next
    // epoch. The tab detects the restart from that difference alone.
    setDaemonEpoch(EPOCH + 1);
    const second = await open(`runs=${RUN_A}&since=0`);
    const after = await helloOf(second.frames);
    expect(after.daemonEpoch).toBe(EPOCH + 1);
    expect(after.daemonEpoch).not.toBe(before.daemonEpoch);
  });

  it('refuses a write stamped with a superseded epoch: 409 epoch_mismatch', async ({ tmp }) => {
    served = await serve(tmp);
    setDaemonEpoch(EPOCH + 1);

    const response = await fetch(`${served.origin}/api/runs/${RUN_A}/spec/approve`, {
      method: 'POST',
      headers: { 'X-DeFlow-Epoch': String(EPOCH) },
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; retryable: boolean; detail?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('epoch_mismatch');
    // Not retryable: the daemon this decision was made against is gone, and
    // repeating the request would apply it to a world the caller has not seen.
    expect(body.error.retryable).toBe(false);
    expect(body.error.detail).toMatchObject({ presented: EPOCH, current: EPOCH + 1 });
  });

  it('lets a write carrying the current epoch through the guard', async ({ tmp }) => {
    served = await serve(tmp);
    const response = await fetch(`${served.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-DeFlow-Epoch': String(EPOCH) },
      body: JSON.stringify({}),
    });
    // 400 rather than 409: the guard passed and the route itself answered
    // about a body it cannot use, which is the point.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_request',
    );
  });

  it('ignores a write that stamps no epoch at all', async ({ tmp }) => {
    // The header is an assertion a caller may make, not one it must: `DeFlow
    // run` from a fresh shell has never seen a `hello` frame and has no epoch
    // to name. Only a caller that claims one is held to it.
    served = await serve(tmp);
    setDaemonEpoch(EPOCH + 1);
    const response = await fetch(`${served.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('leaves a read alone: a stale epoch on a GET is not a write', async ({ tmp }) => {
    served = await serve(tmp);
    setDaemonEpoch(EPOCH + 1);
    const response = await fetch(`${served.origin}/api/health`, {
      headers: { 'X-DeFlow-Epoch': String(EPOCH) },
    });
    expect(response.status).toBe(200);
  });
});
