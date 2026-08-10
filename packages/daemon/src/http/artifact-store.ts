/**
 * KAR-15.6 AC7 — what `GET /api/artifacts/:sha` and its `HEAD` read.
 *
 * The blob store is content-addressed and holds bytes only: a sha256 says
 * nothing about what the bytes *are*. The media type lives in the run artifact
 * index KAR-09.5 writes — `runs/<runId>/artifacts/<sha>/entry.json` — so
 * resolving one means asking the runs this data directory holds whether any of
 * them recorded this digest. That is a handful of `stat` calls against a direct
 * path per run, not a scan, and it is bounded by the number of runs rather than
 * by anything a caller controls.
 *
 * Nothing here reads the whole file to answer a range. `statSync` gives the
 * size and a positional `read` gives the slice, which is the difference between
 * serving the first kilobyte of a 200 MB log and loading 200 MB to serve a
 * kilobyte.
 */
import { blobPath, readRunArtifact } from '@DeFlow/ledger';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** What a sha256 resolves to on this machine. */
export interface ArtifactStat {
  readonly sha256: string;
  readonly path: string;
  readonly bytes: number;
  readonly mime: string;
}

/** 64 lowercase hex. Anything else is not a digest and is a 404, not a 500. */
const SHA256 = /^[0-9a-f]{64}$/;

const DEFAULT_MIME = 'application/octet-stream';

/**
 * Where run directories live under the data directory
 * (docs/16-repo-layout.md §7.2). The ledger's own writers join the same
 * segment; `../../test/integration/read-endpoints.test.ts` builds a fixture at
 * this path, so a drift is a failing spec rather than an empty media type.
 */
const RUNS_DIR = 'runs';

/**
 * The artifact `sha` names, or `null` when this machine does not hold it.
 *
 * A malformed digest is `null` rather than a throw: `/api/artifacts/deadbeef`
 * is a request for an artifact that does not exist, and that is exactly what
 * the caller needs to be told.
 */
export function artifactStat(dataDir: string, sha: string): ArtifactStat | null {
  if (!SHA256.test(sha)) return null;

  const path = blobPath(dataDir, sha);
  let bytes: number;
  try {
    bytes = statSync(path).size;
  } catch {
    return null;
  }

  return { sha256: sha, path, bytes, mime: artifactMime(dataDir, sha) };
}

/**
 * The media type some run recorded for these bytes, or `application/octet-stream`.
 *
 * Never sniffed. A guess from the first few bytes is a guess a browser will act
 * on, and rendering an untrusted artifact as `text/html` because it happened to
 * start with a tag is a stored-XSS vector on the operator's own origin.
 */
function artifactMime(dataDir: string, sha: string): string {
  let runIds: readonly string[];
  try {
    runIds = readdirSync(join(dataDir, RUNS_DIR));
  } catch {
    return DEFAULT_MIME;
  }

  for (const runId of runIds) {
    const entry = readRunArtifact(join(dataDir, RUNS_DIR, runId), sha);
    if (entry !== null) return entry.mime;
  }
  return DEFAULT_MIME;
}

/** `length` bytes from `offset`, read positionally — never the whole file. */
export function readArtifactBytes(path: string, offset: number, length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  if (length === 0) return buffer;

  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, offset + read);
      // A short read that returns nothing means the file ended early — which
      // can only happen if something outside DeFlow truncated it between the
      // `stat` and the read. The partial answer is the honest one.
      if (got === 0) return buffer.subarray(0, read);
      read += got;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}
