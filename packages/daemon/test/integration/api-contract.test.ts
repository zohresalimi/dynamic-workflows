/**
 * KAR-15.1 test plan #6 and #7 — the two properties that are only true on a
 * real socket, plus AC5's artifact.
 *
 * Verifies: EPIC-15-S3 (readiness polling), EPIC-15-S4 (the stack behind a
 * handle), EPIC-15-S5, EPIC-15-S6 (the production half) · AC3, AC5, AC6, AC7
 *
 * Integration because compression is applied by the adaptor as it writes the
 * body: `app.request()` never encodes anything, so a unit test asserting on
 * `Content-Encoding` would agree with a global `app.use(compress())` — which is
 * precisely the mistake this is here to catch.
 */
import { getBlob } from '@DeFlow/ledger';
import { it, makeRepo } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { startHttp } from '../../src/http/server.ts';

type Started = Awaited<ReturnType<typeof startHttp>>;

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: Record<string, unknown>;
    readonly retryable: boolean;
    readonly seq?: number;
  };
}

suite('the API on a real socket', () => {
  let started: Started | undefined;
  let origin = '';

  beforeAll(async () => {
    started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: false });
    origin = `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await started?.close();
  });

  it('compresses a JSON route when the client offers it (AC6)', async () => {
    const response = await fetch(`${origin}/api/health`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });

    expect(response.status).toBe(200);
    // `fetch` decodes transparently and strips the header from the exposed
    // Headers, so the wire is read through the one header it leaves behind.
    expect(response.headers.get('content-encoding')).toBe('gzip');
  });

  it('never compresses /api/stream, whatever the client offers (AC6)', async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(`${origin}/api/stream`, {
        headers: { 'Accept-Encoding': 'gzip' },
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
    } finally {
      controller.abort();
    }
  });

  it('carries X-DeFlow-Api on every API response, stream included (AC3)', async () => {
    const health = await fetch(`${origin}/api/health`);
    expect(health.headers.get('x-DeFlow-api')).toBe('1');

    const missing = await fetch(`${origin}/api/nope`);
    expect(missing.headers.get('x-DeFlow-api')).toBe('1');

    const controller = new AbortController();
    try {
      const stream = await fetch(`${origin}/api/stream`, { signal: controller.signal });
      expect(stream.headers.get('x-DeFlow-api')).toBe('1');
    } finally {
      controller.abort();
    }
  });

  it('answers /api/nope with the envelope and /nope with the SPA fallback (AC7)', async () => {
    const api = await fetch(`${origin}/api/nope`);
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
    const body = (await api.json()) as Envelope;
    expect(body.error.code).toBe('not_found');
    expect(body.error.retryable).toBe(false);

    // The production branch has no built UI in the workspace, so the fallback
    // answers 503 ui_not_built — the point being that it is the *fallback* that
    // answered, not the API's 404.
    const spa = await fetch(`${origin}/nope`);
    expect(spa.status).not.toBe(404);
  });

  it('answers /api/health with no Authorization header at all (AC3)', async () => {
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ apiVersion: 1 });
    expect(body.daemonEpoch).toBeDefined();
    expect(typeof body.headSeq).toBe('number');
  });
});

/**
 * EPIC-15-S5's last clause — *"ten events emitted one second apart arrive at ten
 * distinct client-side timestamps, not in one burst at stream end"*.
 *
 * Four frames 150 ms apart rather than ten a second apart: the property under
 * test is the transport's, not the ledger's, and ten seconds inside the
 * integration slice buys nothing the fourth frame has not already proved. The
 * assertion is a **lower** bound on the gaps, deliberately — a saturated box
 * makes them longer, never shorter, so this cannot go flaky in the direction
 * that would matter.
 *
 * Heartbeats rather than ledger events for the same reason: they are written
 * through the identical `stream.writeSSE` path, and a compressed stream would
 * hold them exactly as it holds anything else.
 */
suite('the stream arrives frame by frame, not in one burst (AC6)', () => {
  let started: Started | undefined;
  let origin = '';
  const heartbeat = process.env.DeFlow_SSE_HEARTBEAT_MS;

  beforeAll(async () => {
    process.env.DeFlow_SSE_HEARTBEAT_MS = '150';
    started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: false });
    origin = `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await started?.close();
    if (heartbeat === undefined) delete process.env.DeFlow_SSE_HEARTBEAT_MS;
    else process.env.DeFlow_SSE_HEARTBEAT_MS = heartbeat;
  });

  it('delivers four heartbeats at four distinct client-side timestamps', async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(`${origin}/api/stream`, {
        headers: { 'Accept-Encoding': 'gzip' },
        signal: controller.signal,
      });
      expect(response.headers.get('content-encoding')).toBeNull();

      const body = response.body;
      if (body === null) throw new Error('the stream carried no body');
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const arrivals: number[] = [];
      let buffered = '';

      while (arrivals.length < 4) {
        const { value, done } = await reader.read();
        if (done) throw new Error('the stream closed before four heartbeats arrived');
        const at = performance.now();
        buffered += decoder.decode(value, { stream: true });
        // One timestamp per *read*, not per frame: a burst would deliver
        // several heartbeats in one chunk and would therefore record one
        // arrival, which is exactly the failure this is looking for.
        if (buffered.includes('event: heartbeat')) {
          arrivals.push(at);
          buffered = '';
        }
      }

      const gaps = arrivals.slice(1).map((at, index) => at - (arrivals[index] as number));
      for (const gap of gaps) expect(gap).toBeGreaterThan(50);
      expect((arrivals.at(-1) as number) - (arrivals[0] as number)).toBeGreaterThan(300);
    } finally {
      controller.abort();
    }
  }, 30_000);
});

suite('an unexpected throw against a booted daemon', () => {
  it('writes the stack to an artifact and returns only its handle (AC5)', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    let booted: Booted | undefined;
    try {
      booted = await boot({ dataDir: `${tmp}/data`, port: 0, dev: false });
      const port = (booted.http.server.address() as AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;

      const created = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { kind: 'text', text: 'Rename the design tokens' },
          cwd: repo.dir,
          permission: 'worktree',
        }),
      });
      const { runId, seq } = (await created.json()) as { runId: string; seq: number };

      // A corrupt row is the honest way to reach the unplanned throw: the
      // reader JSON-parses `payload` unguarded, which is exactly the class of
      // failure AC5 exists for — nobody wrote a `catch` for it, and the client
      // must still get an envelope rather than a stack.
      booted.db.prepare('UPDATE event SET payload = ? WHERE seq = ?').run('{not json', seq);

      const response = await fetch(`${origin}/api/runs/${runId}`);

      expect(response.status).toBe(500);
      const body = (await response.json()) as Envelope;
      expect(body.error.code).toBe('internal');
      expect(body.error.retryable).toBe(true);
      // Nothing in the body may name a source file or a frame.
      expect(JSON.stringify(body)).not.toContain('.ts:');
      expect(JSON.stringify(body)).not.toContain('    at ');

      const handle = body.error.detail.stack;
      expect(typeof handle).toBe('string');
      expect(handle as string).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);

      const stack = new TextDecoder().decode(getBlob(`${tmp}/data`, handle as string));
      expect(stack).toContain('at ');
      expect(stack).toContain('JSON');
    } finally {
      await booted?.shutdown();
    }
  });
});
