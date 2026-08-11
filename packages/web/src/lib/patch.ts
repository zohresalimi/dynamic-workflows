/**
 * KAR-17.6 — splitting the unified patch `DeFlowd` serves into the files a
 * review surface lists (F10.7).
 *
 * Verifies: EPIC-17-S24, EPIC-17-S26 · AC1, AC7
 *
 * Pure, and deliberately small. It does **not** parse hunks into lines —
 * `@git-diff-view/core` does that, from the same bytes, and re-implementing it
 * here would be a second parser to keep in agreement with the renderer. What is
 * here is the one job that library does not do: `GET /api/runs/:id/diff`
 * returns one patch covering every file, and a file list, a file selection and
 * a per-file collapse decision all need it cut up first.
 *
 * ## What a real patch has that a hand-written one does not
 *
 * The daemon runs `git diff --cached --no-color --no-ext-diff --binary <base>`
 * over a scratch index, and that emits four shapes this function has to survive:
 *
 * - a **pure rename** — `similarity index 100%`, `rename from`, `rename to`,
 *   and *no hunk at all*. A parser that keyed on `@@` drops the file silently.
 * - a **binary file** — `GIT binary patch` and base85 `delta`/`literal` blocks
 *   with no `---`/`+++` header. Rendering that as source is how a review
 *   surface shows a user a screenful of `zcmZ?soZ!aH`.
 * - `new file mode` / `deleted file mode`, where one side is `/dev/null`.
 * - `\ No newline at end of file`, which is neither an addition nor a deletion.
 *
 * `Binary files a/x and b/y differ` is handled too, because that is what the
 * same command emits **without** `--binary` — and a caller diffing through some
 * other path (a CLI, a future endpoint) would send it.
 */

/** What happened to the file, as the patch header states it. */
export type PatchChangeKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface PatchFileVM {
  /** The name to show and to key a selection on: the new path, or the old one for a deletion. */
  readonly path: string;
  /** `null` when the file was added. */
  readonly oldPath: string | null;
  /** `null` when the file was deleted. */
  readonly newPath: string | null;
  readonly kind: PatchChangeKind;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** `additions + deletions`; zero for a pure rename and for a binary file. */
  readonly changedLines: number;
  /** The blob the "before" side was read from — a finding's anchor (KAR-12.3 AC6). */
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  /** AC7 — larger than `COLLAPSE_ABOVE_CHANGED_LINES`, so it opens collapsed. */
  readonly collapsed: boolean;
  /** This file's whole section, header included — what `DiffFile` takes. */
  readonly hunks: readonly string[];
}

/**
 * AC7 — the size at which a file opens collapsed with an explicit expand.
 *
 * Stated here, once, rather than as a number inside a template. It is a *line*
 * count and not a byte count because what freezes a tab is DOM nodes: the diff
 * renderer builds a row per line per side, so 500 changed lines is already a
 * four-figure node count before any finding widget is attached to it.
 */
export const COLLAPSE_ABOVE_CHANGED_LINES = 500;

const HEADER = 'diff --git ';

/**
 * The two paths on a `diff --git a/x b/y` line.
 *
 * Ambiguous by construction when a path contains a space, and git offers no
 * escaping on this line for the unquoted case — so the unambiguous reading is
 * tried first: `a/<p> b/<p>` for the same `<p>` covers every file that was not
 * renamed, which is almost all of them. The `---`/`+++` and `rename from`/
 * `rename to` lines below are authoritative where they exist and override this.
 */
function pathsFromHeader(line: string): { old: string | null; new: string | null } {
  const rest = line.slice(HEADER.length).trim();

  const same = /^a\/(.+) b\/\1$/.exec(rest);
  if (same?.[1] !== undefined) return { old: same[1], new: same[1] };

  const quoted = /^"(.+)" "(.+)"$/.exec(rest);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { old: quoted[1].replace(/^a\//, ''), new: quoted[2].replace(/^b\//, '') };
  }

  const split = rest.lastIndexOf(' b/');
  if (split > 0) {
    return { old: rest.slice(0, split).replace(/^a\//, ''), new: rest.slice(split + 3) };
  }
  return { old: null, new: null };
}

/** `--- a/x` → `x`, `--- /dev/null` → `null`. */
function pathFromMarker(line: string): string | null {
  const value = line.slice(4).trim();
  if (value === '/dev/null') return null;
  return value.replace(/^[ab]\//, '');
}

function parseSection(section: string): PatchFileVM | null {
  const lines = section.split('\n');
  const header = lines[0];
  if (header === undefined || !header.startsWith(HEADER)) return null;

  const named = pathsFromHeader(header);
  let oldPath = named.old;
  let newPath = named.new;
  let kind: PatchChangeKind = 'modified';
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let oldBlob: string | null = null;
  let newBlob: string | null = null;
  let inHunk = false;

  for (const line of lines.slice(1)) {
    if (!inHunk) {
      if (line.startsWith('new file mode')) {
        kind = 'added';
        oldPath = null;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        kind = 'deleted';
        newPath = null;
        continue;
      }
      if (line.startsWith('rename from ')) {
        kind = 'renamed';
        oldPath = line.slice('rename from '.length);
        continue;
      }
      if (line.startsWith('rename to ')) {
        kind = 'renamed';
        newPath = line.slice('rename to '.length);
        continue;
      }
      if (line.startsWith('copy from ')) {
        kind = 'copied';
        oldPath = line.slice('copy from '.length);
        continue;
      }
      if (line.startsWith('copy to ')) {
        kind = 'copied';
        newPath = line.slice('copy to '.length);
        continue;
      }
      if (line.startsWith('index ')) {
        // `index <old>..<new> <mode>` — abbreviated by git, and kept as written
        // rather than padded, because it is compared against what the ledger
        // recorded and neither side may normalise the other's spelling.
        const blobs = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
        oldBlob = blobs?.[1] ?? null;
        newBlob = blobs?.[2] ?? null;
        continue;
      }
      if (
        line === 'GIT binary patch' ||
        (line.startsWith('Binary files ') && line.endsWith('differ'))
      ) {
        binary = true;
        continue;
      }
      if (line.startsWith('--- ')) {
        const found = pathFromMarker(line);
        if (found === null) kind = 'added';
        else if (kind !== 'renamed' && kind !== 'copied') oldPath = found;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const found = pathFromMarker(line);
        if (found === null) kind = 'deleted';
        else if (kind !== 'renamed' && kind !== 'copied') newPath = found;
        continue;
      }
    }

    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // `\ No newline at end of file` is a note about the line above it, not a
    // change; counting it would report an addition nobody made.
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }

  const path = newPath ?? oldPath;
  if (path === null) return null;

  const changedLines = binary ? 0 : additions + deletions;

  return {
    path,
    oldPath,
    newPath,
    kind,
    binary,
    additions: binary ? 0 : additions,
    deletions: binary ? 0 : deletions,
    changedLines,
    oldBlob,
    newBlob,
    collapsed: changedLines > COLLAPSE_ABOVE_CHANGED_LINES,
    hunks: [section],
  };
}

/**
 * Every file in `patch`, in the order git printed them.
 *
 * The boundary is a `diff --git ` at **column zero**, and that is safe even
 * though a hunk body can contain any text at all — including a patch inside a
 * patch, which is exactly what this repository's own fixtures are. Every line
 * of a hunk body carries git's own one-character prefix (`' '`, `'+'`, `'-'` or
 * `'\'`), so a bare `diff --git ` at column zero is never content.
 */
export function splitPatch(patch: string): readonly PatchFileVM[] {
  const files: PatchFileVM[] = [];
  const lines = patch.split('\n');
  let start = -1;

  const flush = (end: number): void => {
    if (start < 0) return;
    const parsed = parseSection(lines.slice(start, end).join('\n').replace(/\n+$/, ''));
    if (parsed !== null) files.push(parsed);
  };

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith(HEADER)) continue;
    flush(index);
    start = index;
  }
  flush(lines.length);

  return files;
}

/**
 * AC6 — the before and after text of a file's changed region.
 *
 * Reconstructed from the hunk bodies rather than fetched: a hunk carries its
 * context lines, so ` ` belongs to both sides, `-` to the before and `+` to the
 * after, and that is the whole algorithm. It is the *only* honest before/after
 * available in the browser — the full file contents are not in the patch — and
 * it is exactly what a token-level transition wants, because animating a
 * three-thousand-line file to show that one line moved is worse than animating
 * the six lines around it.
 *
 * Hunks are joined with a blank line when there is more than one, so two
 * distant regions do not read as adjacent code.
 */
export function patchSides(file: PatchFileVM): { before: string; after: string } {
  if (file.binary) return { before: '', after: '' };

  const before: string[] = [];
  const after: string[] = [];
  let inHunk = false;

  for (const section of file.hunks) {
    for (const line of section.split('\n')) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      // `\ No newline at end of file` annotates the line above it.
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) after.push(line.slice(1));
      else if (line.startsWith('-')) before.push(line.slice(1));
      else if (line.startsWith(' ')) {
        before.push(line.slice(1));
        after.push(line.slice(1));
      }
    }
  }

  return { before: before.join('\n'), after: after.join('\n') };
}

/** Whether the diff renderer has anything to draw for this file. */
export function isRenderablePatchFile(file: PatchFileVM | undefined): boolean {
  return file !== undefined && !file.binary && file.changedLines > 0;
}

/**
 * A patch that adds `lines` lines to `path`, for the size assertions.
 *
 * Synthetic on purpose and only used to make something *big*: the shapes that
 * need a real git are asserted against a real git's output next door, and
 * committing a five-thousand-line fixture to prove a threshold is arithmetic
 * would be a quarter of a megabyte of repository for one `>`.
 */
export function synthesiseAddPatch(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => `+export const n${index} = ${index};`);
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...body,
    '',
  ].join('\n');
}
