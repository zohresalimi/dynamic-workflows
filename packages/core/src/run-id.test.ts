/**
 * KAR-02.1 — `RunId` is a legal path segment and sorts by creation order.
 *
 * `.DeFlow/runs/` is browsed by a human and listed by `deflow run --list`; the
 * format puts the timestamp before the random suffix precisely so `ls` is
 * chronological (docs/delivery/flows/EPIC-02-domain-model-flows.md).
 *
 * Verifies: EPIC-02-S5 · AC2
 */
import path from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { RunIdSchema } from './ids.ts';
import { mintRunId } from './run-id.ts';

/** A stand-in for the daemon's real randomness port: deterministic, but only
 * inside this test file — core itself never calls this. */
function sequentialHex(seed: number): () => string {
  return () => seed.toString(16).padStart(6, '0');
}

suite('mintRunId', () => {
  it('produces a RunId matching /^run_\\d{8}T\\d{6}Z_[0-9a-f]{6}$/', () => {
    const id = mintRunId(Date.UTC(2026, 7, 2, 14, 11, 33), sequentialHex(0x9f2a1c));
    expect(id).toBe('run_20260802T141133Z_9f2a1c');
    expect(RunIdSchema.safeParse(id).success).toBe(true);
  });

  it('is a legal single path segment for 100 generated ids, with no case-collision risk', () => {
    for (let i = 0; i < 100; i += 1) {
      const id = mintRunId(Date.UTC(2026, 7, 2, 14, 11, 33) + i * 1000, sequentialHex(i));
      const joined = path.join('/tmp/DeFlow-runs', id);
      expect(path.basename(joined)).toBe(id);
      expect(id).not.toContain('/');
      expect(id).not.toContain(':');
      expect(id).not.toContain('\\');
      // The format's `T` and `Z` are fixed literal separators, present in
      // every RunId — they carry no case-collision risk. The *variable*
      // segments (the date/time digits and the random suffix) must be
      // lowercase, which is what a case-insensitive filesystem actually
      // needs: two RunIds differing only in case cannot occur.
      const match = id.match(/^run_(\d{8})T(\d{6})Z_([0-9a-f]{6})$/);
      expect(match).not.toBeNull();
    }
  });

  it('sorts lexicographically in creation order across a one-second gap', () => {
    const r1 = mintRunId(Date.UTC(2026, 7, 2, 14, 11, 33), sequentialHex(0xaaaaaa));
    const r2 = mintRunId(Date.UTC(2026, 7, 2, 14, 11, 34), sequentialHex(0x000000));
    expect(r1 < r2).toBe(true);
  });
});
