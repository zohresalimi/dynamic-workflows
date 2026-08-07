/**
 * KAR-09.6 AC6 — §6.3's transcript snapshot: one file copy that turns the
 * vendor's unrecoverable in-session compaction into something recoverable.
 *
 * When a `compact_boundary` frame arrives, whatever the vendor summarised away
 * is still on disk in its own transcript
 * (`~/.claude/projects/<project>/<session_id>.jsonl` by the convention decoded
 * from the bundle). Copying it into the content-addressed store before the
 * agent writes another turn gives F6.6's `originalHandle` for the price of a
 * read — the vendor still reports nothing about *what* it dropped, but the
 * bytes are no longer gone.
 *
 * **The path convention is Unverified.** It was read from the bundle and never
 * exercised against a live authenticated session, so every failure here — no
 * file, no permission, a directory where a file was expected — answers `null`.
 * A missing snapshot is a compaction with `originalHandle: null` and a node
 * that keeps running; a node that failed because an Unverified path was wrong
 * would be this story causing the outage it exists to soften.
 *
 * **The entry is tagged `raw-transcript`.** A vendor transcript is the whole
 * conversation verbatim — prompts, tool output, whatever the agent read out of
 * the repository — and it is exactly the artifact leakage PRD G14 is about.
 * Nothing in EPIC-09 exports or syncs an artifact, so the tag is not a filter
 * today; it is what makes F5.9's redaction pass able to *find* these without
 * re-deriving which artifacts came from where.
 *
 * Verifies: EPIC-09-S34 · AC6
 */
import type { Handle, NodeId } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { putBlob } from './blobs.ts';
import { listRunArtifacts, readRunArtifact, recordRunArtifact } from './run-artifacts.ts';

/** The mime a vendor transcript carries: JSON Lines, not JSON. */
export const TRANSCRIPT_MIME = 'application/x-ndjson';

/** `RunArtifactEntry.reason` for a snapshot — it was not demoted out of a
 * packet, so neither `inline-threshold` nor `budget` is true of it. */
export const TRANSCRIPT_SNAPSHOT_REASON = 'transcript-snapshot';

/** `RunArtifactEntry.sensitivity` for bytes that are a raw vendor transcript. */
export const RAW_TRANSCRIPT = 'raw-transcript';

export interface TranscriptSnapshotInput {
  /** The global data directory — where `blobs/` lives. */
  readonly dataDir: string;
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  /** Where the vendor keeps the session's transcript. May not exist. */
  readonly sourcePath: string;
  readonly node: NodeId;
  readonly sessionId: string;
}

/**
 * Copies the transcript into the store and indexes it under the run, or answers
 * `null` when there was nothing to copy.
 *
 * Read whole rather than streamed: a session transcript at compaction time is
 * the size of a context window in JSON, and the copy has to complete *before*
 * the next turn appends to the same file — a streamed copy would race the agent
 * and produce a snapshot of two different moments.
 */
export function snapshotTranscript(input: TranscriptSnapshotInput): Handle | null {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(input.sourcePath);
  } catch {
    // Every failure is the same answer, deliberately: "absent" and "unreadable"
    // are both "DeFlow has no snapshot", and distinguishing them here would
    // only give a caller a second way to fail a node over an Unverified path.
    return null;
  }

  const handle = putBlob(input.dataDir, bytes, TRANSCRIPT_MIME);
  const sha256 = handle.slice(handle.indexOf('//') + 2);

  recordRunArtifact(input.runDir, {
    v: 1,
    sha256,
    handle,
    bytes: bytes.byteLength,
    lines: Buffer.from(bytes).toString('utf8').split('\n').length,
    mime: TRANSCRIPT_MIME,
    description: `vendor session transcript captured at a compaction boundary (session ${input.sessionId})`,
    node: input.node,
    // Not a packet segment: there is no manifest entry this joins to, and
    // saying otherwise would make the packet and the index disagree.
    segment: '',
    reason: TRANSCRIPT_SNAPSHOT_REASON,
    sensitivity: RAW_TRANSCRIPT,
  });

  return handle;
}

/**
 * Every artifact of this run that F5.9's redaction pass has to look at before
 * anything leaves the machine.
 *
 * It exists now, with no exporter to feed, on purpose: the tag is only worth
 * writing if something can act on it, and the first exporter should find this
 * function rather than invent its own idea of what is sensitive.
 */
export function listRawTranscripts(runDir: string): readonly string[] {
  return listRunArtifacts(runDir).filter(
    (sha256) => readRunArtifact(runDir, sha256)?.sensitivity === RAW_TRANSCRIPT,
  );
}
