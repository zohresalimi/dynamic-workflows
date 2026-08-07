/**
 * KAR-06.6 — the `node_wake` table: every wait in the system, from a 2-second
 * retry backoff to a 30-day human gate, as one row and zero CPU
 * (docs/05-durable-execution.md §10.1).
 *
 * File-backed and reopened rather than `:memory:`, because the whole claim is
 * about a wait that outlives the process holding it. A `setTimeout` cannot be
 * reopened; a row can, and the "outlives the daemon" specs below are the code
 * path a restart actually takes.
 *
 * The load-bearing function here is `appendEventsConsumingWakes`: the row is
 * deleted **in the same transaction as the event that consumes it** (AC3). Split
 * the two and a crash in between either fires a wake whose event was lost, or
 * loses a wake whose event landed — and the second is the one nobody notices,
 * because the run simply never comes back.
 *
 * Verifies: EPIC-06-S20 (scenario 2), EPIC-06-S21 (scenario 2), EPIC-06-S22
 * (scenarios 1, 4 and 5) · AC3, AC4, AC5, AC8
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEventsConsumingWakes,
  clearWake,
  dueWakes,
  type EventDraft,
  InvalidWakeReason,
  type NodeWakeRow,
  nextWakeAt,
  openLedger,
  readRange,
  readWakes,
  scheduleWake,
  scheduleWakeIfChanged,
} from '../../src/index.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';
const OTHER_RUN = 'run_20260805T091500Z_7d3e11';
const NOW = 1_754_308_400_000;

const hours = (count: number): number => count * 3_600_000;
const days = (count: number): number => count * 86_400_000;

/** Node's ceiling: `setTimeout(2**31)` fires after ~1 ms rather than clamping. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

const wake = (over: Partial<NodeWakeRow> = {}): NodeWakeRow => ({
  runId: RUN,
  nodeId: 'gate-approve',
  wakeAt: NOW + hours(6),
  reason: 'human_gate',
  ...over,
});

/** The event a due wake is consumed by — the human answering the gate. */
const responded = (nodeId = 'gate-approve'): EventDraft => ({
  runId: RUN,
  ts: NOW + hours(6),
  kind: 'human.responded',
  v: 1,
  epoch: 1,
  nodeId,
  payload: { node: nodeId, optionId: 'approve', at: '2026-08-04T14:33:20.000Z' },
});

suite('a wait is a row (EPIC-06-S22 scenario 1, AC4)', () => {
  it('writes exactly one row per (run, node), whatever the reason', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWake(db, wake());
      expect(readWakes(db)).toEqual([wake()]);
    } finally {
      db.close();
    }
  });

  it('restates the same wait idempotently — the upsert moves the instant, never the row count', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      scheduleWake(db, wake());
      scheduleWake(db, wake());
      scheduleWake(db, wake({ wakeAt: NOW + hours(9), reason: 'poll' }));

      expect(readWakes(db)).toEqual([wake({ wakeAt: NOW + hours(9), reason: 'poll' })]);
    } finally {
      db.close();
    }
  });

  it('refuses a reason outside the closed set, so "why is this asleep" is always answerable', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      expect(() =>
        scheduleWake(db, wake({ reason: 'human-gate' as NodeWakeRow['reason'] })),
      ).toThrow(InvalidWakeReason);
      expect(readWakes(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps two runs’ waits apart', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWake(db, wake());
      scheduleWake(db, wake({ runId: OTHER_RUN, reason: 'backoff', wakeAt: NOW + 2_000 }));

      expect(readWakes(db, RUN)).toEqual([wake()]);
      expect(readWakes(db, OTHER_RUN)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

suite('a 30-day gate is honoured exactly (EPIC-06-S21 scenario 2, AC5)', () => {
  const wakeAt = NOW + days(30);

  it('stores a plain integer ms epoch — a number no timer could have held', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWake(db, wake({ wakeAt }));
      const [stored] = readWakes(db);

      expect(stored?.wakeAt).toBe(wakeAt);
      expect(Number.isSafeInteger(stored?.wakeAt)).toBe(true);
      // Which is the point: as a *delay* this is past Node's ceiling, and Node
      // does not clamp — it fires after ~1 ms.
      expect(wakeAt - NOW).toBeGreaterThan(MAX_TIMER_DELAY);
    } finally {
      db.close();
    }
  });

  it('is not due at 29 days and is due at 30, and the daemon in between died', async ({ tmp }) => {
    const first = openLedger(tmp);
    scheduleWake(first, wake({ wakeAt }));
    first.close();

    // A fresh handle over the same file: the code path a restart takes.
    const restarted = openLedger(tmp);
    try {
      expect(dueWakes(restarted, NOW + days(29))).toEqual([]);
      expect(dueWakes(restarted, wakeAt)).toEqual([wake({ wakeAt })]);
    } finally {
      restarted.close();
    }
  });

  it('reports the next instant to look at, so the ticker never guesses', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(nextWakeAt(db)).toBeNull();

      scheduleWake(db, wake({ wakeAt }));
      scheduleWake(db, wake({ nodeId: 'impl', reason: 'backoff', wakeAt: NOW + 200 }));

      expect(nextWakeAt(db)).toBe(NOW + 200);
    } finally {
      db.close();
    }
  });
});

suite('restating a wait that has not changed writes nothing (AC6)', () => {
  it('writes the row the first time and reports that it did', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(scheduleWakeIfChanged(db, wake())).toBe(true);
      expect(readWakes(db)).toEqual([wake()]);
    } finally {
      db.close();
    }
  });

  it('writes nothing when the row already says exactly that', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWakeIfChanged(db, wake());

      // `decide()` restates every pending wake on every tick — 21,600 of them
      // across a six-hour gate. Each restatement is a WAL commit if it is
      // taken literally, which is how "one row and zero CPU" quietly becomes
      // one row and six hours of fsyncs.
      expect(scheduleWakeIfChanged(db, wake())).toBe(false);
      expect(scheduleWakeIfChanged(db, wake())).toBe(false);
      expect(readWakes(db)).toEqual([wake()]);
    } finally {
      db.close();
    }
  });

  it('writes again the moment the instant or the reason moves', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWakeIfChanged(db, wake());

      expect(scheduleWakeIfChanged(db, wake({ wakeAt: NOW + hours(7) }))).toBe(true);
      expect(scheduleWakeIfChanged(db, wake({ wakeAt: NOW + hours(7), reason: 'poll' }))).toBe(
        true,
      );
      expect(readWakes(db)).toEqual([wake({ wakeAt: NOW + hours(7), reason: 'poll' })]);
    } finally {
      db.close();
    }
  });

  it('refuses a reason outside the closed set before it reads anything', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() =>
        scheduleWakeIfChanged(db, wake({ reason: 'whenever' as NodeWakeRow['reason'] })),
      ).toThrow(InvalidWakeReason);
    } finally {
      db.close();
    }
  });

  // KAR-14.4 AC2. `quota` joined the closed set when the reactive rate-limit
  // path landed, and this asserts it is on the *row* rather than translated
  // into a `backoff` on the way in — the whole reason the column exists is that
  // an operator can tell "waiting on the vendor's own reset" from "backing off".
  it('accepts quota, the fourth reason, and stores it verbatim', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWake(db, wake({ reason: 'quota' }));
      expect(readWakes(db)).toEqual([wake({ reason: 'quota' })]);
    } finally {
      db.close();
    }
  });
});

suite(
  'the row and the event that consumes it commit together (EPIC-06-S22 scenario 5, AC3)',
  () => {
    it('deletes the row and appends the event in one transaction', async ({ tmp }) => {
      const db = openLedger(tmp);
      try {
        scheduleWake(db, wake());

        const [seq] = appendEventsConsumingWakes(db, [responded()], [wake()]);

        expect(seq).toBeGreaterThan(0);
        expect(readWakes(db)).toEqual([]);
        expect(readRange(db, RUN, 0, 10).events.map((event) => event.kind)).toEqual([
          'human.responded',
        ]);
      } finally {
        db.close();
      }
    });

    it('leaves the row alone when the append is refused — a fired wake is never a lost one', async ({
      tmp,
    }) => {
      const db = openLedger(tmp);
      try {
        scheduleWake(db, wake());

        expect(() =>
          appendEventsConsumingWakes(db, [{ ...responded(), kind: '' } as EventDraft], [wake()]),
        ).toThrow();

        // Still asleep, at the same instant, with the same reason.
        expect(readWakes(db)).toEqual([wake()]);
        expect(readRange(db, RUN, 0, 10).events).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('consumes only the wakes it was handed', async ({ tmp }) => {
      const db = openLedger(tmp);
      try {
        scheduleWake(db, wake());
        scheduleWake(db, wake({ nodeId: 'impl', reason: 'backoff', wakeAt: NOW + 2_000 }));

        appendEventsConsumingWakes(db, [responded()], [wake()]);

        expect(readWakes(db).map((row) => row.nodeId)).toEqual(['impl']);
      } finally {
        db.close();
      }
    });

    it('clearWake is the same delete without an event, for a wait nothing is waiting on', async ({
      tmp,
    }) => {
      const db = openLedger(tmp);
      try {
        scheduleWake(db, wake());
        clearWake(db, { runId: RUN, nodeId: 'gate-approve' });
        expect(readWakes(db)).toEqual([]);

        // Idempotent: a wake already consumed is not an error to clear again.
        expect(() => {
          clearWake(db, { runId: RUN, nodeId: 'gate-approve' });
        }).not.toThrow();
      } finally {
        db.close();
      }
    });
  },
);

suite('the wall clock is not monotonic (EPIC-06-S22 scenario 4, AC8)', () => {
  it('fires every wake exactly once across an hour of NTP correction', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWake(db, wake({ nodeId: 'a', reason: 'backoff', wakeAt: NOW + hours(1) }));
      scheduleWake(db, wake({ nodeId: 'b', reason: 'backoff', wakeAt: NOW + hours(2) }));

      // A scripted clock that goes backwards in the middle, the way a laptop
      // waking from sleep and an NTP step both do.
      const script = [
        NOW,
        NOW + hours(1),
        NOW - hours(1), // backwards, across a wake that already fired
        NOW + hours(1),
        NOW + hours(2),
        NOW + hours(3),
      ];

      const fired: string[] = [];
      for (const now of script) {
        for (const row of dueWakes(db, now)) {
          fired.push(row.nodeId);
          appendEventsConsumingWakes(db, [responded(row.nodeId)], [row]);
        }
      }

      // Exactly once each, in wake order, and neither skipped by the step back.
      expect(fired).toEqual(['a', 'b']);
      expect(readWakes(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a wake set in the past is due immediately rather than lost', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // The daemon was asleep for a day; the row's instant is long gone.
      scheduleWake(db, wake({ wakeAt: NOW - days(1) }));
      expect(dueWakes(db, NOW)).toEqual([wake({ wakeAt: NOW - days(1) })]);
    } finally {
      db.close();
    }
  });

  it('orders due rows deterministically, so two daemons read the same list', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      scheduleWake(db, wake({ nodeId: 'z', reason: 'poll', wakeAt: NOW }));
      scheduleWake(db, wake({ nodeId: 'a', reason: 'poll', wakeAt: NOW }));
      scheduleWake(db, wake({ nodeId: 'm', reason: 'poll', wakeAt: NOW - 1 }));

      expect(dueWakes(db, NOW).map((row) => row.nodeId)).toEqual(['m', 'a', 'z']);
    } finally {
      db.close();
    }
  });
});
