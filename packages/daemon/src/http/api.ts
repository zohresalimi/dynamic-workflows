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
 *
 * ## KAR-15.1 — why this file is one expression
 *
 * Every route is chained onto the one `new Hono()` below, and that is
 * load-bearing rather than stylistic (docs/11-api-and-realtime.md §9). `hc<ApiType>`
 * infers the client from the *type of the chained expression*; a route
 * registered as its own `api.get(...)` statement is invisible to that
 * inference, and nothing about the running server would say so — the UI's
 * client silently degrades to `any` and the schema-drift defence is gone. A
 * route-table test in `../../test/api-contract.test.ts` fails if anybody
 * unchains it for readability.
 *
 * Errors are the other half of the contract: `./errors.ts` is the closed
 * envelope, domain failures are values rather than exceptions, and the
 * `onError` at the bottom of the chain is what guarantees no thrown `Error`
 * ever reaches a client — it becomes `500 internal`, and its stack goes to a
 * content-addressed artifact behind a handle.
 */
import { providerFamily, providerTokenAccounting } from '@DeFlow/adapters';
import type { Db, EstimatorInputs, InterjectionMode, RunId } from '@DeFlow/core';
import { INTERJECTION_MODES, NodeIdSchema, SpecEditRefused } from '@DeFlow/core';
import { putBlob, type StoredEvent } from '@DeFlow/ledger';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { respondToHumanNode } from '../human/gate.ts';
import { interjectIntoNode } from '../human/interject.ts';
import { decideQueuedPatch, decisionSurfaceMoved } from '../human/patch-decision.ts';
import { submitTask } from '../intake/intake.ts';
import { log } from '../logging.ts';
import { API_VERSION, BOOT_ID, BUILD, uptimeMs } from '../meta.ts';
import { diffPlanGraphs } from '../plan/diff.ts';
import { unionLayoutKey } from '../plan/plan-history.ts';
import { daemonEpoch, headSeq } from '../runtime.ts';
import {
  abandonRun,
  approveSpec,
  editSpec,
  rejectSpec,
  SpecApprovalRefused,
  SpecGateNotOpen,
} from '../spec/gate.ts';
import { o200kTokenizer } from '../tokens/tokenizer.ts';
import { approvalQueue } from './approvals.ts';
import { apiError, serviceError } from './errors.ts';
import { intakePorts } from './intake-ports.ts';
import { asRunId, type LedgerView, ledgerView } from './ledger-view.ts';
import { runSummary } from './run-summary.ts';
import { registerStream, subscribeStream } from './streams.ts';

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

/**
 * The build-skew header (docs/11-api-and-realtime.md §12), on **every**
 * response including the stream and every refusal.
 *
 * An old tab against a new daemon is the only skew that can happen — daemon and
 * UI ship in the same tarball — and this is how the tab notices.
 */
export const API_HEADER = 'X-DeFlow-Api';

/**
 * The one route that answers without a bearer token, as `"<METHOD> <path>"`.
 *
 * Unauthenticated *deliberately*: `DeFlow up` polls it for readiness before it
 * has read the token file, and it exposes nothing a local process could not
 * already learn from `.DeFlow/daemon.json`. KAR-15.2's middleware is the thing
 * that enforces the other side of this; the list lives here, next to the routes,
 * so that adding a `/api/version` "for convenience" has to walk past it.
 */
export const PUBLIC_ROUTES: readonly string[] = ['GET /health'];

/**
 * Whether `method path` is exempt from authentication.
 *
 * Accepts both the registered path (`/health`, as the route table holds it) and
 * the request path (`/api/health`, as a middleware sees it), because those are
 * the two callers and neither should have to know about the mount prefix.
 */
export function isPublicRoute(method: string, path: string): boolean {
  const registered = path === '/api' ? '/' : path.startsWith('/api/') ? path.slice(4) : path;
  return PUBLIC_ROUTES.includes(`${method.toUpperCase()} ${registered}`);
}

/**
 * `hono/compress`, mounted on JSON routes **only** — never globally.
 *
 * One instance rather than one per mount, so the route table can be asked which
 * paths it is on: a wildcard mount would put a `CompressionStream` in front of
 * `/api/stream`, and the symptom of that — *"events arrive in clumps, then all
 * at once"* — reads as a backend scheduling problem and sends you looking in
 * the wrong place for an afternoon (docs/11-api-and-realtime.md §13).
 */
export const JSON_COMPRESSION: MiddlewareHandler = compress();

/** Stamps the API version on whatever the chain produced, refusals included. */
const apiVersionHeader: MiddlewareHandler = async (c, next) => {
  await next();
  c.header(API_HEADER, String(API_VERSION));
};

/**
 * AC5 — the last line: no thrown `Error` reaches a client.
 *
 * The response is `500 internal` with a message a human can act on and nothing
 * else. The stack goes to the content-addressed blob store and the *handle*
 * goes in `detail`, which is the same "behind a handle" discipline every large
 * payload in this system uses: the operator can fetch it, a bug report can
 * carry it, and a browser that renders an error body cannot leak the daemon's
 * file paths to whatever is watching.
 *
 * Nothing here may throw. An error while recording an error would replace a
 * useful 500 with an unhandled rejection inside the adaptor, so the write is
 * best-effort and its failure costs the handle, not the response.
 */
export const apiErrorHandler: ErrorHandler = (error, c) => {
  const stack = error.stack ?? `${error.name}: ${error.message}`;
  http.error({ err: error, path: c.req.path }, 'unhandled error in an API route');

  let handle: string | null = null;
  const dataDir = intakePorts()?.dataDir;
  if (dataDir !== undefined) {
    try {
      handle = putBlob(dataDir, new TextEncoder().encode(stack), 'text/plain');
    } catch (failure) {
      http.error({ err: failure }, 'could not record the stack of an unhandled error');
    }
  }

  return c.json(
    ...apiError('internal', 'the daemon failed while handling this request', {
      detail: handle === null ? {} : { stack: handle },
    }),
  );
};

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

function heartbeatMs(): number {
  const configured = Number(process.env.DeFlow_SSE_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HEARTBEAT_MS;
}

/**
 * The 503 a route answers with before boot has registered its ports.
 *
 * `daemon_starting` rather than a code of its own: from a client's side "the
 * ledger is not open yet" and "migrations have not finished" are the same
 * fact — the daemon is not ready, and the request is worth retrying — and
 * `detail.reason` keeps which one it was for a log.
 */
function notReady(c: Context) {
  return c.json(
    ...apiError('daemon_starting', 'the daemon is still starting and has no ledger open yet', {
      detail: { reason: 'ledger_unavailable', path: c.req.path },
    }),
  );
}

function gateBy(header: string | undefined): 'ui' | 'cli' {
  return header === 'cli' ? 'cli' : 'ui';
}

/**
 * A gate action, with the four ways it can fail answered once.
 *
 * `SpecGateNotOpen` is a 409 rather than a 400: the request was well formed and
 * the caller is not confused about the shape of anything — a second approval is
 * a *conflict* with what the ledger already says, which is exactly what 409 is
 * for and what lets a UI say "somebody already approved this". `already_answered`
 * is the closed union's word for that, with the gate's own `gate_not_open` kept
 * in `detail.reason`.
 */
async function gateAction<T>(
  c: Context,
  act: (ports: NonNullable<ReturnType<typeof intakePorts>>, runId: RunId) => Promise<T>,
) {
  const ports = intakePorts();
  if (ports === null) return notReady(c);

  const runId = asRunId(c.req.param('id') ?? '');
  if (runId === null) {
    return c.json(...apiError('run_not_found', `no run '${c.req.param('id') ?? ''}'`));
  }

  try {
    return c.json(await act(ports, runId));
  } catch (error) {
    if (error instanceof SpecGateNotOpen) {
      return c.json(
        ...apiError('already_answered', error.message, { detail: { reason: 'gate_not_open' } }),
      );
    }
    // One envelope for both refusals, deliberately: a refused edit and a
    // refused approval (KAR-12.4 AC1) are the same answer — "this document
    // cannot be admitted, and here is exactly what is wrong with it" — and
    // `issues` is what carries the `CRITERION_UNCOVERED` diagnostics naming the
    // criteria, so the operator is told which criterion nothing checks rather
    // than that something failed.
    if (error instanceof SpecEditRefused || error instanceof SpecApprovalRefused) {
      return c.json(
        ...apiError('schema_violation', error.message, { detail: { issues: error.issues } }),
      );
    }
    throw error;
  }
}

/** `?from=` / `?to=`, as the positive plan version integer they name, or
 * `null` for anything else — absent, non-numeric, zero or negative. A version
 * is 1-based (KAR-11.1 AC4), so `0` is never a version the diff endpoint could
 * answer for. */
function parseVersion(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * KAR-14.3 AC3 — the inputs the pre-flight estimate is computed from, assembled
 * at the edge.
 *
 * All four are the *real* ones: the real `o200k_base` tokenizer, the real
 * provider registry's family and accounting columns, and the real learned
 * calibration out of the ledger. `estimatePlan` itself is pure and knows none of
 * them, which is what makes the figure on this response reproducible from the
 * same four inputs months later.
 */
function preflightEstimator(view: LedgerView): EstimatorInputs {
  return {
    tokenizer: o200kTokenizer(),
    accounting: providerTokenAccounting,
    family: providerFamily,
    calibration: (provider, model) => view.calibration(provider, model, providerFamily(provider)),
  };
}

interface RespondBody {
  readonly optionId?: unknown;
  readonly text?: string | undefined;
  readonly output?: unknown;
  readonly ifLastSeq?: number | undefined;
}

interface InterjectBody {
  readonly nodeId?: unknown;
  readonly text?: unknown;
  readonly mode?: unknown;
  readonly ifLastSeq?: number | undefined;
}

interface DecideBody {
  readonly decision?: unknown;
  readonly reason?: string | undefined;
  readonly ifLastSeq?: number | undefined;
}

/**
 * AC6 — the `409 stale_cursor` a write carrying an `ifLastSeq` earns, or `null`
 * when the head moved in no way that changes the decision.
 *
 * The distinction is what keeps the mechanism usable: a `409` on every progress
 * frame would train the Operator to retry blindly, which is the same failure as
 * an approval dialog that is always on.
 */
function staleCursor(db: Db, runId: RunId, ifLastSeq: unknown, c: Context): Response | null {
  if (typeof ifLastSeq !== 'number' || !Number.isSafeInteger(ifLastSeq) || ifLastSeq < 0) {
    return null;
  }
  const movedAt = decisionSurfaceMoved(db, runId, ifLastSeq);
  if (movedAt === null) return null;

  return c.json(
    ...apiError(
      'stale_cursor',
      `the run moved at seq ${movedAt}, after the cursor ${ifLastSeq} this decision was made ` +
        'against; nothing was applied',
      { detail: { head: ledgerView()?.headSeq() ?? headSeq(), movedAt }, seq: movedAt },
    ),
  );
}

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
 * KAR-13.2 AC5 — `runs=*`, and what it is *not*.
 *
 * It is not "every event of every run". It is the low-volume global lifecycle
 * topic, membership exactly four kinds, which is what the run list and the
 * cross-run approval queue need and is deliberately nothing else. An idle tab
 * subscribed to it receives a `human.requested` from any run within one tick
 * and not one `node.progress` frame from the noisy run next to it — which is
 * the whole reason one connection per tab is affordable (docs/11 §2).
 */
export const GLOBAL_TOPIC = '*';

export const GLOBAL_TOPIC_KINDS: readonly string[] = [
  'run.created',
  'run.completed',
  'run.aborted',
  'human.requested',
];

/**
 * One bounded pass over the global topic, returning the cursor it reached.
 *
 * The cursor advances to the ledger's head rather than to the last *matching*
 * row when a page comes back short, so the next pass does not re-scan the
 * thousands of `node.progress` rows the filter just stepped over. Reading the
 * head first is what makes that safe: an event committed after the read is
 * beyond it and is picked up next tick, never skipped.
 */
async function drainGlobal(
  stream: SSEStreamingApi,
  view: LedgerView,
  from: number,
): Promise<number> {
  let cursor = from;
  for (;;) {
    const head = view.headSeq();
    const events = view.globalTail(cursor, GLOBAL_TOPIC_KINDS, DRAIN_BATCH);
    for (const event of events) {
      if (stoppedMidSleep(stream)) return cursor;
      await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
      cursor = event.seq;
    }
    if (events.length < DRAIN_BATCH) return Math.max(cursor, head);
  }
}

/**
 * The API, as one chained expression. See the header comment: the chain is the
 * contract, and `ApiType` at the bottom is the whole of what the UI and the CLI
 * import.
 *
 * Order matters twice over. The middleware is registered before the routes it
 * decorates, and compression is registered per JSON path rather than on `*`.
 */
export const api = new Hono()
  .use('*', apiVersionHeader)
  .use('/health', JSON_COMPRESSION)
  .use('/runs', JSON_COMPRESSION)
  .use('/runs/*', JSON_COMPRESSION)
  .use('/approvals', JSON_COMPRESSION)
  .onError(apiErrorHandler)

  /**
   * The unauthenticated discovery endpoint (docs/11-api-and-realtime.md §12).
   * `pid` and `bootId` are what let `pnpm dev`, and the e2e specs, tell one
   * daemon life from the next across a restart-on-save.
   */
  .get('/health', (c) =>
    c.json(
      {
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
        // The status is stated rather than defaulted, here and on every other
        // success: `c.json(x)` types its status as the whole `ContentfulStatusCode`
        // union, which makes `InferResponseType<…, 404>` on the client match the
        // *success* body as well and quietly collapses the two halves of the
        // contract into one. A literal keeps them apart.
      },
      200,
    ),
  )

  /**
   * KAR-10.1 AC1 — `POST /api/runs`: task intake from text, a file, an issue
   * reference or a spec document.
   *
   * Creating a run does **not** start execution — the 201 body's
   * `status: "awaiting-spec-approval"` is a fixed literal, not a read of
   * `RunState.status`, because a run intake creates has no `RunState` folded
   * for it yet (no event moves `RunState` until `run.created`, which is
   * KAR-10.2's to append).
   * All this route does is normalise the input into one `task.submitted` event;
   * `submitTask` (../intake/intake.ts) owns everything else, so `DeFlow run` can
   * call the exact same function rather than re-implementing this route (AC7).
   *
   * AC7 also asks for `provenance.by: 'cli'` from the CLI and `'ui'` from
   * anything else — a distinction the *documented* request body carries no field
   * for (docs/11-api-and-realtime.md §7.1's example is `input`/`cwd`/`budget`/
   * `permission` only). `X-DeFlow-Submitted-By` is that one bit, sent only by
   * `DeFlow run` (@DeFlow/cli): a header rather than a body field, so the wire
   * shape AC1 documents stays exactly what it documents.
   */
  .post('/runs', async (c) => {
    const ports = intakePorts();
    if (ports === null) return notReady(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        ...apiError('invalid_request', 'body is not JSON', { detail: { field: '<root>' } }),
      );
    }

    const idempotencyKey = c.req.header('Idempotency-Key');
    const by = c.req.header('X-DeFlow-Submitted-By') === 'cli' ? 'cli' : 'ui';
    const result = await submitTask(
      { body, by, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
      ports,
    );

    if (result.outcome === 'rejected') {
      return c.json(
        ...apiError('invalid_request', result.message, { detail: { field: result.field } }),
      );
    }
    return c.json({ runId: result.runId, seq: result.seq, status: 'awaiting-spec-approval' }, 201);
  })

  /**
   * KAR-10.3 AC4 — the F1.3 gate's four operator actions, as four routes.
   *
   * `POST /runs/:id/spec/approve` is the one docs/11-api-and-realtime.md §6 has
   * always documented; `edit`, `reject` and `abandon` are the other three actions
   * §1.3 names, and they are separate paths rather than a `decision` field because
   * each takes different inputs and each answers differently — an edit carries a
   * whole replacement document and can be *refused*, a rejection carries a reason,
   * and an abandon carries nothing at all.
   *
   * All four go through `@DeFlow/daemon`'s `spec/gate.ts` — the same functions
   * `DeFlow approve` reaches over this very route (EPIC-10-S18: two surfaces, one
   * code path). `by` comes off `X-DeFlow-Submitted-By`, the same one-bit header
   * `POST /runs` uses, so the wire shape §7.1 documents stays what it documents.
   */
  .post('/runs/:id/spec/approve', (c) =>
    gateAction(c, async (ports, runId) => {
      const approval = await approveSpec({
        db: ports.db,
        runId,
        epoch: ports.epoch,
        ts: ports.clock.now(),
        by: gateBy(c.req.header('X-DeFlow-Submitted-By')),
      });
      return {
        runId,
        specHash: approval.specHash,
        by: gateBy(c.req.header('X-DeFlow-Submitted-By')),
      };
    }),
  )

  .post('/runs/:id/spec/edit', async (c) => {
    const body = await c.req.json().catch(() => null);
    const document = (body as { document?: unknown } | null)?.document;
    if (document === undefined) {
      return c.json(
        ...apiError(
          'invalid_request',
          'an edit carries the whole amended framed document (DeFlow.taskspecdraft.v1), not a ' +
            'patch: the gate computes the RFC 6902 patch itself, so the ledger cannot record a ' +
            'diff nobody derived from the two documents it claims to relate.',
          { detail: { field: 'document' } },
        ),
      );
    }

    return gateAction(c, (ports, runId) =>
      editSpec({
        db: ports.db,
        runId,
        epoch: ports.epoch,
        ts: ports.clock.now(),
        by: gateBy(c.req.header('X-DeFlow-Submitted-By')),
        edited: document,
      }).then((edit) => ({
        runId,
        specHash: edit.to,
        patch: edit.patch,
        revalidation: edit.revalidation,
      })),
    );
  })

  .post('/runs/:id/spec/reject', async (c) => {
    const body = await c.req.json().catch(() => null);
    const reason = (body as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      return c.json(
        ...apiError(
          'invalid_request',
          'a rejection carries a reason: the next framing attempt is given it as an input, and a ' +
            'rejection with nothing to say sends the agent back to the same blank page that ' +
            'produced the spec you just refused.',
          { detail: { field: 'reason' } },
        ),
      );
    }

    return gateAction(c, (ports, runId) =>
      rejectSpec({
        db: ports.db,
        runId,
        epoch: ports.epoch,
        ts: ports.clock.now(),
        by: gateBy(c.req.header('X-DeFlow-Submitted-By')),
        reason,
        provider: (body as { provider?: string }).provider ?? 'claude-code',
      }).then((rejection) => ({
        runId,
        attempt: rejection.attempt,
        reframing: rejection.reframe !== null,
      })),
    );
  })

  .post('/runs/:id/spec/abandon', (c) =>
    gateAction(c, (ports, runId) => {
      abandonRun({
        db: ports.db,
        runId,
        epoch: ports.epoch,
        ts: ports.clock.now(),
        by: gateBy(c.req.header('X-DeFlow-Submitted-By')),
      });
      return Promise.resolve({ runId, status: 'aborted' });
    }),
  )

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
  .get('/runs/:id', (c) => {
    const view = ledgerView();
    // Only reachable in a test that starts the HTTP server without booting a
    // daemon around it. Honest and retryable, never a crash.
    if (view === null) return notReady(c);

    const runId = asRunId(c.req.param('id'));
    const state = runId === null ? null : view.runState(runId);
    if (runId === null || state === null) {
      return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
    }

    // The accounting fidelity comes from the provider registry, which is where
    // the capability manifest lands (KAR-05.2): a summary that assumed `'exact'`
    // for an unknown vendor would report an enforceable ceiling that never fires.
    return c.json(
      runSummary(runId, state, view.headSeq(), providerTokenAccounting, preflightEstimator(view)),
      200,
    );
  })

  /**
   * KAR-11.5 AC3 — `GET /api/runs/:id/plans/diff?from=N&to=M`, the plan-evolution
   * scrubber's server-side contract (docs/06-planning-and-replanning.md §5).
   *
   * The whole endpoint is composition: `view.planVersion` resolves the two
   * documents through the content-addressed `plan` table (KAR-11.1's retention),
   * `diffPlanGraphs` is KAR-11.6's pure node/edge diff, `unionLayoutKey` is a
   * cache key and never coordinates (AC4), and `view.planTransition` joins in
   * the `reason` and `decision` behind whichever patch produced `to` — `null`
   * for both when `to` is a version with no patch behind it, such as v1's
   * initial compile.
   *
   * A version either side names that this run never proposed is a 404, exactly
   * like `GET /api/runs/:id`: a malformed or absent query parameter is a 400,
   * because that is a request this endpoint can never honour, not a run that
   * does not exist yet.
   */
  .get('/runs/:id/plans/diff', (c) => {
    const view = ledgerView();
    if (view === null) return notReady(c);

    const runId = asRunId(c.req.param('id'));
    if (runId === null) {
      return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
    }

    const from = parseVersion(c.req.query('from'));
    const to = parseVersion(c.req.query('to'));
    if (from === null || to === null) {
      return c.json(
        ...apiError('invalid_request', 'from and to are 1-based plan version numbers', {
          detail: { field: from === null ? 'from' : 'to' },
        }),
      );
    }

    const fromGraph = view.planVersion(runId, from);
    const toGraph = view.planVersion(runId, to);
    if (fromGraph === null || toGraph === null) {
      return c.json(
        ...apiError('plan_version_not_found', 'this run never proposed a version numbered that', {
          detail: { from, to, missing: fromGraph === null ? from : to },
        }),
      );
    }

    const diff = diffPlanGraphs(fromGraph, toGraph);
    const transition = view.planTransition(runId, to);

    return c.json(
      {
        from: diff.from,
        to: diff.to,
        nodes: diff.nodes,
        edges: diff.edges,
        unionLayoutKey: unionLayoutKey(runId, from, to),
        reason: transition?.reason ?? null,
        decision: transition?.decision ?? null,
      },
      200,
    );
  })

  /**
   * KAR-13.2 AC1, AC9 — `GET /api/approvals`: everything waiting on the Operator,
   * across every run, in one call.
   *
   * One request rather than one per run, and that is the requirement rather than
   * an optimisation: *"I never discover a nine-hour run that has been blocked
   * since hour two because I was looking at a different tab"*. The body is a
   * projection over the ledger computed on demand — there is no pending table to
   * poll and none to go stale, so a daemon that restarted a second ago serves the
   * same queue as one that has been up all night.
   */
  .get('/approvals', (c) => {
    const view = ledgerView();
    if (view === null) return notReady(c);
    // Time enters through the injected clock where one is registered, so a spec
    // can assert on an age rather than on "some number". A view-only server —
    // which only a test that skips boot has — falls back to the wall clock.
    const now = intakePorts()?.clock.now() ?? Date.now();
    return c.json(approvalQueue(view, now), 200);
  })

  /**
   * KAR-13.1 AC3 — `POST /api/runs/:id/nodes/:nodeId/respond`, and KAR-13.2 AC6's
   * `ifLastSeq` on top of it.
   *
   * The handler is `respondToHumanNode` plus a status code, and the status code
   * is *on the result* so the two cannot drift: a second answer is the service's
   * conflict with the original decision echoed, an unknown option is its
   * refusal, a node with no open gate is its 404. `./errors.ts` is what turns
   * each of those into a member of the closed union.
   */
  .post('/runs/:id/nodes/:nodeId/respond', async (c) => {
    const ports = intakePorts();
    if (ports === null) return notReady(c);

    const runId = asRunId(c.req.param('id'));
    if (runId === null) {
      return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
    }
    const nodeId = NodeIdSchema.safeParse(c.req.param('nodeId'));
    if (!nodeId.success) {
      return c.json(...apiError('node_not_found', `no node '${c.req.param('nodeId')}'`));
    }

    const body = (await c.req.json().catch(() => null)) as RespondBody | null;
    if (body === null || typeof body.optionId !== 'string' || body.optionId === '') {
      return c.json(
        ...apiError(
          'invalid_request',
          'an answer names the option it chose: the gate offers a closed set, and a response ' +
            'that named none of them would be a decision nothing could act on',
          { detail: { field: 'optionId' } },
        ),
      );
    }

    const stale = staleCursor(ports.db, runId, body.ifLastSeq, c);
    if (stale !== null) return stale;

    const result = respondToHumanNode({
      db: ports.db,
      runId,
      nodeId: nodeId.data,
      optionId: body.optionId,
      text: body.text,
      ...(body.output === undefined ? {} : { output: body.output }),
      by: 'operator',
      epoch: ports.epoch,
      ts: ports.clock.now(),
    });

    if (result.status === 'ok') {
      return c.json({ runId, node: nodeId.data, seq: result.seq, effect: result.effect }, 200);
    }
    if (result.status === 'conflict') {
      return c.json(
        ...serviceError(result.code, result.message, { detail: { response: result.response } }),
      );
    }
    return c.json(
      ...serviceError(result.code, result.message, {
        detail: result.issues === undefined ? {} : { issues: result.issues },
      }),
    );
  })

  /**
   * KAR-13.3 — `POST /api/runs/:id/interject` (docs/11-api-and-realtime.md §7.5).
   *
   * `interjectIntoNode` plus a status code, and the status code is on the result.
   * The one thing worth reading twice is what is *not* here: there is no branch
   * that turns `delivery: 'unsupported'` into an error. It is a `202` with the
   * honest answer and the alternative mode in the body, because F8.5 is P1 and
   * adapter-dependent — an error status would imply the Operator did something
   * wrong and would invite a retry that also cannot work.
   *
   * `ifLastSeq` is checked *first*, before the node's own state: an Operator whose
   * panel is behind should be told their view is stale, not told about a node
   * state they have not seen yet.
   */
  .post('/runs/:id/interject', async (c) => {
    const ports = intakePorts();
    if (ports === null) return notReady(c);

    const runId = asRunId(c.req.param('id'));
    if (runId === null) {
      return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
    }

    const body = (await c.req.json().catch(() => null)) as InterjectBody | null;
    const nodeId = NodeIdSchema.safeParse(body?.nodeId);
    if (body === null || !nodeId.success) {
      return c.json(
        ...apiError(
          'invalid_request',
          'an interjection names the node it is steering: guidance addressed to a run rather ' +
            'than to a node is guidance no packet could carry',
          { detail: { field: 'nodeId' } },
        ),
      );
    }

    // Required rather than defaulted. The two modes behave differently enough —
    // one suspends the node, the other does not — that guessing on the Operator's
    // behalf would be guessing about whether their run pauses.
    if (!(INTERJECTION_MODES as readonly unknown[]).includes(body.mode)) {
      return c.json(
        ...apiError(
          'invalid_request',
          `mode must be one of ${INTERJECTION_MODES.map((one) => `"${one}"`).join(', ')}`,
          { detail: { field: 'mode' } },
        ),
      );
    }

    // `ifLastSeq` is the service's rather than `staleCursor`'s: what an
    // interjection is decided against is one node's liveness, not the run's
    // approval-queue surface, and the two are different questions.
    const result = interjectIntoNode({
      db: ports.db,
      runId,
      nodeId: nodeId.data,
      text: typeof body.text === 'string' ? body.text : '',
      mode: body.mode as InterjectionMode,
      ifLastSeq: body.ifLastSeq,
      epoch: ports.epoch,
      ts: ports.clock.now(),
    });

    if (result.status === 'ok') {
      return c.json(
        {
          runId,
          node: nodeId.data,
          seq: result.seq,
          delivery: result.delivery,
          ...(result.message === undefined ? {} : { message: result.message }),
          ...(result.alternative === undefined ? {} : { alternative: result.alternative }),
        },
        result.http,
      );
    }

    return c.json(
      ...serviceError(result.code, result.message, {
        detail: {
          ...(result.nodeStatus === undefined ? {} : { nodeStatus: result.nodeStatus }),
          ...(result.movedAt === undefined ? {} : { movedAt: result.movedAt, head: result.head }),
        },
        ...(result.movedAt === undefined ? {} : { seq: result.movedAt }),
      }),
    );
  })

  /**
   * KAR-13.2 AC6, AC7 — `POST /api/runs/:id/patches/:patchId/decide`.
   *
   * `decideQueuedPatch` owns both conflicts. Approving needs KAR-11.3's commit
   * pipeline, which the HTTP layer cannot assemble yet (it wants the run's pinned
   * spec, its capability rows and a git ref checker); until it can, an approval
   * is answered honestly with `apply_unavailable` and the patch stays in the
   * queue, rather than being recorded as approved without being applied.
   */
  .post('/runs/:id/patches/:patchId/decide', async (c) => {
    const ports = intakePorts();
    if (ports === null) return notReady(c);

    const runId = asRunId(c.req.param('id'));
    const patchId = c.req.param('patchId');
    if (runId === null) {
      return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
    }
    if (patchId === '') {
      return c.json(...apiError('patch_not_found', 'a decision names the patch it decides'));
    }

    const body = (await c.req.json().catch(() => null)) as DecideBody | null;
    if (body === null || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return c.json(
        ...apiError(
          'invalid_request',
          "a patch decision is 'approve' or 'reject'; there is no third answer",
          { detail: { field: 'decision' } },
        ),
      );
    }

    const result = await decideQueuedPatch({
      db: ports.db,
      runId,
      patchId,
      decision: body.decision,
      reason: body.reason,
      ifLastSeq: body.ifLastSeq,
      by: gateBy(c.req.header('X-DeFlow-Submitted-By')),
      ts: ports.clock.now(),
      epoch: ports.epoch,
    });

    if (result.status === 'ok') {
      return c.json(
        { runId, patchId, decision: result.decision, seq: result.seq, planHash: result.planHash },
        200,
      );
    }
    if (result.status === 'refused') {
      return c.json(...serviceError(result.code, result.message));
    }
    return c.json(
      ...serviceError(
        result.code,
        result.message,
        result.code === 'stale_cursor'
          ? { detail: { head: result.head, movedAt: result.movedAt }, seq: result.movedAt }
          : { detail: { decision: result.original } },
      ),
    );
  })

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
  .get('/stream', (c) => {
    const interval = heartbeatMs();
    const query = c.req.query('runs');
    const runs = subscribedRuns(query);
    const global = query === GLOBAL_TOPIC;
    const since = resumeFrom(c.req.query('since'), c.req.header('Last-Event-ID'));

    const response = streamSSE(c, async (stream) => {
      const view = ledgerView();
      const cursors = new Map<RunId, number>(
        view === null ? [] : runs.map((runId) => [runId, since] as const),
      );
      const handle = registerStream();
      // A global cursor of its own, because the topic is not a run: it advances
      // over the whole `event` table and must not be confused with any run's.
      let globalCursor = since;

      await stream.writeSSE({
        event: 'hello',
        retry: 2000,
        data: JSON.stringify({
          // §3 rule 4 — the id the client posts back to mutate this connection's
          // filter, which is what keeps a third run panel from opening a third
          // socket against a six-connection budget.
          streamId: handle.id,
          apiVersion: API_VERSION,
          build: BUILD,
          bootId: BOOT_ID,
          daemonEpoch: daemonEpoch(),
          headSeq: view?.headSeq() ?? headSeq(),
          runs: global ? [GLOBAL_TOPIC] : [...cursors.keys()],
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
      if (view !== null && global) {
        globalCursor = await drainGlobal(stream, view, globalCursor);
        await stream.writeSSE({
          event: 'caught_up',
          data: JSON.stringify({ runId: GLOBAL_TOPIC, seq: globalCursor }),
        });
      }

      // Phase 2 — re-drain on a tick, heartbeat on the configured cadence. A
      // connection that can be *given* something to watch ticks at the drain
      // cadence even while it is watching nothing yet: `POST …/subscribe` is what
      // adds a run, and a stream sleeping for fifteen seconds would acknowledge
      // it fifteen seconds late.
      const tick = Math.min(interval, DRAIN_TICK_MS);
      let sinceBeat = 0;
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(tick);
        if (stoppedMidSleep(stream)) break;

        // AC10's two-phase order, and it is the same one §5 gives for the serving
        // loop: *subscribe, then drain again*. Backfilling the new run before
        // resuming live delivery is what stops the events committed between the
        // last drain and the subscription from being skipped.
        const added = view === null ? [] : handle.takePending();
        if (added.length > 0) {
          for (const runId of added) if (!cursors.has(runId)) cursors.set(runId, since);
          await stream.writeSSE({
            event: 'subscribed',
            data: JSON.stringify({ runs: [...cursors.keys()] }),
          });
          if (view !== null) {
            await drain(stream, view, cursors);
            for (const runId of added) {
              await stream.writeSSE({
                event: 'caught_up',
                data: JSON.stringify({ runId, seq: cursors.get(runId) ?? since }),
              });
            }
          }
        }
        if (stoppedMidSleep(stream)) break;

        if (view !== null && cursors.size > 0) await drain(stream, view, cursors);
        if (view !== null && global) globalCursor = await drainGlobal(stream, view, globalCursor);
        if (stoppedMidSleep(stream)) break;

        sinceBeat += tick;
        if (sinceBeat < interval) continue;
        sinceBeat = 0;
        await stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ uptimeMs: uptimeMs() }),
        });
      }
      handle.close();
      http.debug('sse stream closed');
    });

    // streamSSE sets "no-cache"; SSE also needs "no-transform", so widen it.
    response.headers.set('Cache-Control', 'no-cache, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  })

  /**
   * KAR-13.2 AC10 — `POST /api/stream/:streamId/subscribe { runs: [...] }`.
   *
   * Opening a run panel mutates the filter on the connection the tab already has.
   * It does not open a second one, and it does not reconnect: six connections per
   * origin is the browser's cap, an SSE connection never closes, and the failure
   * mode of exhausting the budget is not an error but every subsequent `fetch`
   * queueing behind the streams forever.
   *
   * The response is a plain `202`: the acknowledgement the client renders on is
   * the `subscribed` control frame, which arrives on the stream itself, in order
   * with the backfill that follows it. Acknowledging here instead would tell the
   * client it was subscribed before a single backfilled event had been written.
   */
  .post('/stream/:streamId/subscribe', async (c) => {
    const streamId = c.req.param('streamId');
    const body = (await c.req.json().catch(() => null)) as { runs?: unknown } | null;
    const asked = body !== null && Array.isArray(body.runs) ? (body.runs as unknown[]) : null;
    if (asked === null) {
      return c.json(
        ...apiError(
          'invalid_request',
          'a filter mutation names the runs to add, as an array of run ids',
          { detail: { field: 'runs' } },
        ),
      );
    }

    const runs = asked
      .map((value) => (typeof value === 'string' ? asRunId(value) : null))
      .filter((value): value is RunId => value !== null);

    if (!subscribeStream(streamId, runs)) {
      return c.json(
        ...apiError(
          'not_found',
          `no stream '${streamId}' is open on this daemon: a filter mutation for a connection ` +
            'that has gone would be a subscription nothing could ever deliver',
          { detail: { streamId } },
        ),
      );
    }
    return c.json({ streamId, runs }, 202);
  })

  /**
   * Everything under /api terminates here, so an unknown API path is a typed 404
   * and never falls through to the SPA. A 200 with `index.html` on an API path is
   * the failure that costs an afternoon: the client sits there parsing HTML.
   */
  .all('*', (c) =>
    c.json(
      ...apiError('not_found', `this API does not serve ${c.req.path}`, {
        detail: { path: c.req.path },
      }),
    ),
  );

/**
 * The whole contract (docs/11-api-and-realtime.md §9).
 *
 * `packages/web/src/api/client.ts` builds `hc<ApiType>` from this and both the
 * UI and `DeFlow` the CLI import that one module. Because `@DeFlow/daemon`'s
 * `exports` field points at `./src/index.ts` inside the workspace, they
 * typecheck against **live daemon source**: rename a field here and their build
 * breaks in the same commit rather than a view breaking at runtime three weeks
 * later.
 */
export type ApiType = typeof api;
