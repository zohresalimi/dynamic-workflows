/**
 * KAR-00.3 — Spike: Vite middleware mode carrying SSE and HMR on one port.
 *
 * The question D10 rests on: does `vite@8.2.0` really attach to the daemon's
 * own `node:http` server, and does an SSE route on that same server survive
 * without buffering or dying? Every spec below runs the real harness at
 * `spikes/s4-one-port/` as a real subprocess — a real Vite dev server, a real
 * Hono app on `@hono/node-server`, real sockets counted with `lsof`. Nothing is
 * mocked; the point of a spike is that the answer is an executed fact.
 *
 * Verifies: EPIC-00-S11, EPIC-00-S12, EPIC-00-S13 (server half)
 * · AC1, AC2, AC3, AC4, AC5, AC6.
 *
 * The ten-minute run is not re-run on every `pnpm test` — it is run once, by
 * `node spikes/s4-one-port/run-long.mjs`, and its recorded CSV and summary are
 * committed under `spikes/s4-one-port/measurements/`. The suite at the bottom
 * asserts AC2 and AC3 against that recording, exactly as the acceptance
 * criterion says ("measured from the CSV, not by watching a terminal").
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  AC1_PORT,
  freePort,
  type Harness,
  health,
  type ListeningSocket,
  listeningSockets,
  MEASUREMENTS_DIR,
  observations,
  preferredPort,
  sleep,
  startHarness,
  startProxy,
  stopAll,
} from '../../spikes/s4-one-port/src/harness.ts';
import { classifySeq } from '../../spikes/s4-one-port/src/resume.ts';
import { connectSse } from '../../spikes/s4-one-port/src/sse-client.ts';
import { repoRoot } from '../support/workspace.ts';

const MEASUREMENTS = MEASUREMENTS_DIR;

let main: Harness;

beforeAll(async () => {
  // 250 ms rather than the 1 s of AC2: the cadence itself is measured by the
  // ten-minute recording at the bottom of this file, and every spec up here is
  // about routing, headers and resume rather than about the clock.
  //
  // KAR-00.10: `preferredPort` rather than `AC1_PORT` flat. 7777 is the
  // daemon's own default, so on a developer's machine the thing most likely to
  // be holding it is a `deflow up` from an hour ago — twelve of them were
  // cleared off this machine on 2026-08-15, one of which was on 7777. When that
  // happened this whole file died in `beforeAll` and reported 25 skipped tests
  // and a confusing "pid N is already listening there", none of which is about
  // SSE, HMR or mount order. Not one spec below actually needs *that* number:
  // AC1's claim is "one socket", and the claim about 7777 in particular is
  // carried by the committed ten-minute recording at the bottom of this file,
  // which really did bind it.
  const port = await preferredPort(AC1_PORT);
  main = await startHarness({ S4_PORT: String(port), S4_INTERVAL_MS: '250', S4_GAP_AT: '3' });
}, 60_000);

afterAll(async () => {
  await stopAll();
});

suite('EPIC-00-S11 — one process, one port (AC1, AC6)', () => {
  it('listens on exactly one socket, and it is the one it was asked for', async () => {
    const current = await health(main.origin);
    expect(current.pid, 'this run must be looking at the server this run spawned').toBe(main.pid);
    expect(current.port).toBe(main.port);
    const sockets = listeningSockets(current.pid);
    expect(
      sockets,
      `expected one socket, got ${JSON.stringify(sockets)} — a second one means Vite opened its own HMR server and D10's premise is false`,
    ).toHaveLength(1);
    expect(sockets[0]?.port).toBe(main.port);
    expect(sockets[0]?.address).toBe('127.0.0.1');
  });

  /**
   * The one thing that really is about the number 7777: it is what the harness
   * asks for. Whether this machine had it free today is a fact about this
   * machine, and the recorded ten-minute run at the bottom of this file is the
   * evidence that the socket AC1 names was really bound.
   */
  it('asks for 7777, whatever it ends up on', () => {
    expect(AC1_PORT).toBe(7777);
  });

  it('serves the Vue app and the API from that same socket', async () => {
    const ui = await fetch(`${main.origin}/`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');
    expect(await ui.text()).toContain('id="app"');

    const module = await fetch(`${main.origin}/src/Live.vue`);
    expect(module.status, 'Vite must be transforming SFCs on this port').toBe(200);
    expect(await module.text()).toContain('__name');
  });

  it('carries Vite HMR on the same port, with no second server to connect to', async () => {
    const socket = new WebSocket(main.origin.replace(/^http/, 'ws'), 'vite-hmr');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no HMR handshake within 10 s')), 10_000);
        socket.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('the HMR websocket errored while connecting'));
        });
      });
    } finally {
      socket.close();
    }
  });

  it('gives the API route to the API, never to the SPA fallback (AC6)', async () => {
    // The browser's own default `Accept` for a navigation, aimed at an API path.
    // Mount order is the only thing standing between this and 200 text/html —
    // the day /api/stream returns index.html is the day an SSE client sits
    // there silently consuming HTML.
    const response = await fetch(`${main.origin}/api/stream?limit=1`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).not.toContain('<!doctype html');
  });

  it('answers an unknown /api path with a typed 404 rather than the SPA', async () => {
    const response = await fetch(`${main.origin}/api/nope`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

/**
 * The number of streams the server currently believes are open, sampled only
 * once that number has stopped moving.
 *
 * `SseRecorder.close()` aborts the client's fetch and returns synchronously,
 * but the server only decrements `open` when it notices the socket is gone —
 * measured at 1–4 ms on an idle machine, and wider under a loaded run. A
 * baseline taken while an earlier spec's stream is still counted makes the
 * deltas below net out to zero: the stale connection is reaped between the two
 * samples, so one arrives and one leaves and the count does not move. That is a
 * red with nothing to say about the transport it is meant to be testing, so the
 * baseline waits for quiescence rather than assuming it.
 */
async function settledOpen(origin: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = (await observations(origin)).open;
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(25);
    const current = (await observations(origin)).open;
    if (current !== last) {
      last = current;
      stable = 0;
      continue;
    }
    stable += 1;
    // 100 ms of an unchanging count, against a reap measured in single-digit
    // milliseconds.
    if (stable >= 4) return current;
  }
  throw new Error(`the open-stream count never settled within ${timeoutMs} ms (last saw ${last})`);
}

suite('EPIC-00-S11 — the stream transport (AC4)', () => {
  it('sends no-cache, no-transform and X-Accel-Buffering: no, and no Content-Encoding', async () => {
    const stream = await connectSse(`${main.origin}/api/stream`);
    try {
      const headers = stream.responseHeaders();
      expect(headers.get('content-type')).toContain('text/event-stream');
      expect(headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(headers.get('x-accel-buffering')).toBe('no');
      expect(
        headers.get('content-encoding'),
        'anything compressing this route buffers it into one burst',
      ).toBeNull();
    } finally {
      stream.close();
    }
  });

  it('delivers events one at a time rather than in one burst', async () => {
    const stream = await connectSse(`${main.origin}/api/stream`);
    try {
      const events = await stream.waitFor(4, 10_000);
      const receipts = events.map((event) => event.receivedAtMs);
      const spread = (receipts.at(-1) ?? 0) - (receipts[0] ?? 0);
      expect(spread, 'four events at 250 ms apart cannot arrive within 100 ms').toBeGreaterThan(
        400,
      );
    } finally {
      stream.close();
    }
  });

  it('learns immediately when a client goes away', async () => {
    const before = await settledOpen(main.origin);
    const stream = await connectSse(`${main.origin}/api/stream`);
    await stream.waitFor(1, 10_000);
    expect((await observations(main.origin)).open).toBe(before + 1);

    stream.close();
    const deadline = Date.now() + 5_000;
    let open = -1;
    while (Date.now() < deadline) {
      open = (await observations(main.origin)).open;
      if (open === before) break;
      await sleep(50);
    }
    expect(open, 'the backend must learn the client navigated away').toBe(before);
  });
});

suite('EPIC-00-S13 — resume across a reload, at the wire level (AC5)', () => {
  it('records that a plain connection sent no Last-Event-ID and asked for nothing', async () => {
    const stream = await connectSse(`${main.origin}/api/stream`);
    try {
      await stream.waitFor(1, 10_000);
      const last = (await observations(main.origin)).connections.at(-1);
      expect(last?.lastEventId).toBeNull();
      expect(last?.since).toBeNull();
      expect(last?.mode).toBe('live');
    } finally {
      stream.close();
    }
  });

  it('loses nothing and duplicates nothing across a ?since= re-hydration', async () => {
    const first = await connectSse(`${main.origin}/api/stream`);
    const before = await first.waitFor(3, 10_000);
    first.close();

    const lastSeen = before.at(-1)?.seq ?? 0;
    // Long enough that events are produced while nobody is listening — which is
    // the whole point: a reload takes time, and those events must not be lost.
    await sleep(700);

    const second = await connectSse(`${main.origin}/api/stream?since=${lastSeen}`);
    try {
      const after = await second.waitFor(4, 10_000);
      const resumed = (await observations(main.origin)).connections.at(-1);
      expect(resumed?.since).toBe(String(lastSeen));
      expect(resumed?.resumedAfter).toBe(lastSeen);

      const seqs = [...before, ...after].map((event) => event.seq);
      expect(new Set(seqs).size, `duplicates in ${JSON.stringify(seqs)}`).toBe(seqs.length);
      expect(
        after[0]?.seq ?? 0,
        'the first resumed event is strictly after the cursor',
      ).toBeGreaterThan(lastSeen);
      for (let index = 1; index < seqs.length; index += 1) {
        expect(classifySeq(seqs[index - 1] ?? null, seqs[index] ?? 0)).toBe('accepted');
      }
    } finally {
      second.close();
    }
  });

  it('honours a Last-Event-ID header, resuming strictly greater', async () => {
    const stream = await connectSse(`${main.origin}/api/stream`, { lastEventId: '2' });
    try {
      const events = await stream.waitFor(2, 10_000);
      const resumed = (await observations(main.origin)).connections.at(-1);
      expect(resumed?.lastEventId).toBe('2');
      expect(resumed?.mode).toBe('last-event-id');
      // seq 3 is burned by S4_GAP_AT, so "strictly greater than 2" is 4.
      expect(events[0]?.seq).toBe(4);
    } finally {
      stream.close();
    }
  });

  it('burns a sequence number without the client calling it a missing event', async () => {
    const stream = await connectSse(`${main.origin}/api/stream?since=0`);
    try {
      const events = await stream.waitFor(5, 10_000);
      const seqs = events.map((event) => event.seq);
      expect(seqs).not.toContain(3);
      expect(classifySeq(2, 4)).toBe('accepted');
    } finally {
      stream.close();
    }
  });
});

suite('EPIC-00-S11 — mount order is what makes the API win (AC6)', () => {
  it('returns the SPA index.html for /api/stream when the fallback is mounted first', async () => {
    const wrong = await startHarness({ S4_MODE: 'fallback-first', S4_INTERVAL_MS: '250' });
    const response = await fetch(`${wrong.origin}/api/stream`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const body = await response.text();
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body.toLowerCase()).toContain('<!doctype html');
    await wrong.stop();
  }, 60_000);
});

suite('EPIC-00-S12 — compression in front of the stream buffers it into one burst', () => {
  it('withholds every event until the stream ends, and admits it in Content-Encoding', async () => {
    const compressed = await startHarness({ S4_MODE: 'compressed', S4_INTERVAL_MS: '100' });
    const stream = await connectSse(`${compressed.origin}/api/stream?limit=12`, {
      acceptEncoding: 'gzip',
    });
    try {
      expect(
        stream.responseHeaders().get('content-encoding'),
        'the misconfiguration must really be in force, or the symptom proves nothing',
      ).toBe('gzip');

      const events = await stream.waitFor(12, 20_000);
      const receipts = events.map((event) => event.receivedAtMs);
      const first = receipts[0] ?? 0;
      const last = receipts.at(-1) ?? 0;
      // Twelve events, 100 ms apart, span 1.1 s at the server. Arriving inside
      // 150 ms of each other means they were held and flushed together.
      expect(last - first, `receipts: ${JSON.stringify(receipts)}`).toBeLessThan(150);
      expect(last).toBeGreaterThan(1_000);
    } finally {
      stream.close();
      await compressed.stop();
    }
  }, 60_000);

  it('is refused outright while the stream keeps its own headers (AC4, the guard)', async () => {
    // The same compression middleware, on the same route, with `no-transform`
    // left in place and `streamSSE`'s own Transfer-Encoding left alone. hono
    // 4.12.33 declines on all three counts — content type, no-transform,
    // Transfer-Encoding — so the header AC4 asks for is not decoration: it is
    // read at runtime by the middleware that would otherwise do the damage.
    const guarded = await startHarness({ S4_MODE: 'compressed-guarded', S4_INTERVAL_MS: '100' });
    const stream = await connectSse(`${guarded.origin}/api/stream?limit=12`, {
      acceptEncoding: 'gzip',
    });
    try {
      expect(stream.responseHeaders().get('content-encoding')).toBeNull();
      expect(stream.responseHeaders().get('cache-control')).toBe('no-cache, no-transform');
      const events = await stream.waitFor(12, 20_000);
      const receipts = events.map((event) => event.receivedAtMs);
      const spread = (receipts.at(-1) ?? 0) - (receipts[0] ?? 0);
      expect(spread, 'and the events still arrive one at a time').toBeGreaterThan(800);
    } finally {
      stream.close();
      await guarded.stop();
    }
  }, 60_000);
});

suite('EPIC-00-S12 — a Vite dev proxy in front of the daemon', () => {
  /**
   * The third documented symptom is "the backend never learns the client
   * navigated away". On vite@8.2.0 it does not reproduce: the proxy tears the
   * upstream connection down with the client's, within a second. That is the
   * measurement, so it is what this spec asserts — writing down the symptom the
   * issue tracker described would be asserting a belief.
   *
   * Nothing about the decision changes (docs/spikes/S4-one-port.md): the reason
   * not to proxy is that one origin removes CORS and makes dev and production
   * routing identical, not that Vite's proxy is broken. But the day this spec
   * goes red is the day the old reports are live again, which is why it is
   * written as an equality rather than as a shrug.
   */
  it('propagates the disconnect to the backend, on this version, within a second', async () => {
    const proxy = await startProxy(main.port);
    try {
      const before = await settledOpen(main.origin);
      const stream = await connectSse(`${proxy.origin}/api/stream`);
      await stream.waitFor(2, 15_000);
      expect((await observations(main.origin)).open).toBe(before + 1);

      stream.close();
      const deadline = Date.now() + 5_000;
      let open = -1;
      let elapsed = 0;
      const closedAt = Date.now();
      while (Date.now() < deadline) {
        open = (await observations(main.origin)).open;
        if (open === before) {
          elapsed = Date.now() - closedAt;
          break;
        }
        await sleep(100);
      }
      expect(
        open,
        'the proxy held the upstream connection open — vitejs/vite#12157 is live again and docs/03-local-development.md §4.3 needs its third bullet back',
      ).toBe(before);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await proxy.stop();
    }
  }, 60_000);
});

// --- the recorded ten-minute run --------------------------------------------

interface LongRun {
  readonly durationSeconds: number;
  readonly intervalMs: number;
  readonly listeningSockets: ListeningSocket[];
  readonly direct: {
    readonly csv: string;
    readonly events: number;
    readonly heldForMs: number;
  };
  readonly hmr: {
    readonly file: string;
    readonly editAtMs: number;
    readonly updateReceivedAtMs: number;
    readonly updatedModules: string[];
    readonly streamEnded: boolean;
    readonly reconnects: number;
  };
  readonly proxied: {
    readonly csv: string;
    readonly events: number;
    readonly diedAfterMs: number | null;
    readonly backendSawCloseMs: number | null;
  };
}

interface Row {
  readonly seq: number;
  readonly event: string;
  readonly receivedAtMs: number;
}

function readRows(file: string): Row[] {
  const lines = readFileSync(join(MEASUREMENTS, file), 'utf8').trim().split('\n');
  expect(lines[0]).toBe('seq,event,receivedAtMs,gapMs');
  return lines.slice(1).map((line) => {
    const [seq, event, receivedAtMs] = line.split(',');
    return { seq: Number(seq), event: String(event), receivedAtMs: Number(receivedAtMs) };
  });
}

/** Gaps recomputed from the raw receipts, never read back from the gap column. */
function gaps(rows: readonly Row[]): number[] {
  return rows.slice(1).map((row, index) => row.receivedAtMs - (rows[index]?.receivedAtMs ?? 0));
}

suite('AC2, AC3 — the recorded ten-minute run', () => {
  const summaryPath = join(MEASUREMENTS, 'ten-minutes.json');

  it('has been run and committed', () => {
    expect(
      existsSync(summaryPath),
      'run `node spikes/s4-one-port/run-long.mjs` once and commit spikes/s4-one-port/measurements/',
    ).toBe(true);
  });

  const summary = (): LongRun => JSON.parse(readFileSync(summaryPath, 'utf8')) as LongRun;

  it('ran for ten minutes at one event per second, on one socket', () => {
    const run = summary();
    expect(run.durationSeconds).toBe(600);
    expect(run.intervalMs).toBe(1_000);
    expect(run.listeningSockets).toEqual([{ address: '127.0.0.1', port: AC1_PORT }]);
  });

  it('recorded 600 events, individually, with no gap over 3 s (AC2)', () => {
    const run = summary();
    const rows = readRows(run.direct.csv);
    expect(rows).toHaveLength(600);
    expect(run.direct.events).toBe(600);
    // Ten minutes of wall clock, not six hundred events crammed into a minute.
    expect(run.direct.heldForMs).toBeGreaterThanOrEqual(600_000);
    const span = (rows.at(-1)?.receivedAtMs ?? 0) - (rows[0]?.receivedAtMs ?? 0);
    expect(span).toBeGreaterThan(595_000);

    const observed = gaps(rows);
    expect(Math.max(...observed)).toBeLessThan(3_000);

    const sorted = [...observed].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    expect(median).toBeGreaterThan(950);
    expect(median).toBeLessThan(1_050);

    // "the events did not all arrive within the final second"
    const last = rows.at(-1)?.receivedAtMs ?? 0;
    const inFinalSecond = rows.filter((row) => row.receivedAtMs > last - 1_000).length;
    expect(inFinalSecond).toBeLessThan(5);
    expect(rows[0]?.receivedAtMs).toBeLessThan(2_000);
  });

  it('recorded the same ten minutes through a Vite dev proxy, and the note states how it went', () => {
    const run = summary();
    const rows = readRows(run.proxied.csv);
    expect(rows).toHaveLength(run.proxied.events);
    expect(readFileSync(join(repoRoot, 'docs/spikes/S4-one-port.md'), 'utf8')).toMatch(
      /proxied[\s\S]{0,200}ten minutes|ten minutes[\s\S]{0,200}proxied/i,
    );
  });

  it('hot-reloaded a .vue file mid-stream without the stream noticing (AC3)', () => {
    const run = summary();
    expect(run.hmr.file).toContain('.vue');
    expect(run.hmr.editAtMs).toBeGreaterThan(250_000);
    expect(run.hmr.updateReceivedAtMs).toBeGreaterThan(run.hmr.editAtMs);
    expect(run.hmr.updateReceivedAtMs - run.hmr.editAtMs).toBeLessThan(5_000);
    expect(run.hmr.updatedModules.join(' ')).toContain('.vue');
    expect(run.hmr.streamEnded).toBe(false);
    expect(run.hmr.reconnects).toBe(0);

    // And the stream itself shows nothing at all around the edit.
    const rows = readRows(run.direct.csv);
    const around = rows.filter(
      (row) =>
        row.receivedAtMs > run.hmr.editAtMs - 5_000 && row.receivedAtMs < run.hmr.editAtMs + 5_000,
    );
    expect(around.length).toBeGreaterThan(5);
    expect(Math.max(...gaps(around))).toBeLessThan(3_000);
    expect(new Set(around.map((row) => row.seq)).size).toBe(around.length);
  });
});

suite('EPIC-00-S12 — the decision note records the guards', () => {
  const note = () => readFileSync(join(repoRoot, 'docs/spikes/S4-one-port.md'), 'utf8');

  it('exists, with a measurement and a decision', () => {
    expect(existsSync(join(repoRoot, 'docs/spikes/S4-one-port.md'))).toBe(true);
    expect(note()).toMatch(/## Measurement/);
    expect(note()).toMatch(/## Decision/);
  });

  it('names the story that must forbid a proxy, and the one that must assert the headers', () => {
    const text = note();
    expect(text).toContain('KAR-01.3');
    expect(text).toContain('no server.proxy anywhere in the repo');
    expect(text).toContain('KAR-15.3');
  });

  it('records all three documented proxy failure modes and their guards', () => {
    const text = note();
    expect(text).toContain('Content-Encoding');
    expect(text).toContain('no compression middleware');
    expect(text).toContain('navigated away');
  });
});

suite('KAR-00.10 — no spec here depends on one fixed port being free', () => {
  /**
   * The failure this replaces: anything already holding 7777 took the whole
   * file down in `beforeAll`. Twenty-five tests skipped, and a message about a
   * foreign pid rather than about SSE. 7777 is the daemon's own default
   * (docs/03-local-development.md §9), so the likeliest squatter is a `deflow
   * up` somebody forgot — twelve were cleared off this machine on 2026-08-15.
   *
   * `preferredPort` is the whole fix, and it is deliberately *not* the same
   * thing as `freePort`: it prefers the port AC1 names, so the ordinary run
   * still binds 7777 and the spike still demonstrates what it says it does. It
   * only steps aside when it has to.
   */
  it('takes the port it prefers when that port is free', async () => {
    const free = await freePort();
    expect(await preferredPort(free)).toBe(free);
  });

  it('steps aside to a free port when the preferred one is held', async () => {
    // `main` is on `main.port` right now — a real listener, held by a real
    // process, which is exactly the situation a leaked `deflow up` creates.
    const chosen = await preferredPort(main.port);
    expect(chosen).not.toBe(main.port);
    expect(chosen).toBeGreaterThan(0);
  });

  it('and a harness really boots on the port it stepped aside to', async () => {
    const chosen = await preferredPort(main.port);
    const spare = await startHarness({ S4_PORT: String(chosen), S4_INTERVAL_MS: '250' });
    try {
      const current = await health(spare.origin);
      expect(current.pid).toBe(spare.pid);
      expect(current.port).toBe(chosen);
      expect(listeningSockets(spare.pid)).toEqual([{ address: '127.0.0.1', port: chosen }]);
    } finally {
      await spare.stop();
    }
  }, 60_000);
});

suite('the harness refuses a port somebody else is already on', () => {
  /**
   * `startHarness` is given a fixed port — `AC1_PORT` is 7777, because AC1 is
   * about that exact socket — and a fixed port is a shared resource on a
   * developer's machine. Until this spec, the readiness loop asked only whether
   * *something* answered `/api/health` at that origin, so a stranger already
   * listening on 7777 was adopted as the harness: the spawned child died of
   * `EADDRINUSE`, its output was never read, and every spec below ran against
   * the stranger.
   *
   * That is not hypothetical. On the EPIC-19 gate this file failed twice with
   * `2 events did not happen within 10000 ms (0 received)`, and the cause was a
   * `server.ts` from a run six days earlier still holding 7777 — a server whose
   * sequence had been climbing for six days, so the `last-event-id: 2` resume
   * it answered was nothing like the one the spec describes. The routing and
   * header specs all passed, because a stranger running the same code serves
   * those identically. Only the one spec whose meaning depends on *this* run's
   * history could tell, and what it said was that the stream was broken.
   *
   * The health payload has always carried the server's own pid. Comparing it to
   * the pid that was spawned is the whole fix, and it turns a silent
   * wrong-subject test run into a named failure.
   */
  it('names the foreign pid instead of testing a stranger', async () => {
    const squatter = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ pid: 999_999, port: 0, mode: 'squatter', intervalMs: 0, headSeq: 0 }),
      );
    });
    const port = await new Promise<number>((resolve) => {
      squatter.listen(0, '127.0.0.1', () => {
        const address = squatter.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    try {
      await expect(startHarness({ S4_PORT: String(port), S4_INTERVAL_MS: '250' })).rejects.toThrow(
        /999999|already/i,
      );
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 60_000);
});
