/**
 * KAR-07.2 AC6 — the `worktree list --porcelain -z` parser
 * (docs/09-workspace-and-safety.md §4.3; EPIC-07-S13, test plan row 1).
 *
 * The fixture below is not invented: it is the byte layout captured from real
 * `git worktree list --porcelain -z` on git 2.50.1 on 2026-08-06, with the
 * NULs written out explicitly so the shape is readable. Records are
 * NUL-*terminated* (not separated), and an empty record — a second NUL —
 * closes each entry. That is the whole reason `-z` exists: a lock reason
 * containing a space and a worktree path containing a space are both ordinary,
 * and the newline form gives no way to tell either from a field boundary.
 *
 * Verifies: EPIC-07-S13 · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { findOccupant, parseWorktreeList } from './worktree-porcelain.ts';

const NUL = '\0';

/** One entry: its records, then the empty record that closes it. */
const entry = (...records: string[]): string => records.map((r) => `${r}${NUL}`).join('') + NUL;

/**
 * A main checkout, a branch worktree, a detached worktree, a locked worktree
 * whose reason contains spaces and whose path contains a space, and a prunable
 * worktree — the five the scenario names, in the order git prints them.
 */
const CAPTURED =
  entry('worktree /tmp/repo', 'HEAD ' + 'c'.repeat(40), 'branch refs/heads/main') +
  entry(
    'worktree /tmp/wt/r1__n1',
    'HEAD ' + 'a'.repeat(40),
    'branch refs/heads/DeFlow/r1__n1',
    'locked DeFlow run=r1 node=n1',
  ) +
  entry('worktree /tmp/wt/detached', 'HEAD ' + 'b'.repeat(40), 'detached') +
  entry(
    'worktree /tmp/my worktrees/r1 n1',
    'HEAD ' + 'd'.repeat(40),
    'branch refs/heads/DeFlow/r1__n2',
    'locked DeFlow run=r1 node=n2',
  ) +
  entry(
    'worktree /tmp/wt/gone',
    'HEAD ' + 'e'.repeat(40),
    'branch refs/heads/prunbr',
    'prunable gitdir file points to non-existent location',
  );

suite('every record type round-trips (EPIC-07-S13 scenario 1)', () => {
  const entries = parseWorktreeList(CAPTURED);

  it('yields five entries', () => {
    expect(entries).toHaveLength(5);
  });

  it('the branch entry carries its full ref and detached false', () => {
    expect(entries[1]).toMatchObject({
      path: '/tmp/wt/r1__n1',
      head: 'a'.repeat(40),
      branch: 'refs/heads/DeFlow/r1__n1',
      detached: false,
    });
  });

  it('the detached entry carries detached true and no branch', () => {
    expect(entries[2]).toMatchObject({ path: '/tmp/wt/detached', detached: true, branch: null });
  });

  it('the locked entry carries locked true and the multi-word reason', () => {
    expect(entries[1]).toMatchObject({ locked: true, lockReason: 'DeFlow run=r1 node=n1' });
  });

  it('the prunable entry carries prunable true with its reason string', () => {
    expect(entries[4]).toMatchObject({
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    });
  });

  it('an unlocked, unprunable entry says so rather than leaving it undefined', () => {
    expect(entries[0]).toMatchObject({
      locked: false,
      lockReason: null,
      prunable: false,
      prunableReason: null,
      bare: false,
    });
  });
});

suite('a worktree path containing a space (EPIC-07-S13 scenario 2)', () => {
  it('keeps the path exactly, with no field split on whitespace', () => {
    const entries = parseWorktreeList(CAPTURED);

    expect(entries[3]?.path).toBe('/tmp/my worktrees/r1 n1');
    expect(entries[3]?.branch).toBe('refs/heads/DeFlow/r1__n2');
  });

  it('a lock reason with a space survives too', () => {
    expect(parseWorktreeList(CAPTURED)[3]?.lockReason).toBe('DeFlow run=r1 node=n2');
  });
});

suite('the shapes git prints that are not the common case', () => {
  it('reads `locked` with no reason as locked with a null reason', () => {
    const [only] = parseWorktreeList(entry('worktree /tmp/wt', 'HEAD ' + 'f'.repeat(40), 'locked'));

    expect(only).toMatchObject({ locked: true, lockReason: null });
  });

  it('reads a bare repository entry', () => {
    const [only] = parseWorktreeList(entry('worktree /tmp/bare', 'bare'));

    expect(only).toMatchObject({ path: '/tmp/bare', bare: true, head: null, branch: null });
  });

  it('returns nothing for empty output rather than one blank entry', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('ignores a record it has never heard of instead of throwing', () => {
    const [only] = parseWorktreeList(
      entry('worktree /tmp/wt', 'HEAD ' + 'f'.repeat(40), 'somethingnew value', 'detached'),
    );

    expect(only).toMatchObject({ path: '/tmp/wt', detached: true });
  });

  it('tolerates a trailing newline execa may have left on the last record', () => {
    const entries = parseWorktreeList(`${CAPTURED}\n`);

    expect(entries).toHaveLength(5);
  });
});

suite('occupancy is answered from the list, never from an error string (AC3, AC4)', () => {
  const entries = parseWorktreeList(CAPTURED);

  it('finds the worktree holding a branch, given the short name', () => {
    expect(findOccupant(entries, 'DeFlow/r1__n1')).toEqual({
      path: '/tmp/wt/r1__n1',
      kind: 'worktree',
    });
  });

  it('accepts the full ref just as well, so a caller cannot get it half right', () => {
    expect(findOccupant(entries, 'refs/heads/DeFlow/r1__n1')?.path).toBe('/tmp/wt/r1__n1');
  });

  it('calls the first entry — the operator’s own checkout — a main-checkout occupant', () => {
    expect(findOccupant(entries, 'main')).toEqual({ path: '/tmp/repo', kind: 'main-checkout' });
  });

  it('finds nothing for a branch no worktree holds', () => {
    expect(findOccupant(entries, 'DeFlow/r1__n99')).toBeNull();
  });

  it('a detached worktree occupies no branch at all', () => {
    expect(findOccupant(entries, 'detached')).toBeNull();
  });
});
