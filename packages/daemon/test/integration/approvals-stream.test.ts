/**
 * KAR-13.2 test plan #6, #9 — `runs=*` and filter mutation, over a real socket.
 *
 * The claim under test is the one that cannot be made in a unit test: a server
 * -side topic filter. A handler that materialised every row and then dropped
 * most of them would satisfy every in-process assertion and still drag the
 * firehose into an idle tab, which is the cost the whole design exists to
 * avoid — so the frames are counted **by kind, off the wire**, exactly as AC5
 * demands rather than by eyeballing a log.
 *
 * Verifies: EPIC-13-S12, EPIC-13-S16 · AC5, AC10
 */
import type { Db } from '@DeFlow/core';
import { openLedger } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import {
  appendProgress,
  EPOCH,
  GATE_NODE,
  RUN_A,
  RUN_B,
  seedRunB,
  T0,
} from './support/approval-queue-run.ts';
import { type Frames, readFrames } from './support/sse.ts';

/**
 * Every request this spec makes carries the daemon's bearer token (KAR-15.2).
 *
 * Assigned to a local `fetch` so the call sites below read the way they did
 * before the daemon authenticated anything — the token is a property of this
 * whole file, not a decision at each request.
 */
const fetch = authorizedFetch();

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

async function serve(dataDir: string): Promise<Served> {
  const db = openLedger(dataDir);
  const view = openLedgerView(dataDir);
  setLedgerView(view);
  setIntakePorts({
    db,
    epoch: EPOCH,
    clock: { now: () => T0, setTimer: () => ({ cancel: () => {} }) },
    dataDir,
    randomHex: () => 'aa0001',
  });
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    async close() {
      await started.close();
      clearLedgerView();
      clearIntakePorts();
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;
const sockets: AbortController[] = [];

afterEach(async () => {
  for (const controller of sockets.splice(0)) controller.abort();
  await served?.close();
  served = undefined;
});

/** Opens a stream and returns its frame reader, aborted in `afterEach`. */
async function open(origin: string, query: string): Promise<Frames> {
  const controller = new AbortController();
  sockets.push(controller);
  const response = await fetch(`${origin}/api/stream?${query}`, { signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return readFrames(response, controller.signal);
}

const humanRequested = (db: Db, runId: string, node: string): void => {
  db.prepare(
    'INSERT INTO event (run_id, ts, kind, v, epoch, payload) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    runId,
    T0,
    'human.requested',
    4,
    EPOCH,
    JSON.stringify({
      node,
      prompt: 'The codemod changed 41 files. Proceed?',
      options: [{ id: 'yes', label: 'Proceed', effect: 'approve' }],
    }),
  );
};

suite('EPIC-13-S12 — runs=* carries approvals without the firehose (AC5)', () => {
  it('delivers human.requested from any run and zero node.progress frames', async ({ tmp }) => {
    served = await serve(tmp);
    const { db, origin } = served;

    const frames = await open(origin, 'runs=*&since=0');
    await frames.until((frame) => frame.event === 'hello');

    // A noisy run streams beside the idle tab, and a *different* run asks for
    // a decision. Only the second is this topic's business.
    appendProgress(db, RUN_B, 40);
    humanRequested(db, RUN_A, GATE_NODE);
    appendProgress(db, RUN_B, 40);

    const delivered = await frames.until(
      (frame) => frame.event === undefined && frame.data.includes('"human.requested"'),
    );
    expect(Number(delivered.id)).toBeGreaterThan(0);
    expect((JSON.parse(delivered.data) as { runId: string }).runId).toBe(RUN_A);

    // Counted by kind, off the wire — not eyeballed.
    const byKind = frames.countByKind();
    expect(byKind['node.progress'] ?? 0).toBe(0);
    expect(byKind['human.requested']).toBe(1);
  });

  it('announces the four-kind membership of the global topic and nothing else', async ({ tmp }) => {
    served = await serve(tmp);
    const { db, origin } = served;

    const frames = await open(origin, 'runs=*&since=0');
    await frames.until((frame) => frame.event === 'caught_up');

    // One of each: two lifecycle kinds that belong to the topic, and two run
    // events that do not.
    seedRunB(db);
    humanRequested(db, RUN_A, GATE_NODE);

    await frames.until(
      (frame) => frame.event === undefined && frame.data.includes('"human.requested"'),
    );

    const byKind = frames.countByKind();
    expect(Object.keys(byKind).toSorted()).toEqual(['human.requested']);
    expect(byKind['budget.exceeded'] ?? 0).toBe(0);
    expect(byKind['run.paused'] ?? 0).toBe(0);
  });

  it('carries id: <seq> on every ledger frame, and none on a control frame', async ({ tmp }) => {
    served = await serve(tmp);
    const frames = await open(served.origin, 'runs=*&since=0');

    const hello = await frames.until((frame) => frame.event === 'hello');
    expect(hello.id).toBeUndefined();
    expect((JSON.parse(hello.data) as { streamId: string }).streamId).toMatch(/[0-9a-f-]{36}/);

    humanRequested(served.db, RUN_A, GATE_NODE);
    const ledger = await frames.until((frame) => frame.event === undefined);
    expect(Number(ledger.id)).toBe((JSON.parse(ledger.data) as { seq: number }).seq);
  });
});

suite('EPIC-13-S16 — a run panel opens on the connection the tab already has (AC10)', () => {
  it('mutates the filter over POST /stream/:id/subscribe, backfills, then goes live', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const { db, origin } = served;

    // History the new panel has never seen: it must arrive as a backfill.
    seedRunB(db);

    const frames = await open(origin, 'runs=*&since=0');
    const hello = await frames.until((frame) => frame.event === 'hello');
    const { streamId } = JSON.parse(hello.data) as { streamId: string };

    const subscribed = await fetch(`${origin}/api/stream/${streamId}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [RUN_B] }),
    });
    expect(subscribed.status).toBe(202);

    // The acknowledgement is a *frame*, on the connection that was already open.
    const ack = await frames.until((frame) => frame.event === 'subscribed');
    expect((JSON.parse(ack.data) as { runs: string[] }).runs).toContain(RUN_B);

    // Backfill first, then the marker that says live delivery resumes here.
    const backfilled = await frames.until(
      (frame) => frame.event === undefined && frame.data.includes('"budget.exceeded"'),
    );
    expect((JSON.parse(backfilled.data) as { runId: string }).runId).toBe(RUN_B);

    const caughtUp = await frames.until(
      (frame) => frame.event === 'caught_up' && frame.data.includes(RUN_B),
    );
    expect((JSON.parse(caughtUp.data) as { seq: number }).seq).toBeGreaterThan(0);

    // No reconnect, and no second socket: everything above arrived on one.
    expect(frames.frameCount()).toBeGreaterThan(0);
    expect(sockets).toHaveLength(1);
  });

  it('404s a filter mutation for a stream that is not open', async ({ tmp }) => {
    served = await serve(tmp);
    const response = await fetch(`${served.origin}/api/stream/not-a-stream/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [RUN_B] }),
    });
    expect(response.status).toBe(404);
  });
});
