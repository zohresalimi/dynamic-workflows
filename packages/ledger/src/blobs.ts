/**
 * KAR-03.9 — the content-addressed blob store
 * (docs/04-domain-model.md §10, docs/13-observability-and-telemetry.md §6,
 * docs/16-repo-layout.md §7.2).
 *
 * Anything over `MAX_INLINE_PAYLOAD_BYTES` is written to
 * `<dataDir>/blobs/<first two hex of sha256>/<sha256>` and the event keeps only
 * `{ sha256, bytes, mime, head, tail, truncated }`. The reason is one sentence
 * from the domain model: **replay time is a function of ledger size, and
 * un-spilled tool output is what makes it explode.** `event` is append-only and
 * is re-read in full by every replay for the life of the run, so a 4 MB tool
 * transcript written into it is permanent *and* recurring cost.
 *
 * Four properties this file exists to hold.
 *
 * 1. **Content addressing, so deduplication is free.** The most common large
 *    artifact in DeFlow is the *same failing test log emitted again* on
 *    attempts 2 and 3 of a repair loop. Writing the identical bytes a second
 *    time is a no-op here: the target already exists at the name its content
 *    determines, so there is no temp file, no rename and no I/O. That is also
 *    why blobs are global rather than per-run — two runs of the same task
 *    produce the same failing build log, and it is one object.
 * 2. **The temp file is a sibling of its target.** `rename(2)` is atomic only
 *    **within one filesystem**. A temp file under a system temp directory turns
 *    the atomic publish into a copy on every machine where that directory is a
 *    separate mount, silently, and the store then has torn files in it. It
 *    carries the ikey for the same reason the file-write effect's does
 *    (docs/05-durable-execution.md §9.4): an orphan is attributable to the
 *    write that died, and can be unlinked and redone.
 * 3. **The hash is verified on read, never trusted.** A path is a claim about
 *    content; returning bytes because they were found at the right filename is
 *    how a corrupted artifact becomes a plausible-looking agent input. Reads
 *    that disagree with their own name raise `BlobCorrupt` naming the handle.
 * 4. **Failure is typed, and the descriptor survives it.** `head` and `tail`
 *    are in the event, so a missing or corrupt blob still renders as an
 *    excerpt plus an explicit notice rather than an empty box. That is what
 *    `inspectArtifact` returns.
 *
 * Note what is *not* here: any form of deletion. Content addressing means a
 * blob can be referenced by any number of events across any number of runs, so
 * retention has to be reference-counted or mark-and-sweep. That is a note for
 * whoever ships pruning, not a function to add casually.
 */
import { canonicalJson, type Handle } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** The blob directory inside the global data dir (docs/16-repo-layout.md §7.2). */
export const BLOB_DIR = 'blobs';

/**
 * The ceiling on an inline `event.payload`, and therefore the spill threshold —
 * one exported constant, named once, so "~256 KiB" is never a number typed out
 * twice with a chance to disagree with itself.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 256 * 1024;

/**
 * How much of each end of a spilled payload the descriptor keeps.
 *
 * ~2 KiB each, which is what lets the UI render a preview of a 40 MB build log
 * in a list of two hundred nodes without touching the disk once — and is two
 * orders of magnitude below the spill threshold, so a descriptor can never
 * itself be large enough to spill.
 */
export const EXCERPT_BYTES = 2 * 1024;

/** The mime a spilled *event payload* carries: it is canonical JSON, always. */
export const PAYLOAD_MIME = 'application/json';

/** The notice the inspector shows when the full artifact is gone (AC7). */
export const ARTIFACT_UNAVAILABLE = 'full artifact unavailable';

/** The notice the inspector shows when the artifact no longer hashes (AC6). */
export const ARTIFACT_FAILED_INTEGRITY = 'artifact failed integrity';

const ARTIFACT_SCHEME = 'artifact://';
const ARTIFACT_HANDLE = /^artifact:\/\/[0-9a-f]{64}$/;

/**
 * What replaces an oversized payload in the event
 * (docs/13-observability-and-telemetry.md §6).
 *
 * `truncated` is a literal `true` rather than a boolean so the shape is a
 * discriminated union against every other payload: `isBlobRef` is a cheap,
 * unambiguous test, and no ordinary payload can accidentally look like one.
 */
export interface BlobRef {
  /** 64 lowercase hex. The blob's identity, its filename and its integrity check. */
  readonly sha256: string;
  /** Size of the full artifact, not of the excerpt. */
  readonly bytes: number;
  readonly mime: string;
  /** First ~2 KiB, decoded as UTF-8. */
  readonly head: string;
  /** Last ~2 KiB, decoded as UTF-8. Empty when the artifact is shorter than one excerpt. */
  readonly tail: string;
  readonly truncated: true;
}

/** True when this payload is a spill descriptor rather than the payload itself. */
export function isBlobRef(value: unknown): value is BlobRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BlobRef>;
  return (
    candidate.truncated === true &&
    typeof candidate.sha256 === 'string' &&
    typeof candidate.bytes === 'number' &&
    typeof candidate.mime === 'string' &&
    typeof candidate.head === 'string' &&
    typeof candidate.tail === 'string'
  );
}

/** A handle that is not `artifact://<64 hex sha256>` — a `file://` one, or a typo. */
export class InvalidBlobHandle extends Error {
  readonly handle: string;

  constructor(handle: string) {
    super(
      `"${handle}" is not a blob handle. The blob store addresses content by ` +
        `${ARTIFACT_SCHEME}<64 lowercase hex sha256>; a file:// handle names a region of a file ` +
        'in the repo and is resolved against the worktree, not against blobs/.',
    );
    this.name = 'InvalidBlobHandle';
    this.handle = handle;
  }
}

/**
 * A handle whose blob is not on disk. Typed rather than an `ENOENT`, because
 * the caller's correct response is to render the descriptor's excerpt with an
 * explicit notice — not to fail the read, and not to show an empty box.
 */
export class BlobMissing extends Error {
  readonly handle: string;
  readonly path: string;

  constructor(handle: string, path: string) {
    super(
      `${handle} is not in the blob store — expected it at ${path}. The event's ` +
        'head/tail excerpt is still readable, so this renders as an excerpt plus an explicit ' +
        `"${ARTIFACT_UNAVAILABLE}" state. Blobs are never deleted by DeFlow itself: something ` +
        'outside it removed the file, or this data directory was copied without blobs/.',
    );
    this.name = 'BlobMissing';
    this.handle = handle;
    this.path = path;
  }
}

/**
 * A blob whose bytes no longer hash to the name they are filed under.
 *
 * Raised rather than returning the bytes: content addressing is the only
 * integrity guarantee the store has, and a caller that is handed unverified
 * bytes feeds them to an agent as evidence.
 */
export class BlobCorrupt extends Error {
  readonly handle: string;
  readonly path: string;
  readonly actualSha256: string;

  constructor(handle: string, path: string, actualSha256: string) {
    super(
      `${handle} failed its integrity check: the bytes at ${path} hash to ${actualSha256}. ` +
        'The store is content-addressed, so the filename is a claim about the content and this ' +
        'file no longer satisfies it. Returning the bytes anyway would put a corrupted artifact ' +
        'in front of an agent as evidence, which is why this raises instead.',
    );
    this.name = 'BlobCorrupt';
    this.handle = handle;
    this.path = path;
    this.actualSha256 = actualSha256;
  }
}

/** `<dataDir>/blobs/<first two hex>/<full sha256>`. */
export function blobPath(dataDir: string, sha256: string): string {
  return join(dataDir, BLOB_DIR, sha256.slice(0, 2), sha256);
}

/**
 * Anything a filename cannot carry, flattened. An ikey is
 * `run/node/attempt/ordinal`, and its slashes would make the "temp file" a
 * path into directories that do not exist — which is the sibling rule broken by
 * accident rather than by design.
 */
const filenameSafe = (ikey: string): string => ikey.replaceAll(/[^A-Za-z0-9._-]/g, '_');

/**
 * The temp file a blob is written to before it is renamed into place: a
 * **sibling** of the target, in the same shard directory, carrying the ikey.
 *
 * Exported because it is the contract, not an implementation detail — a
 * reconcile pass looking for orphans has to be able to derive the same name,
 * and `test/blob-paths.test.ts` asserts the sibling property against it.
 */
export function blobTempPath(dataDir: string, sha256: string, ikey: string): string {
  return `${blobPath(dataDir, sha256)}.DeFlow-${filenameSafe(ikey)}.tmp`;
}

/** `artifact://<sha256>`, the one handle shape this store hands out. */
export const blobHandle = (sha256: string): Handle => `${ARTIFACT_SCHEME}${sha256}` as Handle;

/** The digest half of a handle, or `InvalidBlobHandle`. */
function shaOf(handle: string): string {
  if (!ARTIFACT_HANDLE.test(handle)) throw new InvalidBlobHandle(handle);
  return handle.slice(ARTIFACT_SCHEME.length);
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A per-process counter, so two blobs written in the same millisecond by the
 * same process cannot pick the same temp filename. Only used when the caller
 * has no ikey of its own to name the write with.
 */
let anonymousWrites = 0;

/**
 * Writes `bytes` and returns `artifact://<sha256>`.
 *
 * Idempotent by construction: the target's name *is* its content, so a second
 * write of the same bytes finds the file already there and does nothing at all
 * — no temp file, no rename, no I/O, same handle. That is the retry loop's
 * third identical test log costing nothing.
 *
 * The write itself is the atomic-rename recipe of
 * docs/05-durable-execution.md §9.4, in full: write to a sibling temp file,
 * `fsync` it, close it, rename it into place, then `fsync` the *directory* so
 * the rename itself survives a power cut rather than only the bytes.
 */
export function putBlob(dataDir: string, bytes: Uint8Array, mime: string, ikey?: string): Handle {
  const sha256 = digest(bytes);
  const target = blobPath(dataDir, sha256);
  const shard = dirname(target);

  // The dedupe fast path. The size check is cheap insurance rather than a
  // second integrity check: `rename` cannot leave a short file behind, so a
  // target of the wrong size is something outside DeFlow having truncated it,
  // and rewriting it is the repair.
  if (existingSize(target) === bytes.byteLength) return blobHandle(sha256);

  mkdirSync(shard, { recursive: true });
  const temp = blobTempPath(dataDir, sha256, ikey ?? `anon-${process.pid}-${anonymousWrites++}`);

  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  fsyncDir(shard);

  return blobHandle(sha256);
}

/** The size of `path`, or null when it is not there. */
function existingSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * `fsync` on the directory, which is what makes the *rename* durable — the
 * bytes being fsynced does not help if the directory entry pointing at them is
 * still only in the page cache.
 *
 * Best-effort: opening a directory for `fsync` is a POSIX behaviour and fails
 * with `EPERM`/`EISDIR` on some platforms. Losing the extra guarantee there is
 * acceptable; refusing to store the blob at all is not.
 */
function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // See above: not every platform permits this, and it is not worth failing over.
  } finally {
    closeSync(fd);
  }
}

/**
 * The bytes behind `handle`, verified against it.
 *
 * Throws `BlobMissing` when the file is gone and `BlobCorrupt` when it is there
 * but no longer hashes to its own name. Both name the handle, because the
 * caller's next move — render the excerpt, or tell the user the evidence is
 * untrustworthy — needs to say which artifact it is talking about.
 */
export function getBlob(dataDir: string, handle: Handle | string): Uint8Array {
  const sha256 = shaOf(handle);
  const path = blobPath(dataDir, sha256);

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      throw new BlobMissing(handle, path);
    }
    throw error;
  }

  const actual = digest(bytes);
  if (actual !== sha256) throw new BlobCorrupt(handle, path, actual);
  return bytes;
}

/** The two bounded ends of `bytes`, decoded as UTF-8. */
function excerpt(bytes: Uint8Array): { head: string; tail: string } {
  // Non-fatal on purpose: an excerpt cuts at a byte offset, so it can land in
  // the middle of a multi-byte character. A replacement character in a preview
  // is correct; throwing on a build log that happens to contain an emoji is not.
  const decoder = new TextDecoder('utf-8');
  return {
    head: decoder.decode(bytes.subarray(0, EXCERPT_BYTES)),
    tail:
      bytes.byteLength > EXCERPT_BYTES
        ? decoder.decode(bytes.subarray(bytes.byteLength - EXCERPT_BYTES))
        : '',
  };
}

/** Stores `bytes` and returns the descriptor an event carries in their place. */
export function spillBytes(
  dataDir: string,
  bytes: Uint8Array,
  mime: string,
  ikey?: string,
): BlobRef {
  putBlob(dataDir, bytes, mime, ikey);
  return {
    sha256: digest(bytes),
    bytes: bytes.byteLength,
    mime,
    ...excerpt(bytes),
    truncated: true,
  };
}

/**
 * The staging directory for blobs that are written as a stream.
 *
 * Inside `blobs/` so the temp file and its target are on the same filesystem —
 * `rename(2)` is atomic only within one mount, and a temp under the system
 * temp directory silently turns the atomic publish into a copy. Named with a
 * leading dot and no two-hex shape so a walk of the store can tell staging from
 * content at a glance.
 */
export const BLOB_STAGING_DIR = '.incoming';

/**
 * A blob whose bytes arrive over time and are never all held at once.
 *
 * `putBlob` wants a `Uint8Array`, which is right for an event payload and wrong
 * for a terminal: a `yarn build` with a progress bar emits tens of megabytes,
 * and buffering all of it in order to hash it is the failure the ring buffer in
 * front of it exists to prevent (docs/07-provider-adapter-layer.md §10.2). So
 * the digest is computed on the way past and the file is renamed into place
 * under it at the end.
 */
export interface BlobSpillWriter {
  write(bytes: Uint8Array): void;
  /** Publishes what has been written and returns its handle. Idempotent. */
  publish(): Handle;
  /** Abandons the capture and removes the staged file. */
  discard(): void;
  bytesWritten(): number;
}

/**
 * Opens a streaming spill into `<dataDir>/blobs/`.
 *
 * `mime` is accepted for symmetry with `putBlob` and is deliberately not stored
 * beside the file: the store is content-addressed, so the same bytes are one
 * object however they were labelled, and the label belongs on the reference in
 * the event rather than on the blob.
 */
export function openBlobSpill(dataDir: string, mime: string, ikey?: string): BlobSpillWriter {
  void mime;
  const staging = join(dataDir, BLOB_DIR, BLOB_STAGING_DIR);
  mkdirSync(staging, { recursive: true });
  const temp = join(
    staging,
    `${filenameSafe(ikey ?? `anon-${process.pid}-${anonymousWrites++}`)}-${Date.now()}.tmp`,
  );

  const hash = createHash('sha256');
  let bytesWritten = 0;
  let fd: number | null = openSync(temp, 'w');
  let handle: Handle | null = null;

  const closeStaged = (): void => {
    if (fd === null) return;
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
  };

  return {
    write(bytes) {
      if (fd === null) {
        throw new Error(
          'this blob stream has already been published or discarded; open another one',
        );
      }
      writeSync(fd, bytes);
      hash.update(bytes);
      bytesWritten += bytes.byteLength;
    },
    publish() {
      if (handle !== null) return handle;
      closeStaged();
      const sha256 = hash.digest('hex');
      const target = blobPath(dataDir, sha256);
      // The same dedupe fast path `putBlob` has: the target's name *is* its
      // content, so an identical capture that is already stored costs an
      // unlink rather than a write.
      if (existingSize(target) === bytesWritten) {
        unlinkSync(temp);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(temp, target);
        fsyncDir(dirname(target));
      }
      handle = blobHandle(sha256);
      return handle;
    },
    discard() {
      closeStaged();
      try {
        unlinkSync(temp);
      } catch {
        // Already published or already gone; either way there is nothing to do.
      }
    },
    bytesWritten: () => bytesWritten,
  };
}

/** What `spillIfLarge` decided. `payload` is what belongs in the event either way. */
export type SpillResult =
  | { readonly spilled: false; readonly payload: unknown }
  | { readonly spilled: true; readonly payload: BlobRef; readonly handle: Handle };

/**
 * The spill decision for one event payload: under the threshold it is returned
 * unchanged, over it the canonical JSON encoding goes to the blob store and the
 * descriptor comes back in its place.
 *
 * The threshold is applied to the **encoded** bytes, not to the object graph:
 * what the ledger stores and every replay re-reads is the row, and 40,000 short
 * keys are a small object and a large row.
 */
export function spillIfLarge(dataDir: string, payload: unknown, ikey?: string): SpillResult {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8');
  if (encoded.byteLength <= MAX_INLINE_PAYLOAD_BYTES) return { spilled: false, payload };
  const ref = spillBytes(dataDir, encoded, PAYLOAD_MIME, ikey);
  return { spilled: true, payload: ref, handle: blobHandle(ref.sha256) };
}

/** Whether the full artifact could be fetched, and why not when it could not. */
export type ArtifactStatus = 'available' | 'unavailable' | 'corrupt';

/**
 * What the node inspector renders for a spilled payload (AC7).
 *
 * `head`/`tail` are always populated — they come from the event, not from the
 * disk — so every status renders as an excerpt plus a notice, never as an empty
 * box.
 */
export interface ArtifactView {
  readonly status: ArtifactStatus;
  readonly handle: Handle;
  readonly sha256: string;
  /** Size of the full artifact, from the descriptor. */
  readonly bytes: number;
  readonly mime: string;
  readonly head: string;
  readonly tail: string;
  /** The full artifact when it resolved, null otherwise. */
  readonly content: Uint8Array | null;
  /** The sentence to show beside the excerpt, or null when nothing is wrong. */
  readonly notice: string | null;
}

/**
 * Resolves `ref` for display, degrading to its excerpt rather than throwing.
 *
 * This is the "the user opened the artifact" path and it verifies the hash,
 * which costs a full read. The list view does not call it at all: `head` and
 * `tail` are in the event, and rendering two hundred node cards must not touch
 * the disk once. That asymmetry is the whole reason the descriptor carries
 * excerpts.
 *
 * It lives in `@DeFlow/ledger` rather than in the UI because deciding that a
 * missing blob is `unavailable` and a mis-hashing one is `corrupt` is a
 * property of the store, not a rendering choice — EPIC-17's inspector renders
 * this value and does not re-derive it.
 */
export function inspectArtifact(dataDir: string, ref: BlobRef): ArtifactView {
  const base = {
    handle: blobHandle(ref.sha256),
    sha256: ref.sha256,
    bytes: ref.bytes,
    mime: ref.mime,
    head: ref.head,
    tail: ref.tail,
  };
  try {
    return { ...base, status: 'available', content: getBlob(dataDir, base.handle), notice: null };
  } catch (error) {
    if (error instanceof BlobMissing) {
      return { ...base, status: 'unavailable', content: null, notice: ARTIFACT_UNAVAILABLE };
    }
    if (error instanceof BlobCorrupt) {
      return { ...base, status: 'corrupt', content: null, notice: ARTIFACT_FAILED_INTEGRITY };
    }
    throw error;
  }
}
