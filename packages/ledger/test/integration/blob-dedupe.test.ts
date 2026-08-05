/**
 * KAR-03.9 — the same evidence across three attempts is one blob
 * (docs/13-observability-and-telemetry.md §6, docs/16-repo-layout.md §7.2).
 *
 * This is not a micro-optimisation and the fixture is not contrived: the single
 * most common large artifact in DeFlow is *the same failing test log, emitted
 * again on attempt 2 and attempt 3 of a repair loop*. Content addressing is
 * what makes the second and third writes free, and "blobs are global, not
 * per-run" is what makes it work across runs too.
 *
 * The inode is asserted rather than only the file count: a store that rewrote
 * the file every time would still show one file, and would still be doing the
 * I/O this design exists to avoid.
 *
 * Verifies: EPIC-03-S29 · AC4
 */
import { it } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  BLOB_DIR,
  blobPath,
  getBlob,
  openLedger,
  putBlob,
  readRange,
} from '../../src/index.ts';
import { draft, RUN_A, RUN_B } from './support/events.ts';

/** A byte-identical 1 MiB failing test log, as three attempts would produce it. */
const failingLog = (): Buffer =>
  Buffer.from(`FAIL packages/api/src/auth.test.ts\n${'  at Object.<anonymous>\n'.repeat(43_690)}`);

suite('three retries producing identical output (AC4)', () => {
  it('writes one file, hands back three identical handles, and never rewrites it', ({ tmp }) => {
    const attempts = [failingLog(), failingLog(), failingLog()];
    const handles = attempts.map((log, index) =>
      putBlob(tmp, log, 'text/plain', `n1/${index + 1}`),
    );

    expect(new Set(handles).size).toBe(1);
    const sha = handles[0]?.slice('artifact://'.length) ?? '';
    const shard = dirname(blobPath(tmp, sha));
    expect(readdirSync(shard)).toEqual([sha]);

    // Same inode and same mtime after the second and third writes: the file was
    // not rewritten, not replaced, not touched.
    const stats = attempts.map(() => statSync(blobPath(tmp, sha)));
    expect(new Set(stats.map((stat) => stat.ino)).size).toBe(1);
    expect(new Set(stats.map((stat) => stat.mtimeMs)).size).toBe(1);
    expect(getBlob(tmp, handles[0] ?? '').byteLength).toBe(attempts[0]?.byteLength);
  });
});

suite('blobs are global, not per-run (AC4)', () => {
  it('resolves the same failing build log from two different runs to one path', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const log = { stdout: `error TS2345\n${'  at build step\n'.repeat(120_000)}` };
      appendEvents(
        db,
        [draft({ runId: RUN_A, payload: log }), draft({ runId: RUN_B, payload: log })],
        { spillTo: tmp },
      );

      const a = readRange(db, RUN_A, 0, 10).events[0]?.payload as { sha256: string };
      const b = readRange(db, RUN_B, 0, 10).events[0]?.payload as { sha256: string };
      expect(a.sha256).toBe(b.sha256);

      // One object under the one global blobs/ directory, and no per-run copy.
      const shard = join(tmp, BLOB_DIR, a.sha256.slice(0, 2));
      expect(readdirSync(shard)).toEqual([a.sha256]);
      expect(readdirSync(join(tmp, BLOB_DIR))).toEqual([a.sha256.slice(0, 2)]);
    } finally {
      db.close();
    }
  });
});
