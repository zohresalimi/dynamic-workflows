/**
 * KAR-15.3 test plan #12 — the connection budget, in a real browser.
 *
 * Verifies: EPIC-15-S15, EPIC-15-S16 · AC1, AC2
 *
 * These two are the reason [11 §2](docs/11-api-and-realtime.md) opens by calling
 * the multiplexed stream *"an architecture constraint, not a tuning knob"*, and
 * they are the two claims in this story that **cannot** be made anywhere but in
 * a browser. Chrome caps concurrent HTTP/1.1 connections per origin at six; an
 * SSE connection never closes; a page that opens one per run panel therefore
 * runs out, and what happens next is not an error. Every subsequent `fetch`
 * from that origin queues behind the streams, forever, and the symptom presents
 * as *"the daemon hung"* against a perfectly healthy daemon.
 *
 * That is why the failure is demonstrated here rather than described in a
 * comment: nobody believes it until they watch a `fetch` sit there.
 *
 * The origin is a real `node:http` server on a port of its own — see
 * `../../test/sse-origin.ts` for what is real about it, what is not, and where
 * the frame contract is actually asserted (against a real DeFlowd, at
 * integration level, which is the right place for bytes).
 */
import { afterEach, expect, inject, it, describe as suite, vi } from 'vitest';
import { openStreamHub, type StreamHub } from './multiplex.ts';
import { connectStream } from './stream.ts';

const ORIGIN = inject('sseOrigin');
const BASE = `${ORIGIN}/api`;

const RUN_A = 'run_20260810T093000Z_aa0001';
const RUN_B = 'run_20260810T093000Z_bb0002';
const RUN_C = 'run_20260810T093000Z_cc0003';
const SIX = [
  RUN_A,
  RUN_B,
  RUN_C,
  'run_20260810T093000Z_dd0004',
  'run_20260810T093000Z_ee0005',
  'run_20260810T093000Z_ff0006',
];

/**
 * The budget the failing scenario waits out.
 *
 * Ten seconds is what EPIC-15-S16 names, and it is generous on purpose: the
 * claim is *"never resolves"*, and the only honest way to assert that in finite
 * time is a wait long enough that a merely-slow request would have arrived. The
 * control is the same `fetch` against the same origin in the multiplexed case,
 * which is asserted to come back inside a fraction of it.
 */
const NEVER_MS = 10_000;
const PROMPT_MS = 2_000;

const hubs: StreamHub[] = [];
const closers: (() => void)[] = [];

function track(hub: StreamHub): StreamHub {
  hubs.push(hub);
  return hub;
}

async function openStreams(runs: readonly string[]): Promise<void> {
  const connected: Promise<void>[] = [];
  for (const runId of runs) {
    connected.push(
      new Promise<void>((resolve) => {
        const connection = connectStream({
          baseUrl: BASE,
          runs: [runId],
          since: 0,
          onConnect: resolve,
        });
        closers.push(() => {
          connection.close();
        });
      }),
    );
  }
  await Promise.all(connected);
}

/** How many streams the origin currently has open. Read from the server. */
async function openStreamCount(): Promise<number> {
  const response = await fetch(`${ORIGIN}/__streams`);
  return ((await response.json()) as { open: number }).open;
}

/** `{ resolved }` after racing an ordinary request against `budget`. */
async function fetchWithin(budget: number): Promise<boolean> {
  const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), budget));
  const request = fetch(`${ORIGIN}/api/runs`).then(() => 'resolved' as const);
  return (await Promise.race([request, timer])) === 'resolved';
}

async function emit(runs: readonly string[]): Promise<void> {
  // `text/plain` keeps it a simple request: a preflight would take a socket of
  // its own, which is the resource under test.
  await fetch(`${ORIGIN}/__emit`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ runs }),
  });
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const close of closers.splice(0)) close();
  // The next spec's budget is only meaningful once the pool is free again: a
  // leaked stream from one case is six-minus-one sockets for the next.
  await vi.waitFor(async () => expect(await openStreamCount()).toBe(0), { timeout: 10_000 });
});

suite('EPIC-15-S15 — three run panels share one stream (AC1)', () => {
  it('holds exactly one connection however many panels are open', async () => {
    const hub = track(openStreamHub({ baseUrl: BASE, since: 0 }));
    await hub.opened();
    expect(await openStreamCount()).toBe(1);

    // The operator opens three run panels, one at a time, exactly as a tab
    // does. Each is a filter mutation on the connection that is already there.
    for (const runId of [RUN_A, RUN_B, RUN_C]) await hub.watch(runId, () => {});

    expect(await openStreamCount()).toBe(1);
    expect(hub.connections()).toBe(1);
    expect([...hub.runs()].toSorted()).toEqual([RUN_A, RUN_B, RUN_C].toSorted());
  });

  it('routes interleaved frames by runId, in strictly increasing seq order', async () => {
    const seen = new Map<string, number[]>([
      [RUN_A, []],
      [RUN_B, []],
      [RUN_C, []],
    ]);
    const arrival: number[] = [];

    const hub = track(openStreamHub({ baseUrl: BASE, since: 0 }));
    await hub.opened();
    for (const runId of [RUN_A, RUN_B, RUN_C]) {
      await hub.watch(runId, (event) => {
        seen.get(runId)?.push(event.seq);
        arrival.push(event.seq);
      });
    }

    // Round-robin, so the three runs interleave in the one sequence — which is
    // what a client multiplexing them has to cope with.
    const interleaved = [RUN_A, RUN_B, RUN_C, RUN_A, RUN_B, RUN_C, RUN_A, RUN_B, RUN_C];
    await emit(interleaved);
    await vi.waitFor(() => expect(arrival).toHaveLength(9), { timeout: 10_000 });

    expect(seen.get(RUN_A)).toEqual([1, 4, 7]);
    expect(seen.get(RUN_B)).toEqual([2, 5, 8]);
    expect(seen.get(RUN_C)).toEqual([3, 6, 9]);
    expect(arrival).toEqual([...arrival].toSorted((left, right) => left - right));
    // And still one connection, after all of it.
    expect(await openStreamCount()).toBe(1);
  });
});

suite('EPIC-15-S16 — the six-connection cap is not a tuning knob (AC2)', () => {
  it('wedges an ordinary fetch behind one stream per panel, with no error at all', async () => {
    // The design being rejected: one connection per run panel. Five first,
    // and the count is read while there is still a socket free to read it
    // with — asking the origin how many streams it has open is itself a
    // request, and after the sixth there is nothing left to carry one. That
    // is the failure, arriving early.
    await openStreams(SIX.slice(0, 5));
    expect(await openStreamCount()).toBe(5);

    // The sixth panel. `onConnect` fired, so the stream is open and the pool
    // is now full — and an SSE connection never gives its socket back.
    await openStreams(SIX.slice(5));

    // No error is raised. The request is simply queued, which is exactly why
    // this reads as "the daemon hung" against a perfectly healthy daemon.
    let failed: unknown = null;
    let resolved = false;
    const queued = fetch(`${ORIGIN}/api/runs`)
      .then(() => {
        resolved = true;
      })
      .catch((error: unknown) => {
        failed = error;
      });

    await new Promise((wake) => setTimeout(wake, NEVER_MS));
    expect(resolved).toBe(false);
    expect(failed).toBeNull();

    // And the proof that it was *queued* rather than broken: close the six
    // and the very same request completes.
    for (const close of closers.splice(0)) close();
    await queued;
    expect(resolved).toBe(true);
    expect(failed).toBeNull();
  }, 60_000);

  it('resolves the same fetch promptly when the six runs share one connection', async () => {
    const hub = track(openStreamHub({ baseUrl: BASE, since: 0 }));
    await hub.opened();
    for (const runId of SIX) await hub.watch(runId, () => {});

    expect(hub.runs()).toHaveLength(6);
    expect(await openStreamCount()).toBe(1);
    expect(await fetchWithin(PROMPT_MS)).toBe(true);
  }, 30_000);
});
