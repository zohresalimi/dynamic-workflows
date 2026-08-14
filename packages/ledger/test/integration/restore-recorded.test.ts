/**
 * KAR-16.5 — restoring a recorded run into a ledger of its own, `seq` and all.
 *
 * Verifies: EPIC-16-S31, EPIC-16-S32, EPIC-16-S34 · AC1, AC6, AC9
 *
 * `deflow replay` serves the **normal** routes, and every one of them reads
 * SQLite. So a fixture becomes servable by being restored into a real
 * `ledger.db`, which is the whole reason the harness needs no second read path
 * and the UI needs no branch: the daemon it talks to is a daemon.
 *
 * File-backed, never `:memory:` — `AUTOINCREMENT`, `sqlite_sequence` and the
 * `event` table's own PRIMARY KEY behaviour are exactly what is under test, and
 * an in-memory database would be testing the same code against a different
 * durability story (docs/14-testing-strategy.md §5).
 */
import { canonicalJson, type Db, type PlanGraph } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  openLedger,
  readPlanDoc,
  readRange,
  restoreRecordedEvents,
  SeqNotAhead,
  type StoredEvent,
} from '../../src/index.ts';

const RUN = 'run_20260811T090000Z_a1b2c3';
const OTHER = 'run_20260811T101500Z_b7c9d2';
const T0 = 1_786_438_800_000;

const event = (over: Partial<StoredEvent> = {}): StoredEvent =>
  ({
    seq: 1,
    runId: RUN,
    ts: T0,
    kind: 'node.progress',
    v: 1,
    epoch: 3,
    payload: { node: 'impl', attempt: 1, phase: 'running', message: 'working' },
    ...over,
  }) as StoredEvent;

const seqsOf = (db: Db, runId: string): number[] =>
  readRange(db, runId, 0, 1_000).events.map((row) => row.seq);

suite('a recorded ledger comes back exactly as it was recorded', () => {
  it('restores every event under its own recorded seq', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const restored = await restoreRecordedEvents(db, [
        event({ seq: 4 }),
        event({ seq: 5 }),
        event({ seq: 7 }),
      ]);

      expect(restored.restored).toBe(3);
      expect(restored.headSeq).toBe(7);
      expect(seqsOf(db, RUN)).toEqual([4, 5, 7]);
    } finally {
      db.close();
    }
  });

  it('keeps the holes a real crash left, rather than renumbering them (AC9)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await restoreRecordedEvents(db, [
        event({ seq: 4 }),
        event({ seq: 5 }),
        event({ seq: 7, runId: OTHER }),
        event({ seq: 11 }),
      ]);

      // 7 belongs to the other run. A client resuming this one at 5 must be
      // served 11 next, with nothing anywhere saying a number went missing.
      expect(seqsOf(db, RUN)).toEqual([4, 5, 11]);
      expect(seqsOf(db, OTHER)).toEqual([7]);
    } finally {
      db.close();
    }
  });

  it('leaves the sequence where the recording left it, so a later append never reuses a number', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      await restoreRecordedEvents(db, [event({ seq: 4 }), event({ seq: 11 })]);

      const [next] = appendEvents(db, [
        {
          runId: RUN,
          ts: T0 + 1,
          kind: 'node.progress',
          v: 1,
          epoch: 3,
          payload: { node: 'impl', attempt: 1, phase: 'running', message: 'live' },
        },
      ]);

      // Not 12-by-luck: `AUTOINCREMENT` must have been told where the recording
      // got to, or a replayed fixture's own tail would collide with it.
      expect(next).toBe(12);
    } finally {
      db.close();
    }
  });

  it('preserves the whole envelope, payload included', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const recorded = event({
        seq: 9,
        nodeId: 'impl-checkout',
        attempt: 2,
        kind: 'node.finished',
        payload: { node: 'impl-checkout', attempt: 2, outcome: 'ok' },
      });
      await restoreRecordedEvents(db, [recorded]);

      const [read] = readRange(db, RUN, 0, 10).events;
      expect(read).toEqual(recorded);
    } finally {
      db.close();
    }
  });
});

suite('what restoring refuses to be used for', () => {
  it('refuses a seq at or below the head — never a graft into history', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await restoreRecordedEvents(db, [event({ seq: 4 }), event({ seq: 7 })]);

      // The property that keeps this out of the daemon's write path: a restore
      // may only ever extend a ledger, never edit one. `event` is append-only,
      // and a restore that could write below the head is a restore that can
      // rewrite history under a client whose cursor is already past it.
      await expect(restoreRecordedEvents(db, [event({ seq: 7 })])).rejects.toThrow(SeqNotAhead);
      await expect(restoreRecordedEvents(db, [event({ seq: 5 })])).rejects.toThrow(SeqNotAhead);
      expect(seqsOf(db, RUN)).toEqual([4, 7]);
    } finally {
      db.close();
    }
  });

  it('accepts the next slice of the same recording — this is how playback commits', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      // `deflow replay` commits a recording in the slices its speed schedule
      // makes due, so the stream delivers a run over time exactly as the live
      // daemon's writer would. Each slice is ahead of the last.
      await restoreRecordedEvents(db, [event({ seq: 4 }), event({ seq: 5 })]);
      const second = await restoreRecordedEvents(db, [event({ seq: 7 }), event({ seq: 11 })]);

      expect(second.headSeq).toBe(11);
      expect(seqsOf(db, RUN)).toEqual([4, 5, 7, 11]);
    } finally {
      db.close();
    }
  });

  it('refuses an envelope the Event schema does not accept', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await expect(
        restoreRecordedEvents(db, [{ seq: 1, runId: RUN, ts: T0 } as unknown as StoredEvent]),
      ).rejects.toThrow(/kind/);
      expect(seqsOf(db, RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('writes nothing at all when one event of the batch is bad', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await expect(
        restoreRecordedEvents(db, [
          event({ seq: 4 }),
          { ...event({ seq: 5 }), kind: '' } as StoredEvent,
        ]),
      ).rejects.toThrow();
      expect(seqsOf(db, RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('the content-addressed plan table is restored with the events (AC1)', () => {
  it('files the graph a plan.proposed carries, so /plans/:version answers', async ({ tmp }) => {
    const proposed = recordedPlanProposed();
    const graph = proposed.payload.graph;
    const db = openLedger(tmp);
    try {
      await restoreRecordedEvents(db, [proposed as unknown as StoredEvent]);

      // The `plan` table is content-addressed and immutable, and it is the one
      // thing an `event` export cannot reconstruct by itself — the doc lives
      // inline on `plan.proposed`, so restoring it is a re-file of the same
      // bytes under the same address, never a re-derivation.
      expect(readPlanDoc(db, graph.planHash)).toBe(canonicalJson(graph));
    } finally {
      db.close();
    }
  });

  it('refuses a graph that does not address its own hash', async ({ tmp }) => {
    const proposed = recordedPlanProposed();
    const forged = `sha256-${'0'.repeat(64)}`;
    const db = openLedger(tmp);
    try {
      await expect(
        restoreRecordedEvents(db, [
          {
            ...proposed,
            payload: {
              ...proposed.payload,
              planHash: forged,
              graph: { ...proposed.payload.graph, planHash: forged },
            },
          } as unknown as StoredEvent,
        ]),
      ).rejects.toThrow(/hash/i);
    } finally {
      db.close();
    }
  });
});

/**
 * A real `plan.proposed`, out of the committed `three-patches` recording.
 *
 * Read rather than authored: the point of the assertion is that the *recorded*
 * shape re-files, and a graph written by hand here would be testing the
 * restore against a document the emitters never produced.
 */
function recordedPlanProposed(): {
  seq: number;
  kind: string;
  payload: { planHash: string; graph: PlanGraph };
} {
  const path = fileURLToPath(
    new URL('../../../../test/fixtures/runs/three-patches/events.jsonl', import.meta.url),
  );
  const events = readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { seq: number; kind: string; payload: unknown });
  const proposed = events.find((one) => one.kind === 'plan.proposed');
  if (proposed === undefined) throw new Error('three-patches holds no plan.proposed');
  return proposed as ReturnType<typeof recordedPlanProposed>;
}
