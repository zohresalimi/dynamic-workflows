/**
 * KAR-15.4 AC4, AC5 — the client's hydrate loop, and the gap it must not
 * notice.
 *
 * Verifies: EPIC-15-S31 (the client half), EPIC-15-S29 · AC4, AC5
 *
 * The loop is four lines and every one of them is a place the resume contract
 * is usually broken: it must page on `cursor` rather than on a count, stop on
 * `more` rather than on a short page, apply a `4, 5, 7` sequence without a word
 * about the missing `6`, and never — under any circumstance it can observe —
 * start again from zero.
 *
 * Driven through an injected `fetch` rather than a live daemon because what is
 * under test is the *loop*, not the endpoint: the endpoint is asserted against
 * a real socket over a real ledger in the daemon's
 * `integration/hydrate-events.test.ts`, and the two meet in
 * `packages/cli/test/integration/resume-cursor.test.ts`, where this exact
 * function runs against that exact endpoint.
 */
import { expect, it, describe as suite } from 'vitest';
import { createClient } from './client.ts';
import { hydrateRun } from './hydrate.ts';

const RUN = 'run_20260806T141133Z_9f2a1c';
const BASE = 'http://127.0.0.1:7777/api';

interface Requested {
  readonly since: number;
  readonly limit: string | null;
}

const event = (seq: number): Record<string, unknown> => ({
  seq,
  runId: RUN,
  ts: 1_754_140_000_000 + seq,
  kind: 'node.progress',
  v: 1,
  epoch: 7,
  payload: { node: 'n-impl-3', attempt: 1, phase: 'running' },
});

/**
 * A `fetch` serving `seqs` as pages of `pageSize`, recording what was asked
 * for. The gap fixture is served by passing a non-contiguous `seqs`.
 */
function serving(seqs: readonly number[], pageSize: number, asked: Requested[]) {
  return (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const since = Number(url.searchParams.get('since') ?? '0');
    asked.push({ since, limit: url.searchParams.get('limit') });

    const after = seqs.filter((seq) => seq > since);
    const page = after.slice(0, pageSize);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          events: page.map(event),
          cursor: page.at(-1) ?? since,
          headSeq: seqs.at(-1) ?? 0,
          more: after.length > page.length,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
}

const client = (fetch: ReturnType<typeof serving>) => createClient({ baseUrl: BASE, fetch });

suite('EPIC-15-S31 — the hydrate loop pages on the cursor (AC4)', () => {
  it('applies every event exactly once and returns the cursor to stream from', async () => {
    const seqs = Array.from({ length: 12_000 }, (_, index) => index + 1);
    const asked: Requested[] = [];
    const applied: number[] = [];

    const result = await hydrateRun(client(serving(seqs, 5000, asked)), RUN, {
      limit: 5000,
      apply: (candidate) => applied.push(candidate.seq),
    });

    expect(applied).toEqual(seqs);
    expect(result.cursor).toBe(12_000);
    expect(result.headSeq).toBe(12_000);
    expect(result.pages).toBe(3);
    // Each page asked from the previous page's cursor — never from zero, and
    // never from an offset it counted itself.
    expect(asked.map((request) => request.since)).toEqual([0, 5000, 10_000]);
    expect(asked.every((request) => request.limit === '5000')).toBe(true);
  });

  it('reports progress against headSeq while it pages', async () => {
    const seqs = Array.from({ length: 250 }, (_, index) => index + 1);
    const progress: { cursor: number; headSeq: number }[] = [];

    await hydrateRun(client(serving(seqs, 100, [])), RUN, {
      limit: 100,
      apply: () => undefined,
      onPage: (page) => progress.push({ cursor: page.cursor, headSeq: page.headSeq }),
    });

    // An honest progress bar rather than a spinner of unknown duration.
    expect(progress).toEqual([
      { cursor: 100, headSeq: 250 },
      { cursor: 200, headSeq: 250 },
      { cursor: 250, headSeq: 250 },
    ]);
  });

  it('sends no limit at all when the caller names none, taking the server default', async () => {
    const asked: Requested[] = [];
    await hydrateRun(client(serving([1, 2, 3], 1000, asked)), RUN, { apply: () => undefined });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.limit).toBeNull();
  });

  it('starts from a persisted cursor when it has one', async () => {
    const asked: Requested[] = [];
    const applied: number[] = [];
    const result = await hydrateRun(client(serving([1, 2, 3, 4, 5], 1000, asked)), RUN, {
      since: 3,
      apply: (event) => applied.push(event.seq),
    });

    expect(asked.map((request) => request.since)).toEqual([3]);
    expect(applied).toEqual([4, 5]);
    expect(result.cursor).toBe(5);
  });

  it('returns the cursor it was given when the run has nothing after it', async () => {
    const result = await hydrateRun(client(serving([1, 2, 3], 1000, [])), RUN, {
      since: 3,
      apply: () => undefined,
    });
    expect(result.cursor).toBe(3);
    expect(result.applied).toBe(0);
    expect(result.pages).toBe(1);
  });
});

suite('EPIC-15-S29 — a gap is not data loss (AC5)', () => {
  it('applies 4, 5, 7, 8, 11 in order, with no warning and no refetch', async () => {
    const asked: Requested[] = [];
    const applied: number[] = [];

    const result = await hydrateRun(client(serving([4, 5, 7, 8, 11], 2, asked)), RUN, {
      limit: 2,
      apply: (event) => applied.push(event.seq),
    });

    expect(applied).toEqual([4, 5, 7, 8, 11]);
    expect(result.cursor).toBe(11);
    // Strictly increasing cursors: nothing went back to zero, and nothing asked
    // for the same window twice.
    // Three round trips, not four: the loop stops on `more`, so the last page
    // — short, and holding the gap's far side — ends it without a fourth call.
    expect(asked.map((request) => request.since)).toEqual([0, 5, 8]);
    expect(new Set(asked.map((request) => request.since)).size).toBe(asked.length);
  });

  it('reports the count it applied, never a count of what it thinks is missing', async () => {
    const result = await hydrateRun(client(serving([4, 5, 7, 8, 11], 1000, [])), RUN, {
      apply: () => undefined,
    });
    // Five applied against a head of 11. A client comparing those two for
    // *density* would report six lost events; the only honest number is what
    // arrived, and the only honest comparison is ordering.
    expect(result.applied).toBe(5);
    expect(result.headSeq).toBe(11);
    expect(result.cursor).toBe(11);
  });
});
