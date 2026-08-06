/**
 * KAR-07.2 AC8 — the `worktrees` projection: an index over git, never the
 * source of truth (docs/09-workspace-and-safety.md §4.3).
 *
 * > **Git is the authority; SQLite is an index over it.** The moment a user
 * > runs `git worktree remove` by hand — and they will — a SQLite-authoritative
 * > design is wrong and does not know it.
 *
 * That single sentence is what shapes the write API. There is no
 * `insertWorktree`, no `deleteWorktree` and no `updateWorktree`: the only way
 * to change this table is `replaceWorktrees`, which takes the *whole* list git
 * just reported and makes the table equal to it inside one transaction. A
 * partial-update API would let the projection drift from git one call at a
 * time, which is precisely the failure it exists to make impossible.
 *
 * File-backed, through `openLedger`, because the migration is under test as
 * much as the statements are.
 *
 * Verifies: EPIC-07-S14 · AC8
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { openLedger, readWorktrees, replaceWorktrees, type WorktreeRow } from '../../src/index.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';

const row = (over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path: '/tmp/repo/.DeFlow/wt/r1__n1',
  head: 'a'.repeat(40),
  branch: 'refs/heads/DeFlow/r1__n1',
  detached: false,
  bare: false,
  locked: true,
  lockReason: `DeFlow run=${RUN} node=n1`,
  prunable: false,
  prunableReason: null,
  runId: RUN,
  nodeId: 'n1',
  refreshedAt: 1_754_313_093_000,
  ...over,
});

suite('the projection is whatever git last said', () => {
  it('round-trips every column, in path order', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const main = row({
        path: '/tmp/repo',
        branch: 'refs/heads/main',
        locked: false,
        lockReason: null,
        runId: null,
        nodeId: null,
      });

      replaceWorktrees(db, [main, row()]);

      expect(readWorktrees(db)).toEqual([main, row()]);
    } finally {
      db.close();
    }
  });

  it('stores a detached read node with no branch', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const detached = row({
        path: '/tmp/repo/.DeFlow/wt/r1__n2',
        branch: null,
        detached: true,
        nodeId: 'n2',
        lockReason: `DeFlow run=${RUN} node=n2`,
      });

      replaceWorktrees(db, [detached]);

      expect(readWorktrees(db)[0]).toMatchObject({ branch: null, detached: true });
    } finally {
      db.close();
    }
  });

  it('keeps a prunable entry with its reason rather than dropping it', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      replaceWorktrees(db, [
        row({ prunable: true, prunableReason: 'gitdir file points to non-existent location' }),
      ]);

      expect(readWorktrees(db)[0]).toMatchObject({
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      });
    } finally {
      db.close();
    }
  });
});

suite('replace is the only write, so the table cannot drift from git', () => {
  it('a second replace with one row fewer leaves exactly that row gone', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const a = row({ path: '/tmp/a', nodeId: 'a' });
      const b = row({ path: '/tmp/b', nodeId: 'b' });
      const c = row({ path: '/tmp/c', nodeId: 'c' });
      replaceWorktrees(db, [a, b, c]);

      replaceWorktrees(db, [a, c]);

      expect(readWorktrees(db).map((entry) => entry.path)).toEqual(['/tmp/a', '/tmp/c']);
    } finally {
      db.close();
    }
  });

  it('an empty list empties the table — git reporting nothing is a real answer', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      replaceWorktrees(db, [row()]);

      replaceWorktrees(db, []);

      expect(readWorktrees(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('survives close and reopen: the projection is on disk, not in a process', ({ tmp }) => {
    const first = openLedger(tmp);
    try {
      replaceWorktrees(first, [row()]);
    } finally {
      first.close();
    }

    const second = openLedger(tmp);
    try {
      expect(readWorktrees(second)).toEqual([row()]);
    } finally {
      second.close();
    }
  });
});
