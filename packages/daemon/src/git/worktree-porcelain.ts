/**
 * KAR-07.2 — the one way DeFlow reads git's worktree list
 * (docs/09-workspace-and-safety.md §4.3).
 *
 * > `git -C <mainRepo> worktree list --porcelain -z`
 * >
 * > **Never parse the non-porcelain form.**
 *
 * The non-porcelain form is a human display format: it packs path, oid and
 * branch onto one space-padded line, which is unparseable the moment a user
 * has a space in their home directory — and `~/my projects/` is not exotic.
 * `-z` additionally makes a multi-word lock reason (`DeFlow run=r1 node=n1`,
 * which is the reason DeFlow itself writes) safe to read back.
 *
 * **The byte layout, captured from real git 2.50.1 on 2026-08-06.** Records
 * are NUL-*terminated*, not NUL-separated, and an entry is closed by an empty
 * record — that is, two NULs in a row:
 *
 * ```
 * worktree /tmp/repo\0HEAD <oid>\0branch refs/heads/main\0\0
 * worktree /tmp/wt\0HEAD <oid>\0detached\0locked DeFlow run=r1 node=n1\0\0
 * worktree /tmp/gone\0HEAD <oid>\0branch refs/heads/b\0prunable gitdir file …\0\0
 * ```
 *
 * Everything here is total: an unknown record is skipped rather than thrown
 * on, because this parser stands between the daemon and a `git` whose porcelain
 * gains fields over time, and a boot that refuses to start because git learned
 * a new record is a worse failure than a field this build does not show.
 *
 * Verifies: EPIC-07-S13 · AC5, AC6
 */
import type { WorktreeOccupantKind } from '@DeFlow/core';

/** One entry of `worktree list --porcelain -z`, with every optional record
 * resolved to an explicit value — `locked: false` rather than absent, so a
 * caller can never mistake "not locked" for "not looked at". */
export interface WorktreeEntry {
  /** Absolute path, exactly as git printed it. */
  readonly path: string;
  /** The checked-out commit, or `null` for a bare repository entry. */
  readonly head: string | null;
  /** The full ref (`refs/heads/…`), or `null` when detached or bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  /** git prints `locked` alone when the lock was taken with no reason. */
  readonly lockReason: string | null;
  readonly prunable: boolean;
  readonly prunableReason: string | null;
}

/** A record's key and its value: `branch refs/heads/x` → `['branch', 'refs/heads/x']`.
 * Split on the **first** space only — every value that has one (a lock reason,
 * a prunable explanation) keeps it. */
function splitRecord(record: string): readonly [string, string | null] {
  const space = record.indexOf(' ');
  return space === -1 ? [record, null] : [record.slice(0, space), record.slice(space + 1)];
}

interface MutableEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

function blank(path: string): MutableEntry {
  return {
    path,
    head: null,
    branch: null,
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
  };
}

function applyRecord(entry: MutableEntry, key: string, value: string | null): void {
  if (key === 'HEAD') entry.head = value;
  else if (key === 'branch') entry.branch = value;
  else if (key === 'detached') entry.detached = true;
  else if (key === 'bare') entry.bare = true;
  else if (key === 'locked') {
    entry.locked = true;
    entry.lockReason = value;
  } else if (key === 'prunable') {
    entry.prunable = true;
    entry.prunableReason = value;
  }
  // Anything else: a record this build has not heard of. Skipped on purpose.
}

/**
 * Parses the whole `--porcelain -z` stream.
 *
 * A `worktree <path>` record starts a new entry, which is what makes this
 * robust against the empty-record terminator being absent, doubled, or
 * followed by a stray newline some layer added — none of which changes where
 * the entries begin.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: MutableEntry[] = [];
  let current: MutableEntry | null = null;

  for (const record of stdout.split('\0')) {
    // `\n` only: execa's stripFinalNewline leaves a trailing one when the
    // stream came through a layer that appended it, and a record is never
    // legitimately whitespace-padded.
    const trimmed = record.replace(/\n+$/, '');
    if (trimmed === '') continue;

    const [key, value] = splitRecord(trimmed);
    if (key === 'worktree') {
      current = blank(value ?? '');
      entries.push(current);
      continue;
    }
    if (current === null) continue;
    applyRecord(current, key, value);
  }

  return entries;
}

const HEADS_PREFIX = 'refs/heads/';

/** `refs/heads/DeFlow/r1__n1` → `DeFlow/r1__n1`; anything else unchanged. */
export function shortBranch(ref: string): string {
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}

/**
 * Where a branch is occupied, and by what kind of thing.
 *
 * The kind is not cosmetic. `main-checkout` is the **common real-world hit**
 * (§3.2, verified 2026-08-02): the operator's own current branch counts as an
 * occupant, so the failure lands on the very first run rather than on some
 * exotic concurrency case, and it deserves a message about *their* checkout
 * rather than about another agent. The vocabulary is @DeFlow/core's, because
 * it also travels in the `workspace.branch_occupied` payload.
 */
export interface WorktreeOccupant {
  readonly path: string;
  readonly kind: WorktreeOccupantKind;
}

/**
 * The worktree holding `branch`, or `null`.
 *
 * **This is the occupancy pre-check** (§3.1). DeFlow never learns that a branch
 * is taken by running `worktree add` and reading git's error: the real message
 * is `fatal: '<branch>' is already used by worktree at '<path>'`, not the
 * widely-quoted `already checked out at`, and a design that parses either one
 * is a git release away from silently deciding every branch is free.
 *
 * The first entry git prints is the main checkout — the repository the command
 * ran against — which is what makes `main-checkout` derivable here rather than
 * requiring the caller to know its own path.
 */
export function findOccupant(
  entries: readonly WorktreeEntry[],
  branch: string,
): WorktreeOccupant | null {
  const wanted = shortBranch(branch);
  const index = entries.findIndex(
    (entry) => entry.branch !== null && shortBranch(entry.branch) === wanted,
  );
  if (index === -1) return null;
  const entry = entries[index];
  if (entry === undefined) return null;
  return { path: entry.path, kind: index === 0 ? 'main-checkout' : 'worktree' };
}
