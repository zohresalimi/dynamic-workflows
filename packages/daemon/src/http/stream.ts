/**
 * The multiplexed control-plane stream (docs/11-api-and-realtime.md §2 and §5).
 *
 * One connection per browser tab, whose subscription set changes without a
 * reconnect. §2 opens by calling that *"an architecture constraint, not a
 * tuning knob"*, and it is: HTTP/1.1 caps concurrent connections per origin at
 * about six, an SSE connection never closes, and a tab that opens one per run
 * panel exhausts the budget — after which every subsequent `fetch` from that
 * origin queues behind the streams, forever, with no error anywhere. The
 * symptom reads as *"the daemon hung"* against a perfectly healthy daemon.
 *
 * ## The serving loop
 *
 * A **two-phase drain**, and the second phase is subscribe-then-drain-again,
 * never subscribe-only: drain to empty with bounded queries, park on the
 * post-commit signal, wake, drain again. Getting that order wrong loses every
 * event that commits between the last drain and the subscription.
 *
 * The park is a race between the signal and a bounded tick, and both halves
 * earn their place. The signal is `@DeFlow/ledger`'s post-commit emitter, so a
 * commit in this process is delivered in microseconds; the tick is what covers
 * a writer this process cannot hear — another daemon life, a crash-fuzz worker,
 * a `sqlite3` shell — and is what §5.2 means by *"a missed notification only
 * delays delivery to the next one"*.
 *
 * ## Three read-side rules, all from measured failure (§5.1)
 *
 * - **Never hold an open cursor or a read transaction across the stream.** One
 *   held while 20k rows were written produced an **82.6 MB** `-wal` file that
 *   `wal_checkpoint(TRUNCATE)` could not truncate — it returned
 *   `{busy:0, log:0, checkpointed:0}` and the space came back only when the
 *   cursor closed. Every read here is one bounded `LIMIT 500` statement that
 *   finishes before it returns.
 * - **Never serve the stream from the write connection.** `better-sqlite3` is
 *   fully synchronous, so a tail query on the writer stalls every append behind
 *   it. `./ledger-view.ts` opens its own read-only connection with a
 *   `busy_timeout`.
 * - **Never let `io_chunk` into the query.** Agent stdout is the data plane and
 *   has its own endpoint. Mixing it in is what makes people believe event
 *   sourcing needs snapshots — and it would break the progress watermark too,
 *   since an agent producing megabytes while accomplishing nothing would start
 *   to look like progress.
 */
import type { Clock, RunId } from '@DeFlow/core';
import { onCommitted } from '@DeFlow/ledger';
import type { Context } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { systemClock } from '../clock.ts';
import { log } from '../logging.ts';
import { API_VERSION, BOOT_ID, BUILD } from '../meta.ts';
import { daemonEpoch, headSeq } from '../runtime.ts';
import { bearerToken, constantTimeEqual, daemonAuth } from './auth.ts';
import { type ApiErrorEnvelope, apiError } from './errors.ts';
import { type LedgerView, ledgerView } from './ledger-view.ts';
import { resumeFrom } from './resume.ts';
import { Signal } from './signal.ts';
import {
  controlFrame,
  GLOBAL_TOPIC,
  KEEPALIVE_FRAME,
  ledgerFrame,
  parseRuns,
  RETRY_FRAME,
  TERMINAL_KINDS,
} from './sse.ts';
import { registerStream } from './streams.ts';

const http = log.child({ mod: 'http' });

/** §5.1's bound. A batch, never an open cursor. */
export const DRAIN_BATCH = 500;

/** §3.2 rule 3 — the idle cadence. */
export const DEFAULT_KEEPALIVE_MS = 15_000;

/**
 * How long the park waits before re-draining on its own.
 *
 * The floor under the post-commit signal rather than a replacement for it: a
 * writer in another process cannot notify this one, and a stream that woke only
 * on its own daemon's writes would be correct in a test and wrong in
 * production. One covering-index seek per subscribed run per tick, measured at
 * roughly 0.2 ms each (§5.1).
 */
export const DEFAULT_DRAIN_TICK_MS = 100;

/**
 * The clock the loop parks and keepalives on.
 *
 * Injected the same way `./ledger-view.ts` injects the view — a module-level
 * setter — because a `Hono` app is a module-level constant and threading a
 * context object through every route for one dependency is worse. `TestClock`
 * is what lets an integration spec assert *four keepalives over a minute*
 * without a minute, and without faking a timer, so the socket's own I/O still
 * arrives while the clock is being advanced.
 */
let clock: Clock = systemClock;

export function setStreamClock(next: Clock): void {
  clock = next;
}

export function resetStreamClock(): void {
  clock = systemClock;
}

function envMs(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/**
 * `stream.aborted` and `.closed` flip from an internal event listener the loop
 * below can never see, but they are read through the *same* expression at the
 * top of the loop and again after the `await`. TypeScript's control-flow
 * narrowing treats a repeated property read as unchanged unless it sees a local
 * assignment — it has no way to know the flip happens inside the client's own
 * implementation — so it narrows the second read to the literal `false` the
 * condition just proved and calls the check dead code. It is not: a real client
 * can disconnect mid-park. Crossing a function boundary resets that narrowing.
 */
function stopped(stream: SSEStreamingApi): boolean {
  return stream.aborted || stream.closed;
}

/**
 * The conditions that end a stream mid-flight, as the envelope the `fatal`
 * frame carries (AC15).
 *
 * Both are re-checked on every wake-up rather than once at open, because both
 * happen *to* a connection that authenticated correctly: a token rotates under
 * an open stream, and a daemon epoch advances when another daemon life takes
 * the ledger. The client stops retrying for exactly these two — everything
 * else, `internal` included, is worth reconnecting for.
 */
function fatalCondition(
  presented: string | null,
  epochAtOpen: number | null,
): ApiErrorEnvelope | null {
  const auth = daemonAuth();
  if (auth !== null && (presented === null || !constantTimeEqual(presented, auth.token))) {
    return apiError(
      'bad_token',
      'this daemon’s token has changed since this stream was opened; reconnect with the ' +
        'token in .DeFlow/daemon.json',
    )[0];
  }

  const epoch = daemonEpoch();
  if (epochAtOpen !== null && epoch !== null && epoch !== epochAtOpen) {
    return apiError(
      'epoch_mismatch',
      `this stream was opened against daemon epoch ${epochAtOpen} and the ledger is now at ` +
        `${epoch}: the daemon you were talking to has been replaced`,
      { detail: { opened: epochAtOpen, current: epoch } },
    )[0];
  }

  return null;
}

/**
 * `GET /api/stream?runs=<ids|*>&since=<seq>`.
 *
 * Registered from `./api.ts` so the route table stays one chained expression —
 * `hc<ApiType>` infers the client from the *type* of that chain, and a route
 * registered on its own statement is invisible to it.
 */
export function serveStream(c: Context): Response {
  const keepaliveMs = envMs('DeFlow_SSE_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS);
  // Never longer than the keepalive: a park that outlived it would make the
  // idle cadence a function of the drain tick, which is an implementation
  // detail the wire contract must not depend on.
  const tickMs = Math.min(envMs('DeFlow_SSE_DRAIN_TICK_MS', DEFAULT_DRAIN_TICK_MS), keepaliveMs);
  const filter = parseRuns(c.req.query('runs'));
  // KAR-15.4 — `since` > `Last-Event-ID` > head, resolved before the socket is
  // handed over so the head read below is the head at open (./resume.ts).
  const resume = resumeFrom(c.req.query('since'), c.req.header('Last-Event-ID'));
  // Kept for the life of the connection so a rotation can be noticed. It is the
  // token this client already presented and that `requireAuth` already
  // accepted; nothing here widens what a stream may do.
  const presented = bearerToken(c.req.header('Authorization'));

  const response = streamSSE(c, async (stream) => {
    const view = ledgerView();
    const epochAtOpen = daemonEpoch();
    const wake = new Signal();
    // The registry is a handoff: `POST …/subscribe` appends and wakes, this
    // handler drains, and nothing but this handler ever writes a frame or
    // touches a cursor. Two writers on one SSE socket is how frames end up
    // interleaved mid-line.
    const handle = registerStream(() => wake.notify());
    const offCommitted = onCommitted(() => wake.notify());
    stream.onAbort(() => wake.notify());

    // Read once, and used for both the cursor and `hello.headSeq`, so a client
    // that started at head is told the *same* number it started from rather
    // than one an event committed in between could make disagree.
    const headAtOpen = view?.headSeq() ?? headSeq();
    // §4.1's floor. A connection that named no cursor at all starts here and
    // `hello.headSeq` says so — the client can hydrate to it through
    // `GET /api/runs/:id/events` rather than accept the gap.
    const since = resume.kind === 'seq' ? resume.seq : headAtOpen;

    const cursors = new Map<RunId, number>(
      view === null ? [] : filter.runs.map((runId) => [runId, since] as const),
    );
    // A cursor of its own, because the global topic is not a run: it advances
    // over the whole `event` table and must not be confused with any run's.
    let globalCursor = since;
    /** The subscribed runs this connection has already delivered an ending for. */
    const ended = new Set<RunId>();
    let lastWriteAt = clock.now();

    const write = async (frame: string): Promise<void> => {
      await stream.write(frame);
      lastWriteAt = clock.now();
    };

    /** One bounded pass over every subscribed run, merge-sorted by `seq`. */
    const drainRuns = async (): Promise<void> => {
      if (view === null || cursors.size === 0) return;
      for (;;) {
        // Paired with the run that was asked for rather than read back off the
        // envelope: the cursor this loop advances is its own termination
        // condition, and deriving it from the row would make a mislabelled row
        // an infinite loop against a live SQLite file rather than a wrong
        // answer.
        const batch: {
          readonly runId: RunId;
          readonly event: ReturnType<LedgerView['tail']>[number];
        }[] = [];
        for (const [runId, cursor] of cursors) {
          for (const event of view.tail(runId, cursor, DRAIN_BATCH)) batch.push({ runId, event });
        }
        if (batch.length === 0) return;
        // Merge-sorted because `seq` is the total order of the system: a client
        // multiplexing two runs must see them interleaved the way they were
        // committed, or a cursor it saves mid-batch skips the other run's tail.
        batch.sort((left, right) => left.event.seq - right.event.seq);

        for (const { runId, event } of batch) {
          if (stopped(stream)) return;
          await write(ledgerFrame(event));
          cursors.set(runId, event.seq);
          if (TERMINAL_KINDS.includes(event.kind)) ended.add(runId);
        }
      }
    };

    /**
     * One bounded pass over the global topic.
     *
     * The cursor advances to the ledger's head rather than to the last
     * *matching* row when a page comes back short, so the next pass does not
     * re-scan the thousands of `node.progress` rows the filter just stepped
     * over. Reading the head first is what makes that safe: an event committed
     * after the read is beyond it and is picked up next pass, never skipped.
     */
    const drainGlobal = async (): Promise<void> => {
      if (view === null || !filter.global) return;
      for (;;) {
        const head = view.headSeq();
        const events = view.globalTail(globalCursor, filter.kinds, DRAIN_BATCH);
        for (const event of events) {
          if (stopped(stream)) return;
          await write(ledgerFrame(event));
          globalCursor = event.seq;
        }
        if (events.length < DRAIN_BATCH) {
          globalCursor = Math.max(globalCursor, head);
          return;
        }
      }
    };

    /**
     * KAR-19.2 AC8 — whether this connection has nothing left to deliver, ever.
     *
     * True only for a per-run subscription every one of whose runs has reached
     * a terminal kind. `runs=*` is never done: the global topic is about runs
     * that do not exist yet, and closing it would make the run list stop
     * updating the moment the run it was opened beside finished.
     *
     * A run that ends is the common case; a run that ends *at submission* is
     * the case this exists for. `created — no nodes yet` was the string the
     * operator stared at, and a socket that stays open on keepalives is the
     * same defect one layer down — the UI's spinner has no way to tell "still
     * working" from "will never speak again".
     */
    const nothingLeftToSay = (): boolean =>
      !filter.global && cursors.size > 0 && ended.size === cursors.size;

    /** Parks until something commits, a subscription lands, or the tick. */
    const park = async (): Promise<void> => {
      const abort = new AbortController();
      const timeout = clock.sleep(tickMs, abort.signal).catch(() => undefined);
      await Promise.race([wake.wait(), timeout]);
      abort.abort();
    };

    try {
      await write(
        controlFrame('hello', {
          // §3.2 rule 4 — the id the client posts back to mutate this
          // connection's filter, which is what keeps a third run panel from
          // opening a third socket against a six-connection budget.
          streamId: handle.id,
          apiVersion: API_VERSION,
          build: BUILD,
          bootId: BOOT_ID,
          daemonEpoch: epochAtOpen,
          headSeq: headAtOpen,
          runs: filter.global ? [GLOBAL_TOPIC, ...cursors.keys()] : [...cursors.keys()],
        }),
      );
      // §3.2 rule 2 — once, immediately after the headers, and never again.
      await write(RETRY_FRAME);

      // Phase 1 — backfill from the cursor, then say where it ended. A client
      // that knows that can stop showing a spinner without guessing.
      await drainRuns();
      for (const [runId, seq] of cursors) {
        await write(controlFrame('caught_up', { runId, seq }));
      }
      if (filter.global) {
        await drainGlobal();
        await write(controlFrame('caught_up', { runId: GLOBAL_TOPIC, seq: globalCursor }));
      }

      while (!stopped(stream) && !nothingLeftToSay()) {
        await park();
        if (stopped(stream)) break;

        const fatal = fatalCondition(presented, epochAtOpen);
        if (fatal !== null) {
          await write(controlFrame('fatal', fatal));
          break;
        }

        // Subscribe, *then* drain again — never subscribe-only. Backfilling the
        // newly named runs before live delivery resumes is what stops the
        // events committed between the last drain and the subscription from
        // being skipped.
        const added = handle.takePending().filter((runId) => !cursors.has(runId));
        if (added.length > 0) {
          for (const runId of added) cursors.set(runId, since);
          await write(
            controlFrame('subscribed', {
              runs: filter.global ? [GLOBAL_TOPIC, ...cursors.keys()] : [...cursors.keys()],
            }),
          );
          await drainRuns();
          for (const runId of added) {
            await write(controlFrame('caught_up', { runId, seq: cursors.get(runId) ?? since }));
          }
        }
        if (stopped(stream)) break;

        await drainRuns();
        await drainGlobal();
        if (stopped(stream) || nothingLeftToSay()) break;

        // §3.2 rule 3 — 13 bytes whose only job is that no socket-inactivity
        // timer anywhere in the path ever sees a silent connection.
        if (clock.now() - lastWriteAt >= keepaliveMs) await write(KEEPALIVE_FRAME);
      }
    } catch (error) {
      // A stream never returns an error body mid-flight: by the time anything
      // here can fail the status line and the headers are long gone, so the
      // failure is a final frame and then the socket.
      http.error({ err: error }, 'the SSE stream failed and is closing');
      if (!stopped(stream)) {
        await stream
          .write(
            controlFrame(
              'fatal',
              apiError('internal', 'the daemon failed while serving this stream')[0],
            ),
          )
          .catch(() => undefined);
      }
    } finally {
      offCommitted();
      handle.close();
      http.debug('sse stream closed');
    }
  });

  // `streamSSE` sets "no-cache"; SSE also needs "no-transform" so no
  // intermediary may re-chunk it, and `X-Accel-Buffering: no` for anyone who
  // later puts a reverse proxy in front of DeFlowd (§3.1).
  response.headers.set('Cache-Control', 'no-cache, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  response.headers.set('Connection', 'keep-alive');
  return response;
}
