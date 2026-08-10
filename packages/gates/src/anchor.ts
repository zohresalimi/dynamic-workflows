/**
 * KAR-12.3 AC6 — anchoring a finding's range to the revision it was read from
 * (docs/10-verification-gates.md §8).
 *
 * A parser cannot do this. It reads a tool's output, which says `line 42` and
 * nothing about *which* file content line 42 belonged to; the answer is a fact
 * about the worktree at the moment the gate ran, and it is read here.
 *
 * **The name is git's, computed rather than shelled out for.** A blob's object
 * name is `sha1("blob " + byteLength + "\0" + bytes)` — the same value
 * `git hash-object` prints, which is what makes a finding's anchor comparable
 * with anything git will later say about the file. Computing it costs a hash
 * over bytes already in memory; spawning `git hash-object` once per file costs
 * a process per file and adds a git dependency to a package that otherwise
 * needs none. `../test/integration/blob-anchor.test.ts` holds the two to each
 * other against a real repository, which is where that claim belongs.
 *
 * A sha256 repository names its blobs differently, and DeFlow does not pretend
 * otherwise: the schema accepts both widths, and a finding anchored here always
 * carries the sha1 name of the bytes the gate actually read. The comparison the
 * projection makes is between two names produced the same way, so it is exact
 * either way.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { GateFinding, ParsedFinding } from './finding.ts';

/** `sha1("blob <len>\0<bytes>")` — the object name `git hash-object` prints. */
export function gitBlobSha(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Resolves a repo-relative path to the blob name of its current content, or
 * `undefined` when there is nothing to read. */
export type BlobShaOf = (file: string) => string | undefined;

/**
 * The blob resolver for a real directory. Unreadable is `undefined` rather than
 * a throw: a tool that reported a path which no longer exists has still
 * reported something true about the run, and the missing file is not an error
 * in the gate.
 */
export function blobShaIn(root: string): BlobShaOf {
  return (file) => {
    try {
      return gitBlobSha(readFileSync(isAbsolute(file) ? file : join(root, file)));
    } catch {
      return undefined;
    }
  };
}

/**
 * AC6 — every parsed finding, with the blob its range refers to.
 *
 * A finding whose file cannot be read is **kept and left unanchored**. The two
 * alternatives are both worse: dropping it hides a real complaint from the
 * repair loop, and inventing a blob anchors a range to bytes nobody read. An
 * unanchored finding simply carries no `location` into the sealed verdict —
 * `DeFlow.finding.v2` rejects a location with no blob, which is the same rule
 * stated where it can be enforced.
 */
export function anchorFindings(
  findings: readonly ParsedFinding[],
  blobShaOf: BlobShaOf,
): readonly GateFinding[] {
  const resolved = new Map<string, string | undefined>();
  return findings.map((finding) => {
    if (!resolved.has(finding.file)) resolved.set(finding.file, blobShaOf(finding.file));
    const blobSha = resolved.get(finding.file);
    return blobSha === undefined ? finding : { ...finding, blobSha };
  });
}
