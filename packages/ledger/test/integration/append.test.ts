/**
 * KAR-03.3 — the append path and `readRange`, against a real file-backed
 * ledger opened through `openLedger`.
 *
 * File-backed and not `:memory:` on purpose: scenario 3 of EPIC-03-S1 is a
 * reopen, which is the code path a daemon restart takes, and an in-memory
 * database cannot be reopened at all.
 *
 * Verifies: EPIC-03-S1 (scenarios 2 and 3) · AC2, AC4, AC6
 */

import { NodeIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { appendEvents, InvalidEventEnvelope, openLedger, readRange } from '../../src/index.ts';
import { draft, drafts, RUN_A } from './support/events.ts';

suite('appending returns the assigned sequence numbers (EPIC-03-S1 scenario 2)', () => {
  it('returns [1, 2, 3] for the first three events of a fresh ledger', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(appendEvents(db, drafts(3))).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it('reads them back in seq order', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, drafts(3));
      const page = readRange(db, RUN_A, 0, 100);
      expect(page.events.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(page.events.map((event) => event.payload)).toEqual([
        { ordinal: 0 },
        { ordinal: 1 },
        { ordinal: 2 },
      ]);
      expect(page.hasMore).toBe(false);
    } finally {
      db.close();
    }
  });

  it('round-trips the whole envelope, including the optional columns', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const [seq] = appendEvents(db, [
        draft({
          nodeId: NodeIdSchema.parse('n1'),
          attempt: 2,
          ts: 17,
          kind: 'node.started',
          v: 3,
          epoch: 4,
        }),
      ]);
      const [stored] = readRange(db, RUN_A, 0, 10).events;
      expect(stored).toEqual({
        seq,
        runId: RUN_A,
        ts: 17,
        kind: 'node.started',
        v: 3,
        epoch: 4,
        nodeId: 'n1',
        attempt: 2,
        payload: { note: 'fixture' },
      });
      // Absent, not null: an envelope that never carried an ikey must not come
      // back carrying one.
      expect(stored && 'ikey' in stored).toBe(false);
    } finally {
      db.close();
    }
  });

  it('appends nothing and returns [] for an empty batch', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(appendEvents(db, [])).toEqual([]);
      expect(readRange(db, RUN_A, 0, 10).events).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('a batch of 100 is one transaction (AC2)', () => {
  it('returns 100 strictly increasing seqs and moves the high-water mark', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const seqs = appendEvents(db, drafts(100));
      expect(seqs).toHaveLength(100);
      expect(seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? 0))).toBe(true);

      const highWater = db
        .prepare<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'event'")
        .get();
      expect(highWater).toEqual({ seq: seqs.at(-1) });
    } finally {
      db.close();
    }
  });

  it('writes nothing at all when one event in the batch is not appendable', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, drafts(2));
      const poisoned = drafts(5);
      // A batch is validated as a unit before a row is written: the fourth
      // draft's `v` is not a positive integer, and the whole batch is refused.
      poisoned[3] = { ...draft(), v: 0 };
      expect(() => appendEvents(db, poisoned)).toThrow(InvalidEventEnvelope);
      expect(readRange(db, RUN_A, 0, 100).events.map((event) => event.seq)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });
});

suite('readRange is a strictly-greater-than cursor (AC4)', () => {
  it('returns [] when afterSeq is the last seq it returned', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const seqs = appendEvents(db, drafts(3));
      const last = seqs.at(-1) ?? 0;
      expect(readRange(db, RUN_A, last, 100).events).toEqual([]);
      expect(readRange(db, RUN_A, last, 100).hasMore).toBe(false);
    } finally {
      db.close();
    }
  });

  it('honours limit and reports that more remain', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, drafts(10));
      const first = readRange(db, RUN_A, 0, 4);
      expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(first.hasMore).toBe(true);

      const second = readRange(db, RUN_A, first.events.at(-1)?.seq ?? 0, 4);
      expect(second.events.map((event) => event.seq)).toEqual([5, 6, 7, 8]);
      expect(second.hasMore).toBe(true);

      const third = readRange(db, RUN_A, second.events.at(-1)?.seq ?? 0, 4);
      expect(third.events.map((event) => event.seq)).toEqual([9, 10]);
      expect(third.hasMore).toBe(false);
    } finally {
      db.close();
    }
  });

  it('refuses a limit that is not a positive integer', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => readRange(db, RUN_A, 0, 0)).toThrow(RangeError);
      expect(() => readRange(db, RUN_A, 0, 1.5)).toThrow(RangeError);
      expect(() => readRange(db, RUN_A, -1, 10)).toThrow(RangeError);
    } finally {
      db.close();
    }
  });
});

suite('reopening finds the same events (EPIC-03-S1 scenario 3)', () => {
  it('returns the same three events with the same seqs after a close and reopen', ({ tmp }) => {
    const first = openLedger(tmp);
    let before: unknown;
    try {
      appendEvents(first, drafts(3));
      before = readRange(first, RUN_A, 0, 100).events;
    } finally {
      first.close();
    }

    const second = openLedger(tmp);
    try {
      expect(readRange(second, RUN_A, 0, 100).events).toEqual(before);
      // Continuing after a restart continues the sequence rather than
      // restarting it.
      expect(appendEvents(second, drafts(1))).toEqual([4]);
    } finally {
      second.close();
    }
  });
});

suite('every appended row carries an epoch and a v (AC6)', () => {
  it('has no row with a null epoch', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [draft({ epoch: 1 }), draft({ epoch: 2 })]);
      const nulls = db
        .prepare<{ n: number }>('SELECT count(*) AS n FROM event WHERE epoch IS NULL OR v IS NULL')
        .get();
      expect(nulls).toEqual({ n: 0 });
      expect(readRange(db, RUN_A, 0, 10).events.map((event) => event.epoch)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });
});
