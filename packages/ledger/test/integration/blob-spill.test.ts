/**
 * KAR-03.9 — a payload over ~256 KiB spills to the content-addressed blob
 * store, and the event keeps only a descriptor
 * (docs/04-domain-model.md §10, docs/13-observability-and-telemetry.md §6).
 *
 * Integration rather than unit, and against a real directory rather than
 * `memfs`, because every property under test is a filesystem property: the
 * shard layout, the atomic rename, the absence of a residual temp file and the
 * integrity check on read. A virtual filesystem would agree with any of them.
 *
 * Verifies: EPIC-03-S28 · AC1, AC2, AC3, AC5, AC6, AC7
 */
import { canonicalJson } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  BLOB_DIR,
  BlobCorrupt,
  BlobMissing,
  blobPath,
  getBlob,
  inspectArtifact,
  isBlobRef,
  MAX_INLINE_PAYLOAD_BYTES,
  openLedger,
  putBlob,
  readRange,
} from '../../src/index.ts';
import { draft, RUN_A } from './support/events.ts';

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');

/** A payload whose canonical JSON encoding is at least `bytes` long. */
const sized = (bytes: number): Record<string, unknown> => ({ text: 'q'.repeat(bytes) });

/**
 * Every file under `<dataDir>/blobs/`, as paths relative to it. An absent
 * directory reads as no files: not spilling must not create the directory
 * either.
 */
function blobFiles(dataDir: string, dir = join(dataDir, BLOB_DIR), prefix = ''): string[] {
  let found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name);
    found = entry.isDirectory()
      ? [...found, ...blobFiles(dataDir, full, `${prefix}${entry.name}/`)]
      : [...found, `${prefix}${entry.name}`];
  }
  return found;
}

suite('the spill threshold (AC1, AC2)', () => {
  it('stores a 255 KiB payload inline and writes no blob at all', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const payload = sized(255 * 1024 - 64);
      appendEvents(db, [draft({ payload })], { spillTo: tmp });

      const [event] = readRange(db, RUN_A, 0, 10).events;
      expect(event?.payload).toEqual(payload);
      expect(isBlobRef(event?.payload)).toBe(false);
      expect(blobFiles(tmp)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('replaces a 2 MiB payload with { sha256, bytes, mime, head, tail } and shards the file', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const payload = sized(2 * 1024 * 1024);
      const encoded = canonicalJson(payload);
      appendEvents(db, [draft({ payload })], { spillTo: tmp });

      const [event] = readRange(db, RUN_A, 0, 10).events;
      if (!isBlobRef(event?.payload)) throw new Error('expected the payload to have spilled');
      const ref = event.payload;

      expect(ref.sha256).toBe(sha256(encoded));
      expect(ref.bytes).toBe(Buffer.byteLength(encoded, 'utf8'));
      expect(ref.mime).toBe('application/json');
      expect(ref.head).toMatch(/^\{"text":"q+/);
      expect(ref.tail).toMatch(/q+"\}$/);
      expect(ref.truncated).toBe(true);

      // <dataDir>/blobs/<first two hex>/<full sha256>, and that file hashes to
      // the name it is filed under.
      expect(blobFiles(tmp)).toEqual([`${ref.sha256.slice(0, 2)}/${ref.sha256}`]);
      expect(sha256(readFileSync(blobPath(tmp, ref.sha256)))).toBe(ref.sha256);
    } finally {
      db.close();
    }
  });

  it('leaves a descriptor that is itself well under the inline ceiling', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [draft({ payload: sized(8 * 1024 * 1024) })], { spillTo: tmp });
      const [event] = readRange(db, RUN_A, 0, 10).events;
      const encoded = Buffer.byteLength(canonicalJson(event?.payload), 'utf8');
      expect(encoded).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES / 16);
    } finally {
      db.close();
    }
  });
});

suite('the handle round-trips (AC3)', () => {
  it('returns artifact://<64 hex sha256> and resolves it to bytes that hash to it', ({ tmp }) => {
    const bytes = Buffer.from('x'.repeat(2 * 1024 * 1024), 'utf8');
    const handle = putBlob(tmp, bytes, 'text/plain');

    expect(handle).toBe(`artifact://${sha256(bytes)}`);
    expect(handle).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);

    const read = getBlob(tmp, handle);
    expect(read.byteLength).toBe(2 * 1024 * 1024);
    expect(sha256(read)).toBe(handle.slice('artifact://'.length));
  });
});

suite('the write is atomic and stays on one filesystem (AC5)', () => {
  it('leaves no temp file beside the blob once the write completes', ({ tmp }) => {
    const bytes = Buffer.from('y'.repeat(1024 * 1024), 'utf8');
    const handle = putBlob(tmp, bytes, 'text/plain');
    const target = blobPath(tmp, handle.slice('artifact://'.length));

    expect(readdirSync(dirname(target))).toEqual([handle.slice('artifact://'.length)]);
    expect(statSync(target).size).toBe(bytes.byteLength);
  });
});

suite('failure modes are typed, and the inspector still renders (AC6, AC7)', () => {
  it('raises BlobMissing naming the handle when the file has been deleted', ({ tmp }) => {
    const bytes = Buffer.from('z'.repeat(512 * 1024), 'utf8');
    const handle = putBlob(tmp, bytes, 'text/plain');
    rmSync(blobPath(tmp, handle.slice('artifact://'.length)));

    expect(() => getBlob(tmp, handle)).toThrow(BlobMissing);
    expect(() => getBlob(tmp, handle)).toThrow(handle);
  });

  it('raises BlobCorrupt naming the handle rather than returning wrong bytes', ({ tmp }) => {
    const bytes = Buffer.from('z'.repeat(512 * 1024), 'utf8');
    const handle = putBlob(tmp, bytes, 'text/plain');
    // Same length, different content: a size check would pass this, and a
    // caller trusting the path would get bytes that are not what it asked for.
    writeFileSync(blobPath(tmp, handle.slice('artifact://'.length)), 'w'.repeat(512 * 1024));

    expect(() => getBlob(tmp, handle)).toThrow(BlobCorrupt);
    expect(() => getBlob(tmp, handle)).toThrow(handle);
  });

  it('renders the head/tail excerpt with an explicit "full artifact unavailable" state', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [draft({ payload: sized(2 * 1024 * 1024) })], { spillTo: tmp });
      const [event] = readRange(db, RUN_A, 0, 10).events;
      if (!isBlobRef(event?.payload)) throw new Error('expected the payload to have spilled');
      rmSync(blobPath(tmp, event.payload.sha256));

      const view = inspectArtifact(tmp, event.payload);
      expect(view.status).toBe('unavailable');
      expect(view.notice).toBe('full artifact unavailable');
      expect(view.head).toBe(event.payload.head);
      expect(view.tail).toBe(event.payload.tail);
      expect(view.head.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('renders an explicit "artifact failed integrity" state instead of the wrong bytes', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [draft({ payload: sized(2 * 1024 * 1024) })], { spillTo: tmp });
      const [event] = readRange(db, RUN_A, 0, 10).events;
      if (!isBlobRef(event?.payload)) throw new Error('expected the payload to have spilled');
      writeFileSync(blobPath(tmp, event.payload.sha256), 'tampered');

      const view = inspectArtifact(tmp, event.payload);
      expect(view.status).toBe('corrupt');
      expect(view.notice).toBe('artifact failed integrity');
      expect(view.head).toBe(event.payload.head);
      expect(view.tail).toBe(event.payload.tail);
    } finally {
      db.close();
    }
  });

  it('reports the artifact as available, with its bytes, when nothing is wrong', ({ tmp }) => {
    const bytes = Buffer.from('k'.repeat(1024 * 1024), 'utf8');
    const handle = putBlob(tmp, bytes, 'text/plain');
    const view = inspectArtifact(tmp, {
      sha256: handle.slice('artifact://'.length),
      bytes: bytes.byteLength,
      mime: 'text/plain',
      head: 'kkk',
      tail: 'kkk',
      truncated: true,
    });

    expect(view.status).toBe('available');
    expect(view.notice).toBe(null);
  });
});

suite('without a blob store, an oversized payload is still refused', () => {
  it('does not silently write a 2 MiB row when appendEvents is given nowhere to spill', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      expect(() => appendEvents(db, [draft({ payload: sized(2 * 1024 * 1024) })])).toThrow(
        /KAR-03\.9/,
      );
      expect(readRange(db, RUN_A, 0, 10).events).toEqual([]);
    } finally {
      db.close();
    }
  });
});
