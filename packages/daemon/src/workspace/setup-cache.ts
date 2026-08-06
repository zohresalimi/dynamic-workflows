/**
 * KAR-07.5 Layer 3 — the success marker, keyed on content
 * (docs/09-workspace-and-safety.md §5.1; EPIC-07-S21).
 *
 * `workspace.setup` runs once per *distinct dependency state*, not once per
 * worktree, and what makes "distinct" decidable is the sha256 of the files
 * `setupCacheKey` declares. The two obvious cheaper markers are both wrong in
 * the direction that costs an agent turn: a timestamp calls a lockfile that
 * changed and changed back a miss, and a boolean calls a lockfile that changed
 * a hit.
 *
 * The concatenation is **framed** — `<path>\0<byteLength>\0<bytes>` per file,
 * in the declared order — rather than a bare `Buffer.concat`. Bare
 * concatenation cannot distinguish `["a" → "xy", "b" → ""]` from
 * `["a" → "x", "b" → "y"]`, and the consequence of that collision is a skipped
 * install on a repository whose dependencies really did change. A file that
 * does not exist yet is framed as `-1` rather than as zero bytes, because a
 * lockfile is frequently *created* by the very install being cached and
 * "absent" must not hash the same as "present and empty".
 *
 * Verifies: EPIC-07-S21 · AC5
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/** One `setupCacheKey` entry, read. `bytes` is `null` when the file is absent. */
export interface CacheKeyFile {
  /** Repo-relative, as the config declared it. Part of the digest. */
  readonly path: string;
  readonly bytes: Uint8Array | null;
}

const PREFIX = 'sha256-';
const DIGEST = /^sha256-[0-9a-f]{64}$/;

/** The marker key: `sha256-<64 hex>` over the framed concatenation. */
export function setupCacheKey(files: readonly CacheKeyFile[]): string {
  const hash = createHash('sha256');
  // Domain separation, so an empty `setupCacheKey` list is not the digest of
  // the empty string — which is a value other things in this system also hash.
  hash.update('DeFlow workspace.setup v1\0');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.bytes === null ? -1 : file.bytes.byteLength));
    hash.update('\0');
    if (file.bytes !== null) hash.update(Buffer.from(file.bytes));
  }
  return `${PREFIX}${hash.digest('hex')}`;
}

/**
 * The file name a marker for `key` is written under.
 *
 * The prefix is stripped so the name is 64 hex characters and nothing else —
 * and the shape is *checked* rather than assumed, because this value ends up
 * joined onto a directory path and a caller that hands over an arbitrary
 * string would otherwise be writing wherever it liked.
 */
export function markerFileName(key: string): string {
  if (!DIGEST.test(key)) {
    throw new Error(
      `"${key}" is not a sha256-<64 hex> marker key, and this value becomes a file name — ` +
        'refusing rather than joining it onto the marker directory.',
    );
  }
  return key.slice(PREFIX.length);
}
