/**
 * KAR-15.7 — the client half of `GET /api/runs/:id/snapshot?seq=N`, in a real
 * browser.
 *
 * Verifies: EPIC-15-S47 (its three UI-free lines) · AC1, AC2, AC3, AC8
 *
 * *"The reason this endpoint exists is browser memory."* The server half —
 * that the endpoint resolves a `seq` down through a gap, echoes the `seq` it
 * answered at, and folds through the one shared reducer — is asserted over a
 * real ledger and a real socket in `packages/ledger`'s `run-snapshot.test.ts`
 * and `packages/daemon`'s `run-snapshot-endpoint.test.ts` (EPIC-15-S45,
 * EPIC-15-S46). None of that stops the *client* from throwing the endpoint
 * away and folding the run itself, which is the failure the endpoint was built
 * to prevent, so this file asserts the three claims EPIC-15-S47 makes about
 * the client and nothing about the endpoint:
 *
 * 1. **Each position is hydrated from `…/snapshot?seq=<N>`.** Dragging to a
 *    plan version is one request to the snapshot endpoint carrying that
 *    version's `seq`, not a hydrate of the run's events.
 * 2. **Forward replay starts at the nearest snapshot.** When the scrubber does
 *    fold events itself — following the live tail a few events past a position
 *    it holds — it re-bases on the *greatest* snapshot at or below the target,
 *    never on the first one it happens to have.
 * 3. **No client-side reduction from `seq` 0 occurs.** Nothing here ever asks
 *    `…/events?since=0`, and no fold ever starts from `initialRunState()` — the
 *    base of every fold is a state the server computed.
 *
 * Driven through an injected `fetch` rather than a live daemon for the same
 * reason `hydrate.test.ts` is: what is under test is *which request the client
 * makes*, which a live daemon would answer identically whether the client
 * asked for one snapshot or replayed ten thousand events. The fake below
 * answers with `@DeFlow/core`'s own `foldEvents`, so the states it serves are
 * real reduced states rather than canned objects.
 *
 * The remaining two lines of EPIC-15-S47 — that the tab stays responsive while
 * the operator drags, and that the diff rendered at each step matches
 * `plans/diff` for the same pair — need the plan-evolution view that EPIC-16
 * builds, and are recorded as deferred to it in
 * `docs/delivery/flows/EPIC-15-daemon-api-flows.md`.
 */
import type { RunState } from '@DeFlow/core';
import { foldEvents, initialRunState, PLANGRAPH_SCHEMA_ID } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { createClient } from './client.ts';
import { createScrubber } from './scrub.ts';

const RUN = 'run_20260806T141133Z_9f2a1c';
const BASE = 'http://127.0.0.1:7777/api';

const hashOf = (digit: string): string => `sha256-${digit.repeat(64)}`;
const [H1, H2, H3, H4] = [hashOf('1'), hashOf('2'), hashOf('3'), hashOf('4')];
const SPEC_HASH = hashOf('f');

const DECISION = { decision: 'auto', by: 'policy', at: '2026-08-06T14:12:00.000Z' } as const;

interface Row {
  readonly seq: number;
  readonly runId: string;
  readonly ts: number;
  readonly kind: string;
  readonly v: number;
  readonly epoch: number;
  readonly payload: unknown;
}

const row = (seq: number, kind: string, v: number, payload: unknown): Row => ({
  seq,
  runId: RUN,
  ts: 1_754_140_000_000 + seq,
  kind,
  v,
  epoch: 7,
  payload,
});

const patch = (version: number, fromHash: string, toHash: string): Row =>
  row(version === 2 ? 6 : version === 3 ? 9 : 13, 'plan.patched', 2, {
    version,
    fromHash,
    toHash,
    patchId: `p_v${version}`,
    decision: DECISION,
  });

/**
 * The `three-patches` fixture: a run that compiled v1, started on it, and was
 * patched three times. The sequence is 1, 2, 3, 6, 7, 9, 12, 13, 15 — the
 * holes belong to other runs in the same directory, which is what makes
 * "hydrated from `?seq=<N>`" a claim with teeth: several of the numbers the
 * scrubber lands on were never committed by *this* run.
 */
const THREE_PATCHES: readonly Row[] = [
  row(1, 'plan.proposed', 2, {
    version: 1,
    planHash: H1,
    graph: {
      schemaId: PLANGRAPH_SCHEMA_ID,
      runId: RUN,
      version: 1,
      planHash: H1,
      parent: null,
      taskSpecHash: SPEC_HASH,
      createdBy: 'planner',
      createdAt: '2026-08-06T14:11:33.000Z',
      nodes: [],
      edges: [],
    },
    by: 'planner',
  }),
  row(2, 'run.started', 1, { planHash: H1 }),
  row(3, 'node.scheduled', 1, { node: 'n-impl-1', provider: 'claude', permission: 'read' }),
  patch(2, H1, H2),
  row(7, 'node.progress', 1, { node: 'n-impl-1', attempt: 1, phase: 'running' }),
  patch(3, H2, H3),
  row(12, 'node.progress', 1, { node: 'n-impl-1', attempt: 1, phase: 'running' }),
  patch(4, H3, H4),
  row(15, 'run.paused', 1, { by: 'user' }),
];

/** Every request the client made, in order, as its path and query. */
interface Asked {
  readonly path: string;
  readonly seq: string | null;
  readonly since: string | null;
}

/**
 * A fold with the checkpoint cache the real ledger has (KAR-03.6), so a fake
 * standing in for the daemon answers a monotone drag in one pass rather than
 * re-reducing the whole run per request. It resolves down exactly as
 * `snapshotRunAt` does: the answer is the greatest committed `seq` at or below
 * the request, whatever the request was.
 */
function serverFold(rows: readonly Row[]) {
  let base: { seq: number; state: RunState } = { seq: 0, state: initialRunState() };
  return (upTo: number): { seq: number; state: RunState } => {
    if (base.seq > upTo) base = { seq: 0, state: initialRunState() };
    const pending = rows.filter((candidate) => candidate.seq > base.seq && candidate.seq <= upTo);
    const report = foldEvents(pending, base.state);
    base = { seq: Math.max(base.seq, report.lastSeq), state: report.state };
    return { seq: base.seq, state: base.state };
  };
}

const json = (body: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

/** A `fetch` serving `/snapshot` and `/events` for `rows`, recording every ask. */
function daemon(rows: readonly Row[], asked: Asked[], pageSize = 1000) {
  const fold = serverFold(rows);

  return (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    asked.push({
      path: url.pathname,
      seq: url.searchParams.get('seq'),
      since: url.searchParams.get('since'),
    });

    if (url.pathname.endsWith('/snapshot')) {
      const requested = url.searchParams.get('seq');
      const snapshot = fold(requested === 'head' ? Number.POSITIVE_INFINITY : Number(requested));
      return json({
        seq: snapshot.seq,
        state: snapshot.state,
        planVersion: snapshot.state.planVersion,
        planHash: snapshot.state.planHash,
      });
    }

    if (url.pathname.endsWith('/events')) {
      const since = Number(url.searchParams.get('since') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? String(pageSize));
      const after = rows.filter((candidate) => candidate.seq > since);
      const page = after.slice(0, limit);
      return json({
        events: page,
        cursor: page.at(-1)?.seq ?? since,
        headSeq: rows.at(-1)?.seq ?? 0,
        more: after.length > page.length,
      });
    }

    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

const clientFor = (fetch: ReturnType<typeof daemon>) => createClient({ baseUrl: BASE, fetch });

const snapshots = (asked: readonly Asked[]) =>
  asked.filter((one) => one.path.endsWith('/snapshot'));
const events = (asked: readonly Asked[]) => asked.filter((one) => one.path.endsWith('/events'));

suite('EPIC-15-S47 — every scrub position is hydrated from the snapshot endpoint', () => {
  it('drags back to v1 and forward through each patch, one snapshot request per position', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN);

    // The four positions of the plan-evolution timeline: v1 as the run started
    // on it, then each patch.
    const positions = [];
    for (const seq of [2, 6, 9, 13]) positions.push(await scrubber.positionAt(seq));

    expect(positions.map((position) => position.planVersion)).toEqual([1, 2, 3, 4]);
    expect(positions.map((position) => position.planHash)).toEqual([H1, H2, H3, H4]);
    expect(positions.map((position) => position.seq)).toEqual([2, 6, 9, 13]);

    // Every one of them came from `…/snapshot?seq=<N>`, carrying the `seq` of
    // the position asked for.
    expect(positions.every((position) => position.hydratedBy === 'snapshot')).toBe(true);
    expect(snapshots(asked).map((one) => one.seq)).toEqual(['2', '6', '9', '13']);
    expect(snapshots(asked).every((one) => one.path === `/api/runs/${RUN}/snapshot`)).toBe(true);

    // And nothing was hydrated by replaying the run: no events request was made
    // at all, which is the whole reason the endpoint exists.
    expect(events(asked)).toEqual([]);
  });

  it('lands on a seq this run never committed and is told which one it got', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN);

    // 11 is a hole — it belongs to another run in the same directory. The
    // scrubber asks for the position it dragged to, and the state it is handed
    // says which `seq` it actually reflects rather than leaving it to guess.
    const position = await scrubber.positionAt(11);

    expect(snapshots(asked).map((one) => one.seq)).toEqual(['11']);
    expect(position.seq).toBe(9);
    expect(position.planVersion).toBe(3);
    expect(position.planHash).toBe(H3);
    // Held under the seq it reflects, not the one that was asked for: a cache
    // keyed on the request would answer 10 and 11 from different entries that
    // hold the identical state.
    expect(scrubber.held()).toEqual([9]);
  });

  it("resolves the 'head' alias through the endpoint rather than guessing a number", async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN);

    const position = await scrubber.positionAt('head');

    expect(snapshots(asked).map((one) => one.seq)).toEqual(['head']);
    expect(position.seq).toBe(15);
    expect(position.state.status).toBe('paused');
    expect(events(asked)).toEqual([]);
  });
});

suite('EPIC-15-S47 — forward replay starts at the nearest snapshot and nowhere else', () => {
  it('re-bases on the greatest snapshot at or below the target, not the first one held', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN, {
      replayWindow: 5,
    });

    await scrubber.positionAt(2);
    await scrubber.positionAt(6);
    await scrubber.positionAt(9);
    asked.length = 0;

    // 12 is three seq past the nearest snapshot (9) and ten past the oldest one
    // held (2). Only the nearest may be folded forward from.
    const position = await scrubber.positionAt(12);

    expect(events(asked).map((one) => one.since)).toEqual(['9']);
    expect(snapshots(asked)).toEqual([]);
    expect(position.hydratedBy).toBe('replay');
    expect(position.replayedFrom).toBe(9);
    // One event lies in (9, 12]: seq 12. Not the four that lie in (2, 12].
    expect(position.replayed).toBe(1);
    expect(position.seq).toBe(12);
  });

  it('agrees with the server, state for state, at the position it replayed to', async () => {
    const replayed = createScrubber(clientFor(daemon(THREE_PATCHES, [])), RUN, { replayWindow: 5 });
    await replayed.positionAt(9);
    const byReplay = await replayed.positionAt(12);

    const direct = createScrubber(clientFor(daemon(THREE_PATCHES, [])), RUN);
    const bySnapshot = await direct.positionAt(12);

    // The client's forward fold and the server's are the same reducer, so a
    // position reached either way is the same state — the property that makes
    // the replay path safe to take at all.
    expect(byReplay.hydratedBy).toBe('replay');
    expect(bySnapshot.hydratedBy).toBe('snapshot');
    expect(byReplay.state).toEqual(bySnapshot.state);
    expect(byReplay.seq).toBe(bySnapshot.seq);
  });

  it('re-bases on the snapshot rather than on the position it last replayed to', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN, {
      replayWindow: 5,
    });

    await scrubber.positionAt(9);
    await scrubber.positionAt(12);
    asked.length = 0;
    const position = await scrubber.positionAt(14);

    // A position this client folded itself is not a snapshot, so it is not a
    // base: replays never chain off each other, and the fold behind any
    // position stays at most one window deep rather than growing with the drag.
    expect(events(asked).map((one) => one.since)).toEqual(['9']);
    expect(position.replayedFrom).toBe(9);
    expect(position.replayed).toBe(2);
    expect(position.seq).toBe(13);
  });

  it('goes back to the endpoint when the target is further ahead than the window', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN, {
      replayWindow: 2,
    });

    await scrubber.positionAt(2);
    asked.length = 0;
    const position = await scrubber.positionAt(13);

    // Eleven seq of ground: the server folds that, not the tab.
    expect(events(asked)).toEqual([]);
    expect(snapshots(asked).map((one) => one.seq)).toEqual(['13']);
    expect(position.hydratedBy).toBe('snapshot');
    expect(position.replayed).toBe(0);
  });

  it('never replays backwards from a snapshot ahead of the target', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN, {
      replayWindow: 50,
    });

    await scrubber.positionAt(13);
    asked.length = 0;
    const position = await scrubber.positionAt(6);

    // Dragging *back* has no nearest snapshot at or below it, and events only
    // move a fold forward — so this is a fetch, not a rewind.
    expect(events(asked)).toEqual([]);
    expect(snapshots(asked).map((one) => one.seq)).toEqual(['6']);
    expect(position.planVersion).toBe(2);
  });
});

suite('EPIC-15-S47 — no client-side reduction from seq 0 occurs', () => {
  /** A long run: 10,000 committed events, the figure §7.3 measured against. */
  const LONG: readonly Row[] = Array.from({ length: 10_000 }, (_, index) =>
    row(index + 1, 'node.progress', 1, { node: 'n-impl-1', attempt: 1, phase: 'running' }),
  );

  it('scrubs a 10,000-event run without ever asking for the run from zero', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(LONG, asked)), RUN, { replayWindow: 50 });

    const positions = [];
    for (const seq of [2500, 5000, 7500, 7520, 10_000]) {
      positions.push(await scrubber.positionAt(seq));
    }

    // Not one request for the run's events from the beginning — nor from
    // anywhere else except the one snapshot the tail was replayed from.
    expect(asked.some((one) => one.since === '0')).toBe(false);
    expect(events(asked).map((one) => one.since)).toEqual(['7500']);

    // Every position's fold began at a state the server computed, never at
    // `initialRunState()`.
    expect(positions.every((position) => position.replayedFrom > 0)).toBe(true);

    // Twenty events folded in the browser against ten thousand in the run: the
    // difference between a scrubber and a frozen tab.
    const folded = positions.reduce((total, position) => total + position.replayed, 0);
    expect(folded).toBe(20);
    expect(positions.at(-1)?.seq).toBe(10_000);
  });

  it('refuses to fold forward from the empty state even when it is holding one', async () => {
    const asked: Asked[] = [];
    const scrubber = createScrubber(clientFor(daemon(THREE_PATCHES, asked)), RUN, {
      replayWindow: 100,
    });

    // `seq` 0 is the state before this run's first event — the initial state,
    // by another name. It is inside the replay window of every later position,
    // and it is still never folded forward from: doing so is the client-side
    // reduction from zero this endpoint exists to prevent.
    const empty = await scrubber.positionAt(0);
    expect(empty.seq).toBe(0);
    expect(empty.state).toEqual(initialRunState());

    const position = await scrubber.positionAt(13);

    expect(events(asked)).toEqual([]);
    expect(snapshots(asked).map((one) => one.seq)).toEqual(['0', '13']);
    expect(position.hydratedBy).toBe('snapshot');
    expect(position.planVersion).toBe(4);
  });
});
