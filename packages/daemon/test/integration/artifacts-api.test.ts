/**
 * EPIC-15-S41 — `GET /api/artifacts/:sha` and `HEAD` beside it: content
 * addressing, `Range` and immutable caching.
 *
 * Integration and over a real socket, because two of the three claims are about
 * HTTP rather than about a function: a `206` carries the bytes the client asked
 * for and a `Content-Range` that agrees with them, and a `HEAD` carries a size
 * and a media type with **no body at all**. A unit test over a handler cannot
 * tell a `HEAD` that returned an empty string from one that returned nothing.
 *
 * Verifies: EPIC-15-S41 · KAR-15.6 AC7 · test plan #6, #8
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import {
  ARTIFACT_SCHEME,
  appendEvents,
  type Db,
  type EventDraft,
  openLedger,
  putBlob,
  recordRunArtifact,
} from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260810T111500Z_ac1541');
const T0 = 1_754_812_800_000;

/** 4 KiB of deterministic bytes, so a slice is checkable by value. */
const BYTES = new Uint8Array(4096).map((_unused, index) => index % 251);

interface Served {
  readonly origin: string;
  readonly db: Db;
  readonly sha: string;
  close(): Promise<void>;
}

async function serveArtifact(tmp: string): Promise<Served> {
  const db = openLedger(tmp);
  const handle = putBlob(tmp, BYTES, 'application/x-ndjson');
  const sha = handle.slice(ARTIFACT_SCHEME.length);

  // The media type lives in the run's artifact index, not in the blob store —
  // a sha256 says nothing about what the bytes are.
  recordRunArtifact(join(tmp, 'runs', RUN), {
    v: 1,
    sha256: sha,
    handle,
    bytes: BYTES.byteLength,
    lines: 1,
    mime: 'application/x-ndjson',
    description: 'the agent transcript this node produced',
    node: 'n-impl',
    segment: 'tool.output',
    reason: 'inline-threshold',
  });

  const draft = (kind: string, payload: unknown): EventDraft =>
    ({ runId: RUN, ts: T0, kind, v: 1, epoch: 1, payload }) as EventDraft;
  appendEvents(db, [
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'offload an artifact',
        scope: { included: [] },
        nonGoals: [],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'artifacts are fetchable' }],
        knownFailureModes: [],
        approvedBy: null,
        specHash: `sha256-${'3'.repeat(64)}`,
      },
      cwd: '/workspace/repo',
      repo: { head: 'abcdef1', branch: 'main' },
    }),
  ]);

  const view = openLedgerView(tmp);
  setLedgerView(view);
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    sha,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('content-addressed blobs (EPIC-15-S41, AC7)', () => {
  it('answers HEAD with the size and the media type and no body', async ({ tmp }) => {
    served = await serveArtifact(tmp);

    const response = await fetch(`${served.origin}/api/artifacts/${served.sha}`, {
      method: 'HEAD',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.arrayBuffer()).toHaveProperty('byteLength', 0);
  });

  it('answers a Range with 206 and exactly those bytes', async ({ tmp }) => {
    served = await serveArtifact(tmp);

    const response = await fetch(`${served.origin}/api/artifacts/${served.sha}`, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-1023/${BYTES.byteLength}`);

    // 1,024 bytes, because both ends of a Range are inclusive. The off-by-one
    // here is a truncated download rather than a test failure.
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(1024);
    expect([...body]).toEqual([...BYTES.subarray(0, 1024)]);
  });

  it('answers a suffix range with the last N bytes', async ({ tmp }) => {
    served = await serveArtifact(tmp);

    const response = await fetch(`${served.origin}/api/artifacts/${served.sha}`, {
      headers: { Range: 'bytes=-100' },
    });

    const body = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(206);
    expect([...body]).toEqual([...BYTES.subarray(BYTES.byteLength - 100)]);
  });

  it('carries immutable cache headers, because content addressing makes it safe', async ({
    tmp,
  }) => {
    served = await serveArtifact(tmp);

    const response = await fetch(`${served.origin}/api/artifacts/${served.sha}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('etag')).toBe(`"${served.sha}"`);
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(BYTES.byteLength);
  });

  it('refuses a range that starts past the end with 416', async ({ tmp }) => {
    served = await serveArtifact(tmp);

    const response = await fetch(`${served.origin}/api/artifacts/${served.sha}`, {
      headers: { Range: `bytes=${BYTES.byteLength}-` },
    });

    // 416 rather than an empty 206: a 206 with nothing in it reads to a client
    // as "this file is empty".
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${BYTES.byteLength}`);
  });

  it('answers an unknown sha with artifact_not_found', async ({ tmp }) => {
    served = await serveArtifact(tmp);

    for (const sha of ['deadbeef', 'f'.repeat(64)]) {
      const response = await fetch(`${served.origin}/api/artifacts/${sha}`);
      expect(response.status, sha).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code, sha).toBe(
        'artifact_not_found',
      );
    }
  });

  it('falls back to octet-stream rather than sniffing a media type', async ({ tmp }) => {
    served = await serveArtifact(tmp);

    // A blob nothing recorded an entry for. Guessing from the first bytes is
    // how an untrusted artifact gets rendered as text/html on the operator's
    // own origin.
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const handle = putBlob(tmp, html, 'text/html');
    const sha = handle.slice(ARTIFACT_SCHEME.length);

    const response = await fetch(`${served.origin}/api/artifacts/${sha}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/octet-stream');
  });
});
