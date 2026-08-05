/**
 * KAR-03.6 — the checkpoint cache, against a real file-backed ledger
 * (docs/05-durable-execution.md §5.1).
 *
 * Integration rather than unit for one reason: every claim here is about a
 * *transaction*. "Written in the same transaction as the events it covers" and
 * "`last_seq` never runs ahead of `max(seq)`" are statements about what a real
 * SQLite file can be observed holding after a rollback, and a fake database
 * that commits by assignment cannot make either one false.
 *
 * The core assertion is the deep-equality pair: the state reached by decoding
 * a checkpoint and folding the tail must equal the state reached by folding
 * the whole ledger from zero. Everything else in the file exists to make that
 * pair meaningful — a corpus the reducer accepts (`support/checkpoint-run.ts`),
 * and the four ways a cache is refused.
 *
 * Verifies: EPIC-03-S18, EPIC-03-S19, EPIC-03-S20, EPIC-03-S27 · AC1, AC2,
 * AC3, AC4, AC5, AC6
 */
import { CHECKPOINT_VERSION, type Db, foldEvents, initialRunState, type RunId } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { expect, describe as suite } from 'vitest';
import {
  CHECKPOINT_EVENT_INTERVAL,
  describeCheckpointRejection,
  drainEvents,
  type EventDraft,
  NO_CHECKPOINT_ENV,
  openLedger,
  RunCheckpointer,
  readCheckpoint,
  replayRun,
} from '../../src/index.ts';
import {
  CHECKPOINT_RUN,
  checkpointRun,
  completedCheckpointRun,
  OTHER_RUN,
} from './support/checkpoint-run.ts';

/** Checkpointing off, as the env flag asks for. */
const DISABLED = { [NO_CHECKPOINT_ENV]: '1' } as const;

/** Checkpointing on: an environment that simply does not mention the flag. */
const ENABLED: Record<string, string | undefined> = {};

const RUN_ROW_SQL =
  'SELECT run_id, last_seq, state_json, checkpoint_version FROM run WHERE run_id = ?';

interface RunRow {
  run_id: string;
  last_seq: number;
  state_json: string;
  checkpoint_version: number;
}

const runRow = (db: Db, runId: RunId): RunRow | undefined =>
  db.prepare<RunRow>(RUN_ROW_SQL).get(runId);

const runRowCount = (db: Db): number =>
  db.prepare<{ rows: number }>('SELECT count(*) AS rows FROM run').get()?.rows ?? 0;

const maxEventSeq = (db: Db, runId: RunId): number =>
  db
    .prepare<{ events: number; last: number }>(
      'SELECT count(*) AS events, coalesce(max(seq), 0) AS last FROM event WHERE run_id = ?',
    )
    .get(runId)?.last ?? 0;

/** The cold path, spelled out rather than borrowed, so the comparison is real. */
const coldFold = (db: Db, runId: RunId) =>
  foldEvents(drainEvents(db, runId), initialRunState()).state;

/** Appends `drafts` through a checkpointer, `size` events at a time. */
function appendInBatches(
  checkpointer: RunCheckpointer,
  drafts: readonly EventDraft[],
  size: number,
): void {
  for (let index = 0; index < drafts.length; index += size) {
    checkpointer.append(drafts.slice(index, index + size));
  }
}

/**
 * The real ledger with one statement rigged to throw — the crash that lands
 * between the events and their checkpoint.
 *
 * A decorator over the `Db` port, not a mocked module: SQLite underneath is
 * the real thing, the transaction is a real transaction, and what is being
 * asked is what the *file* holds afterwards. Nothing else can answer that.
 */
function failingOn(db: Db, marker: string, boom: Error): Db {
  return {
    get open() {
      return db.open;
    },
    prepare<Row>(sql: string) {
      const statement = db.prepare<Row>(sql);
      if (!sql.includes(marker)) return statement;
      return {
        run: () => {
          throw boom;
        },
        get: (...parameters: never[]) => statement.get(...parameters),
        all: (...parameters: never[]) => statement.all(...parameters),
      };
    },
    exec: (sql: string) => db.exec(sql),
    transaction: <T>(fn: () => T) => db.transaction(fn),
    pragma: (source: string) => db.pragma(source),
    close: () => db.close(),
  };
}

/** A deterministic PRNG: a randomised spec that cannot be replayed is a rumour. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── EPIC-03-S18 ─────────────────────────────────────────────────────────────

suite('the checkpoint is committed with the events it covers (EPIC-03-S18)', () => {
  it('writes exactly one run row once the ~500-event threshold is crossed', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const drafts = checkpointRun({ nodes: 60 }).slice(0, 600);
      expect(drafts).toHaveLength(600);
      const checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED });

      appendInBatches(checkpointer, drafts, 50);

      expect(CHECKPOINT_EVENT_INTERVAL).toBe(500);
      expect(checkpointer.writes).toBe(1);
      expect(runRowCount(db)).toBe(1);

      const row = runRow(db, CHECKPOINT_RUN);
      expect(row?.checkpoint_version).toBe(CHECKPOINT_VERSION);
      // The covered seq is a *committed* event of this run, not a number the
      // checkpointer hoped would exist.
      expect(row?.last_seq).toBeGreaterThan(0);
      expect(row?.last_seq).toBeLessThanOrEqual(maxEventSeq(db, CHECKPOINT_RUN));
    } finally {
      db.close();
    }
  });

  it('leaves no window: a failure at the checkpoint takes its events with it (AC1)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const boom = new Error('the disk filled up between the events and the checkpoint');
      const rigged = failingOn(db, 'INSERT INTO run', boom);
      const checkpointer = new RunCheckpointer(rigged, CHECKPOINT_RUN, {
        env: ENABLED,
        interval: 20,
      });

      expect(() => checkpointer.append(checkpointRun({ nodes: 4 }).slice(0, 20))).toThrow(boom);

      // The events are gone with it. This is the whole of AC1: if the append
      // committed on its own and the checkpoint followed in a second
      // transaction, the ledger would be sitting here holding 20 events and no
      // checkpoint — which is the *recoverable* half of the window. The other
      // half, a checkpoint ahead of its events, is unreachable for the same
      // reason.
      expect(maxEventSeq(db, CHECKPOINT_RUN)).toBe(0);
      expect(runRowCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('never lets last_seq run ahead of max(seq), across randomised rollbacks (AC2)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const drafts = checkpointRun({ nodes: 40 });
      // A small interval, so 50 cycles cross it many times rather than never.
      const options = { env: ENABLED, interval: 20 } as const;
      let checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, options);
      const random = mulberry32(0x5eed);
      let cursor = 0;

      for (let cycle = 0; cycle < 50; cycle++) {
        const size = 1 + Math.floor(random() * 8);
        const batch = drafts.slice(cursor, cursor + size);
        if (batch.length === 0) break;
        cursor += batch.length;

        if (random() < 0.3) {
          // A batch that is appended, checkpointed, and then rolled back whole.
          // If the checkpoint were written outside the transaction, this is
          // where it would survive its own events.
          expect(() =>
            db.transaction(() => {
              checkpointer.append(batch);
              throw new Error('rolled back on purpose');
            }),
          ).toThrow('rolled back on purpose');
          // What a daemon does after losing a transaction: take its state from
          // the ledger again rather than from memory, which is now describing
          // events that no longer exist.
          checkpointer = RunCheckpointer.resume(db, CHECKPOINT_RUN, options);
        } else {
          checkpointer.append(batch);
        }

        const row = runRow(db, CHECKPOINT_RUN);
        expect(row?.last_seq ?? 0).toBeLessThanOrEqual(maxEventSeq(db, CHECKPOINT_RUN));
      }

      expect(maxEventSeq(db, CHECKPOINT_RUN)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('folds only the tail on startup, and the fold count says so (AC3)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const drafts = checkpointRun({ nodes: 60 }).slice(0, 530);
      const checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED });
      appendInBatches(checkpointer, drafts, 10);

      const replay = replayRun(db, CHECKPOINT_RUN, { env: ENABLED });

      expect(replay.source).toBe('checkpoint');
      expect(replay.fromSeq).toBe(runRow(db, CHECKPOINT_RUN)?.last_seq);
      expect(replay.folded).toBe(30);
      expect(replay.discarded).toBeNull();
      expect(replay.state).toEqual(coldFold(db, CHECKPOINT_RUN));
    } finally {
      db.close();
    }
  });

  it('is also written on quiesce, below the threshold (AC1)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const drafts = checkpointRun({ nodes: 6 }).slice(0, 40);
      const checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED });
      checkpointer.append(drafts);
      expect(checkpointer.writes).toBe(0);
      expect(runRowCount(db)).toBe(0);

      expect(checkpointer.quiesce()).toBe(true);

      expect(checkpointer.writes).toBe(1);
      expect(runRow(db, CHECKPOINT_RUN)?.last_seq).toBe(maxEventSeq(db, CHECKPOINT_RUN));
      // Nothing is left to fold, and the state is still the ledger's own.
      const replay = replayRun(db, CHECKPOINT_RUN, { env: ENABLED });
      expect(replay.folded).toBe(0);
      expect(replay.state).toEqual(coldFold(db, CHECKPOINT_RUN));
      // A second quiesce with nothing new to say writes nothing.
      expect(checkpointer.quiesce()).toBe(false);
      expect(checkpointer.writes).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps one run’s checkpoint out of another run’s replay', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const a = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED });
      const b = new RunCheckpointer(db, OTHER_RUN, { env: ENABLED });
      a.append(checkpointRun({ nodes: 4 }));
      b.append(checkpointRun({ nodes: 2, runId: OTHER_RUN }));
      a.quiesce();

      expect(readCheckpoint(db, OTHER_RUN).status).toBe('absent');
      expect(replayRun(db, OTHER_RUN, { env: ENABLED }).source).toBe('cold');
      expect(replayRun(db, OTHER_RUN, { env: ENABLED }).state).toEqual(coldFold(db, OTHER_RUN));
    } finally {
      db.close();
    }
  });
});

// ── EPIC-03-S19 ─────────────────────────────────────────────────────────────

suite('a checkpoint_version bump forces a full replay to the same state (EPIC-03-S19)', () => {
  it('ignores the cache and folds from seq 0, reaching a deeply equal state (AC4)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED });
      checkpointer.append(completedCheckpointRun({ nodes: 12 }));
      checkpointer.quiesce();

      const cached = replayRun(db, CHECKPOINT_RUN, { env: ENABLED });
      expect(cached.source).toBe('checkpoint');

      // The next binary changed the reducer's shape and bumped the constant;
      // the row on disk still carries the old one.
      db.prepare('UPDATE run SET checkpoint_version = ? WHERE run_id = ?').run(
        CHECKPOINT_VERSION - 1,
        CHECKPOINT_RUN,
      );

      const replayed = replayRun(db, CHECKPOINT_RUN, { env: ENABLED });

      expect(replayed.source).toBe('cold');
      expect(replayed.fromSeq).toBe(0);
      expect(replayed.folded).toBe(maxEventSeq(db, CHECKPOINT_RUN));
      expect(replayed.discarded?.reason).toBe('version-mismatch');
      expect(replayed.state).toEqual(cached.state);
    } finally {
      db.close();
    }
  });

  it('agrees with DeFlow_NO_CHECKPOINT=1 on every corpus shape (AC6, EPIC-03-S27)', ({ tmp }) => {
    const corpus: readonly (readonly [string, EventDraft[]])[] = [
      ['one-node', checkpointRun({ nodes: 1 })],
      ['retry-and-suspend', checkpointRun({ nodes: 4 })],
      ['twelve-nodes', checkpointRun({ nodes: 12 })],
      ['completed', completedCheckpointRun({ nodes: 12 })],
      ['stress-600', checkpointRun({ nodes: 60 }).slice(0, 600)],
    ];

    for (const [name, drafts] of corpus) {
      const dir = `${tmp}/${name}`;
      mkdirSync(dir, { recursive: true });
      const db = openLedger(dir);
      try {
        const checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED });
        appendInBatches(checkpointer, drafts, 37);
        checkpointer.quiesce();

        const cached = replayRun(db, CHECKPOINT_RUN, { env: ENABLED });
        const cold = replayRun(db, CHECKPOINT_RUN, { env: DISABLED });

        expect(cached.source, name).toBe('checkpoint');
        expect(cold.source, name).toBe('cold');
        expect(cold.folded, name).toBeGreaterThan(cached.folded);
        expect(cached.state, name).toEqual(cold.state);
        // And the live path — the state the checkpointer held in memory as it
        // wrote — agrees with both, which is what makes the cache a cache.
        expect(checkpointer.state, name).toEqual(cold.state);
        // The corpus is worth folding: an empty projection would make every
        // equality above true for the wrong reason.
        expect(Object.keys(cold.state.nodes).length, name).toBeGreaterThan(0);
        expect(cold.state.staleEpochSkipped, name).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    }
  });

  it('agrees across a run whose seqs are non-contiguous (EPIC-03-S27)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // `event.seq` is global across runs, so a run interleaved with another
      // walks a strided subsequence with permanent holes in it — the gap a
      // resumed cursor really meets (see ./sequence-gaps.test.ts), and the one
      // `last_seq` has to survive.
      const mine = checkpointRun({ nodes: 8 });
      const theirs = checkpointRun({ nodes: 8, runId: OTHER_RUN });
      const a = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED, interval: 25 });
      const b = new RunCheckpointer(db, OTHER_RUN, { env: ENABLED, interval: 25 });
      for (let index = 0; index < Math.max(mine.length, theirs.length); index += 7) {
        a.append(mine.slice(index, index + 7));
        b.append(theirs.slice(index, index + 7));
      }
      a.quiesce();

      const seqs = [...drainEvents(db, CHECKPOINT_RUN)].map((event) => event.seq);
      expect(seqs.length).toBeGreaterThan(1);
      expect(seqs.at(-1)).toBeGreaterThan(seqs.length);
      expect(a.writes).toBeGreaterThan(1);

      expect(replayRun(db, CHECKPOINT_RUN, { env: ENABLED }).state).toEqual(
        replayRun(db, CHECKPOINT_RUN, { env: DISABLED }).state,
      );
      expect(replayRun(db, OTHER_RUN, { env: ENABLED }).state).toEqual(
        replayRun(db, OTHER_RUN, { env: DISABLED }).state,
      );
    } finally {
      db.close();
    }
  });

  it('writes nothing at all when the flag is set (AC6)', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, { env: DISABLED });
      appendInBatches(checkpointer, checkpointRun({ nodes: 60 }).slice(0, 600), 50);
      expect(checkpointer.quiesce()).toBe(false);

      expect(checkpointer.writes).toBe(0);
      expect(runRowCount(db)).toBe(0);
      expect(replayRun(db, CHECKPOINT_RUN, { env: DISABLED }).state).toEqual(
        coldFold(db, CHECKPOINT_RUN),
      );
    } finally {
      db.close();
    }
  });
});

// ── EPIC-03-S20 ─────────────────────────────────────────────────────────────

suite('a corrupted checkpoint cannot corrupt state (EPIC-03-S20)', () => {
  /** Seeds a ledger with a valid checkpoint, then breaks it however asked. */
  function seedThenCorrupt(tmp: string, corrupt: (db: Db, valid: string) => void): Db {
    const db = openLedger(tmp);
    const checkpointer = new RunCheckpointer(db, CHECKPOINT_RUN, { env: ENABLED });
    checkpointer.append(completedCheckpointRun({ nodes: 8 }));
    checkpointer.quiesce();
    const row = runRow(db, CHECKPOINT_RUN);
    if (row === undefined) throw new Error('the fixture wrote no checkpoint');
    corrupt(db, row.state_json);
    return db;
  }

  const setStateJson = (db: Db, text: string): void => {
    db.prepare('UPDATE run SET state_json = ? WHERE run_id = ?').run(text, CHECKPOINT_RUN);
  };

  const corruptions: readonly (readonly [string, (db: Db, valid: string) => void, string])[] = [
    ['truncated mid-object', (db) => setStateJson(db, '{"garbage":'), 'decode-failed'],
    ['an array instead of an object', (db) => setStateJson(db, '[]'), 'shape-invalid'],
    [
      'a valid JSON object of an older RunState shape',
      (db, valid) => {
        const { staleEpochSkipped: _gone, ...older } = JSON.parse(valid);
        setStateJson(db, JSON.stringify(older));
      },
      'shape-invalid',
    ],
    [
      'a valid RunState with last_seq past max(seq)',
      (db) => {
        db.prepare('UPDATE run SET last_seq = ? WHERE run_id = ?').run(9_000_000, CHECKPOINT_RUN);
      },
      'last-seq-impossible',
    ],
  ];

  for (const [name, corrupt, reason] of corruptions) {
    it(`discards ${name} and replays cleanly, reason "${reason}"`, ({ tmp }) => {
      const db = seedThenCorrupt(tmp, corrupt);
      try {
        const replay = replayRun(db, CHECKPOINT_RUN, { env: ENABLED });

        expect(replay.source).toBe('cold');
        expect(replay.fromSeq).toBe(0);
        expect(replay.state).toEqual(coldFold(db, CHECKPOINT_RUN));

        const rejection = replay.discarded;
        if (rejection === null) throw new Error('the cache was not discarded');
        expect(rejection.reason).toBe(reason);
        // The operator gets one line naming the run and why, and no stack:
        // nothing went wrong, the daemon is about to do the correct thing.
        const warning = describeCheckpointRejection(rejection);
        expect(warning).toContain(CHECKPOINT_RUN);
        expect(warning).toContain(reason);
      } finally {
        db.close();
      }
    });
  }

  it('validates the candidate, rather than merely parsing it', ({ tmp }) => {
    const db = seedThenCorrupt(tmp, (db_, valid) => {
      // Parses perfectly. Is not state: every key is right, one type is not.
      const shifted = { ...JSON.parse(valid), planVersion: '4' };
      setStateJson(db_, JSON.stringify(shifted));
    });
    try {
      const read = readCheckpoint(db, CHECKPOINT_RUN);
      expect(read.status).toBe('rejected');
      expect(read.status === 'rejected' && read.rejection.reason).toBe('shape-invalid');
      // Nothing of the candidate reached RunState.
      const replay = replayRun(db, CHECKPOINT_RUN, { env: ENABLED });
      expect(replay.state.planVersion).toBe(0);
      expect(replay.state).toEqual(coldFold(db, CHECKPOINT_RUN));
    } finally {
      db.close();
    }
  });
});
