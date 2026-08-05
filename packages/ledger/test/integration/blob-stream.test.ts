/**
 * KAR-05.4 — spilling bytes the process never holds all of.
 *
 * `putBlob` takes a `Uint8Array`, which is the right shape for an event payload
 * and the wrong one for a terminal: a `yarn build` with a progress bar emits
 * tens of megabytes, and "keep it all in memory so it can be hashed" is the
 * failure mode the ring buffer in front of it exists to prevent. So this writer
 * hashes as it goes, streams to a temp file, and renames the finished file into
 * the store under the digest it computed on the way past.
 *
 * The temp file is a **sibling inside the same store** for the reason
 * docs/05-durable-execution.md §9.4 gives: `rename(2)` is atomic only within
 * one filesystem, and a temp under the system temp directory silently becomes a
 * copy — and a torn file — on any machine where that is a separate mount.
 *
 * Integration and against a real directory, because every property under test
 * is a filesystem property.
 *
 * Verifies: EPIC-05-S18 · AC7
 */
import { it } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { BLOB_DIR, blobPath, getBlob, openBlobSpill } from '../../src/index.ts';

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');

/** Files under `blobs/<ab>/`, ignoring the writer's own staging directory. */
function published(dataDir: string): string[] {
  const root = join(dataDir, BLOB_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
    .flatMap((shard) => readdirSync(join(root, shard.name)).map((name) => `${shard.name}/${name}`))
    .sort();
}

suite('a blob written as a stream', () => {
  it('publishes 5 MB under the digest of everything that went through it', ({ tmp }) => {
    const chunk = Buffer.alloc(64 * 1024, 0x62);
    const writer = openBlobSpill(tmp, 'text/plain');
    for (let written = 0; written < 5 * 1024 * 1024; written += chunk.byteLength) {
      writer.write(chunk);
    }
    expect(writer.bytesWritten()).toBe(5 * 1024 * 1024);

    const handle = writer.publish();
    const digest = sha256(Buffer.alloc(5 * 1024 * 1024, 0x62));

    expect(handle).toBe(`artifact://${digest}`);
    expect(published(tmp)).toEqual([`${digest.slice(0, 2)}/${digest}`]);
    // Read back through the store's own verifying reader, so the file has to
    // hash to the name it is filed under.
    expect(getBlob(tmp, handle).byteLength).toBe(5 * 1024 * 1024);
    expect(sha256(readFileSync(blobPath(tmp, digest)))).toBe(digest);
  });

  it('leaves nothing staged once it has published', ({ tmp }) => {
    const writer = openBlobSpill(tmp, 'text/plain');
    writer.write(Buffer.from('a build log', 'utf8'));
    writer.publish();

    const staged = readdirSync(join(tmp, BLOB_DIR), { withFileTypes: true }).filter(
      (entry) => !(entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name)),
    );
    // The staging directory may remain; a staged *file* may not.
    for (const entry of staged) {
      expect(
        entry.isDirectory() ? readdirSync(join(tmp, BLOB_DIR, entry.name)) : ['a file'],
      ).toEqual([]);
    }
  });

  it('deduplicates: two writers of the same bytes are one file', ({ tmp }) => {
    const first = openBlobSpill(tmp, 'text/plain');
    first.write(Buffer.from('the same failing test log', 'utf8'));
    const second = openBlobSpill(tmp, 'text/plain');
    second.write(Buffer.from('the same failing test log', 'utf8'));

    expect(first.publish()).toBe(second.publish());
    expect(published(tmp)).toHaveLength(1);
  });

  it('publishes an empty capture rather than pretending there was none', ({ tmp }) => {
    const writer = openBlobSpill(tmp, 'text/plain');
    const handle = writer.publish();
    expect(handle).toBe(`artifact://${sha256('')}`);
    expect(getBlob(tmp, handle).byteLength).toBe(0);
  });

  it('is idempotent: publishing twice returns the same handle and one file', ({ tmp }) => {
    const writer = openBlobSpill(tmp, 'text/plain');
    writer.write(Buffer.from('once', 'utf8'));
    expect(writer.publish()).toBe(writer.publish());
    expect(published(tmp)).toHaveLength(1);
  });

  it('discards without publishing, and without leaving the bytes behind', ({ tmp }) => {
    const writer = openBlobSpill(tmp, 'text/plain');
    writer.write(Buffer.from('abandoned', 'utf8'));
    writer.discard();
    expect(published(tmp)).toEqual([]);
  });

  it('refuses a write after the stream has been published or discarded', ({ tmp }) => {
    const writer = openBlobSpill(tmp, 'text/plain');
    writer.publish();
    expect(() => writer.write(Buffer.from('late', 'utf8'))).toThrow(/published|closed/i);
  });
});
