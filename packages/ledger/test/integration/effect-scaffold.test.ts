/**
 * KAR-06.4 — the scaffold: what a `mutating` shell effect journals into its
 * own `pending` row **before** it spawns the command
 * (docs/05-durable-execution.md §8.3, AC5).
 *
 * Migration 0006 froze the `effect` row so hard that a terminal one cannot be
 * touched and a `pending` one could not be annotated either — the only legal
 * update moved `pending` to `done` or `failed`. That was one rule too many.
 * The before-hash of `git status --porcelain` has to be durable *before* the
 * migration runs, and after the migration returns the after-hash has to be
 * durable *before* the row goes terminal, or a crash in the window between
 * them can never be told apart from a crash before the command ever ran.
 *
 * Migration 0007 therefore allows exactly one more transition — `pending` to
 * `pending`, changing nothing but `result_json` — and keeps every other
 * refusal exactly as it was. The tests below are mostly about what is still
 * refused, because a relaxed trigger that relaxed too much is the failure
 * this file exists to catch.
 *
 * File-backed throughout: the claim is about what a dead daemon left behind.
 *
 * Verifies: EPIC-06-S12, EPIC-06-S15 · AC5
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  type EffectRowDraft,
  type EventDraft,
  journalEffect,
  markEffectDone,
  openLedger,
  readEffect,
  readRange,
  scaffoldEffect,
} from '../../src/index.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';
const HASH = `sha256-${'a'.repeat(64)}`;
const IKEY = `${RUN}/db-migrate/0/0`;
const BEFORE = `sha256-${'1'.repeat(64)}`;
const AFTER = `sha256-${'2'.repeat(64)}`;

const draft = (): EffectRowDraft => ({
  ikey: IKEY,
  runId: RUN,
  nodeId: 'db-migrate',
  attempt: 0,
  ordinal: 0,
  kind: 'shell',
  requestHash: HASH,
  startedAt: 1_754_313_093_000,
});

const startedEvent = (): EventDraft => ({
  runId: RUN,
  ts: 1_754_313_093_000,
  kind: 'effect.started',
  v: 1,
  epoch: 1,
  nodeId: 'db-migrate',
  attempt: 0,
  ikey: IKEY,
  payload: { ikey: IKEY, kind: 'shell', requestHash: HASH },
});

const completedEvent = (result: unknown): EventDraft => ({
  runId: RUN,
  ts: 1_754_313_094_000,
  kind: 'effect.completed',
  v: 1,
  epoch: 1,
  nodeId: 'db-migrate',
  attempt: 0,
  ikey: IKEY,
  payload: { ikey: IKEY, result, reconciled: false },
});

suite('scaffoldEffect writes the before/after hashes onto a pending row (AC5)', () => {
  it('is readable by the next daemon life, which is the only reader it has', ({ tmp }) => {
    const first = openLedger(tmp);
    try {
      journalEffect(first, draft(), startedEvent());
      scaffoldEffect(first, IKEY, { kind: 'shell.mutating', before: BEFORE, after: null });
    } finally {
      first.close();
    }

    const second = openLedger(tmp);
    try {
      const row = readEffect(second, IKEY);
      expect(row?.state).toBe('pending');
      expect(JSON.parse(row?.resultJson ?? 'null')).toEqual({
        kind: 'shell.mutating',
        before: BEFORE,
        after: null,
      });
    } finally {
      second.close();
    }
  });

  it('can be written twice: the after-hash lands in the same row the before-hash did', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      scaffoldEffect(db, IKEY, { kind: 'shell.mutating', before: BEFORE, after: null });
      scaffoldEffect(db, IKEY, {
        kind: 'shell.mutating',
        before: BEFORE,
        after: AFTER,
        result: { exitCode: 0 },
      });

      expect(JSON.parse(readEffect(db, IKEY)?.resultJson ?? 'null')).toEqual({
        kind: 'shell.mutating',
        before: BEFORE,
        after: AFTER,
        result: { exitCode: 0 },
      });
    } finally {
      db.close();
    }
  });

  it('appends no event: a scaffold is a note to the next daemon, not a timeline entry', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      scaffoldEffect(db, IKEY, { kind: 'shell.mutating', before: BEFORE, after: null });

      expect(readRange(db, RUN, 0, 100).events.map((event) => event.kind)).toEqual([
        'effect.started',
      ]);
    } finally {
      db.close();
    }
  });

  it('is overwritten by the real result when the row goes done', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      scaffoldEffect(db, IKEY, { kind: 'shell.mutating', before: BEFORE, after: AFTER });
      markEffectDone(db, IKEY, { exitCode: 0 }, 1_754_313_094_000, completedEvent({ exitCode: 0 }));

      const row = readEffect(db, IKEY);
      expect(row?.state).toBe('done');
      expect(JSON.parse(row?.resultJson ?? 'null')).toEqual({ exitCode: 0 });
    } finally {
      db.close();
    }
  });
});

suite('migration 0007 relaxes exactly one rule and no others (AC5)', () => {
  it('refuses a scaffold on a row that has already gone done', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      markEffectDone(db, IKEY, { exitCode: 0 }, 1_754_313_094_000, completedEvent({ exitCode: 0 }));

      expect(() =>
        scaffoldEffect(db, IKEY, { kind: 'shell.mutating', before: BEFORE, after: AFTER }),
      ).toThrow();
      // And the memoised result is untouched — the whole reason the rule
      // exists is that a rewritten result answers a question nobody asked.
      expect(JSON.parse(readEffect(db, IKEY)?.resultJson ?? 'null')).toEqual({ exitCode: 0 });
    } finally {
      db.close();
    }
  });

  it('refuses a scaffold for an ikey nothing ever journalled', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() =>
        scaffoldEffect(db, IKEY, { kind: 'shell.mutating', before: BEFORE, after: null }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('still refuses an update that edits the row identity', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      expect(() =>
        db.prepare("UPDATE effect SET request_hash = 'sha256-0' WHERE ikey = ?").run(IKEY),
      ).toThrow(/identity/);
    } finally {
      db.close();
    }
  });

  it('still refuses reopening a terminal row', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      markEffectDone(db, IKEY, { exitCode: 0 }, 1_754_313_094_000, completedEvent({ exitCode: 0 }));

      expect(() =>
        db.prepare("UPDATE effect SET state = 'pending' WHERE ikey = ?").run(IKEY),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('still refuses a pending row that tries to move backwards into nothing', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      journalEffect(db, draft(), startedEvent());
      // `ended_at` on a pending row would claim the effect finished while the
      // state says it has not. The scaffold exception is scoped to
      // `result_json` alone, and this is the assertion that keeps it there.
      expect(() => db.prepare('UPDATE effect SET ended_at = 1 WHERE ikey = ?').run(IKEY)).toThrow();
    } finally {
      db.close();
    }
  });
});
