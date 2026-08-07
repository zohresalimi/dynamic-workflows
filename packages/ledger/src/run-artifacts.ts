/**
 * KAR-09.5 — the run's artifact index: `runs/<runId>/artifacts/<sha256>/`
 * (docs/08-context-and-memory.md §5.2, docs/16-repo-layout.md §7.1, §7.2).
 *
 * **Two documents disagree about where an artifact lives, and both are right
 * about the thing they care about.** §5.2 says the store is content-addressed
 * under `runs/<runId>/artifacts/<sha256>/`; repo-layout §7.2 says there is one
 * blob store under the data directory, global across runs, because the same
 * failing build log across three retries and two runs is *one* object. Storing
 * the bytes per run would undo that.
 *
 * So the bytes stay global and this directory holds the **index**: one
 * directory per digest this run offloaded, containing one small `artifact.json`
 * that says what those bytes are, which node offloaded them and why. That gives
 * every property both documents ask for:
 *
 *   - the bytes are stored once, however many runs and retries produce them
 *     (AC2 — deduplication is real, not a naming convention);
 *   - two nodes of one run offloading identical bodies still produce exactly
 *     one directory here, because the directory is named by the digest;
 *   - and a handle is resolvable **from the run that recorded it and no other**
 *     (EPIC-09-S29's third scenario), which a global store alone cannot express
 *     — a digest is not a capability, and a run that never saw those bytes has
 *     no business reading them through `DeFlow_read_artifact`.
 *
 * The index is a directory of files rather than a table because NF8 wants every
 * artifact inspectable on disk in an open format: `cat` the entry, `cat` the
 * blob it names, no daemon required.
 *
 * **First writer wins.** The bytes cannot change under a digest, so a second
 * offload of the same body has nothing new to say about them, and overwriting
 * the entry would swap a description an event already referenced for a later
 * one. Immutable by construction, like the handle itself.
 *
 * Verifies: EPIC-09-S26 (first scenario), EPIC-09-S27 · AC1, AC2
 */
import type { Handle, NodeId } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** `<runDir>/artifacts/` — repo-layout §7.1. */
export const RUN_ARTIFACT_DIR = 'artifacts';

/** The one file inside `<runDir>/artifacts/<sha256>/`. */
export const RUN_ARTIFACT_ENTRY = 'artifact.json';

export function runArtifactsDirOf(runDir: string): string {
  return join(runDir, RUN_ARTIFACT_DIR);
}

export function runArtifactDirOf(runDir: string, sha256: string): string {
  return join(runArtifactsDirOf(runDir), sha256);
}

/**
 * What the index says about one artifact.
 *
 * `v` rather than a `schemaId`: this is a file DeFlow writes and reads on one
 * machine, not a document that travels through the ledger or over the API, and
 * the registered-`schemaId` machinery (`schemas/`, the append-only check) is
 * for the ones that do.
 */
export interface RunArtifactEntry {
  readonly v: 1;
  readonly sha256: string;
  readonly handle: Handle;
  readonly bytes: number;
  /** As a reader counts them — the `412 lines` of the handle line. */
  readonly lines: number;
  readonly mime: string;
  /** The sentence the handle line showed the agent. */
  readonly description: string;
  /** The first node whose packet offloaded these bytes. */
  readonly node: NodeId;
  /** That node's segment id, so the packet manifest and the index join. */
  readonly segment: string;
  /** `inline-threshold` or `budget` — see `DemotionReason`. */
  readonly reason: string;
}

/**
 * Records `entry` under the run, unless the digest is already indexed.
 *
 * Returns whether anything was written, which is what the deduplication claim
 * is made of: a second identical body is a no-op, not a second directory.
 */
export function recordRunArtifact(runDir: string, entry: RunArtifactEntry): boolean {
  const dir = runArtifactDirOf(runDir, entry.sha256);
  const path = join(dir, RUN_ARTIFACT_ENTRY);
  if (existsSync(path)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(entry, null, 2)}\n`);
  return true;
}

/** The entry for `sha256`, or `null` when this run never offloaded it. */
export function readRunArtifact(runDir: string, sha256: string): RunArtifactEntry | null {
  try {
    return JSON.parse(
      readFileSync(join(runArtifactDirOf(runDir, sha256), RUN_ARTIFACT_ENTRY), 'utf8'),
    ) as RunArtifactEntry;
  } catch {
    return null;
  }
}

/** Every digest this run offloaded, sorted. `[]` when it offloaded nothing —
 * an absent directory is a run with no artifacts, never an error. */
export function listRunArtifacts(runDir: string): readonly string[] {
  try {
    return readdirSync(runArtifactsDirOf(runDir)).toSorted();
  } catch {
    return [];
  }
}

/** Write, fsync, rename — docs/05-durable-execution.md §9.4, with the temp file
 * a sibling of its target so the rename is atomic rather than a
 * cross-filesystem copy. */
function writeFileAtomic(path: string, text: string): void {
  const temp = `${path}.DeFlow.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, Buffer.from(text, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
