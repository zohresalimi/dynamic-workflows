/**
 * KAR-13.3 — `POST /api/runs/:id/interject`, over a real file-backed ledger and
 * a real socket.
 *
 * Integration rather than unit because every claim here is about a **response
 * status reached over HTTP against a database**, and the three that matter are
 * exactly the ones an in-process projection cannot show.
 *
 * **`unsupported` is a `202`.** A unit test proves the delivery *value*; only a
 * response proves nobody turned it into a `4xx` on the way out, which is the
 * whole design decision the story carries.
 *
 * **A refusal appends nothing.** "Nothing was appended" is a statement about a
 * table, and it is only worth making against one that a write could have
 * reached.
 *
 * **The delivery is read off the probed capability row.** Two providers are
 * seeded differing in one bit, so an answer that came from a provider name
 * rather than from the row would show up as the same answer twice.
 *
 * Verifies: EPIC-13-S17, EPIC-13-S18, EPIC-13-S20 · AC1, AC2, AC4, AC6, AC7,
 * AC9 · test plan #5, #8
 */
import type { Db, RunId } from '@DeFlow/core';
import { initialRunState, interjectionsOf, RESPOND_ROUTE } from '@DeFlow/core';
import { openLedger, readRange, replayAll } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import {
  completeImpl,
  EPOCH,
  GATE,
  GUIDANCE,
  IMPL,
  INTERJECT_RUN,
  type SeedOptions,
  seedInterjectRun,
  T0,
  UNSTEERABLE,
} from './support/interject-run.ts';

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

async function serve(dataDir: string, options: SeedOptions = {}): Promise<Served> {
  const db = openLedger(dataDir);
  seedInterjectRun(db, options);

  const view = openLedgerView(dataDir);
  setLedgerView(view);
  setIntakePorts({
    db,
    epoch: EPOCH,
    clock: { now: () => T0 + 5_000, setTimer: () => ({ cancel: () => {} }) },
    dataDir,
    randomHex: () => 'aa0001',
  });

  const started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: false });
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

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const events = (db: Db) => readRange(db, INTERJECT_RUN as RunId, 0, 500).events;

const countOf = (db: Db, kind: string): number =>
  events(db).filter((event) => event.kind === kind).length;

const stateOf = (db: Db) => replayAll(db).runs.get(INTERJECT_RUN) ?? initialRunState();

interface Body {
  readonly seq?: number;
  readonly delivery?: string;
  readonly error?: string;
  readonly message?: string;
  readonly nodeStatus?: string;
  readonly alternative?: string;
  readonly head?: number;
  readonly movedAt?: number;
}

async function post(origin: string, body: unknown): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${origin}/api/runs/${INTERJECT_RUN}/interject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

// ── EPIC-13-S17 — the correction lands, and the run is not discarded ─────────

suite('EPIC-13-S17 — a correction lands without throwing the run away (AC1, AC4)', () => {
  it('answers 202 with the appended seq and a queued delivery', async ({ tmp }) => {
    served = await serve(tmp);
    const before = stateOf(served.db);

    const { status, body } = await post(served.origin, {
      nodeId: IMPL,
      text: GUIDANCE,
      mode: 'next-turn',
    });

    expect(status).toBe(202);
    expect(body.delivery).toBe('queued');

    // The returned seq is the appended event's, so a client can position its
    // cursor on it immediately.
    const interjected = events(served.db).filter((event) => event.kind === 'human.interjected');
    expect(interjected).toHaveLength(1);
    expect(body.seq).toBe(interjected[0]?.seq);
    expect(interjected[0]?.payload).toEqual({
      node: IMPL,
      text: GUIDANCE,
      mode: 'next-turn',
      delivery: 'queued',
    });

    // Nothing was cancelled, reset or re-attempted, and the run did not move.
    const after = stateOf(served.db);
    expect(after.status).toBe(before.status);
    expect(after.nodes[IMPL]?.status).toBe('running');
    expect(after.nodes[IMPL]?.attempt).toBe(1);
    expect(countOf(served.db, 'node.retry.scheduled')).toBe(0);
    expect(countOf(served.db, 'node.cancelled')).toBe(0);
    expect(countOf(served.db, 'run.cancel.requested')).toBe(0);
  });

  it('keeps every correction typed before the next turn, in seq order (AC8)', async ({ tmp }) => {
    served = await serve(tmp);

    for (const text of ['first', 'second', 'third']) {
      const { status } = await post(served.origin, { nodeId: IMPL, text, mode: 'next-turn' });
      expect(status).toBe(202);
    }

    const recorded = interjectionsOf(stateOf(served.db), IMPL);
    expect(recorded.map((one) => one.text)).toEqual(['first', 'second', 'third']);
    const seqs = recorded.map((one) => one.seq);
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
  });
});

// ── EPIC-13-S18 — an adapter that cannot steer says so, with a 202 ───────────

suite('EPIC-13-S18 — an unsteerable adapter answers 202 unsupported (AC2, test plan #5)', () => {
  it('is a 202 and not a 4xx, and the projection carries the undelivered state', async ({
    tmp,
  }) => {
    served = await serve(tmp, { provider: UNSTEERABLE });

    const { status, body } = await post(served.origin, {
      nodeId: IMPL,
      text: GUIDANCE,
      mode: 'next-turn',
    });

    expect(status).toBe(202);
    expect(body.delivery).toBe('unsupported');
    expect(body.error).toBeUndefined();

    // AC9: the UI reads this, so it cannot render a delivered guidance bubble.
    expect(interjectionsOf(stateOf(served.db), IMPL)).toEqual([
      {
        seq: body.seq,
        node: IMPL,
        text: GUIDANCE,
        mode: 'next-turn',
        delivery: 'unsupported',
      },
    ]);
  });

  it('offers pause-and-inject as the alternative that always works', async ({ tmp }) => {
    served = await serve(tmp, { provider: UNSTEERABLE });

    const { body } = await post(served.origin, {
      nodeId: IMPL,
      text: GUIDANCE,
      mode: 'next-turn',
    });

    expect(body.alternative).toBe('pause-and-inject');
    expect(body.message).toContain('steer');
  });

  it('accepts pause-and-inject on that same adapter, and queues it', async ({ tmp }) => {
    served = await serve(tmp, { provider: UNSTEERABLE });

    const { status, body } = await post(served.origin, {
      nodeId: IMPL,
      text: GUIDANCE,
      mode: 'pause-and-inject',
    });

    expect(status).toBe(202);
    expect(body.delivery).toBe('queued');
    expect(stateOf(served.db).nodes[IMPL]?.status).toBe('suspended');
  });
});

// ── EPIC-13-S20 — the write lands on a world that moved ──────────────────────

suite('EPIC-13-S20 — a node that finished while the Operator typed (AC6, test plan #8)', () => {
  it('answers 409 stale_cursor and appends nothing when ifLastSeq is behind', async ({ tmp }) => {
    served = await serve(tmp);
    const cursor = events(served.db).at(-1)?.seq ?? 0;
    completeImpl(served.db);
    const before = events(served.db).length;

    const { status, body } = await post(served.origin, {
      nodeId: IMPL,
      text: GUIDANCE,
      mode: 'next-turn',
      ifLastSeq: cursor,
    });

    expect(status).toBe(409);
    expect(body.error).toBe('stale_cursor');
    expect(body.head).toBeGreaterThan(cursor);
    expect(events(served.db)).toHaveLength(before);
    expect(countOf(served.db, 'human.interjected')).toBe(0);
  });

  it('is still a typed refusal naming the terminal state without ifLastSeq', async ({ tmp }) => {
    served = await serve(tmp);
    completeImpl(served.db);
    const before = events(served.db).length;

    const { status, body } = await post(served.origin, {
      nodeId: IMPL,
      text: GUIDANCE,
      mode: 'next-turn',
    });

    expect(status).toBe(409);
    expect(body.error).toBe('node_not_running');
    expect(body.nodeStatus).toBe('completed');
    expect(body.message).toContain('completed');
    expect(events(served.db)).toHaveLength(before);
  });

  it('sends an Operator who interjected a human gate to the respond route (AC7)', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const before = events(served.db).length;

    const { status, body } = await post(served.origin, {
      nodeId: GATE,
      text: GUIDANCE,
      mode: 'next-turn',
    });

    expect(status).toBe(409);
    expect(body.error).toBe('use_respond');
    expect(body.message).toContain(RESPOND_ROUTE);
    expect(events(served.db)).toHaveLength(before);
  });

  it('refuses a node the plan never named, and one with nothing to say', async ({ tmp }) => {
    served = await serve(tmp);
    const before = events(served.db).length;

    const missing = await post(served.origin, {
      nodeId: 'never-planned',
      text: GUIDANCE,
      mode: 'next-turn',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('node_not_found');

    const empty = await post(served.origin, { nodeId: IMPL, text: '  ', mode: 'next-turn' });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe('empty_text');

    const bogus = await post(served.origin, { nodeId: IMPL, text: GUIDANCE, mode: 'shout' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.message).toContain('pause-and-inject');

    expect(events(served.db)).toHaveLength(before);
  });
});
