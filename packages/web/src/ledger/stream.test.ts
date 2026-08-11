/**
 * KAR-16.2 test plan #5–#11 — the tab's one connection, over a real socket in a
 * real browser.
 *
 * Verifies: EPIC-16-S6, EPIC-16-S7, EPIC-16-S8, EPIC-16-S12, EPIC-16-S13,
 * EPIC-16-S14, EPIC-16-S24 · AC1, AC2, AC3, AC4, AC5, AC9, AC10, AC11, AC12
 *
 * Everything here runs against `../../test/sse-origin.ts` — a real `node:http`
 * server on a port of its own, speaking the daemon's wire shape — because every
 * claim in this story is about a *connection*: how many there are, what happens
 * when one is severed, whether a reload loses events, whether fifteen idle
 * minutes cause a reconnect. Not one of those can be told apart from a lucky
 * in-memory implementation without a socket.
 *
 * What is deliberately **not** claimed here is that the daemon's bytes are
 * right. The frame contract — `id: <seq>`, `retry: 2000`, the four named
 * frames, `: keepalive`, the `runs=*` membership, the two-phase drain — is
 * asserted against a real DeFlowd over a real ledger in
 * `packages/daemon/test/integration/stream-contract.test.ts` and
 * `stream-drain.test.ts`, which is the right level for bytes. `packages/web`
 * may not import `@DeFlow/daemon` at runtime at all (R2), so a spec here that
 * tried would be the wrong spec in the wrong package.
 */
import type { Event } from '@DeFlow/core';
import { afterEach, beforeEach, expect, inject, it, describe as suite, vi } from 'vitest';
import { connectStream } from '../api/stream.ts';
import type { Projection } from './apply.ts';
import { CURSOR_STORAGE_KEY, openCursor } from './cursor.ts';
import { type LedgerStream, openLedgerStream, RECONNECT_INTERVAL_MS } from './stream.ts';

const ORIGIN = inject('sseOrigin');
const BASE = `${ORIGIN}/api`;

const RUN_A = 'run_20260811T093000Z_aa0001';
const RUN_B = 'run_20260811T093000Z_bb0002';
const RUN_C = 'run_20260811T093000Z_cc0003';

/** The one projection these specs need: what arrived, in what order. */
interface Trace {
  readonly seqs: number[];
}

const trace: Projection<Trace> = {
  name: 'trace',
  create: () => ({ seqs: [] }),
  apply: (state, event) => state.seqs.push(event.seq),
};

function scratchStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

interface StreamsSeen {
  readonly open: number;
  readonly accepted: number;
  readonly opens: readonly { since: number | null; runs: string[]; lastEventId: string | null }[];
}

const streamsSeen = async (): Promise<StreamsSeen> =>
  (await fetch(`${ORIGIN}/__streams`)).json() as Promise<StreamsSeen>;

async function post(path: string, body: unknown): Promise<void> {
  // `text/plain` keeps it a simple request: a preflight would take a socket of
  // its own, which is the resource half these specs are about.
  await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(body),
  });
}

const emit = (runs: readonly string[], extra: { kind?: string; seqs?: number[] } = {}) =>
  post('/__emit', { runs, ...extra });

const opened: LedgerStream[] = [];

function track(stream: LedgerStream): LedgerStream {
  opened.push(stream);
  return stream;
}

function open(options: Partial<Parameters<typeof openLedgerStream>[0]> = {}): LedgerStream {
  return track(
    openLedgerStream({
      baseUrl: BASE,
      storage: scratchStorage(),
      projections: [trace],
      ...options,
    }),
  );
}

beforeEach(async () => {
  // One origin serves the whole slice, so every case starts from an empty
  // ledger — otherwise `seq` 1 would mean "the first event this file emitted"
  // in one case and "the fortieth" in the next.
  await post('/__reset', {});
});

afterEach(async () => {
  for (const stream of opened.splice(0)) stream.close();
  await vi.waitFor(async () => expect((await streamsSeen()).open).toBe(0), { timeout: 10_000 });
});

suite('EPIC-16-S1 — a cold tab hydrates first and opens the stream after (AC3)', () => {
  it('pages the hydrate endpoint to the head, then opens one stream at that cursor', async () => {
    await emit(Array.from({ length: 12 }, () => RUN_A));
    const before = (await streamsSeen()).accepted;

    const progress: string[] = [];
    const stream = open({
      onHydrateProgress: (page) => progress.push(`${page.applied}/${page.headSeq}`),
    });
    const run = await stream.watch(RUN_A);

    // Every event applied exactly once, before a socket was opened at all.
    expect(run.state(trace).seqs).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(progress).toEqual(['12/12']);

    const seen = await streamsSeen();
    expect(seen.accepted - before).toBe(1);
    // Opened at the cursor the hydrate ended on — never at 0, which would fold
    // the run twice, and never at head, which would lose the seam.
    expect(seen.opens.at(-1)?.since).toBe(12);
    expect(stream.cursor()).toBe(12);
    expect(stream.state().status).toBe('live');
  });

  it('applies live frames onto the hydrated state, in seq order', async () => {
    const stream = open();
    const run = await stream.watch(RUN_A);

    await emit([RUN_A, RUN_A, RUN_A]);
    await vi.waitFor(() => expect(run.state(trace).seqs).toHaveLength(3), { timeout: 10_000 });

    const seqs = run.state(trace).seqs;
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
    expect(stream.cursor()).toBe(seqs.at(-1));
  });

  it('applies a ledger with holes in it and says nothing about the missing numbers', async () => {
    // The crash-resume shape. 6, 9, 10 and 11 were burned by transactions that
    // rolled back, and AUTOINCREMENT never reissues them.
    await emit([RUN_A, RUN_A, RUN_A, RUN_A, RUN_A], { seqs: [4, 5, 7, 8, 12] });

    const stream = open();
    const run = await stream.watch(RUN_A);

    expect(run.state(trace).seqs).toEqual([4, 5, 7, 8, 12]);
    expect(stream.state().status).toBe('live');
    expect(stream.state().fatal).toBeNull();
    expect(run.appliedCount()).toBe(5);
  });
});

suite('EPIC-16-S6 — three run panels, one connection (AC1)', () => {
  it('adds each panel as a filter mutation, never as a second socket', async () => {
    const stream = open();
    await stream.watch(RUN_A);
    const streamId = stream.streamId();

    await stream.watch(RUN_B);
    await stream.watch(RUN_C);

    expect((await streamsSeen()).open).toBe(1);
    expect(stream.connections()).toBe(1);
    expect(stream.streamId()).toBe(streamId);
    expect([...stream.runs()].toSorted()).toEqual([RUN_A, RUN_B, RUN_C].toSorted());
  });

  it('routes interleaved frames by runId and leaves each panel’s neighbours alone', async () => {
    const stream = open();
    const a = await stream.watch(RUN_A);
    const b = await stream.watch(RUN_B);

    await emit([RUN_A, RUN_B, RUN_A, RUN_B, RUN_A]);
    await vi.waitFor(() => expect(a.state(trace).seqs).toHaveLength(3), { timeout: 10_000 });
    await vi.waitFor(() => expect(b.state(trace).seqs).toHaveLength(2), { timeout: 10_000 });

    expect(a.state(trace).seqs).toEqual([1, 3, 5]);
    expect(b.state(trace).seqs).toEqual([2, 4]);
  });
});

suite('EPIC-16-S24 — the subscribe backfill overlaps the cursor (AC2)', () => {
  it('marks a run live only on its caught_up, and dedupes the overlap it brings', async () => {
    await emit([RUN_A, RUN_A, RUN_B, RUN_B]);

    const stream = open();
    const a = await stream.watch(RUN_A);
    expect(stream.state().live).toEqual([RUN_A]);

    // The second panel. The daemon backfills it from the cursor the connection
    // opened at, which is behind where this tab has already hydrated `r_b` to —
    // so the same two events arrive twice by design.
    const b = await stream.watch(RUN_B);
    await vi.waitFor(() => expect(stream.state().live).toContain(RUN_B), { timeout: 10_000 });

    expect(b.state(trace).seqs).toEqual([3, 4]);
    expect(b.appliedCount()).toBe(2);
    // And the run that was already open is untouched by the other's traffic.
    expect(a.state(trace).seqs).toEqual([1, 2]);
  });
});

suite('EPIC-16-S7 — the page reloads and Last-Event-ID is not sent (AC4)', () => {
  it('reopens from its own persisted cursor and loses nothing that arrived meanwhile', async () => {
    const storage = scratchStorage();
    await emit([RUN_A, RUN_A, RUN_A, RUN_A, RUN_A]);

    const first = open({ storage });
    const before = await first.watch(RUN_A);
    expect(before.state(trace).seqs).toEqual([1, 2, 3, 4, 5]);

    // The tab goes away. Everything it held goes with it except one string in
    // sessionStorage — and the run carries on regardless.
    first.close();
    opened.splice(opened.indexOf(first), 1);
    await vi.waitFor(async () => expect((await streamsSeen()).open).toBe(0), { timeout: 10_000 });
    await emit([RUN_A, RUN_A, RUN_A]);

    expect(storage.getItem(CURSOR_STORAGE_KEY)).toBe('5');
    const reloaded = open({ storage });
    const after = await reloaded.watch(RUN_A);

    // Identical to a tab that never reloaded: every event, once, in order.
    // The projections went with the old tab, so the run is folded again from
    // the beginning — a client that resumed the *fold* from the persisted
    // cursor would render the tail of a run as though it were all of it.
    expect(after.state(trace).seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const seen = await streamsSeen();
    // No Last-Event-ID on a fresh connection, however high the cursor. The
    // header is the browser's mechanism for a connection it reconnected
    // itself; this one has never been open before, so the query parameter is
    // the only cursor there is — and it is never absent, which is what the
    // next case is about.
    expect(seen.opens.at(-1)?.lastEventId).toBeNull();
    expect(seen.opens.at(-1)?.since).toBe(8);
    // And never below what the tab had persisted before it went away.
    expect(seen.opens.at(-1)?.since).toBeGreaterThanOrEqual(5);
  });

  it('loses every event of the outage for the build that omits ?since=', async () => {
    // The regression this scenario exists to prevent, demonstrated rather than
    // described. A client relying on Last-Event-ID alone sends no cursor on a
    // connection it did not itself reconnect, so the daemon serves it from the
    // head and the outage window is gone — a plausible, wrong picture, and a
    // direct NF10 violation.
    await emit([RUN_A, RUN_A, RUN_A]);

    const received: number[] = [];
    const connection = connectStream({
      baseUrl: BASE,
      runs: [RUN_A],
      since: 3,
      fetch: (url, init) => {
        const stripped = new URL(url.toString());
        stripped.searchParams.delete('since');
        return globalThis.fetch(stripped, init as RequestInit);
      },
      onMessage: (message) => {
        if (message.event === undefined || message.event === 'message') {
          received.push((JSON.parse(message.data) as { seq: number }).seq);
        }
      },
    });

    await vi.waitFor(async () => expect((await streamsSeen()).open).toBe(1), { timeout: 10_000 });
    // Give the backfill every chance to arrive. It never does.
    await new Promise((wake) => setTimeout(wake, 500));
    expect(received).toEqual([]);
    expect((await streamsSeen()).opens.at(-1)?.since).toBeNull();
    connection.close();
  });
});

suite('EPIC-16-S8 — the connection drops mid-run and comes back with no seam (AC5)', () => {
  it('reconnects from its own cursor with no gap and no duplicate', async () => {
    const applied: number[] = [];
    const stream = open({ onApplied: (event: Event) => applied.push(event.seq) });
    const run = await stream.watch(RUN_A);

    await emit([RUN_A, RUN_A, RUN_A]);
    await vi.waitFor(() => expect(run.state(trace).seqs).toHaveLength(3), { timeout: 10_000 });

    // The socket, severed mid-run: no final frame, no clean end.
    await post('/__sever', {});
    await emit([RUN_A, RUN_A, RUN_A]);

    await vi.waitFor(() => expect(run.state(trace).seqs).toHaveLength(6), { timeout: 20_000 });

    expect(applied).toEqual([1, 2, 3, 4, 5, 6]);
    expect(applied).toEqual([...applied].toSorted((left, right) => left - right));
    expect(new Set(applied).size).toBe(applied.length);

    const seen = await streamsSeen();
    // Its own cursor on the way back in, not where it first opened.
    expect(seen.opens.at(-1)?.since).toBe(3);
    expect(seen.open).toBe(1);
  }, 40_000);

  it('says it is reconnecting while it is reconnecting', async () => {
    // Found by `e2e/replay-stream.test.ts` — moving this scenario into a real
    // browser is what surfaced it — but it is not a browser bug, and this is
    // where it belongs.
    //
    // `eventsource-client` calls `onDisconnect` from exactly one place: the
    // branch where `reader.read()` returns `done: true`, i.e. a body the server
    // ended **cleanly**. A destroyed socket does not end a body; it *rejects*
    // the read, and that lands in the library's `.catch`, which calls
    // `scheduleReconnect()` and nothing else. So on the common failure — a lid
    // closing, Wi-Fi going, a daemon restarting, anything that is not a polite
    // `res.end()` — the connection was gone and this client still said `live`.
    //
    // Which is the one thing NF10 forbids: a view rendering its indicator off
    // `status` showed a healthy connection for the whole outage, and `live` was
    // never cleared either, so a `watch()` on a run mid-backfill resolved
    // immediately as already caught up.
    const stream = open();
    await stream.watch(RUN_A);
    expect(stream.state().status).toBe('live');

    await post('/__sever', {});

    await vi.waitFor(() => expect(stream.state().status).toBe('reconnecting'), { timeout: 10_000 });
    // And nothing is claimed to be caught up while the socket is down.
    expect(stream.state().live).toEqual([]);

    // Then back, on its own: the state is a report, not a latch.
    await vi.waitFor(() => expect(stream.state().status).toBe('live'), { timeout: 20_000 });
    expect(stream.state().live).toEqual([RUN_A]);
  }, 40_000);

  it('reconnects on the interval the server itself asked for', async () => {
    const stream = open();
    await stream.watch(RUN_A);
    await post('/__sever', {});

    await vi.waitFor(() => expect(stream.state().reconnectDelays.length).toBeGreaterThan(0), {
      timeout: 10_000,
    });

    // `retry: 2000`, written once immediately after the headers, and a client
    // policy that agrees with it — so a native-EventSource fallback and this
    // client behave identically.
    expect(stream.state().reconnectDelays.every((delay) => delay === RECONNECT_INTERVAL_MS)).toBe(
      true,
    );
    expect(RECONNECT_INTERVAL_MS).toBe(2000);
  }, 30_000);
});

suite('EPIC-16-S12 — the daemon restarted underneath the tab (AC9)', () => {
  it('surfaces the restart, keeps the projections, and resumes from its own cursor', async () => {
    const stream = open();
    const run = await stream.watch(RUN_A);
    await emit([RUN_A, RUN_A]);
    await vi.waitFor(() => expect(run.state(trace).seqs).toHaveLength(2), { timeout: 10_000 });

    // A different daemon life takes the ledger: same directory, new epoch.
    await post('/__daemon', { epoch: 8 });
    await post('/__sever', {});
    await emit([RUN_A]);

    await vi.waitFor(() => expect(stream.state().restarted).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(run.state(trace).seqs).toHaveLength(3), { timeout: 20_000 });

    // A restart is not a new run. Nothing is reset, and the events the daemon
    // appended during recovery are applied in order onto what was already
    // there.
    expect(run.state(trace).seqs).toEqual([1, 2, 3]);
    expect(stream.state().reloadRequired).toBe(false);
    expect((await streamsSeen()).opens.at(-1)?.since).toBe(2);
  }, 40_000);

  it('asks for a reload rather than running an old tab against a new build', async () => {
    const stream = open({ build: 'the-build-this-tab-was-served' });
    await stream.watch(RUN_A);

    expect(stream.state().reloadRequired).toBe(true);
    // Two different facts with two different remedies: a new build is a stale
    // tab, a new epoch is a replaced process, and only one of them needs a
    // reload.
    expect(stream.state().restarted).toBe(false);
  });

  it('says nothing at all when the daemon is the one it opened against', async () => {
    const stream = open({ build: 'test' });
    await stream.watch(RUN_A);
    expect(stream.state().restarted).toBe(false);
    expect(stream.state().reloadRequired).toBe(false);
  });
});

suite('EPIC-16-S13 — which fatal conditions stop the retry loop (AC10)', () => {
  it('stops retrying on bad_token and asks the operator to re-authenticate', async () => {
    const stream = open();
    await stream.watch(RUN_A);
    const before = (await streamsSeen()).accepted;

    await post('/__fatal', { code: 'bad_token' });
    await vi.waitFor(() => expect(stream.state().fatal?.code).toBe('bad_token'), {
      timeout: 10_000,
    });

    expect(stream.state().fatal?.terminal).toBe(true);
    expect(stream.state().status).toBe('stopped');
    // Well past one retry interval, and the socket was never re-opened: a
    // rotated token needs a human, and a client that retried would hammer a
    // connection that can only ever refuse it.
    await new Promise((wake) => setTimeout(wake, RECONNECT_INTERVAL_MS * 2));
    expect((await streamsSeen()).accepted).toBe(before);
  }, 30_000);

  it('stops retrying on epoch_mismatch, and that one wants a reload', async () => {
    const stream = open();
    await stream.watch(RUN_A);

    await post('/__fatal', { code: 'epoch_mismatch' });
    await vi.waitFor(() => expect(stream.state().fatal?.code).toBe('epoch_mismatch'), {
      timeout: 10_000,
    });

    expect(stream.state().fatal?.terminal).toBe(true);
    expect(stream.state().reloadRequired).toBe(true);
  }, 30_000);

  it('keeps retrying everything else, including a transient internal error', async () => {
    const stream = open();
    const run = await stream.watch(RUN_A);
    const before = (await streamsSeen()).accepted;

    await post('/__fatal', { code: 'internal' });
    await vi.waitFor(() => expect(stream.state().fatal?.code).toBe('internal'), {
      timeout: 10_000,
    });
    expect(stream.state().fatal?.terminal).toBe(false);

    // And it comes back, on its own, and picks the run up where it left off.
    await vi.waitFor(async () => expect((await streamsSeen()).accepted).toBeGreaterThan(before), {
      timeout: 20_000,
    });
    await emit([RUN_A]);
    await vi.waitFor(() => expect(run.state(trace).seqs).toEqual([1]), { timeout: 20_000 });
    expect(stream.state().status).toBe('live');
  }, 60_000);
});

suite('EPIC-16-S14 — an idle stream, and the comments that keep it quiet (AC11)', () => {
  it('ignores every keepalive comment and does not reconnect over any of them', async () => {
    const stream = open();
    const run = await stream.watch(RUN_A);
    const before = (await streamsSeen()).accepted;

    // Sixty comments is fifteen minutes at the daemon's 15-second cadence. The
    // wall clock is compressed and the client contributes no timer to compress
    // — it has no inactivity timeout of its own, which is the property under
    // test: what fifteen real minutes would add is sixty more of these.
    await post('/__keepalive', { times: 60 });
    await vi.waitFor(() => expect(stream.state().keepalives).toBe(60), { timeout: 10_000 });

    expect((await streamsSeen()).accepted).toBe(before);
    expect((await streamsSeen()).open).toBe(1);
    expect(stream.state().status).toBe('live');
    // A comment carries no field, so nothing reached the reducer either.
    expect(run.state(trace).seqs).toEqual([]);

    // And the connection is still the same live one afterwards.
    await emit([RUN_A]);
    await vi.waitFor(() => expect(run.state(trace).seqs).toEqual([1]), { timeout: 10_000 });
    expect((await streamsSeen()).accepted).toBe(before);
  }, 30_000);
});

suite('EPIC-16-S6 — the global topic is not a firehose (AC12)', () => {
  it('opens with runs=* and routes lifecycle events away from the run panels', async () => {
    const lifecycle: Event[] = [];
    const stream = open({ global: true, onLifecycle: (event: Event) => lifecycle.push(event) });
    await stream.opened();

    await emit([RUN_A, RUN_B], { kind: 'node.progress' });
    await emit([RUN_C], { kind: 'run.completed' });
    await vi.waitFor(() => expect(lifecycle).toHaveLength(1), { timeout: 10_000 });

    expect((await streamsSeen()).opens.at(-1)?.runs).toEqual(['*']);
    expect(lifecycle[0]?.kind).toBe('run.completed');
    // Zero node.progress frames from any run — the membership itself is
    // asserted against a real DeFlowd in the daemon's stream-contract spec.
    expect(lifecycle.filter((event) => event.kind === 'node.progress')).toEqual([]);
  }, 30_000);
});

suite('the cursor the whole thing turns on', () => {
  it('is the one in sessionStorage, shared with everything else that reads it', async () => {
    const storage = scratchStorage();
    const stream = open({ storage });
    const run = await stream.watch(RUN_A);
    await emit([RUN_A, RUN_A]);
    await vi.waitFor(() => expect(run.state(trace).seqs).toHaveLength(2), { timeout: 10_000 });

    expect(openCursor(storage).read()).toBe(2);
    expect(stream.cursor()).toBe(2);
  });

  it('opens no connection at all until a panel asks for one', async () => {
    const before = (await streamsSeen()).accepted;
    const stream = open();
    await new Promise((wake) => setTimeout(wake, 200));

    // Hydrate first, stream second — so there is nothing to open before the
    // first watch, and the connection that is eventually opened carries a
    // cursor rather than a zero.
    expect((await streamsSeen()).accepted).toBe(before);
    expect(stream.streamId()).toBeNull();
    expect(stream.state().status).toBe('idle');
  });
});
