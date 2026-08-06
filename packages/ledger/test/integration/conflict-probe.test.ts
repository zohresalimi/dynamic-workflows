/**
 * KAR-07.6 — the `conflict_probe` table (docs/09-workspace-and-safety.md §6.2).
 *
 * Two properties, and both are in the primary key. The pair is the identity —
 * `(run_id, branch_a, branch_b)` — so probing the same pair twice updates one
 * row rather than growing a history nobody reads; and the pair is **normalized
 * before the key is formed**, so a caller that happens to name the branches the
 * other way round writes the *same* row. Without that, `(a,b)` and `(b,a)` are
 * two rows holding two answers to one question, and a scheduler that reads the
 * stale one has no way to know.
 *
 * Both tips are stored. That is a three-column cost that turns "is this cached
 * answer still true?" from an unanswerable question into a comparison —
 * without it the table becomes a source of confidently wrong scheduling
 * decisions the moment a node commits again, and that failure is silent.
 *
 * File-backed, through `openLedger`, because the migration is under test as
 * much as the statements are.
 *
 * Verifies: EPIC-07-S30 (scenarios 3 and 4) · AC4
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  type ConflictProbeRow,
  openLedger,
  readConflictProbe,
  readConflictProbes,
  upsertConflictProbe,
} from '../../src/index.ts';

const RUN = 'run_20260806T090000Z_5c1d2e';
const A = 'DeFlow/r1__a';
const B = 'DeFlow/r1__b';
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

const row = (over: Partial<ConflictProbeRow> = {}): ConflictProbeRow => ({
  runId: RUN,
  branchA: A,
  branchB: B,
  probedAt: 1_754_400_000_000,
  aCommit: OID_A,
  bCommit: OID_B,
  clean: false,
  paths: ['src/a.ts'],
  ...over,
});

suite('one row per pair, holding the later probe (EPIC-07-S30 scenario 3)', () => {
  it('round-trips every column', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      upsertConflictProbe(db, row());

      expect(readConflictProbes(db, RUN)).toEqual([row()]);
    } finally {
      db.close();
    }
  });

  it('derives path_count from the paths, so the two can never disagree', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      upsertConflictProbe(db, row({ paths: ['src/a.ts', 'src/b.ts'] }));

      const stored = db
        .prepare<{ path_count: number; paths_json: string }>(
          'SELECT path_count, paths_json FROM conflict_probe',
        )
        .all();
      expect(stored).toEqual([
        { path_count: 2, paths_json: JSON.stringify(['src/a.ts', 'src/b.ts']) },
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps exactly one row when the same pair is probed twice with different results', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      upsertConflictProbe(db, row());
      upsertConflictProbe(
        db,
        row({ probedAt: 1_754_400_009_000, aCommit: OID_C, clean: true, paths: [] }),
      );

      expect(readConflictProbes(db, RUN)).toEqual([
        row({ probedAt: 1_754_400_009_000, aCommit: OID_C, clean: true, paths: [] }),
      ]);
    } finally {
      db.close();
    }
  });

  it('separates runs: the same branch pair under another run is another row', ({ tmp }) => {
    const other = 'run_20260806T090000Z_000000';
    const db = openLedger(tmp);
    try {
      upsertConflictProbe(db, row());
      upsertConflictProbe(db, row({ runId: other }));

      expect(readConflictProbes(db, RUN)).toHaveLength(1);
      expect(readConflictProbes(db, other)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

suite('the pair is canonical, so (a,b) and (b,a) are one row (EPIC-07-S30 scenario 4)', () => {
  it('writes the reversed pair into the row the forward pair created', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      upsertConflictProbe(db, row());
      upsertConflictProbe(
        db,
        row({
          branchA: B,
          branchB: A,
          aCommit: OID_B,
          bCommit: OID_C,
          probedAt: 1_754_400_009_000,
          clean: true,
          paths: [],
        }),
      );

      // One row, and the tips travelled with their branches through the swap:
      // `branch_b`'s commit is the `OID_C` the reversed call gave it.
      expect(readConflictProbes(db, RUN)).toEqual([
        row({
          aCommit: OID_C,
          bCommit: OID_B,
          probedAt: 1_754_400_009_000,
          clean: true,
          paths: [],
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('reads the same row whichever way round the pair is asked for', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      upsertConflictProbe(db, row());

      expect(readConflictProbe(db, RUN, B, A)).toEqual(row());
      expect(readConflictProbe(db, RUN, A, B)).toEqual(row());
    } finally {
      db.close();
    }
  });

  it('returns null for a pair that has never been probed', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(readConflictProbe(db, RUN, A, B)).toBeNull();
    } finally {
      db.close();
    }
  });
});
