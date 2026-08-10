/**
 * KAR-15.2 AC8 and AC9 — the SSE connection carries the token as a header, and
 * its URL carries no credential at all.
 *
 * Verifies: EPIC-15-S13 (scenario 2, the client half) · AC8, AC9
 *
 * > Native `EventSource` **cannot send custom headers** — the API has no
 * > mechanism for it — which is the entire reason `eventsource-client` is a
 * > dependency: a native-`EventSource` design forces the token into the query
 * > string.
 *
 * So this asserts the request the connector actually makes, through a `fetch`
 * the spec supplies. The server's side of the same scenario — what the daemon's
 * access log shows for an open stream — is in the daemon's
 * `integration/first-run-handoff.test.ts`.
 */
import { expect, it, describe as suite, vi } from 'vitest';
import { connectStream, streamUrl } from './stream.ts';

const TOKEN = 'CFqL3n_Ov6dRk8QpYt2wZs1xJ4mHb7uE9aTgN0cVpRs';
const RUN = 'run_20260806T141133Z_9f2a1c';

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** A `fetch` that records the request and then holds the stream open. */
function recording(seen: Seen[]) {
  return (url: string | URL, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: url.toString(), headers: { ...init?.headers } });
    return Promise.resolve({
      status: 200,
      redirected: false,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        },
      }),
      url: url.toString(),
    });
  };
}

suite('the stream URL (AC9)', () => {
  it('carries runs= and since= and nothing else', () => {
    const url = new URL(streamUrl('http://127.0.0.1:7777/api', [RUN], 42));
    expect([...url.searchParams.keys()].sort()).toEqual(['runs', 'since']);
    expect(url.searchParams.get('runs')).toBe(RUN);
    expect(url.searchParams.get('since')).toBe('42');
  });

  it('never contains the token, in any parameter', () => {
    const url = streamUrl('http://127.0.0.1:7777/api', [RUN], 0);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain('token');
  });
});

suite('the connection (AC8)', () => {
  it('sends Authorization: Bearer on the stream request itself', async () => {
    const seen: Seen[] = [];
    const connection = connectStream({
      baseUrl: 'http://127.0.0.1:7777/api',
      runs: [RUN],
      since: 7,
      token: () => TOKEN,
      fetch: recording(seen),
    });

    try {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    } finally {
      connection.close();
    }

    const headers = Object.fromEntries(
      Object.entries(seen[0]?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.url).not.toContain(TOKEN);
  });

  it('sends no Authorization header at all when there is no token yet', async () => {
    const seen: Seen[] = [];
    const connection = connectStream({
      baseUrl: 'http://127.0.0.1:7777/api',
      runs: [],
      since: 0,
      token: () => null,
      fetch: recording(seen),
    });

    try {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    } finally {
      connection.close();
    }

    // An empty `Authorization: Bearer ` is worse than none: it reads as a
    // malformed credential rather than as an anonymous request.
    const names = Object.keys(seen[0]?.headers ?? {}).map((name) => name.toLowerCase());
    expect(names).not.toContain('authorization');
  });
});
