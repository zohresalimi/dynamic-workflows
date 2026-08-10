/**
 * KAR-15.4 — the client's half of the resume contract, in a real browser.
 *
 * Verifies: EPIC-15-S27 (its browser half), EPIC-15-S32 (the client's
 * detection) · AC2, AC7, AC9
 *
 * Two claims, and both are about what the *client* sends rather than about what
 * the daemon serves:
 *
 * 1. **Every attempt carries `?since=<the cursor this tab has applied>`.** Not
 *    the cursor it had when the object was constructed — a URL built once and
 *    reused across a reconnect resumes from a stale cursor, and under §4.1's
 *    precedence (`since` beats `Last-Event-ID`) that stale number *wins* over
 *    the fresher one the browser would have sent. The bug that produces is
 *    duplicate delivery on every reconnect, which looks like a server fault.
 * 2. **No `Last-Event-ID` on a fresh connection.** The browser does not send
 *    one after a reload, and neither does this client — deliberately, so that
 *    the UI and the CLI resume through the identical code path (AC9) and the
 *    server is never allowed to depend on a header half its clients cannot
 *    produce.
 *
 * Driven through an injected `fetch` because the assertion is about the request
 * line and the headers, which is exactly what a real `EventSource` hides. The
 * reconnect is the library's own: the stream tells it `retry: 10` and then
 * ends, so what is exercised is the real reconnection path rather than a second
 * manual `connectStream`.
 */
import { afterEach, expect, it, describe as suite, vi } from 'vitest';
import { openStreamHub, type StreamHub } from './multiplex.ts';
import { connectStream, type StreamConnection } from './stream.ts';

const BASE = 'http://127.0.0.1:7777/api';
const RUN = 'run_20260806T141133Z_9f2a1c';

interface Attempt {
  readonly url: URL;
  readonly headers: Record<string, string>;
}

const ledgerFrame = (seq: number): string =>
  `id: ${seq}\ndata: ${JSON.stringify({
    seq,
    runId: RUN,
    ts: 1_754_140_000_000 + seq,
    kind: 'node.progress',
    v: 1,
    epoch: 7,
    payload: { node: 'n-impl-3', attempt: 1, phase: 'running' },
  })}\n\n`;

const helloFrame = (payload: Record<string, unknown>): string =>
  `event: hello\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * A `fetch` that records every attempt and serves it the body `bodyFor` builds
 * — then **ends** it, so the client's own reconnection logic runs. `retry: 10`
 * on the first line is what keeps that inside a test's patience.
 */
function attempts(seen: Attempt[], bodyFor: (attempt: number) => string) {
  return (input: string | URL, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input.toString());
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const index = seen.length;
    seen.push({ url, headers });

    return Promise.resolve({
      status: 200,
      redirected: false,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      url: url.toString(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`retry: 10\n\n${bodyFor(index)}`));
          controller.close();
        },
      }),
    });
  };
}

const closers: (() => void)[] = [];
const close = <T extends StreamConnection | StreamHub>(value: T): T => {
  closers.push(() => value.close());
  return value;
};

// An SSE connection nobody closed keeps retrying against a `fetch` the next
// spec is asserting on, so every one of them is closed here rather than in each
// spec's own `finally`.
afterEach(() => {
  for (const closer of closers.splice(0)) closer();
});

suite('EPIC-15-S27 — the cursor travels in ?since=, on every attempt (AC2, AC9)', () => {
  it('sends no Last-Event-ID on a fresh connection, however high the cursor', async () => {
    const seen: Attempt[] = [];
    close(
      connectStream({
        baseUrl: BASE,
        runs: [RUN],
        since: 10_432,
        fetch: attempts(seen, () => ''),
      }),
    );

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]?.url.searchParams.get('since')).toBe('10432');
    // The page-reload path: the cursor is the client's own, and the header the
    // browser would have sent does not exist here at all.
    expect(Object.keys(seen[0]?.headers ?? {})).not.toContain('last-event-id');
  });

  it('re-reads the cursor for each attempt rather than pinning the first', async () => {
    const seen: Attempt[] = [];
    let cursor = 7;
    close(
      connectStream({
        baseUrl: BASE,
        runs: [RUN],
        since: () => cursor,
        fetch: attempts(seen, () => ''),
      }),
    );

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    cursor = 10_432;
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));

    expect(seen[0]?.url.searchParams.get('since')).toBe('7');
    expect(seen[1]?.url.searchParams.get('since')).toBe('10432');
  });

  it('resumes a hub from the highest seq it applied, not from where it opened', async () => {
    const seen: Attempt[] = [];
    const hub = close(
      openStreamHub({
        baseUrl: BASE,
        since: 100,
        fetch: attempts(seen, (attempt) =>
          attempt === 0
            ? helloFrame({ streamId: 's1', runs: [RUN], headSeq: 140, daemonEpoch: 7 }) +
              ledgerFrame(120) +
              ledgerFrame(140)
            : helloFrame({ streamId: 's2', runs: [RUN], headSeq: 140, daemonEpoch: 7 }),
        ),
      }),
    );
    await hub.opened();

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));
    // The cursor is the hub's own, advanced by the frames it read — including
    // any whose kind this build does not know, which is what stops a reconnect
    // from asking for them again forever (./dispatch.ts).
    expect(hub.cursor()).toBe(140);
    // 140, not 100: a reconnect that asked from where the tab opened would be
    // handed 120 and 140 a second time, and every projection would see them
    // twice.
    expect(seen[0]?.url.searchParams.get('since')).toBe('100');
    expect(seen[1]?.url.searchParams.get('since')).toBe('140');
  });
});

suite('EPIC-15-S32 — the tab notices the world changed underneath it (AC7)', () => {
  it('reports a restart when the next hello carries a different daemonEpoch', async () => {
    const seen: Attempt[] = [];
    const skews: { restarted: boolean; buildChanged: boolean }[] = [];
    const hub = close(
      openStreamHub({
        baseUrl: BASE,
        since: 0,
        onSkew: (skew) =>
          skews.push({ restarted: skew.restarted, buildChanged: skew.buildChanged }),
        fetch: attempts(seen, (attempt) =>
          helloFrame({
            streamId: `s${attempt}`,
            runs: [],
            headSeq: 0,
            daemonEpoch: 7 + attempt,
            build: 'deadbeef',
          }),
        ),
      }),
    );
    await hub.opened();

    await vi.waitFor(() => expect(skews.length).toBeGreaterThan(0));
    expect(skews[0]).toEqual({ restarted: true, buildChanged: false });
    // And it keeps resuming from its own cursor rather than starting over.
    expect(seen[1]?.url.searchParams.get('since')).toBe('0');
  });

  it('reports a build skew against the build this tab was loaded with', async () => {
    const seen: Attempt[] = [];
    const skews: { restarted: boolean; buildChanged: boolean }[] = [];
    const hub = close(
      openStreamHub({
        baseUrl: BASE,
        since: 0,
        build: 'the-build-this-tab-loaded',
        onSkew: (skew) =>
          skews.push({ restarted: skew.restarted, buildChanged: skew.buildChanged }),
        fetch: attempts(seen, () =>
          helloFrame({
            streamId: 's1',
            runs: [],
            headSeq: 0,
            daemonEpoch: 7,
            build: 'a-newer-one',
          }),
        ),
      }),
    );
    await hub.opened();

    await vi.waitFor(() => expect(skews.length).toBeGreaterThan(0));
    // The first hello already disagrees: daemon and UI ship in one tarball, so
    // this only ever means "stale tab", and a reload prompt is the whole answer.
    expect(skews[0]).toEqual({ restarted: false, buildChanged: true });
  });

  it('says nothing at all when the daemon is the same one it opened against', async () => {
    const seen: Attempt[] = [];
    const skews: unknown[] = [];
    const hub = close(
      openStreamHub({
        baseUrl: BASE,
        since: 0,
        build: 'deadbeef',
        onSkew: (skew) => skews.push(skew),
        fetch: attempts(seen, () =>
          helloFrame({ streamId: 's1', runs: [], headSeq: 0, daemonEpoch: 7, build: 'deadbeef' }),
        ),
      }),
    );
    await hub.opened();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));

    expect(skews).toEqual([]);
  });
});
