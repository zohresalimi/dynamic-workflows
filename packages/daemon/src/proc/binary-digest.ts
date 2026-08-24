/**
 * The sha256 of the binary an attempt is about to spawn, hex and bare.
 *
 * Lived in `pipeline/live-nodes.ts` until KAR-23.9, where the tool performer
 * became the second caller. Two implementations of "what is on `node.started`'s
 * `binary.sha256`" would be two answers to a provenance question, and the whole
 * point of the field is that there is one.
 *
 * **Not optional, and the reason is worth the paragraph.** `node.started`'s
 * payload requires a bare sha256 (`NodeStartedSchema`), and `appendEvents` does
 * not validate payloads on write — so a performer that passed `''` writes an
 * event the ledger stores happily and `parseEvent` then refuses on **read**.
 * The row is in the file, the SSE stream drops it, and `deflow run` never
 * learns the node started, so it never follows the node's `io_chunk` tail and
 * the operator sees a run with no output at all. That is precisely the
 * 2026-08-12 symptom, reproduced by a two-character shortcut.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/** Digested once per (path, mtime, size): a binary does not change under a
 * daemon, and hashing 60 MB per node would be a real cost. */
const digests = new Map<string, string>();

export function binarySha256(path: string): string {
  const stat = statSync(path);
  const key = `${path}:${String(stat.mtimeMs)}:${String(stat.size)}`;
  const held = digests.get(key);
  if (held !== undefined) return held;
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  digests.set(key, digest);
  return digest;
}
