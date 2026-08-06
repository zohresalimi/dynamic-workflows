/**
 * KAR-06.3 AC1 — the short-hex form of an ikey, for the places the key has to
 * be embedded in a filename.
 *
 * docs/05-durable-execution.md §8.1: "Hash it to short hex when it has to be
 * embedded in a filename." The atomic file write of §8.3 puts the ikey in a
 * sibling temp filename, and the raw key contains `/` — so the short hash is
 * not a cosmetic shortening, it is the only form that is a legal path segment.
 * The length is pinned here because a reconcile probe globbing for an orphaned
 * temp file has to build the same string a previous daemon life wrote.
 *
 * Verifies: EPIC-06-S8 (the key half) · AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { NodeIdSchema, RunIdSchema } from './ids.ts';
import { IKEY_SHORT_HASH_LENGTH, ikey, shortIkeyHash } from './ikey.ts';

const runId = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');
const nodeId = NodeIdSchema.parse('implement');

suite('shortIkeyHash (AC1)', () => {
  it('is a documented-length lowercase hex prefix of the sha256 of the key', async () => {
    expect(IKEY_SHORT_HASH_LENGTH).toBe(12);
    const short = await shortIkeyHash(ikey(runId, nodeId, 0, 0));
    expect(short).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable — the same key hashes to the same string on every call', async () => {
    const key = ikey(runId, nodeId, 0, 0);
    expect(await shortIkeyHash(key)).toBe(await shortIkeyHash(key));
  });

  it('is a legal filename segment, unlike the key it stands for', async () => {
    const key = ikey(runId, nodeId, 0, 0);
    expect(key).toContain('/');
    expect(await shortIkeyHash(key)).not.toContain('/');
  });

  it('separates keys that differ only in ordinal', async () => {
    const first = await shortIkeyHash(ikey(runId, nodeId, 0, 0));
    const second = await shortIkeyHash(ikey(runId, nodeId, 0, 1));
    expect(first).not.toBe(second);
  });

  it('separates keys that differ only in attempt — a retry is a different effect', async () => {
    const first = await shortIkeyHash(ikey(runId, nodeId, 1, 0));
    const second = await shortIkeyHash(ikey(runId, nodeId, 2, 0));
    expect(first).not.toBe(second);
  });
});
