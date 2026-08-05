/**
 * KAR-03.8 — `openAndReplay`, the daemon's start-of-life rebuild
 * (docs/05-durable-execution.md §14, EPIC-03-S16, EPIC-03-S24 scenario 3).
 *
 * `replayRun` (KAR-03.6) is the per-run half. This is the whole of it: open the
 * data directory, migrate it, find every run it holds, and hand back the state
 * each one folds to — the map DeFlowd starts serving from.
 *
 * File-backed and never in-process, because the property under test is a
 * *restart*: the ledger is written by one engine, that engine is closed, and a
 * **fresh** one is constructed over the same file. Reusing the open handle
 * would test the handle, and it is the one thing a daemon restart never does.
 *
 * Verifies: EPIC-03-S16, EPIC-03-S24 (scenario 3), EPIC-03-S27 · AC1, AC3, AC4
 */
import {
  type Db,
  describeSkipped,
  foldEvents,
  initialRunState,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  drainEvents,
  type EventDraft,
  openAndReplay,
  openLedger,
  RunCheckpointer,
  replayAll,
} from '../../src/index.ts';
import { CHECKPOINT_RUN, checkpointRun, OTHER_RUN } from './support/checkpoint-run.ts';

/** A third run, so "every run in the directory" is more than a pair. */
const THIRD_RUN: RunId = RunIdSchema.parse('run_20260805T090002Z_1b9c55');

/** Enough nodes that the corpus is over the 5,000 events the test plan asks for. */
const BIG_RUN_NODES = 400;

/** The seq the hand-made hole is punched at (test plan #3). */
const GAP_AT = 412;

const APPEND_BATCH = 250;

/** The cold path, spelled out rather than borrowed, so the comparison is real. */
const coldFold = (db: Db, runId: RunId) =>
  foldEvents(drainEvents(db, runId), initialRunState()).state;

/**
 * Writes `drafts` the way a daemon does — through a checkpointer, in batches,
 * so the ledger left behind carries a real cache — and returns the projection
 * that process held in memory when it stopped.
 */
function writeAsPreviousProcess(db: Db, runId: RunId, drafts: readonly EventDraft[]) {
  const checkpointer = new RunCheckpointer(db, runId);
  for (let index = 0; index < drafts.length; index += APPEND_BATCH) {
    checkpointer.append(drafts.slice(index, index + APPEND_BATCH));
  }
  checkpointer.quiesce();
  return checkpointer.state;
}

suite('openAndReplay rebuilds the previous process’s state (AC1)', () => {
  it('reconstructs a 5,000-event run deeply equal to the state that wrote it', ({ tmp }) => {
    const drafts = checkpointRun({ nodes: BIG_RUN_NODES });
    expect(drafts.length).toBeGreaterThan(5_000);

    const writer = openLedger(tmp);
    const inMemory = writeAsPreviousProcess(writer, CHECKPOINT_RUN, drafts);
    // The process that wrote it is gone. Everything after this line is a
    // different engine over the same bytes.
    writer.close();

    const opened = openAndReplay(tmp);
    try {
      expect(opened.runs.get(CHECKPOINT_RUN)).toEqual(inMemory);
    } finally {
      opened.db.close();
    }
  });

  it('agrees with a cold fold of the same file, cache or no cache', ({ tmp }) => {
    const writer = openLedger(tmp);
    writeAsPreviousProcess(writer, CHECKPOINT_RUN, checkpointRun({ nodes: 24 }));
    writer.close();

    const opened = openAndReplay(tmp);
    try {
      expect(opened.replays[0]?.source).toBe('checkpoint');
      expect(opened.runs.get(CHECKPOINT_RUN)).toEqual(coldFold(opened.db, CHECKPOINT_RUN));
    } finally {
      opened.db.close();
    }
  });

  it('holds every run the directory contains, in the order they were started', ({ tmp }) => {
    const writer = openLedger(tmp);
    for (const runId of [CHECKPOINT_RUN, OTHER_RUN, THIRD_RUN]) {
      writeAsPreviousProcess(writer, runId, checkpointRun({ nodes: 3, runId }));
    }
    writer.close();

    const opened = openAndReplay(tmp);
    try {
      expect([...opened.runs.keys()]).toEqual([CHECKPOINT_RUN, OTHER_RUN, THIRD_RUN]);
      for (const runId of opened.runs.keys()) {
        expect(opened.runs.get(runId)).toEqual(coldFold(opened.db, runId));
      }
    } finally {
      opened.db.close();
    }
  });

  it('migrates an empty data directory and serves an empty map rather than throwing', ({ tmp }) => {
    const opened = openAndReplay(tmp);
    try {
      expect(opened.runs.size).toBe(0);
      expect(opened.headSeq).toBe(0);
      expect(opened.db.pragma('user_version')).toBeGreaterThan(0);
    } finally {
      opened.db.close();
    }
  });

  it('reports the head seq the ledger reached, across every run', ({ tmp }) => {
    const writer = openLedger(tmp);
    writeAsPreviousProcess(writer, CHECKPOINT_RUN, checkpointRun({ nodes: 3 }));
    writeAsPreviousProcess(writer, OTHER_RUN, checkpointRun({ nodes: 3, runId: OTHER_RUN }));
    const highest =
      writer.prepare<{ last: number }>('SELECT max(seq) AS last FROM event').get()?.last ?? 0;
    writer.close();

    const opened = openAndReplay(tmp);
    try {
      expect(opened.headSeq).toBe(highest);
    } finally {
      opened.db.close();
    }
  });
});

suite('a sequence gap is replayed, never repaired (AC3, EPIC-03-S24 scenario 3)', () => {
  /**
   * The hole is punched by deleting a row, which is the one thing that really
   * produces a permanent gap: `AUTOINCREMENT` never reissues a deleted number
   * (test/integration/sequence-gaps.test.ts records why a rollback does not).
   */
  const seedWithHole = (tmp: string): { removed: EventDraft; expected: unknown } => {
    const writer = openLedger(tmp);
    writeAsPreviousProcess(writer, CHECKPOINT_RUN, checkpointRun({ nodes: 60 }));
    const before = [...drainEvents(writer, CHECKPOINT_RUN)];
    const removed = before.find((event) => event.seq === GAP_AT);
    if (removed === undefined) throw new Error(`the corpus has no event at seq ${GAP_AT}`);

    writer.prepare('DELETE FROM event WHERE seq = ?').run(GAP_AT);
    // The cache still claims a `last_seq` from before the hole, exactly as a
    // surviving checkpoint would after a crash.
    const expected = coldFold(writer, CHECKPOINT_RUN);
    writer.close();
    return { removed, expected };
  };

  it('replays without error and without inventing the missing row', ({ tmp }) => {
    const { expected } = seedWithHole(tmp);

    const opened = openAndReplay(tmp);
    try {
      const seqs = [...drainEvents(opened.db, CHECKPOINT_RUN)].map((event) => event.seq);
      expect(seqs).not.toContain(GAP_AT);
      expect(seqs).toContain(GAP_AT - 1);
      expect(seqs).toContain(GAP_AT + 1);
      expect(opened.runs.get(CHECKPOINT_RUN)).toEqual(expected);
    } finally {
      opened.db.close();
    }
  });

  it('leaves the surviving checkpoint’s last_seq at or below max(seq)', ({ tmp }) => {
    seedWithHole(tmp);

    const opened = openAndReplay(tmp);
    try {
      const row = opened.db
        .prepare<{ last_seq: number; head: number }>(
          'SELECT run.last_seq AS last_seq, (SELECT max(seq) FROM event) AS head FROM run',
        )
        .get();
      expect(row?.last_seq).toBeLessThanOrEqual(row?.head ?? 0);
    } finally {
      opened.db.close();
    }
  });
});

suite('a ledger holding kinds this build never heard of still opens (AC4)', () => {
  const FUTURE_KIND = 'future.thing';
  const FUTURE_COUNT = 40;

  /** The corpus, with the future events spread evenly through it. */
  function seedWithFutureEvents(tmp: string): void {
    const db = openLedger(tmp);
    const known = checkpointRun({ nodes: 20 });
    const stride = Math.floor(known.length / FUTURE_COUNT);
    const mixed: EventDraft[] = [];
    let planted = 0;
    for (const [index, draft] of known.entries()) {
      mixed.push(draft);
      if (index % stride === stride - 1 && planted < FUTURE_COUNT) {
        planted += 1;
        mixed.push({
          runId: CHECKPOINT_RUN,
          ts: draft.ts + 1,
          kind: FUTURE_KIND,
          v: 1,
          epoch: draft.epoch,
          payload: { sandbox: 'seatbelt', reason: 'network' },
        });
      }
    }
    if (planted !== FUTURE_COUNT) {
      throw new Error(`planted ${planted} future events, wanted ${FUTURE_COUNT}`);
    }
    appendEvents(db, mixed);
    db.close();
  }

  it('skips the unknown kinds, applies the known ones, and reports one aggregate', ({ tmp }) => {
    seedWithFutureEvents(tmp);

    const opened = openAndReplay(tmp);
    try {
      const replay = opened.replays[0];
      if (replay === undefined) throw new Error('the ledger replayed no runs at all');
      expect(replay.report.skippedByKind).toEqual({ [FUTURE_KIND]: FUTURE_COUNT });
      expect(replay.report.unreadable).toEqual([]);
      expect(describeSkipped(replay.report)).toBe(
        `skipped ${FUTURE_COUNT} events of 1 unknown kind: ${FUTURE_KIND}`,
      );
    } finally {
      opened.db.close();
    }
  });

  it('produces a degraded projection, not a corrupted one', ({ tmp }) => {
    seedWithFutureEvents(tmp);

    const opened = openAndReplay(tmp);
    try {
      const state = opened.runs.get(CHECKPOINT_RUN);
      expect(state?.status).toBe('needs-human');
      expect(Object.keys(state?.nodes ?? {})).toHaveLength(20);
      for (const node of Object.values(state?.nodes ?? {})) {
        // Completed-without-having-run is the shape a skipped lifecycle event
        // would leave behind, and `attempts` being derived is what stops it.
        if (node.status === 'completed') expect(node.attempts).toBeGreaterThanOrEqual(1);
      }
    } finally {
      opened.db.close();
    }
  });

  it('does the same thing on the second open — a crash loop is the failure', ({ tmp }) => {
    seedWithFutureEvents(tmp);

    const first = openAndReplay(tmp);
    const firstState = first.runs.get(CHECKPOINT_RUN);
    first.db.close();

    const second = openAndReplay(tmp);
    try {
      expect(second.runs.get(CHECKPOINT_RUN)).toEqual(firstState);
    } finally {
      second.db.close();
    }
  });
});

suite('replayAll works on an already-open ledger, as boot needs it to', () => {
  it('returns the same map openAndReplay would over the same file', ({ tmp }) => {
    const writer = openLedger(tmp);
    writeAsPreviousProcess(writer, CHECKPOINT_RUN, checkpointRun({ nodes: 6 }));
    writer.close();

    const db = openLedger(tmp);
    try {
      const replayed = replayAll(db);
      expect(replayed.runs.get(CHECKPOINT_RUN)).toEqual(coldFold(db, CHECKPOINT_RUN));
      expect(replayed.headSeq).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
