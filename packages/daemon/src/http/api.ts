/**
 * The `/api` surface, mounted before anything that can serve the SPA.
 *
 * Most of docs/11-api-and-realtime.md §6's route table is still EPIC-15's, and
 * what is here is what earlier stories needed: readiness, a stream to prove
 * that SSE and HMR share one port (D10, ADR 0011), and — from KAR-14.1 AC8 —
 * the run summary plus the ledger tail that make a run's cost rollup reachable.
 *
 * AC8 is worth stating in full, because it is a constraint on this file rather
 * than a feature request: *"The rollup is available at `GET /api/runs/:id` as
 * part of the run summary and updates live over the SSE stream because
 * `budget.consumed` is an ordinary ledger event — no separate polling endpoint
 * exists."* So there is no `/runs/:id/budget` and there will not be one. The
 * accounting figures are a reducer projection over events the stream already
 * carries; a second endpoint would be a second source, and two sources of one
 * number is how an F4.6 ceiling ends up evaluated against the wrong figure.
 */
import type { RunId } from '@DeFlow/core';
import type { StoredEvent } from '@DeFlow/ledger';
import { Hono } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { log } from '../logging.ts';
import { API_VERSION, BOOT_ID, BUILD, uptimeMs } from '../meta.ts';
import { daemonEpoch, headSeq } from '../runtime.ts';
import { asRunId, type LedgerView, ledgerView } from './ledger-view.ts';
import { runSummary } from './run-summary.ts';

const http = log.child({ mod: 'http' });

const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * How often a subscribed stream re-drains the ledger.
 *
 * §5's design parks the handler on a post-commit emitter instead, and this is
 * not that — deliberately, for now. Today's writers are not all in this
 * process: an adapter runs a node through its own `LedgerSink`, so an
 * in-process `bus.emit` would be silent for exactly the appends a client is
 * waiting on, and a stream that only woke on its own daemon's writes would be
 * correct in tests and wrong in production. A bounded re-drain has no such
 * blind spot. It costs one covering-index seek per subscribed run per tick —
 * §5.1 measured those at roughly 0.2 ms — and the emitter becomes a latency
 * optimisation on top of it once every writer is behind one connection
 * (EPIC-15).
 */
const DRAIN_TICK_MS = 100;

/** §5.1's bound. A batch, never an open cursor. */
const DRAIN_BATCH = 500;

function heartbeatMs(): number {
  const configured = Number(process.env.DeFlow_SSE_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HEARTBEAT_MS;
}

/**
 * `stream.aborted` and `.closed` flip from an internal event listener the
 * while-loop below can never see, but they are read through the *same*
 * `stream.aborted` expression at the top of that loop and again after the
 * `await`. TypeScript's control-flow narrowing treats a repeated property
 * read as unchanged unless it sees a local assignment to it — it has no way
 * to know the flip happens inside the client's own implementation — so it
 * narrows both reads to the literal `false` the while-condition just proved
 * and reports the second check as dead code. It is not: a real client can
 * disconnect mid-`sleep`. Crossing a function boundary resets that narrowing,
 * which is the only way to keep the guard TypeScript will still believe.
 */
function stoppedMidSleep(stream: SSEStreamingApi): boolean {
  return stream.aborted || stream.closed;
}

export const api = new Hono();

/**
 * The unauthenticated discovery endpoint (docs/11-api-and-realtime.md §12).
 * `pid` and `bootId` are what let `pnpm dev`, and the e2e specs, tell one
 * daemon life from the next across a restart-on-save.
 */
api.get('/health', (c) =>
  c.json({
    apiVersion: API_VERSION,
    build: BUILD,
    // A changed epoch across two reads means the daemon was replaced
    // (KAR-03.7). `headSeq` is the ledger's head as this daemon last observed
    // it — set at boot by KAR-03.8's replay, and the number an SSE client
    // compares its own cursor against to know how far behind it is.
    daemonEpoch: daemonEpoch(),
    headSeq: headSeq(),
    uptimeMs: uptimeMs(),
    pid: process.pid,
    bootId: BOOT_ID,
  }),
);

/**
 * KAR-14.1 AC8 — the run summary, cost rollup included.
 *
 * `docs/11-api-and-realtime.md` §6: *"Run summary: status, plan version,
 * counts, cost, head seq"*. The body is `runSummary()` over the state the
 * ledger reduces to right now, so the figure served is the figure a replay
 * would produce, and the client keeps it current from the stream rather than
 * by coming back here.
 *
 * A run the directory does not hold is a 404, and so is an id that is not a
 * `RunId` — `/api/runs/r1` is a request for a run that does not exist, and
 * answering it with a 500 out of a schema tells the caller nothing.
 */
api.get('/runs/:id', (c) => {
  const view = ledgerView();
  if (view === null) {
    // Only reachable in a test that starts the HTTP server without booting a
    // daemon around it. Honest and retryable, never a crash.
    return c.json({ error: 'ledger_unavailable', path: c.req.path }, 503);
  }

  const runId = asRunId(c.req.param('id'));
  const state = runId === null ? null : view.runState(runId);
  if (runId === null || state === null) {
    return c.json({ error: 'not_found', path: c.req.path }, 404);
  }

  return c.json(runSummary(runId, state, view.headSeq()));
});

/** `?runs=a,b` as the `RunId`s it names; anything unparseable is dropped. */
function subscribedRuns(query: string | undefined): readonly RunId[] {
  if (query === undefined || query === '') return [];
  const ids = query
    .split(',')
    .map((value) => asRunId(value.trim()))
    .filter((value): value is RunId => value !== null);
  return [...new Set(ids)];
}

/**
 * The cursor this connection resumes from, in §4.1's documented precedence:
 * `since` query param > `Last-Event-ID` header > 0.
 *
 * The query parameter wins because the client's own persisted cursor is more
 * trustworthy than the browser's — a tab that reloads sends no `Last-Event-ID`
 * at all — and because the CLI has no such header. `0` rather than the head of
 * the log, for the reason §4.1 gives at length: treating "no cursor" as "start
 * from now" silently loses every event that happened while the client was
 * down, which is NF10 violated without a single error being logged.
 */
function resumeFrom(since: string | undefined, lastEventId: string | undefined): number {
  for (const candidate of [since, lastEventId]) {
    if (candidate === undefined) continue;
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

/**
 * One bounded pass over every subscribed run, merge-sorted by `seq`.
 *
 * Merge-sorted rather than run-by-run because `seq` is the total order of the
 * system: a client multiplexing two runs must see their events interleaved the
 * way they were committed, or a cursor it saves mid-batch skips the other run's
 * tail. Returns whether anything was written, so the caller can tell a drained
 * backfill from a live one.
 */
async function drain(
  stream: SSEStreamingApi,
  view: LedgerView,
  cursors: Map<RunId, number>,
): Promise<boolean> {
  let wrote = false;
  for (;;) {
    // Paired with the run that was asked for, rather than read back off the
    // envelope: the cursor this loop advances is its own termination
    // condition, and deriving it from the row would make a mislabelled row an
    // infinite loop against a live SQLite file instead of a wrong answer.
    const batch: { readonly runId: RunId; readonly event: StoredEvent }[] = [];
    for (const [runId, cursor] of cursors) {
      for (const event of view.tail(runId, cursor, DRAIN_BATCH)) batch.push({ runId, event });
    }
    if (batch.length === 0) return wrote;
    batch.sort((left, right) => left.event.seq - right.event.seq);

    for (const { runId, event } of batch) {
      if (stoppedMidSleep(stream)) return wrote;
      // Unnamed, so the client needs one `onmessage` feeding `applyEvent`, and
      // `id: <seq>` on every one of them — that pair is what makes resume a
      // single `WHERE seq > ?` (§3 rules 1 and 4).
      await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
      cursors.set(runId, event.seq);
      wrote = true;
    }
  }
}

/**
 * The control-plane stream.
 *
 * The *transport* was never a placeholder: no compression, `no-transform` so no
 * intermediary may re-chunk it, and `X-Accel-Buffering: no` for anyone who
 * later puts a reverse proxy in front of DeFlowd. Those three are the settings
 * that make an SSE stream survive hours instead of arriving in one burst at the
 * end (docs/11-api-and-realtime.md §13).
 *
 * The body now carries the ledger tail for whatever `?runs=` names — the half
 * of KAR-14.1 AC8 that makes a cost rollup *live*: `budget.consumed` is an
 * ordinary ledger event, so it arrives here with everything else and a client
 * folds it into the summary it already has. Subscribe to nothing and the
 * connection is what it always was, a hello frame and a heartbeat, which is
 * what the dev loop uses it for.
 *
 * `hello` and `heartbeat` are stream-control frames and deliberately carry no
 * `id:`. Only ledger frames do (§3 rule 1): a control frame that set one would
 * poison `Last-Event-ID` with a number from a different sequence, and the
 * client would resume from a `seq` that belongs to somebody else's event.
 */
api.get('/stream', (c) => {
  const interval = heartbeatMs();
  const runs = subscribedRuns(c.req.query('runs'));
  const since = resumeFrom(c.req.query('since'), c.req.header('Last-Event-ID'));

  const response = streamSSE(c, async (stream) => {
    const view = ledgerView();
    const cursors = new Map<RunId, number>(
      view === null ? [] : runs.map((runId) => [runId, since] as const),
    );

    await stream.writeSSE({
      event: 'hello',
      retry: 2000,
      data: JSON.stringify({
        apiVersion: API_VERSION,
        build: BUILD,
        bootId: BOOT_ID,
        daemonEpoch: daemonEpoch(),
        headSeq: view?.headSeq() ?? headSeq(),
        runs: [...cursors.keys()],
      }),
    });

    // Phase 1 — backfill from the cursor, then say so. A client that knows
    // where the backfill ended can stop showing a spinner without guessing.
    if (view !== null && cursors.size > 0) {
      await drain(stream, view, cursors);
      for (const [runId, seq] of cursors) {
        await stream.writeSSE({ event: 'caught_up', data: JSON.stringify({ runId, seq }) });
      }
    }

    // Phase 2 — re-drain on a tick, heartbeat on the configured cadence. The
    // tick is only shortened for a connection that actually subscribed to
    // something; an unsubscribed stream sleeps exactly as long as it used to.
    const tick = cursors.size === 0 ? interval : Math.min(interval, DRAIN_TICK_MS);
    let sinceBeat = 0;
    while (!stream.aborted && !stream.closed) {
      await stream.sleep(tick);
      if (stoppedMidSleep(stream)) break;

      if (view !== null && cursors.size > 0) await drain(stream, view, cursors);
      if (stoppedMidSleep(stream)) break;

      sinceBeat += tick;
      if (sinceBeat < interval) continue;
      sinceBeat = 0;
      await stream.writeSSE({
        event: 'heartbeat',
        data: JSON.stringify({ uptimeMs: uptimeMs() }),
      });
    }
    http.debug('sse stream closed');
  });

  // streamSSE sets "no-cache"; SSE also needs "no-transform", so widen it.
  response.headers.set('Cache-Control', 'no-cache, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
});

/**
 * Everything under /api terminates here, so an unknown API path is a typed 404
 * and never falls through to the SPA. A 200 with `index.html` on an API path is
 * the failure that costs an afternoon: the client sits there parsing HTML.
 */
api.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));
