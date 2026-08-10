/**
 * KAR-15.1 AC1 — a typed round trip through `hc<ApiType>`, from the UI's side.
 *
 * Verifies: EPIC-15-S1 · AC1, AC2
 *
 * The daemon is not running here and does not need to be: what this asserts is
 * that the *client* is derived from the daemon's own route definitions — the
 * URL it builds, the parameter it substitutes, the header it attaches, and the
 * shape it hands back. The compile-time half of the same scenario lives in
 * `./contract.type-test.ts`, which `pnpm typecheck` runs over this package and
 * over `packages/cli`.
 */
import { expect, it, describe as suite } from 'vitest';
import { createClient } from './client.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';

/** Enough of a run summary for the client to parse; the daemon owns the rest. */
const SUMMARY = {
  runId: RUN_ID,
  status: 'running',
  outcome: null,
  planHash: null,
  planVersion: 1,
  nodeCounts: { running: 1 },
  headSeq: 42,
};

interface Call {
  readonly url: string;
  readonly headers: Headers;
}

function recordingFetch(calls: Call[], body: unknown, status = 200) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'X-DeFlow-Api': '1' },
      }),
    );
  };
}

suite('the typed client', () => {
  it("builds GET /api/runs/:id from the daemon's own route (AC1)", async () => {
    const calls: Call[] = [];
    const rpc = createClient({
      baseUrl: 'http://127.0.0.1:7777/api',
      fetch: recordingFetch(calls, SUMMARY),
    });

    const response = await rpc.runs[':id'].$get({ param: { id: RUN_ID } });

    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:7777/api/runs/${RUN_ID}`);
  });

  it("hands back the daemon's own return type, not any (AC1)", async () => {
    const rpc = createClient({
      baseUrl: 'http://127.0.0.1:7777/api',
      fetch: recordingFetch([], SUMMARY),
    });

    const response = await rpc.runs[':id'].$get({ param: { id: RUN_ID } });
    if (!response.ok) throw new Error(`unexpected ${response.status}`);

    // `runId` and `planVersion` are read by name off the inferred type. If the
    // daemon renamed either, this file would stop compiling — which is exactly
    // what AC2 asks for, and is asserted as a build failure in the type test
    // beside this one rather than only here.
    const run = await response.json();
    expect(run.runId).toBe(RUN_ID);
    expect(run.planVersion).toBe(1);
  });

  it('sends the bearer token as a header and never in the URL (AC1, KAR-15.2)', async () => {
    const calls: Call[] = [];
    const rpc = createClient({
      baseUrl: 'http://127.0.0.1:7777/api',
      token: () => 'a-token-nobody-should-see-in-a-log',
      fetch: recordingFetch(calls, SUMMARY),
    });

    await rpc.runs[':id'].$get({ param: { id: RUN_ID } });

    expect(calls[0]?.headers.get('authorization')).toBe(
      'Bearer a-token-nobody-should-see-in-a-log',
    );
    expect(calls[0]?.url).not.toContain('a-token-nobody-should-see-in-a-log');
  });

  it('reads the closed error envelope off a refusal (AC4)', async () => {
    const rpc = createClient({
      baseUrl: 'http://127.0.0.1:7777/api',
      fetch: recordingFetch(
        [],
        { error: { code: 'run_not_found', message: 'no such run', detail: {}, retryable: false } },
        404,
      ),
    });

    const response = await rpc.runs[':id'].$get({ param: { id: RUN_ID } });
    if (response.ok) throw new Error('expected a refusal');

    const body = await response.json();
    expect('error' in body && body.error.code).toBe('run_not_found');
  });

  it("defaults to the daemon's own origin, so a tab needs no configuration", async () => {
    const calls: Call[] = [];
    const rpc = createClient({ fetch: recordingFetch(calls, { apiVersion: 1 }) });

    await rpc.health.$get();

    expect(calls[0]?.url).toBe(`${globalThis.location.origin}/api/health`);
  });
});
