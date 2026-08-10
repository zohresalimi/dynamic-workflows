/**
 * KAR-15.4 test plan #7 — the explicit hydrate path, over a real ledger
 * (docs/11-api-and-realtime.md §7.2).
 *
 * Verifies: EPIC-15-S31 · AC4
 *
 * `GET /api/runs/:id/events?since=&limit=` is what a client with no cursor
 * calls before it opens a stream at all, and the loop it drives — page until
 * `more` is false, then open the stream at `cursor` — is the only path that
 * produces neither a gap nor a duplicate at the seam. Twelve thousand events
 * rather than twelve, because the properties under test are the page boundary,
 * the cap and the `more` transition, and all three are invisible on a page that
 * fits in one call.
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { afterEach, expect, describe as suite } from 'vitest';
import { DEFAULT_HYDRATE_LIMIT, MAX_HYDRATE_LIMIT } from '../../src/http/resume.ts';
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

interface HydratePage {
  readonly events: { seq: number; runId: string; kind: string }[];
  readonly cursor: number;
  readonly headSeq: number;
  readonly more: boolean;
}

let served: Served | undefined;
const opened: OpenStream[] = [];

afterEach(async () => {
  for (const stream of opened.splice(0)) stream.close();
  await served?.close();
  served = undefined;
});

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

/** 12,000 events for `RUN_A`, interleaved with another run's — so the sequence
 * this endpoint pages over has gaps in it, exactly as a real ledger does. */
function twelveThousand(): number[] {
  const seqs: number[] = [];
  for (let batch = 0; batch < 12; batch += 1) {
    seqs.push(...appendEvents(served?.db as never, progress(RUN_A, 1000, batch * 1000)));
    appendEvents(served?.db as never, progress(RUN_B, 3, batch * 3));
  }
  return seqs;
}

async function hydrate(query: string): Promise<HydratePage> {
  const response = await fetch(`${served?.origin ?? ''}/api/runs/${RUN_A}/events?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as HydratePage;
}

suite('EPIC-15-S31 — cold-start hydrate loop, then the stream at the cursor (AC4)', () => {
  it('answers { events, cursor, headSeq, more } and pages to the end exactly once', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const all = twelveThousand();
    const runHead = all.at(-1) ?? 0;

    const applied: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await hydrate(`since=${cursor}&limit=${MAX_HYDRATE_LIMIT}`);
      pages += 1;
      applied.push(...page.events.map((event) => event.seq));
      // The progress bar's honest denominator, on every page.
      expect(page.headSeq).toBe(runHead);
      expect(page.cursor).toBe(page.events.at(-1)?.seq ?? cursor);
      cursor = page.cursor;
      if (!page.more) break;
      expect(page.events).toHaveLength(MAX_HYDRATE_LIMIT);
    }

    expect(pages).toBe(3);
    expect(applied).toEqual(all);
    expect(new Set(applied).size).toBe(12_000);
    // This run's events and nobody else's, however the global sequence
    // interleaved them.
    expect(applied.every((seq) => all.includes(seq))).toBe(true);
  });

  it('defaults limit to 1000 and caps it at 5000', async ({ tmp }) => {
    served = await serve(tmp);
    twelveThousand();

    expect((await hydrate('since=0')).events).toHaveLength(DEFAULT_HYDRATE_LIMIT);
    expect((await hydrate('since=0&limit=50000')).events).toHaveLength(MAX_HYDRATE_LIMIT);
    expect((await hydrate('since=0&limit=25')).events).toHaveLength(25);
  });

  it('opens the stream at the cursor with no gap and no duplicate at the seam', async ({ tmp }) => {
    served = await serve(tmp);
    const hydrated = twelveThousand();

    let cursor = 0;
    const applied: number[] = [];
    for (;;) {
      const page = await hydrate(`since=${cursor}&limit=${MAX_HYDRATE_LIMIT}`);
      applied.push(...page.events.map((event) => event.seq));
      cursor = page.cursor;
      if (!page.more) break;
    }

    // Committed between the last page and the stream opening — the seam.
    const between = appendEvents(served.db, progress(RUN_A, 4, 12_000));

    const stream = await openStream(served.origin, `runs=${RUN_A}&since=${cursor}`);
    opened.push(stream);
    await helloOf(stream.frames);
    const live = appendEvents(served.db, progress(RUN_A, 2, 12_004));
    await stream.frames.until(
      (frame) => frame.event === undefined && frame.id === String(live.at(-1)),
    );

    const streamed = stream.frames
      .all()
      .filter((frame) => frame.event === undefined)
      .map((frame) => (JSON.parse(frame.data) as { seq: number }).seq);

    expect(streamed).toEqual([...between, ...live]);
    const whole = [...applied, ...streamed];
    expect(whole).toEqual([...hydrated, ...between, ...live]);
    expect(new Set(whole).size).toBe(whole.length);
  });

  it('answers an empty page at the head, with the cursor the caller sent', async ({ tmp }) => {
    served = await serve(tmp);
    const all = appendEvents(served.db, progress(RUN_A, 3));
    const head = all.at(-1) ?? 0;

    const page = await hydrate(`since=${head}`);
    expect(page.events).toEqual([]);
    expect(page.more).toBe(false);
    // The cursor the caller sent, unchanged: a client that looped on a cursor
    // that reset to zero would hydrate forever.
    expect(page.cursor).toBe(head);
    expect(page.headSeq).toBe(head);
  });

  it('is a 404 for a run this directory does not hold', async ({ tmp }) => {
    served = await serve(tmp);
    const response = await fetch(`${served.origin}/api/runs/${RUN_A}/events?since=0`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'run_not_found',
    );
  });
});
