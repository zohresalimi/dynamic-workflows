/**
 * KAR-16.2 test plan #2 and #6 — the tab's own cursor, and the hydrate loop
 * that fills it before a socket is ever opened.
 *
 * Verifies: EPIC-16-S7 (the persistence half), EPIC-16-S1 (the hydrate half),
 * EPIC-16-S9 · AC3, AC4, AC6
 *
 * The cursor is the whole resume contract on the client side. `Last-Event-ID`
 * is sent **only** on the browser's own automatic reconnect of a connection
 * that previously opened — never after a reload, never on the first connection
 * of a session, and never when the first connection failed to open, which is
 * the common case in development (docs/11 §4.1, verified 2026-08-02). So the
 * tab persists its own, in `sessionStorage` so it is per-tab and cannot be
 * poisoned by the tab next to it, and always opens with `?since=<it>`.
 *
 * Two properties carry the weight and both are about what the cursor refuses:
 * it never moves backwards, so an out-of-order or replayed frame cannot rewind
 * a tab into re-applying a run; and it never notices a gap, because `4, 5, 7`
 * is a healthy log and a client that "repaired" it would refetch a multi-hour
 * run over nothing (§4.2).
 */
import { expect, it, describe as suite } from 'vitest';
import { createClient } from '../api/client.ts';
import { CURSOR_STORAGE_KEY, hydrateToCursor, openCursor } from './cursor.ts';

const RUN = 'run_20260806T141133Z_9f2a1c';
const BASE = 'http://127.0.0.1:7777/api';

const event = (seq: number): Record<string, unknown> => ({
  seq,
  runId: RUN,
  ts: 1_754_140_000_000 + seq,
  kind: 'node.progress',
  v: 1,
  epoch: 7,
  payload: { node: 'n-impl-3', attempt: 1, phase: 'running' },
});

/** A `fetch` serving `seqs` as pages of `pageSize`, recording every `since`. */
function serving(seqs: readonly number[], pageSize: number, asked: number[]) {
  return (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const since = Number(url.searchParams.get('since') ?? '0');
    asked.push(since);

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

/** A fresh `Storage`, so one case cannot read another's cursor. */
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

suite('EPIC-16-S7 — the cursor is the tab’s own, and it only ever goes up (AC4)', () => {
  it('starts at zero, which means "everything" and never "from now"', () => {
    expect(openCursor(scratchStorage()).read()).toBe(0);
  });

  it('advances to a higher seq and refuses a lower one', () => {
    const cursor = openCursor(scratchStorage());
    expect(cursor.advance(4)).toBe(4);
    expect(cursor.advance(7)).toBe(7);
    // The replayed frame a reconnect's backfill overlap produces. A cursor that
    // took it would re-request everything between the two, forever.
    expect(cursor.advance(5)).toBe(7);
    expect(cursor.read()).toBe(7);
  });

  it('survives the reload: a fresh cursor over the same storage reads it back', () => {
    const storage = scratchStorage();
    openCursor(storage).advance(8200);

    // The reload. Nothing of the old tab survives except this one string.
    expect(openCursor(storage).read()).toBe(8200);
    expect(storage.getItem(CURSOR_STORAGE_KEY)).toBe('8200');
  });

  it('reads zero rather than NaN out of a storage some other tool scribbled on', () => {
    const storage = scratchStorage();
    storage.setItem(CURSOR_STORAGE_KEY, 'the-daemon-was-here');
    expect(openCursor(storage).read()).toBe(0);
  });

  it('keeps working in memory when the storage itself refuses to write', () => {
    // Safari's private mode, and a quota that is already full. A tab that threw
    // here would lose the stream over a preference it cannot control.
    const refusing: Storage = {
      ...scratchStorage(),
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    };
    const cursor = openCursor(refusing);
    expect(() => cursor.advance(12)).not.toThrow();
    expect(cursor.read()).toBe(12);
  });

  it('is one cursor per tab, because seq is one global sequence', () => {
    // Not one per run: `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT` over the
    // whole ledger, so the number a stream resumes from is the tab's, not a
    // run's, and a per-run cursor would open the stream at the wrong place the
    // moment two runs interleave.
    expect(CURSOR_STORAGE_KEY).toBe('DeFlow.cursor');
  });
});

suite('EPIC-16-S1 — the cold hydrate fills the cursor before a socket opens (AC3)', () => {
  it('pages until more is false and leaves the cursor at the head', async () => {
    const seqs = Array.from({ length: 4127 }, (_, index) => index + 1);
    const asked: number[] = [];
    const applied: number[] = [];
    const cursor = openCursor(scratchStorage());

    const result = await hydrateToCursor(
      createClient({ baseUrl: BASE, fetch: serving(seqs, 1000, asked) }),
      RUN,
      cursor,
      { apply: (event) => applied.push(event.seq) },
    );

    expect(applied).toHaveLength(4127);
    expect(result.cursor).toBe(4127);
    expect(cursor.read()).toBe(4127);
    expect(asked).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('reports honest progress against headSeq rather than a spinner', async () => {
    const seqs = Array.from({ length: 250 }, (_, index) => index + 1);
    const progress: string[] = [];

    await hydrateToCursor(
      createClient({ baseUrl: BASE, fetch: serving(seqs, 100, []) }),
      RUN,
      openCursor(scratchStorage()),
      {
        limit: 100,
        apply: () => undefined,
        onProgress: (page) => progress.push(`${page.cursor} of ${page.headSeq}`),
      },
    );

    expect(progress).toEqual(['100 of 250', '200 of 250', '250 of 250']);
  });

  it('advances the persisted cursor page by page, so a reload mid-hydrate resumes', async () => {
    const storage = scratchStorage();
    const seen: number[] = [];
    await hydrateToCursor(
      createClient({ baseUrl: BASE, fetch: serving([1, 2, 3, 4, 5, 6], 2, []) }),
      RUN,
      openCursor(storage),
      {
        limit: 2,
        apply: () => undefined,
        onProgress: () => seen.push(Number(storage.getItem(CURSOR_STORAGE_KEY))),
      },
    );

    // Not one write at the end: a tab closed mid-hydrate would otherwise come
    // back and fold the whole run again.
    expect(seen).toEqual([2, 4, 6]);
  });

  it('resumes from the cursor it was handed, and asks for nothing before it', async () => {
    const storage = scratchStorage();
    openCursor(storage).advance(8200);
    const asked: number[] = [];
    const applied: number[] = [];

    await hydrateToCursor(
      createClient({ baseUrl: BASE, fetch: serving([8199, 8200, 8201, 8202], 1000, asked) }),
      RUN,
      openCursor(storage),
      { apply: (event) => applied.push(event.seq) },
    );

    expect(asked).toEqual([8200]);
    expect(applied).toEqual([8201, 8202]);
  });

  it('applies a ledger with gaps without a word about the missing numbers', async () => {
    const asked: number[] = [];
    const applied: number[] = [];
    const cursor = openCursor(scratchStorage());

    // The crash-resume fixture's shape: 6, 9 and 10 were allocated by
    // transactions that rolled back, and AUTOINCREMENT never reissues them.
    const result = await hydrateToCursor(
      createClient({ baseUrl: BASE, fetch: serving([4, 5, 7, 8, 12], 2, asked) }),
      RUN,
      cursor,
      { limit: 2, apply: (event) => applied.push(event.seq) },
    );

    expect(applied).toEqual([4, 5, 7, 8, 12]);
    expect(cursor.read()).toBe(12);
    expect(result.applied).toBe(5);
    // Five applied against a head of 12, and nothing anywhere calls that seven
    // lost events. Every window was asked for exactly once.
    expect(new Set(asked).size).toBe(asked.length);
  });
});
