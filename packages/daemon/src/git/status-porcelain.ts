/**
 * KAR-07.4 — the one way DeFlow reads a worktree's dirtiness
 * (docs/09-workspace-and-safety.md §4.4).
 *
 * > 1. Capture `git -C <wt> status --porcelain=v2 -z` into the ledger as a
 * >    `workspace.dirty_on_remove` event.
 *
 * **`--porcelain=v2 -z`, never `--porcelain` and never `--porcelain=v1`.** The
 * v1 format quotes paths containing unusual bytes and leaves the quoting to the
 * reader to undo; v2 with `-z` emits raw bytes and terminates every record with
 * a NUL, which is the only form in which `src/new name.ts` survives the trip
 * intact. A truncated path here is not a display bug — it is a file the salvage
 * commit is about to be judged against, in the one code path whose entire
 * purpose is to not lose an agent's work.
 *
 * **The byte layout, captured from real git 2.50.1 on 2026-08-06.** Note the
 * rename: its record is followed by a *second* NUL field holding the original
 * path, so NUL fields and entries are not the same thing.
 *
 * ```
 * 1 .M N... 100644 100644 100644 <hH> <hI> src/a.ts\0
 * 2 R. N... 100644 100644 100644 <hH> <hI> R100 src/new name.ts\0src/old name.ts\0
 * ? .gitignore\0
 * ? src/new.ts\0
 * ```
 *
 * A gitignored path (`node_modules/`, `dist/`) appears in **none** of these
 * without `--ignored`, which is exactly why AC5 needs no cleanup machinery: git
 * does not consider such a worktree dirty, `worktree remove` exits 0, and this
 * parser reports it clean without anything having to special-case it.
 *
 * Everything here is total — an unknown record is skipped rather than thrown
 * on, for the same reason ./worktree-porcelain.ts is total.
 *
 * Verifies: EPIC-07-S17, EPIC-07-S18 · AC1, AC5
 */

/**
 * What kind of difference an entry is.
 *
 * `renamed` covers git's `2 ` record, which is renames *and* copies: both carry
 * an original path, and both mean the same thing to a salvage commit.
 */
export type StatusEntryKind = 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

/** One entry of `status --porcelain=v2 -z`, reduced to what the ledger records. */
export interface StatusEntry {
  readonly kind: StatusEntryKind;
  /** Porcelain v2's two-character staged/unstaged code, or `null` for an
   * untracked or ignored entry, which git prints without one. */
  readonly xy: string | null;
  /** The path, raw, exactly as git wrote it. Spaces and all. */
  readonly path: string;
  /** Where a rename or copy came from; `null` for every other kind. */
  readonly origPath: string | null;
}

/** Field counts before the path, per porcelain v2's own documented layouts.
 * `2 ` has one more than `1 ` (the `<X><score>` field); `u ` has three extra
 * object names. Getting one of these wrong silently shifts every path. */
const ORDINARY_FIELDS = 8;
const RENAME_FIELDS = 9;
const UNMERGED_FIELDS = 10;

/** The path of a `1 `/`2 `/`u ` record: everything after the first `count`
 * space-separated fields, **rejoined**, because a path may contain spaces and
 * `-z` does not quote it. */
function pathAfter(record: string, count: number): string | null {
  const fields = record.split(' ');
  if (fields.length <= count) return null;
  return fields.slice(count).join(' ');
}

/** The path of a `? `/`! ` record: the single space after the marker is the
 * only separator there is, so `indexOf` rather than `split`. */
function pathAfterMarker(record: string): string | null {
  const space = record.indexOf(' ');
  return space === -1 ? null : record.slice(space + 1);
}

const XY_FIELD = 1;

function xyOf(record: string): string | null {
  return record.split(' ')[XY_FIELD] ?? null;
}

/**
 * Parses the whole `--porcelain=v2 -z` stream.
 *
 * The index walk is not stylistic: a `2 ` record **consumes the next NUL field**
 * as its original path, and a `for…of` over the split cannot do that without
 * either lookahead state or reporting a phantom fourth file. That phantom is
 * the bug this parser is written to not have.
 */
export function parseStatusPorcelainV2(stdout: string): StatusEntry[] {
  // `\n` only, and only at the very end: execa's stripFinalNewline leaves one
  // behind when the stream came through a layer that appended it.
  const fields = stdout.replace(/\n+$/, '').split('\0');
  const entries: StatusEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record === undefined || record === '') continue;

    const marker = record.slice(0, 2);
    if (marker === '1 ') {
      const path = pathAfter(record, ORDINARY_FIELDS);
      if (path !== null) entries.push({ kind: 'changed', xy: xyOf(record), path, origPath: null });
    } else if (marker === '2 ') {
      const path = pathAfter(record, RENAME_FIELDS);
      // The next field, whatever it is: git wrote it as this entry's original
      // path, so it must not be read again as an entry of its own.
      index += 1;
      const origPath = fields[index] ?? null;
      if (path !== null) {
        entries.push({ kind: 'renamed', xy: xyOf(record), path, origPath: origPath ?? null });
      }
    } else if (marker === 'u ') {
      const path = pathAfter(record, UNMERGED_FIELDS);
      if (path !== null) entries.push({ kind: 'unmerged', xy: xyOf(record), path, origPath: null });
    } else if (marker === '? ' || marker === '! ') {
      const path = pathAfterMarker(record);
      const kind = marker === '? ' ? 'untracked' : 'ignored';
      if (path !== null) entries.push({ kind, xy: null, path, origPath: null });
    }
    // `# branch.*` headers, and any record shape this build has not heard of:
    // skipped on purpose. @see the module header.
  }

  return entries;
}

/** Whether the worktree has anything `worktree remove` would refuse to discard.
 * An empty parse is a clean worktree — AC5's whole point. */
export function isDirty(entries: readonly StatusEntry[]): boolean {
  return entries.length > 0;
}

/** §4.4 step 1, and the only form `status` is ever invoked in. */
export const STATUS_ARGS: readonly string[] = ['status', '--porcelain=v2', '-z'];
