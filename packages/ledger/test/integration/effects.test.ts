/**
 * KAR-06.3 — the write-ahead effect journal at the storage layer: the
 * insert-or-read that makes two callers agree on one row, the derived ordinal
 * that survives a restart, and the triggers that make the row's history
 * unrewritable (docs/05-durable-execution.md §8.2).
 *
 * File-backed throughout, never `:memory:`. Every claim here is a claim about
 * what a *dead* daemon left behind, and an in-memory database cannot be
 * reopened, so it would test nothing (docs/14-testing-strategy.md §7).
 *
 * Verifies: EPIC-06-S8, EPIC-06-S9, EPIC-06-S11 · AC2, AC3, AC6, AC8
 */
import type { NodeFailure } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  type EffectRowDraft,
  type EventDraft,
  journalEffect,
  markEffectDone,
  markEffectFailed,
  nextOrdinal,
  openLedger,
  readEffect,
  readEffects,
  readRange,
} from '../../src/index.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';
const HASH = `sha256-${'a'.repeat(64)}`;
const IKEY = `${RUN}/implement/0/0`;

const draft = (over: Partial<EffectRowDraft> = {}): EffectRowDraft => ({
  ikey: IKEY,
  runId: RUN,
  nodeId: 'implement',
  attempt: 0,
  ordinal: 0,
  kind: 'agent',
  requestHash: HASH,
  startedAt: 1_754_313_093_000,
  ...over,
});

const startedEvent = (over: Partial<EffectRowDraft> = {}): EventDraft => {
  const row = draft(over);
  return {
    runId: row.runId,
    ts: row.startedAt,
    kind: 'effect.started',
    v: 1,
    epoch: 1,
    nodeId: row.nodeId,
    attempt: row.attempt,
    ikey: row.ikey,
    payload: { ikey: row.ikey, kind: row.kind, requestHash: row.requestHash },
  };
};

const completedEvent = (result: unknown, over: Partial<EffectRowDraft> = {}): EventDraft => {
  const row = draft(over);
  return {
    runId: row.runId,
    ts: row.startedAt + 5,
    kind: 'effect.completed',
    v: 1,
    epoch: 1,
    nodeId: row.nodeId,
    attempt: row.attempt,
    ikey: row.ikey,
    payload: { ikey: row.ikey, result, reconciled: false },
  };
};

const failure: NodeFailure = {
  reason: 'agent.nonzero-exit',
  class: 'permanent',
  message: 'the agent exited 2',
  evidence: [],
  occurredAtEvent: 1,
  attempt: 0,
};

const failedEvent = (over: Partial<EffectRowDraft> = {}): EventDraft => {
  const row = draft(over);
  return {
    runId: row.runId,
    ts: row.startedAt + 5,
    kind: 'effect.failed',
    v: 1,
    epoch: 1,
    nodeId: row.nodeId,
    attempt: row.attempt,
    ikey: row.ikey,
    payload: { ikey: row.ikey, failure },
  };
};

suite('the intent row and effect.started are one transaction (AC2)', () => {
  it('writes both, and the row is pending with started_at set', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const journalled = journalEffect(db, draft(), startedEvent());

      expect(journalled.created).toBe(true);
      expect(journalled.row).toEqual({
        ...draft(),
        state: 'pending',
        resultJson: null,
        endedAt: null,
      });
      expect(readRange(db, RUN, 0, 10).events.map((event) => event.kind)).toEqual([
        'effect.started',
      ]);
    } finally {
      db.close();
    }
  });

  it('writes neither when the event is refused, so no intent outlives its record', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      expect(() =>
        journalEffect(db, draft(), { ...startedEvent(), kind: '' } as EventDraft),
      ).toThrow();

      expect(readEffect(db, IKEY)).toBeUndefined();
      expect(readRange(db, RUN, 0, 10).events).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('leaves the pending row behind for the next daemon life', async ({ tmp }) => {
    const first = openLedger(tmp);
    journalEffect(first, draft(), startedEvent());
    first.close();

    const second = openLedger(tmp);
    try {
      expect(readEffect(second, IKEY)?.state).toBe('pending');
    } finally {
      second.close();
    }
  });
});

suite('ON CONFLICT DO NOTHING then SELECT returns the pre-existing row (AC3)', () => {
  it('leaves one row and reports the second caller as not the creator', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const first = journalEffect(db, draft(), startedEvent());
      const second = journalEffect(db, draft({ requestHash: `sha256-${'b'.repeat(64)}` }), {
        ...startedEvent(),
        payload: { ikey: IKEY, kind: 'agent', requestHash: `sha256-${'b'.repeat(64)}` },
      });

      expect(second.created).toBe(false);
      // The pre-existing row, not the one the second caller proposed: the
      // conflicting request_hash is what durable() compares and rejects.
      expect(second.row).toEqual(first.row);
      expect(readEffects(db, RUN)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('appends effect.started exactly once, however many callers journal it', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      journalEffect(db, draft(), startedEvent());
      journalEffect(db, draft(), startedEvent());

      expect(readRange(db, RUN, 0, 10).events).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

suite('a row moves pending -> done | failed and records the outcome', () => {
  it('records the memoised result and ended_at with effect.completed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      markEffectDone(
        db,
        IKEY,
        { sessionId: 's-1' },
        1_754_313_098_000,
        completedEvent({
          sessionId: 's-1',
        }),
      );

      const row = readEffect(db, IKEY);
      expect(row?.state).toBe('done');
      expect(row?.endedAt).toBe(1_754_313_098_000);
      expect(JSON.parse(row?.resultJson ?? 'null')).toEqual({ sessionId: 's-1' });
      expect(readRange(db, RUN, 0, 10).events.map((event) => event.kind)).toEqual([
        'effect.started',
        'effect.completed',
      ]);
    } finally {
      db.close();
    }
  });

  it('records the NodeFailure verbatim with effect.failed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      markEffectFailed(db, IKEY, failure, 1_754_313_098_000, failedEvent());

      const row = readEffect(db, IKEY);
      expect(row?.state).toBe('failed');
      expect(JSON.parse(row?.resultJson ?? 'null')).toEqual(failure);
    } finally {
      db.close();
    }
  });

  it('refuses to complete an ikey that was never journalled', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => markEffectDone(db, IKEY, 1, 1_754_313_098_000, completedEvent(1))).toThrow(
        /never journalled|no pending effect/i,
      );
      expect(readRange(db, RUN, 0, 10).events).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('the journal is not rewritable (AC8, test plan #8)', () => {
  it('rejects moving a done row back to pending', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      markEffectDone(db, IKEY, 1, 1_754_313_098_000, completedEvent(1));

      expect(() =>
        db.prepare(`UPDATE effect SET state = 'pending' WHERE ikey = ?`).run(IKEY),
      ).toThrow(/pending/i);
      expect(readEffect(db, IKEY)?.state).toBe('done');
    } finally {
      db.close();
    }
  });

  it('rejects moving a done row to failed, or a failed row to done', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      markEffectDone(db, IKEY, 1, 1_754_313_098_000, completedEvent(1));
      expect(() =>
        db.prepare(`UPDATE effect SET state = 'failed' WHERE ikey = ?`).run(IKEY),
      ).toThrow();

      const other = draft({ ikey: `${RUN}/implement/0/1`, ordinal: 1 });
      journalEffect(db, other, startedEvent({ ikey: other.ikey, ordinal: 1 }));
      markEffectFailed(db, other.ikey, failure, 1, failedEvent({ ikey: other.ikey, ordinal: 1 }));
      expect(() =>
        db.prepare(`UPDATE effect SET state = 'done' WHERE ikey = ?`).run(other.ikey),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects rewriting the memoised result of a done row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      markEffectDone(db, IKEY, 1, 1_754_313_098_000, completedEvent(1));

      expect(() =>
        db.prepare(`UPDATE effect SET result_json = '99' WHERE ikey = ?`).run(IKEY),
      ).toThrow();
      expect(readEffect(db, IKEY)?.resultJson).toBe('1');
    } finally {
      db.close();
    }
  });

  it('rejects rewriting the request_hash of a pending row while completing it', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());

      expect(() =>
        db
          .prepare(
            `UPDATE effect SET state = 'done', request_hash = 'sha256-${'c'.repeat(64)}' WHERE ikey = ?`,
          )
          .run(IKEY),
      ).toThrow(/request_hash|identity/i);
      expect(readEffect(db, IKEY)?.requestHash).toBe(HASH);
    } finally {
      db.close();
    }
  });

  it('rejects deleting a row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());

      expect(() => db.prepare('DELETE FROM effect WHERE ikey = ?').run(IKEY)).toThrow();
      expect(readEffect(db, IKEY)).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('rejects an insert that is born anything but pending', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO effect (ikey, run_id, node_id, attempt, ordinal, kind, request_hash, state, started_at)
             VALUES (?, ?, 'implement', 0, 0, 'agent', ?, 'done', 1)`,
          )
          .run(IKEY, RUN, HASH),
      ).toThrow(/pending/i);
    } finally {
      db.close();
    }
  });
});

suite('nextOrdinal is derived from the journal, never counted (AC6)', () => {
  it('is 0 for an attempt that has journalled nothing', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(nextOrdinal(db, { runId: RUN, nodeId: 'implement', attempt: 0 })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('counts the intents of that triple only — not another node, attempt or run', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      journalEffect(
        db,
        draft({ ikey: `${RUN}/migrate/0/0`, nodeId: 'migrate' }),
        startedEvent({ ikey: `${RUN}/migrate/0/0`, nodeId: 'migrate' }),
      );
      journalEffect(
        db,
        draft({ ikey: `${RUN}/implement/1/0`, attempt: 1 }),
        startedEvent({ ikey: `${RUN}/implement/1/0`, attempt: 1 }),
      );

      expect(nextOrdinal(db, { runId: RUN, nodeId: 'implement', attempt: 0 })).toBe(1);
      expect(nextOrdinal(db, { runId: RUN, nodeId: 'migrate', attempt: 0 })).toBe(1);
      expect(nextOrdinal(db, { runId: RUN, nodeId: 'implement', attempt: 1 })).toBe(1);
      expect(nextOrdinal(db, { runId: RUN, nodeId: 'implement', attempt: 2 })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('does not restart at 0 when the process that wrote the first effect is gone', async ({
    tmp,
  }) => {
    const first = openLedger(tmp);
    journalEffect(first, draft(), startedEvent());
    markEffectDone(first, IKEY, 1, 1_754_313_098_000, completedEvent(1));
    first.close();

    const second = openLedger(tmp);
    try {
      expect(nextOrdinal(second, { runId: RUN, nodeId: 'implement', attempt: 0 })).toBe(1);
    } finally {
      second.close();
    }
  });

  it('counts a pending intent too — an effect that started is an effect that happened', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      expect(nextOrdinal(db, { runId: RUN, nodeId: 'implement', attempt: 0 })).toBe(1);
    } finally {
      db.close();
    }
  });
});
