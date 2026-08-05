/**
 * KAR-06.4 — the atomic file write, with the ikey in the temp filename
 * (docs/05-durable-execution.md §8.3).
 *
 * The sequence is fixed and each step earns its place:
 *
 * ```
 * open("<target>.DeFlow-<ikeyHash>.tmp") → write → fsync(fd) → close
 *   → rename(tmp, target) → fsync(directory fd)
 * ```
 *
 * `fsync(fd)` puts the *bytes* on the disk; the directory `fsync` puts the
 * *name* there. Skip the second and a power cut can leave a target that
 * resolves to nothing, which is worse than either the old file or the new one.
 *
 * The temp file is a **sibling of the target and never `os.tmpdir()`**, because
 * `rename` is atomic only within one filesystem — `/tmp` is a different one on
 * a very ordinary Linux box, and the rename silently degrades to
 * copy-then-unlink, which is precisely the non-atomic write this whole
 * sequence exists to avoid. `./file.test.ts` asserts the property rather than
 * commenting it, because "move the temp files to the temp directory" is a
 * plausible-sounding tidy-up.
 *
 * Reconcile is then pleasingly simple, and its three answers are the three
 * things that can be true after a crash:
 *
 * | on disk                              | verdict       |
 * | ------------------------------------ | ------------- |
 * | an orphaned tmp bearing this ikey    | `not-started` (unlink it and redo) |
 * | no tmp, target's hash matches        | `done`        |
 * | no tmp, target's hash differs        | `unknown`     |
 *
 * The orphan is found by **rebuilding its name**, never by mtime: a clock that
 * moved, a restored backup or a slow filesystem all break an mtime heuristic,
 * and the ikey in the name is exact.
 *
 * Verifies: EPIC-06-S14 · AC8
 */
import { contentHash, IKEY_SHORT_HASH_LENGTH } from '@DeFlow/core';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What the orphan sweep globs for. */
export const TMP_SUFFIX = '.tmp';

const TMP_INFIX = '.DeFlow-';

const HASH_PATTERN = new RegExp(`^[0-9a-f]{${IKEY_SHORT_HASH_LENGTH}}$`);

/**
 * `<target>.DeFlow-<ikeyHash>.tmp`, in the target's own directory.
 *
 * The hash — not the raw ikey — is what goes in, and the check is not
 * defensive politeness: an ikey contains `/`, so a caller passing one would
 * name a file in a directory that does not exist, the write would fail on a
 * path nobody recognises, and the orphan the next daemon looks for would never
 * be there.
 */
export function tmpPathFor(target: string, ikeyHash: string): string {
  if (!HASH_PATTERN.test(ikeyHash)) {
    throw new Error(
      `temp file names carry shortIkeyHash — ${IKEY_SHORT_HASH_LENGTH} lowercase hex characters — not ${JSON.stringify(ikeyHash)}. ` +
        'A raw ikey contains "/" and would name a file in a directory that does not exist.',
    );
  }
  return `${target}${TMP_INFIX}${ikeyHash}${TMP_SUFFIX}`;
}

/** fsync of the directory, so the *name* is durable and not only the bytes it
 * points at. Skip it and a power cut can leave a target that resolves to
 * nothing — worse than either the old file or the new one. A no-op on
 * Windows, which M1 does not target (NF5). */
async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export interface AtomicWrite {
  readonly tmpPath: string;
  /** `sha256-<hex>` of the bytes written — the value reconcile compares. */
  readonly contentHash: string;
}

/**
 * Writes `data` to `target` atomically, through the sibling temp file this
 * effect's ikey names.
 *
 * The order is the whole point: bytes, `fsync(fd)`, `close`, `rename`,
 * `fsync(dir)`. Every step before the rename is invisible to a reader of
 * `target`, and the rename itself is the only instant at which the file
 * changes — which is what makes a crash at any point either "the old content"
 * or "the new content", never "half of each".
 */
export async function atomicWriteFile(
  target: string,
  data: string,
  ikeyHash: string,
): Promise<AtomicWrite> {
  const tmpPath = tmpPathFor(target, ikeyHash);

  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmpPath, target);
  await syncDirectory(dirname(target));

  return { tmpPath, contentHash: await contentHash(data) };
}

export type FileReconcileVerdict =
  | { readonly status: 'not-started'; readonly unlinkedTmp: boolean }
  | { readonly status: 'done'; readonly contentHash: string }
  | { readonly status: 'unknown'; readonly expected: string; readonly observed: string };

export interface FileReconcileInput {
  readonly target: string;
  readonly ikeyHash: string;
  /** The hash of the bytes this effect meant to write. */
  readonly expected: string;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function reconcileFileWrite(input: FileReconcileInput): Promise<FileReconcileVerdict> {
  const tmpPath = tmpPathFor(input.target, input.ikeyHash);

  // A tmp bearing *this* ikey means the crash happened before the rename. It
  // is unlinked here rather than left for `perform()` to overwrite, so that a
  // redo which itself dies leaves no half-written sibling for the next probe
  // to find. A temp file bearing somebody else's ikey is somebody else's
  // business and is not touched.
  if ((await readIfPresent(tmpPath)) !== null) {
    await unlink(tmpPath);
    return { status: 'not-started', unlinkedTmp: true };
  }

  const present = await readIfPresent(input.target);
  // No tmp and no target: the rename never happened and nothing was left
  // behind. Nothing landed in the world, which is exactly `not-started`.
  if (present === null) return { status: 'not-started', unlinkedTmp: false };

  const observed = await contentHash(present);
  if (observed === input.expected) return { status: 'done', contentHash: observed };

  // Somebody else wrote this file, or wrote over ours. Re-performing would
  // destroy their edit and skipping would drop ours; neither is a decision
  // this process is entitled to make on its own.
  return { status: 'unknown', expected: input.expected, observed };
}
