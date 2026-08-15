/**
 * DeFlow — the only package published to npm.
 *
 * KAR-18.5 landed the packaging: `bin`, `files`, and `tsdown.config.ts`, which
 * inlines every @DeFlow/* package (`deps.alwaysBundle: [/^@DeFlow\//]`) and
 * leaves exactly two native runtime dependencies external. This module is the
 * package's `.` export inside the workspace and the fourth build entry; the
 * three bins beside it are `src/bin.ts`, `src/mcp.ts` and `src/mock-agent.ts`.
 * On a clean checkout `pnpm install` warns that it cannot link the bins,
 * because `dist/` does not exist until `pnpm build` runs — expected, and
 * documented in docs/03-local-development.md §13.
 *
 * KAR-10.1 adds `runTask`, the body of `deflow run "…"` (docs/11 §7.1) — ahead
 * of the argv parser and the `bin` entry EPIC-18 wires up, because the ACs it
 * has to satisfy are about what the command *does*: post the same wire shape
 * `POST /api/runs` accepts, over the daemon's own HTTP API. *"Both entry
 * points — POST /api/runs and deflow run '…' — go through the same daemon
 * code path; the CLI is a client of the HTTP API, not a second
 * implementation."*
 *
 * KAR-15.1 makes that literal. Both commands below go through
 * `createClient()` — the *same* module `packages/web` imports — so the CLI and
 * the UI share one typed surface and one error envelope, and a route change
 * breaks both builds in the commit that made it. There is no second protocol
 * implementation to keep in sync, which is the usual place a CLI and a UI
 * diverge.
 */
import type { Event, PermissionLevel, ProviderRoute } from '@DeFlow/core';
import {
  type ApiClient,
  connectStream,
  createClient,
  createDispatcher,
  hydrateRun,
  type StreamConnection,
} from '@DeFlow/web';

// KAR-18.4 — `deflow doctor`. Like `init`, it is not a client of the daemon's
// HTTP API: it answers questions about the machine the daemon would run on,
// and most of them have to be answerable when no daemon can start at all.
export type {
  CheckStatus,
  DoctorCheck,
  DoctorReport,
  DoctorSection,
  DoctorSectionId,
} from './doctor/report.ts';
export {
  DOCTOR_EX_FAIL,
  DOCTOR_SECTION_IDS,
  DOCTOR_SECTION_TITLES,
  reduceReport,
  renderJson,
  renderText,
} from './doctor/report.ts';
export type { DoctorOptions, DoctorResult } from './doctor/run.ts';
export { runDoctor } from './doctor/run.ts';
// KAR-18.1 — `deflow init`. Unlike `runTask`/`approveSpec` below, it is not a
// client of the daemon's HTTP API: there is nothing running yet to be a
// client of. It calls straight into `@DeFlow/daemon`'s `initWorkspace`.
export type { InitCommandOptions, InitCommandResult } from './init.ts';
export { runInit } from './init.ts';
// KAR-18.7 — the two diagnostics. Neither is a client of the daemon's HTTP
// API either: `status` has to answer when the daemon is *dead*, and a snapshot
// is taken with a read-only SQLite connection while it keeps serving.
export type {
  CommandResult,
  LedgerSnapshotOptions,
  ParsedLedgerArgs,
  SnapshotArgs,
  SnapshotReport,
} from './ledger-snapshot.ts';
export {
  EX_CANTCREAT,
  EX_NOINPUT,
  parseLedgerArgs,
  renderSnapshotReport,
  runLedgerSnapshot,
} from './ledger-snapshot.ts';
export type {
  ActiveRun,
  DaemonStatus,
  NoStatus,
  RunningStatus,
  StaleReason,
  StaleStatus,
  StatusArgs,
  StatusOptions,
  StatusResult,
} from './status.ts';
export {
  classifyDaemonFile,
  formatUptime,
  parseStatusArgs,
  readStatus,
  renderStatusJson,
  renderStatusText,
  runStatus,
} from './status.ts';

export interface RunTaskOptions {
  /** The daemon's own origin, e.g. `http://127.0.0.1:4173` — never assumed. */
  readonly baseUrl: string;
  /**
   * The daemon's bearer token, out of `.DeFlow/daemon.json` (KAR-15.2).
   *
   * Every route but `GET /api/health` requires it, so a command without one
   * gets `401 missing_token` — deliberately, because "the CLI runs on the same
   * machine" is exactly the reasoning the token exists to refuse. Reading the
   * file is `DeFlow`'s own argv layer, which is EPIC-18's.
   */
  readonly token?: string;
  /** The repository the run executes against. */
  readonly cwd: string;
  readonly permission?: PermissionLevel;
  readonly budget?: {
    readonly costUsd?: number | null;
    readonly wallclockMs?: number | null;
  };
  /** Forwarded as the `Idempotency-Key` header (AC6). */
  readonly idempotencyKey?: string;
  /**
   * KAR-19.10 AC1 — the provider the operator named, or absent for "choose".
   *
   * A registry id, already validated against `PROVIDER_SPECS` by whoever built
   * this. Whether *this machine* can serve it is a different question with a
   * different exit code, and the daemon answers that one.
   */
  readonly provider?: string;
}

export interface RunTaskResult {
  readonly runId: string;
  readonly seq: number;
  readonly status: string;
  /**
   * KAR-19.10 AC4 — what the daemon chose, on the 201 itself.
   *
   * Absent when the daemon was never told which machine it is on (no
   * `providerRoots`), which is the honest answer rather than a guess: it
   * admitted because it had no basis on which to refuse, and it has none on
   * which to announce either.
   */
  readonly provider?: {
    readonly provider: string;
    readonly binaryPath: string;
    readonly route: ProviderRoute;
    readonly limitation: string | null;
  };
}

/** A submission the daemon refused — the `field` out of the envelope's
 * `detail`, and the envelope's own human-readable `message`. */
export class RunTaskRejected extends Error {
  readonly field: string;
  /**
   * KAR-19.2 AC5 — the envelope's `code`, so the caller can tell a request that
   * was wrong from a machine that cannot host a run. A member of the closed
   * union, or `null` when the daemon answered with something that was not an
   * error envelope at all.
   */
  readonly code: string | null;

  constructor(field: string, message: string, code: string | null = null) {
    super(message);
    this.name = 'RunTaskRejected';
    this.field = field;
    this.code = code;
  }
}

/**
 * The daemon at `baseUrl`, through the one typed client.
 *
 * The token goes in as a *function* because that is the shape `createClient`
 * takes — read per request, so the browser's fragment handoff and the CLI's
 * file read are the same client with two sources — and it is attached as an
 * `Authorization` header, never as a query parameter (KAR-15.2 AC9).
 */
function clientFor(baseUrl: string, token: string | undefined): ApiClient {
  return createClient({
    baseUrl: `${baseUrl.replace(/\/$/, '')}/api`,
    token: () => token ?? null,
  });
}

/**
 * The closed error envelope, as far as a CLI cares about it
 * (docs/11-api-and-realtime.md §10).
 *
 * Read structurally rather than imported as a type, because what arrives here
 * has been through `JSON.parse` and the only honest thing to say about it is
 * what was actually checked.
 */
interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail?: Record<string, unknown>;
  };
}

function isEnvelope(body: unknown): body is Envelope {
  const error: unknown = (body as { error?: unknown } | null)?.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/**
 * `deflow run "<text>"` — posts free text to `POST /api/runs` on the daemon at
 * `options.baseUrl`, and returns the same `{ runId, seq, status }` the HTTP
 * route does.
 *
 * `X-DeFlow-Submitted-By: cli` is what turns into `provenance.by: 'cli'` on
 * the `task.submitted` event the daemon appends (../../daemon/src/http/api.ts).
 */
export async function runTask(text: string, options: RunTaskOptions): Promise<RunTaskResult> {
  return createRun({ kind: 'text', text }, options);
}

/**
 * KAR-18.3 AC8 — the same submission, over all three of F1.1's wire shapes.
 *
 * `runTask` above is this function with the `text` shape spelled out, kept
 * because it is what KAR-10.1's specs and `deflow run "…"` read like. Adding a
 * second poster for `--file` and `--issue` would have been the drift AC7 exists
 * to prevent, so there is one, and the four operator-facing sources collapse
 * onto the three wire kinds in `./run/args.ts` where the argv is parsed.
 */
export async function createRun(
  input:
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'issue'; readonly url: string },
  options: RunTaskOptions,
): Promise<RunTaskResult> {
  const response = await clientFor(options.baseUrl, options.token).runs.$post(
    {
      json: {
        input,
        cwd: options.cwd,
        permission: options.permission ?? 'worktree',
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.provider === undefined ? {} : { provider: options.provider }),
      },
    },
    {
      headers: {
        'X-DeFlow-Submitted-By': 'cli',
        ...(options.idempotencyKey === undefined
          ? {}
          : { 'Idempotency-Key': options.idempotencyKey }),
      },
    },
  );

  const payload: unknown = await response.json();
  if (response.status === 201 && !isEnvelope(payload)) {
    const created = payload as RunTaskResult;
    return {
      runId: created.runId,
      seq: created.seq,
      status: created.status,
      ...(created.provider === undefined ? {} : { provider: created.provider }),
    };
  }

  throw new RunTaskRejected(
    isEnvelope(payload) && typeof payload.error.detail?.field === 'string'
      ? payload.error.detail.field
      : '<root>',
    isEnvelope(payload) ? payload.error.message : `POST /api/runs failed with ${response.status}`,
    isEnvelope(payload) ? payload.error.code : null,
  );
}

/** Where a daemon is, and nothing else this client assumes about it. */
export interface DaemonClientOptions {
  /** The daemon's own origin, e.g. `http://127.0.0.1:4173` — never assumed. */
  readonly baseUrl: string;
  /** Its bearer token, out of `.DeFlow/daemon.json` (KAR-15.2). */
  readonly token?: string;
}

export interface ApproveSpecResult {
  readonly runId: string;
  /** The digest that was approved — what every later verdict cites. */
  readonly specHash: string;
  /** `'cli'` from here, always. */
  readonly by: 'cli';
}

/** The daemon refused the approval — usually because the gate is not open.
 * `code` is the envelope's, so it is a member of the closed union and may be
 * branched on. */
export class SpecApprovalRejected extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SpecApprovalRejected';
    this.code = code;
  }
}

/**
 * KAR-10.3 AC4 — `deflow approve <runId>`: the F1.3 gate, answered from a
 * second terminal.
 *
 * A client of `POST /api/runs/:id/spec/approve` and nothing more, exactly as
 * `runTask` is a client of `POST /api/runs`. The daemon owns the transaction —
 * `human.responded`, `run.spec.approved` and `spec.pinned` in one commit — so
 * the CLI and the UI cannot diverge on what approval *means*, only on the `by`
 * field the daemon reads off `X-DeFlow-Submitted-By` (EPIC-10-S18).
 *
 * This matters more than it looks: M1's UI arrives in W10–W11, well after W7a,
 * so until then this is the only way a run gets past the gate at all.
 */
export async function approveSpec(
  runId: string,
  options: DaemonClientOptions,
): Promise<ApproveSpecResult> {
  const response = await clientFor(options.baseUrl, options.token).runs[':id'].spec.approve.$post(
    { param: { id: runId } },
    { headers: { 'X-DeFlow-Submitted-By': 'cli' } },
  );

  const payload: unknown = await response.json();
  if (response.ok && !isEnvelope(payload)) {
    const approved = payload as { runId: string; specHash: string };
    return { runId: approved.runId, specHash: approved.specHash, by: 'cli' };
  }

  throw new SpecApprovalRejected(
    isEnvelope(payload) ? payload.error.code : 'request_failed',
    isEnvelope(payload)
      ? payload.error.message
      : `POST /api/runs/${runId}/spec/approve failed with ${response.status}`,
  );
}

/**
 * KAR-15.4 AC9 — what `DeFlow` needs to rejoin a run's log.
 *
 * `since` is the operator's own persisted cursor and it is the **only** resume
 * mechanism a terminal has: nothing in a shell maintains a `Last-Event-ID`, so
 * the header path the browser sometimes uses does not exist here at all. That
 * is why the daemon's precedence puts `?since=` first
 * (docs/11-api-and-realtime.md §4.1) — half its clients cannot produce anything
 * else.
 */
export interface ResumeRunOptions extends DaemonClientOptions {
  /** The cursor to resume from. `0` — the default — is the whole history. */
  readonly since?: number;
  /** Page size; the daemon's own default of 1000 when omitted. */
  readonly limit?: number;
  /** Every event, in `seq` order, exactly once. */
  readonly onEvent: (event: Event) => void;
  /** Called once per hydrate page, for a progress line over a long run. */
  readonly onProgress?: (progress: { cursor: number; headSeq: number }) => void;
}

export interface ResumeRunResult {
  /** The cursor to persist, and to open the stream at. */
  readonly cursor: number;
  /** This run's head as the last page reported it. */
  readonly headSeq: number;
  readonly applied: number;
  readonly pages: number;
}

/**
 * `DeFlow` catching up on a run: hydrate from `since` to the head of its log.
 *
 * `hydrateRun` is `@DeFlow/web`'s — the exact function the UI's cold start
 * calls, over the exact endpoint — so the CLI and the browser cannot disagree
 * about what resume means, only about what they do with the events. There is no
 * gap detection here or in it: `seq` 4, 5, 7 is a healthy log, and a terminal
 * that announced "3 events lost" over a pruned number would be lying loudly.
 */
export async function resumeRun(
  runId: string,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
  const client = clientFor(options.baseUrl, options.token);
  return hydrateRun(client, runId, {
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    apply: options.onEvent,
    ...(options.onProgress === undefined
      ? {}
      : {
          onPage: (page: { cursor: number; headSeq: number }) =>
            options.onProgress?.({ cursor: page.cursor, headSeq: page.headSeq }),
        }),
  });
}

export interface FollowRunResult extends ResumeRunResult {
  /** Closes the stream. The command that opened it owns it. */
  close(): void;
}

/**
 * `DeFlow` watching a run: hydrate first, then stream from the cursor that
 * returned.
 *
 * The order is the whole contract (§4.1): hydrating *after* opening the stream
 * would duplicate everything in between, and opening the stream from head
 * without hydrating would silently drop it. And the stream is opened with
 * `?since=<cursor>` on every attempt — `connectStream` re-reads the cursor per
 * connection, so a reconnect resumes from what this process has applied rather
 * than from where it started watching.
 */
export async function followRun(
  runId: string,
  options: ResumeRunOptions,
): Promise<FollowRunResult> {
  const hydrated = await resumeRun(runId, options);

  const dispatcher = createDispatcher({
    applyEvent: (event) => {
      if (event.runId === runId) options.onEvent(event);
    },
    // A terminal has no use for `hello`, `caught_up` or `subscribed`; a `fatal`
    // frame ends the connection on the server's side, and the library stops
    // retrying only when this process closes it.
    control: () => undefined,
  });

  const connection: StreamConnection = connectStream({
    baseUrl: `${options.baseUrl.replace(/\/$/, '')}/api`,
    ...(options.token === undefined ? {} : { token: () => options.token ?? null }),
    runs: [runId],
    since: () => Math.max(hydrated.cursor, dispatcher.cursor()),
    onMessage: (message) => {
      dispatcher.onFrame({
        event: message.event,
        id: message.id ?? undefined,
        data: message.data,
      });
    },
  });

  return { ...hydrated, close: () => connection.close() };
}
