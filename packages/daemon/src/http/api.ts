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
import { PROVIDER_SPECS, providerFamily, providerTokenAccounting } from '@DeFlow/adapters';
import type {
  CancelMode,
  Db,
  EstimatorInputs,
  FactId,
  InterjectionMode,
  NodeId,
  NodeState,
  RunId,
  RunState,
  TaskSpec,
  VerdictV2,
} from '@DeFlow/core';
import {
  acceptanceBoard,
  CANCEL_MODES,
  INTERJECTION_MODES,
  mintRunId,
  NodeIdSchema,
  parseDeFlowConfig,
  SpecEditRefused,
  sealTaskSpec,
  VerdictV2Schema,
} from '@DeFlow/core';
import { putBlob, type SnapshotSeq } from '@DeFlow/ledger';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { validator } from 'hono/validator';
import { loadWorkspaceConfig, writeWorkspaceConfig } from '../config/workspace-config.ts';
import { Git } from '../git/git.ts';
import { respondToHumanNode } from '../human/gate.ts';
import { interjectIntoNode } from '../human/interject.ts';
import { decideQueuedPatch, decisionSurfaceMoved } from '../human/patch-decision.ts';
import { submitTask } from '../intake/intake.ts';
import { killRun } from '../kill-switch.ts';
import { log } from '../logging.ts';
import { API_VERSION, BOOT_ID, BUILD, uptimeMs } from '../meta.ts';
import { diffPlanGraphs } from '../plan/diff.ts';
import { unionLayoutKey } from '../plan/plan-history.ts';
import { runProviderDoctor } from '../providers/doctor.ts';
import { controlRun, type RunControlVerb } from '../run-control.ts';
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
import { artifactStat, readArtifactBytes } from './artifact-store.ts';
import { requireAuth, varyOrigin } from './auth.ts';
import { parseByteRange } from './byte-range.ts';
import { requireCurrentEpoch } from './epoch-guard.ts';
import { apiError, serviceError } from './errors.ts';
import { factsPage, findingsByFile, gatesView, nodeBundle, packetView } from './inspect.ts';
import { intakePorts } from './intake-ports.ts';
import { IO_NDJSON_MEDIA_TYPE, IO_NDJSON_UNVERSIONED, ioChunkLine } from './io-ndjson.ts';
import { asRunId, type LedgerView, ledgerView } from './ledger-view.ts';
import { boundedLimit, LIMIT_HEADER, READ_LIMITS } from './read-limits.ts';
import { hydrateLimit, resumeFrom } from './resume.ts';
import { runSummary } from './run-summary.ts';
import { serveStream } from './stream.ts';
import { subscribeStream } from './streams.ts';

const http = log.child({ mod: 'http' });

/**
 * The build-skew header (docs/11-api-and-realtime.md §12), on **every**
 * response including the stream and every refusal.
 *
 * An old tab against a new daemon is the only skew that can happen — daemon and
 * UI ship in the same tarball — and this is how the tab notices.
 */
export const API_HEADER = 'X-DeFlow-Api';

/**
 * The one route that answers without a bearer token, and the predicate over it
 * (./api-routes.ts).
 *
 * Re-exported here, next to the routes, so that adding a `/api/version` "for
 * convenience" has to walk past it — it lives in its own module only because
 * `./auth.ts` enforces it and must not import the app it guards.
 */
export { isPublicRoute, PUBLIC_ROUTES } from './api-routes.ts';

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
 * KAR-15.7 — `?seq=` for the snapshot endpoint: the `'head'` alias, a
 * non-negative integer, or `null` for anything else — absent, non-numeric or
 * negative. `0` is accepted (the state before this run's first event), unlike
 * `parseVersion`'s 1-based versions.
 */
function parseSnapshotSeq(value: string | undefined): SnapshotSeq | null {
  if (value === 'head') return 'head';
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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

/**
 * KAR-15.6 AC11 — the header naming a surface that is **not** versioned.
 *
 * Two of this story's responses carry a shape the `apiVersion` does not cover:
 * the `io_chunk` NDJSON framing, and `unionLayoutKey`. Saying so only in the
 * docs means nobody reads it; saying so on the response means a client that
 * logs its headers has already been told.
 */
export const UNVERSIONED_HEADER = 'X-DeFlow-Unversioned';

/** AC11's second marker: what `unionLayoutKey` is and is not. */
export const UNION_LAYOUT_KEY_UNVERSIONED =
  'unionLayoutKey is an opaque cache key and is not part of the versioned ' +
  'contract: it identifies a union layout the client may have cached and ' +
  'carries no coordinates, no ordering and no meaning a client may parse.';

/** A resolved run, or the refusal the route should return instead. */
type RunLookup =
  | { readonly view: LedgerView; readonly runId: RunId; readonly state: RunState }
  | { readonly response: Response };

/**
 * The run a read endpoint addressed, reduced once.
 *
 * Every read route starts here, and the two failures are answered in one place
 * rather than eleven: no ledger yet is a retryable `503`, and a run this
 * directory does not hold — including an id that is not a `RunId` at all — is
 * `404 run_not_found`, because `/api/runs/r1` is a request for a run that does
 * not exist and telling the caller anything else wastes their afternoon.
 */
function resolveRun(c: Context): RunLookup {
  const view = ledgerView();
  if (view === null) return { response: notReady(c) };

  const raw = c.req.param('id') ?? '';
  const runId = asRunId(raw);
  const state = runId === null ? null : view.runState(runId);
  if (runId === null || state === null) {
    return { response: c.json(...apiError('run_not_found', `no run '${raw}'`)) };
  }
  return { view, runId, state };
}

type NodeLookup =
  | {
      readonly view: LedgerView;
      readonly runId: RunId;
      readonly state: RunState;
      readonly nodeId: string;
      readonly node: NodeState;
    }
  | { readonly response: Response };

/**
 * The node a read endpoint addressed — `404 node_not_found` when the run holds
 * no such node, which is its **own** code and never the run's.
 *
 * EPIC-15-S44 is entirely about this distinction: a 404 has to answer *which*
 * thing was missing, or the caller cannot tell a typo in a node id from a run
 * that was pruned.
 */
function resolveNode(c: Context): NodeLookup {
  const found = resolveRun(c);
  if ('response' in found) return found;

  const nodeId = c.req.param('nodeId') ?? '';
  const node = found.state.nodes[nodeId];
  if (node === undefined) {
    return {
      response: c.json(
        ...apiError('node_not_found', `run '${found.runId}' has no node '${nodeId}'`, {
          detail: { runId: found.runId, node: nodeId },
        }),
      ),
    };
  }
  return { ...found, nodeId, node };
}

/**
 * `?attempt=`, or the node's current one.
 *
 * Defaulting to the *current* attempt rather than to 0 is what makes the
 * inspector's first request useful on a node that has been retried: attempt 0
 * of a node that failed twice is the least interesting of the three.
 */
function attemptOf(c: Context, node: NodeState): number {
  const raw = c.req.query('attempt');
  if (raw === undefined) return node.attempt;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : node.attempt;
}

/**
 * The node id as the `io_chunk` selector wants it.
 *
 * A cast rather than a parse, and only reachable once `resolveNode` has found
 * the node in the run's own projection — an id the plan holds is a `NodeId` by
 * construction, and re-parsing it would let a schema change turn a found node
 * into a 500.
 */
const asNodeId = (nodeId: string): NodeId => nodeId as NodeId;

/**
 * The path segment as a `FactId`.
 *
 * Unparsed on purpose: an id nothing wrote returns no consumers, which is the
 * honest answer and the same one a well-formed id for a fact nobody read gets.
 * A 400 here would make "this fact has no readers" and "you typed it wrong"
 * two different answers to a question the memory graph answers the same way.
 */
const asFactId = (factId: string): FactId => factId as FactId;

/**
 * The version the last probe of `provider` reported, or `null`.
 *
 * `.at(-1)`, because `providerCapabilities` is a *history* and it is ordered
 * oldest first: taking `[0]` would answer with the first version this machine
 * ever saw, which is wrong exactly when it matters — after an upgrade, or
 * after `POST /providers/doctor` re-probed and recorded a new row.
 */
function probedVersion(view: LedgerView, provider: string | null): string | null {
  if (provider === null) return null;
  return view.providerCapabilities(provider).at(-1)?.version ?? null;
}

/**
 * The verdict documents the acceptance board reduces, parsed out of
 * `gate.evaluated` and skipping anything this build cannot read.
 *
 * `GateVerdictState` is the *ladder's* view of a verdict and carries only what
 * admission needs; the board decides a row on the verdict's `criteria` entries
 * and on the `specHash` it was judged against, which are fields of the
 * document. A verdict a newer daemon wrote in a shape this one does not parse
 * is skipped rather than thrown on — the board is a read, and a run with one
 * unreadable verdict still has an honest answer for every other row.
 */
function boardVerdicts(view: LedgerView, runId: RunId, limit: number): readonly VerdictV2[] {
  return view.gateVerdictDocuments(runId, limit).flatMap((document) => {
    const parsed = VerdictV2Schema.safeParse(document);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The spec a run is currently judged against: the latest amendment sealed, or
 * `run.created.spec` for a run nobody has amended.
 *
 * Sealed here rather than read from a stored copy, because `spec.amended`
 * carries the framed *draft* and the sealed spec is `sealTaskSpec(document)` —
 * ./spec/gate.ts is explicit that there is one door a `TaskSpec` comes through,
 * and a second copy in the payload is a second thing that can disagree.
 */
async function currentSpec(view: LedgerView, runId: RunId): Promise<TaskSpec | null> {
  const { created, amended } = view.runSpec(runId);
  if (amended !== null) {
    try {
      return await sealTaskSpec(amended);
    } catch {
      // An amendment this build can no longer seal is not a reason to refuse
      // the board: the pre-edit spec is still in the ledger, still at its own
      // hash, and still the honest answer to "what was approved".
      return created;
    }
  }
  return created;
}

/**
 * `dir`'s whole change since `base`, as a patch — **including files the agent
 * created and never added**.
 *
 * A plain `git diff <base>` omits untracked files, and for this endpoint that
 * is not a detail: a node whose entire contribution is three new modules would
 * render as an empty diff, which reads as "the node did nothing". The two ways
 * to include them are `git add -N` — which writes the repository's index, and
 * a `GET` may not — and a **temporary index**, which is this.
 *
 * `GIT_INDEX_FILE` points git at a scratch file: `read-tree` fills it from the
 * base commit, `add -A` stages the worktree into it (honouring `.gitignore`
 * exactly as a real `add` would), and `diff --cached` prints the result. The
 * repository's own index, worktree and refs are untouched, which is what makes
 * a read that stages files still a read.
 */
async function worktreePatch(dir: string, base: string): Promise<string | null> {
  const scratch = mkdtempSync(join(tmpdir(), 'DeFlow-diff-'));
  const index = join(scratch, 'index');
  // Only `GIT_INDEX_FILE` is added: `runGit` composes this over
  // `gitChildEnv()`, and spreading `process.env` in would undo the scrubbing
  // that keeps a child git out of the developer's own configuration.
  const git = new Git(dir, { env: { GIT_INDEX_FILE: index } });

  try {
    const seeded = await git.run(['read-tree', base]);
    if (seeded.exitCode !== 0) return null;
    const staged = await git.run(['add', '-A']);
    if (staged.exitCode !== 0) return null;
    const diff = await git.run([
      'diff',
      '--cached',
      '--no-color',
      '--no-ext-diff',
      '--binary',
      base,
    ]);
    if (diff.exitCode !== 0) return null;
    // `runGit` strips the final newline, which is right for `rev-parse` and
    // wrong for a patch: `git apply` rejects a hunk whose last line has no
    // terminator with "corrupt patch at line N". Restoring the byte git wrote
    // is not assembling a patch — it is undoing a convenience applied to the
    // wrong kind of output.
    return diff.stdout === '' ? '' : `${diff.stdout}\n`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The directory a diff is taken in, and the revision it is taken from. */
type DiffTarget = { readonly dir: string; readonly base: string } | { readonly response: Response };

/**
 * `?node=` / `?worktree=` / `?cumulative=1`, resolved to a directory this run
 * actually worked in.
 *
 * `base` is `HEAD` for a node's worktree — the uncommitted change that node has
 * made — and the commit the run was **created** against for the cumulative
 * view, which is what makes "what has this run done in total" include the
 * commits it made along the way as well as the working tree.
 */
function diffTarget(c: Context, view: LedgerView, runId: RunId, state: RunState): DiffTarget {
  const node = c.req.query('node');
  const worktree = c.req.query('worktree');
  const cumulative = c.req.query('cumulative');
  const named = [node, worktree, cumulative].filter((value) => value !== undefined);

  if (named.length !== 1) {
    return {
      response: c.json(
        ...apiError(
          'invalid_request',
          'name exactly one of node, worktree or cumulative=1: the three mean different things ' +
            'and a caller given the wrong one has no way to notice',
          { detail: { field: 'node|worktree|cumulative' } },
        ),
      ),
    };
  }

  const repoRoot = state.repoRoot;
  if (repoRoot === null) {
    return {
      response: c.json(
        ...apiError('not_applicable', 'this run has no repository yet', { detail: {} }),
      ),
    };
  }

  if (node !== undefined) {
    const found = state.nodes[node];
    if (found === undefined) {
      return {
        response: c.json(
          ...apiError('node_not_found', `this run has no node '${node}'`, { detail: { node } }),
        ),
      };
    }
    return { dir: found.worktree ?? repoRoot, base: 'HEAD' };
  }

  if (worktree !== undefined) {
    const held =
      worktree === repoRoot ||
      Object.values(state.nodes).some((entry) => entry.worktree === worktree);
    if (!held) {
      return {
        response: c.json(
          ...apiError('invalid_request', 'this run never held that worktree', {
            detail: { field: 'worktree' },
          }),
        ),
      };
    }
    return { dir: worktree, base: 'HEAD' };
  }

  // `cumulative=1`, and anything else under that name is a request nobody can
  // honour rather than a different view.
  if (cumulative !== '1') {
    return {
      response: c.json(
        ...apiError('invalid_request', 'cumulative takes the value 1', {
          detail: { field: 'cumulative' },
        }),
      ),
    };
  }
  // The commit the run began at, so "what has this run done in total" includes
  // the commits it made along the way. `HEAD` when `run.created` has been
  // pruned — the narrower question, answered honestly, rather than a wrong
  // version of the broader one.
  return { dir: repoRoot, base: view.runOrigin(runId)?.head ?? 'HEAD' };
}

/** The workspace `?cwd=` names, or the refusal. */
type WorkspaceLookup = { readonly cwd: string } | { readonly response: Response };

/**
 * `?cwd=`, checked against the repositories this ledger holds runs for.
 *
 * Not taken as given. The daemon is bearer-token protected, but *the agents
 * DeFlow itself spawned* are inside that boundary (docs/15-security-model.md
 * §3), and a config endpoint that would read or write `.DeFlow/config.yaml`
 * under any path on the machine is a file reader and a file writer with a
 * different name.
 */
function workspaceRoot(c: Context): WorkspaceLookup {
  const view = ledgerView();
  if (view === null) return { response: notReady(c) };

  const cwd = c.req.query('cwd');
  if (cwd === undefined || cwd === '') {
    return {
      response: c.json(
        ...apiError('invalid_request', 'cwd names the workspace whose config is read', {
          detail: { field: 'cwd' },
        }),
      ),
    };
  }

  const known = view.runIds().some((runId) => view.runState(runId)?.repoRoot === cwd);
  if (!known) {
    return {
      response: c.json(
        ...apiError('invalid_request', 'cwd is not a repository this daemon holds a run for', {
          detail: { field: 'cwd' },
        }),
      ),
    };
  }
  return { cwd };
}

/**
 * AC7 — one content-addressed blob, with `Range` and immutable caching.
 *
 * `GET` and `HEAD` share a body because they must not disagree about the size
 * or the media type: a `HEAD` that answered from a different code path is a
 * `HEAD` that will eventually be wrong, and a client sizes its download off it.
 *
 * The media type comes from the run artifact index — `runs/<runId>/artifacts/
 * <sha>/entry.json`, written by KAR-09.5 — because the blob store is
 * content-addressed and a sha256 says nothing about what the bytes are.
 * `application/octet-stream` when nothing recorded one, which is the honest
 * answer rather than a guess from the first few bytes.
 */
function serveArtifact(c: Context, method: 'GET' | 'HEAD') {
  // The view's own data directory, because the blob store is part of the read
  // side: a read endpoint that could only answer once the *write* ports were
  // registered would be unavailable for exactly as long as the write path is,
  // which is the opposite of what a reader wants from a restart.
  const dataDir = ledgerView()?.dataDir ?? intakePorts()?.dataDir;
  if (dataDir === undefined) return notReady(c);

  const sha = c.req.param('sha') ?? '';
  const found = artifactStat(dataDir, sha);
  if (found === null) {
    return c.json(...apiError('artifact_not_found', `no artifact '${sha}'`, { detail: { sha } }));
  }

  c.header('Accept-Ranges', 'bytes');
  c.header('Content-Type', found.mime);
  c.header('ETag', `"${found.sha256}"`);
  // Safe precisely because the address is the digest: these bytes cannot become
  // different bytes, so there is nothing for a cache to go stale against.
  c.header('Cache-Control', 'private, max-age=31536000, immutable');

  const range = parseByteRange(c.req.header('Range'), found.bytes);
  if (range.kind === 'unsatisfiable') {
    c.header('Content-Range', `bytes */${found.bytes}`);
    return c.body(null, 416);
  }

  if (method === 'HEAD') {
    c.header('Content-Length', String(found.bytes));
    return c.body(null, 200);
  }

  if (range.kind === 'whole') {
    c.header('Content-Length', String(found.bytes));
    return c.body(readArtifactBytes(found.path, 0, found.bytes) as unknown as ArrayBuffer, 200);
  }

  c.header('Content-Range', `bytes ${range.start}-${range.end}/${found.bytes}`);
  c.header('Content-Length', String(range.length));
  return c.body(
    readArtifactBytes(found.path, range.start, range.length) as unknown as ArrayBuffer,
    206,
  );
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

interface ControlRequestBody {
  readonly ifLastSeq?: number | undefined;
  readonly reason?: unknown;
  readonly mode?: unknown;
}

/**
 * KAR-15.5 AC1, AC2, AC3, AC6, AC9 — `pause`, `resume` and `cancel`, which are
 * the same route three times over (docs/11-api-and-realtime.md §7.3).
 *
 * `controlRun` (../run-control.ts) owns the state machine and the append; what
 * is here is the wire — the body, the mode, the status code and the closed
 * envelope. The three verbs share it rather than repeating it, because the
 * property that makes the surface safe to double-click is *shared*: a repeat
 * answers `200` with the seq already in the log, and three copies of that rule
 * is three chances for one of them to answer `409` instead.
 *
 * `forceful` is the one verb with a side effect beyond the append: it is the
 * F5.7 kill switch (KAR-08.6), and the response is deliberately sent **after**
 * the ladder has finished and verified, because "stopped" is a claim this
 * endpoint has to be able to make. `kill.outcome` carries what actually
 * happened, `survivors` names anything that outlived SIGKILL, and neither is
 * inferred from the absence of an error.
 */
async function controlRoute(c: Context, verb: RunControlVerb) {
  const ports = intakePorts();
  if (ports === null) return notReady(c);

  const runId = asRunId(c.req.param('id') ?? '');
  if (runId === null) {
    return c.json(...apiError('run_not_found', `no run '${c.req.param('id') ?? ''}'`));
  }

  // An empty body is legitimate on all three — `pause` needs nothing, and
  // `cancel` defaults to the ladder that lets the agent flush a transcript.
  const body = (await c.req.json().catch(() => null)) as ControlRequestBody | null;

  let mode: CancelMode | undefined;
  if (verb === 'cancel') {
    const asked = body?.mode ?? 'cooperative';
    if (!(CANCEL_MODES as readonly unknown[]).includes(asked)) {
      return c.json(
        ...apiError(
          'invalid_request',
          `mode must be one of ${CANCEL_MODES.map((one) => `"${one}"`).join(', ')}: ` +
            'one lets the agent flush its transcript and one does not, and guessing on the ' +
            "operator's behalf would be guessing about whether that transcript survives",
          { detail: { field: 'mode' } },
        ),
      );
    }
    mode = asked as CancelMode;
  }

  const result = controlRun({
    db: ports.db,
    runId,
    verb,
    by: 'user',
    reason: typeof body?.reason === 'string' ? body.reason : undefined,
    ifLastSeq: body?.ifLastSeq,
    ...(mode === undefined ? {} : { mode }),
    epoch: ports.epoch,
    ts: ports.clock.now(),
  });

  if (result.status === 'refused') {
    return c.json(
      ...apiError(result.code, result.message, {
        detail: {
          ...(result.movedAt === undefined ? {} : { movedAt: result.movedAt, head: result.head }),
          ...(result.runStatus === undefined ? {} : { status: result.runStatus }),
        },
        // The same shape `staleCursor` above answers with, so a client branching
        // on `stale_cursor` reads one contract wherever the code can occur.
        ...(result.movedAt === undefined ? {} : { seq: result.movedAt }),
      }),
    );
  }

  const kill =
    mode === 'forceful'
      ? await killRun(runId, {
          db: ports.db,
          clock: ports.clock,
          epoch: ports.epoch,
          mode: 'forceful',
          by: 'user',
        })
      : null;

  return c.json(
    {
      runId,
      seq: result.seq,
      status: result.runStatus,
      appended: result.appended,
      ...(kill === null
        ? {}
        : { kill: { outcome: kill.outcome, survivors: kill.survivors.map((one) => one.pid) } }),
    },
    200,
  );
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
  // KAR-15.2, and in this order: `Vary` is registered before the guard so it
  // lands on the guard's own refusals too (AC4), and the guard is registered
  // before every route so an unknown path answers 401 rather than confirming
  // which routes exist.
  .use('*', varyOrigin)
  .use('*', requireAuth)
  // KAR-15.4 AC7, and after the token guard on purpose: an unauthenticated
  // request is refused before this daemon says anything about which epoch it is
  // at (./epoch-guard.ts).
  .use('*', requireCurrentEpoch)
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
   * KAR-15.5 AC1 — F4.4's pause and resume, and F5.7's cancel.
   *
   * Three routes rather than one `POST /runs/:id/control { verb }`, because
   * that is what §6's route table documents and because the three answer
   * differently: only `cancel` takes a mode, and only its forceful ladder does
   * anything beyond appending an event.
   *
   * Each is a one-line call onto the shared handler above, and it stays *on
   * this chain* for the reason the file header gives — `hc<ApiType>` infers the
   * client from the type of the chained expression, and a route registered on
   * its own statement is invisible to it.
   */
  .post('/runs/:id/pause', (c) => controlRoute(c, 'pause'))

  .post('/runs/:id/resume', (c) => controlRoute(c, 'resume'))

  .post('/runs/:id/cancel', (c) => controlRoute(c, 'cancel'))

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
   * KAR-15.4 AC4 — `GET /api/runs/:id/events?since=<seq>&limit=<n>`: the
   * explicit hydrate path (docs/11-api-and-realtime.md §4.1, §7.2).
   *
   * *"The explicit hydrate path is mandatory, not an optimisation."* A tab that
   * reloads sends no `Last-Event-ID`, and a tab whose first connection never
   * opened — DeFlowd was restarting — has no cursor at all. Both hydrate here
   * first and open the stream at the `cursor` this returns, which is the only
   * sequence that produces neither a gap nor a duplicate at the seam.
   *
   * `more` rather than a total: the client loops until it is false. `headSeq`
   * is this **run's** head, not the directory's, so it is a denominator a
   * hydrating client actually converges on — and it is what turns a long
   * hydrate into an honest progress bar rather than a spinner.
   *
   * `cursor` is the last `seq` in the page, and the *requested* cursor when the
   * page is empty. Never `events.length` and never `cursor + 1`: the sequence
   * is global across runs and `AUTOINCREMENT` never reissues a pruned number,
   * so `4, 5, 7` is a healthy page and the contract is "strictly greater than"
   * (§4.2).
   */
  .get(
    '/runs/:id/events',
    // Declared rather than read straight off `c.req.query()`, so the two
    // parameters are part of the *type* of this chain and therefore part of
    // `hc<ApiType>`: `hydrateRun` in @DeFlow/web is the only caller, and its
    // loop passing a cursor this route stopped accepting should be a compile
    // error rather than a page of zero events. Both stay strings here —
    // `./resume.ts` owns what they mean, including what an unusable one falls
    // back to.
    validator('query', (value) => ({
      since: typeof value.since === 'string' ? value.since : undefined,
      limit: typeof value.limit === 'string' ? value.limit : undefined,
    })),
    (c) => {
      const view = ledgerView();
      if (view === null) return notReady(c);

      const runId = asRunId(c.req.param('id'));
      // Head first, then the page. A row committed between the two reads is
      // beyond this `headSeq` and arrives on the next call or on the stream —
      // whereas reading the head *after* the page could report a head lower
      // than the cursor just returned, which is a progress bar that goes
      // backwards.
      //
      // It doubles as the 404, and that is why this route does **not** reduce
      // the run the way `GET /api/runs/:id` does: a hydrate loop calls this
      // once per page, and replaying twelve thousand events three times to
      // answer "does this run exist" would make the cheap path the expensive
      // one. A head is one covering-index seek; the run list is only consulted
      // for the rare run that holds no events at all.
      const runHead = runId === null ? 0 : view.runHeadSeq(runId);
      if (runId === null || (runHead === 0 && !view.runIds().includes(runId))) {
        return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
      }

      const query = c.req.valid('query');
      const resume = resumeFrom(query.since, c.req.header('Last-Event-ID'));
      const since = resume.kind === 'seq' ? resume.seq : runHead;
      const page = view.tailPage(runId, since, hydrateLimit(query.limit));

      return c.json(
        {
          events: page.events,
          cursor: page.events.at(-1)?.seq ?? since,
          headSeq: runHead,
          more: page.hasMore,
        },
        200,
      );
    },
  )

  /**
   * KAR-15.7 AC1, AC2, AC3, AC7, AC8 — `GET /api/runs/:id/snapshot?seq=N`
   * (docs/11-api-and-realtime.md §7.3).
   *
   * *"The reason this endpoint exists is browser memory, not server
   * convenience."* Scrubbing the plan-evolution timeline or replaying a run
   * must not mean replaying from `seq` 0 in JavaScript — SQLite does it in
   * milliseconds. `view.runSnapshotAt` is the whole handler: it resolves
   * `seq=head` and a `seq` that lands in a gap the same way it resolves a
   * `seq` past this run's own head — to the greatest committed `seq` it
   * actually has, echoed back rather than assumed, because a caller cannot
   * otherwise tell which one it got.
   *
   * The 404/existence check is the same cheap head lookup `/events` uses
   * above, and for the same reason: this route must not reduce the run twice
   * — once to answer "does it exist" and again for the requested `seq` — on a
   * ledger the whole point of this endpoint is to spare the caller from
   * folding client-side.
   */
  .get(
    '/runs/:id/snapshot',
    // Declared rather than read straight off `c.req.query()`, for the reason
    // `/runs/:id/events` above declares its two: it puts `seq` into the *type*
    // of this chain and therefore into `hc<ApiType>`. `createScrubber` in
    // @DeFlow/web is its only caller, and a scrubber naming a parameter this
    // route stopped accepting should be a compile error rather than a silent
    // 400 in a tab. It stays a string here — `parseSnapshotSeq` below owns
    // what it means, including the `'head'` alias.
    validator('query', (value) => ({
      seq: typeof value.seq === 'string' ? value.seq : undefined,
    })),
    (c) => {
      const view = ledgerView();
      if (view === null) return notReady(c);

      const runId = asRunId(c.req.param('id'));
      const runHead = runId === null ? 0 : view.runHeadSeq(runId);
      if (runId === null || (runHead === 0 && !view.runIds().includes(runId))) {
        return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
      }

      const seq = parseSnapshotSeq(c.req.valid('query').seq);
      if (seq === null) {
        return c.json(
          ...apiError('invalid_request', "seq must be a non-negative integer or 'head'", {
            detail: { field: 'seq' },
          }),
        );
      }

      const snapshot = view.runSnapshotAt(runId, seq);
      return c.json(
        {
          seq: snapshot.seq,
          state: snapshot.state,
          planVersion: snapshot.state.planVersion,
          planHash: snapshot.state.planHash,
        },
        200,
      );
    },
  )

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
  .get(
    '/runs/:id/plans/diff',
    // Declared rather than read straight off `c.req.query()`, for the reason
    // `/runs/:id/snapshot` above declares its `seq`: it puts `from` and `to`
    // into the *type* of this chain and therefore into `hc<ApiType>`. The
    // plan-evolution view in @DeFlow/web is its only caller, and a view naming a
    // parameter this route stopped accepting should be a compile error rather
    // than a silent 400 in a tab. They stay strings here — `parseVersion` below
    // owns what they mean.
    validator('query', (value) => ({
      from: typeof value.from === 'string' ? value.from : undefined,
      to: typeof value.to === 'string' ? value.to : undefined,
    })),
    (c) => {
      const view = ledgerView();
      if (view === null) return notReady(c);

      const runId = asRunId(c.req.param('id'));
      if (runId === null) {
        return c.json(...apiError('run_not_found', `no run '${c.req.param('id')}'`));
      }

      const query = c.req.valid('query');
      const from = parseVersion(query.from);
      const to = parseVersion(query.to);
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

      // KAR-15.6 AC11 — `unionLayoutKey` is an opaque cache key and not part of
      // the versioned contract. Said on the response rather than only in the
      // docs, because a client that logs its headers has then been told.
      c.header(UNVERSIONED_HEADER, UNION_LAYOUT_KEY_UNVERSIONED);
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
    },
  )

  /**
   * KAR-15.6 AC1 — `GET /api/runs/:id/plans`: the plan-evolution scrubber's
   * version rail (docs/11-api-and-realtime.md §6).
   *
   * One row per version, in version order, each carrying the `seq` that
   * proposed it and — joined from `plan.patched`/`plan.patch.proposed` — the
   * `decision` and the verbatim `reason` behind it. `null` for both on a
   * version with no patch behind it, which is what v1's initial compile is.
   *
   * A grouped, bounded statement rather than a fold: a nine-hour run with forty
   * replans costs forty rows here and forty thousand folded events the other
   * way, and the scrubber is the first thing the operator opens.
   */
  .get(
    '/runs/:id/plans',
    // Same reason as `/plans/diff` above: the version rail's only caller is the
    // UI, and `limit` belongs in the type it compiles against.
    validator('query', (value) => ({
      limit: typeof value.limit === 'string' ? value.limit : undefined,
    })),
    (c) => {
      const found = resolveRun(c);
      if ('response' in found) return found.response;

      const limit = boundedLimit(c.req.valid('query').limit, READ_LIMITS.plans);
      c.header(LIMIT_HEADER, String(limit));

      return c.json(
        found.view.planVersions(found.runId, limit).map((row) => {
          const transition = found.view.planTransition(found.runId, row.version);
          return {
            version: row.version,
            seq: row.seq,
            planHash: row.planHash,
            decision: transition?.decision ?? null,
            reason: transition?.reason ?? null,
          };
        }),
        200,
      );
    },
  )

  /**
   * KAR-15.6 AC1 — `GET /api/runs/:id/plans/:version`: the immutable plan
   * document that version names.
   *
   * Registered **after** `/plans/diff` so the literal path wins over the
   * parameter, and cacheable forever because the document is addressed by a
   * content hash: version 3 of a run's plan is the same bytes for as long as
   * the ledger exists, so `immutable` is a statement of fact rather than an
   * optimisation.
   */
  .get('/runs/:id/plans/:version', (c) => {
    const found = resolveRun(c);
    if ('response' in found) return found.response;

    const version = parseVersion(c.req.param('version'));
    const document = version === null ? null : found.view.planVersion(found.runId, version);
    if (document === null) {
      return c.json(
        ...apiError('plan_version_not_found', 'this run never proposed a version numbered that', {
          detail: { version: c.req.param('version') },
        }),
      );
    }

    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.json(document, 200);
  })

  /**
   * KAR-15.6 AC3 — `GET /api/runs/:id/nodes/:nodeId?attempt=`: F10.3's
   * inspector bundle.
   *
   * One object rather than four endpoints, because the panel renders once: the
   * scheduling decision (provider, model, permission, worktree), the binary
   * that produced the output, the wall clock, the accounting and the retry
   * count are all answers to *"what happened at this node"*, and a view that
   * had to join them would show four loading states.
   */
  .get('/runs/:id/nodes/:nodeId', (c) => {
    const found = resolveNode(c);
    if ('response' in found) return found.response;

    return c.json(
      nodeBundle({
        runId: found.runId,
        nodeId: found.nodeId,
        attempt: attemptOf(c, found.node),
        node: found.node,
        budget: found.state.budget,
        timing: found.view.nodeTiming(found.runId, found.nodeId),
        binaryVersion: probedVersion(found.view, found.node.provider),
      }),
      200,
    );
  })

  /**
   * KAR-15.6 AC3 — `GET /api/runs/:id/nodes/:nodeId/packet?attempt=`: the
   * assembled `ContextPacket`, with per-segment token counts.
   *
   * Served **from the stored `context.built` manifest** and re-derived in no
   * respect. The sum assertion in EPIC-15-S42 is a Playwright smoke for a
   * reason: a breakdown that does not add up to its header is the visible
   * symptom of the packet being recomputed from the rendered prompt, which
   * makes the inspector explain a prompt the agent was never given.
   *
   * Segment `text` is not on the wire — the text of every segment *is* the
   * prompt. `renderedPromptHandle` and each `contentHash` are how a client
   * fetches the bytes, through `GET /api/artifacts/:sha`.
   */
  .get('/runs/:id/nodes/:nodeId/packet', (c) => {
    const found = resolveNode(c);
    if ('response' in found) return found.response;

    const attempt = attemptOf(c, found.node);
    const record = found.view.contextPacket(found.runId, found.nodeId, attempt);
    if (record === null) {
      return c.json(
        ...apiError('not_found', 'no context packet was built for that node attempt', {
          detail: { node: found.nodeId, attempt },
        }),
      );
    }

    return c.json(packetView(record), 200);
  })

  /**
   * KAR-15.6 AC4, AC11 — `GET /api/runs/:id/nodes/:nodeId/io`: the terminal
   * reattach, as `application/x-ndjson`.
   *
   * **`fromSeq` omitted plus `limit` set means the tail.** That is the case a
   * tab opening on a node with 200 MB of output is in, and it is why there are
   * two queries rather than one: paging forward from zero to reach the end
   * reads the whole log to answer *"what are the last few hundred lines"*.
   * `fromSeq` set pages forward from that cursor, deterministically, with
   * `seq > fromSeq` — never `>=`, because `io_chunk.seq` is `AUTOINCREMENT`
   * and pruning leaves permanent gaps.
   *
   * The framing is deliberately outside the versioned contract (AC11); the
   * `X-DeFlow-Unversioned` header says so on every response, and the stable
   * archive is `runs/<runId>/nodes/<nodeId>/stdout.log`.
   */
  .get('/runs/:id/nodes/:nodeId/io', (c) => {
    const found = resolveNode(c);
    if ('response' in found) return found.response;

    const attempt = attemptOf(c, found.node);
    const limit = boundedLimit(c.req.query('limit'), READ_LIMITS.io);
    // The translation `../exec/ledger-sink.ts` owns on the write side, applied
    // once here on the read side: the data plane counts attempts from 1 and
    // the event envelope counts from 0. Getting it wrong does not fail — it
    // silently serves the output of the attempt this one replaced, which is
    // invisible until somebody reads a transcript.
    const selector = { runId: found.runId, nodeId: asNodeId(found.nodeId), attempt: attempt + 1 };
    const fromSeq = c.req.query('fromSeq');
    const page =
      fromSeq === undefined
        ? found.view.ioTail(selector, limit)
        : found.view.ioPage(selector, Math.max(0, Number(fromSeq) || 0), limit);

    // Joined here rather than streamed, and bounded by `limit` rather than by
    // the size of the table: the memory this response costs is the window the
    // caller asked for, whatever the log behind it weighs.
    const body = page.chunks.map((chunk) => ioChunkLine(chunk)).join('');

    c.header('Content-Type', IO_NDJSON_MEDIA_TYPE);
    c.header(LIMIT_HEADER, String(limit));
    c.header(UNVERSIONED_HEADER, IO_NDJSON_UNVERSIONED);
    c.header('X-DeFlow-Io-More', String(page.hasMore));
    return c.body(body, 200);
  })

  /**
   * KAR-15.6 AC5 — `GET /api/runs/:id/facts?key=&by=`: F10.4's memory graph.
   *
   * Provenance travels **on** every fact rather than being joinable from it:
   * *"which node wrote it, from what evidence, at what time, at what
   * confidence"* is the question the view exists to answer, so a second request
   * to answer it would be the view failing at its own job.
   *
   * An invalidated fact is still a row, marked. History is never rewritten, and
   * hiding stale facts would leave a node that read one showing an input from
   * nowhere.
   */
  .get('/runs/:id/facts', (c) => {
    const found = resolveRun(c);
    if ('response' in found) return found.response;

    const limit = boundedLimit(c.req.query('limit'), READ_LIMITS.facts);
    c.header(LIMIT_HEADER, String(limit));

    return c.json(
      factsPage(found.view.facts(found.runId), {
        limit,
        key: c.req.query('key'),
        by: c.req.query('by'),
      }),
      200,
    );
  })

  /**
   * KAR-15.6 AC5 — `GET /api/runs/:id/facts/:factId/consumers`.
   *
   * One indexed `GROUP BY` over `fact_edges_by_fact`, computed in SQLite. The
   * `direction = 'read'` clause is what excludes the writer and it is in the
   * `WHERE` rather than applied afterwards: filtering in JavaScript would read
   * every edge of the run to answer a question about one fact.
   */
  .get('/runs/:id/facts/:factId/consumers', (c) => {
    const found = resolveRun(c);
    if ('response' in found) return found.response;

    const limit = boundedLimit(c.req.query('limit'), READ_LIMITS.consumers);
    c.header(LIMIT_HEADER, String(limit));

    return c.json(found.view.factConsumers(asFactId(c.req.param('factId')), limit), 200);
  })

  /**
   * KAR-15.6 AC6 — `GET /api/runs/:id/gates`: what each gate node concluded.
   *
   * The projection the ladder itself reads, exposed unchanged. A void verdict
   * leaves no entry (KAR-12.4 AC6) and therefore no row, which is correct:
   * a verdict judged against a spec nobody approved is not evidence about this
   * contract, and a row for it would read as an answered gate.
   */
  .get('/runs/:id/gates', (c) => {
    const found = resolveRun(c);
    if ('response' in found) return found.response;

    const limit = boundedLimit(c.req.query('limit'), READ_LIMITS.gates);
    c.header(LIMIT_HEADER, String(limit));

    return c.json(gatesView(found.state.gateVerdicts).slice(0, limit), 200);
  })

  /**
   * KAR-15.6 AC6 — `GET /api/runs/:id/findings?file=`: findings grouped by
   * file, ordered by line.
   *
   * Grouped on the server because the annotation layer draws per file, and
   * ordered by line because it draws top to bottom; a client re-sorting a flat
   * list is a client that will eventually sort it differently from the next
   * client. A finding with no location keeps its own group, last — dropping it
   * would hide the judgements that are about the change as a whole, which are
   * the ones that matter most.
   */
  .get('/runs/:id/findings', (c) => {
    const found = resolveRun(c);
    if ('response' in found) return found.response;

    const limit = boundedLimit(c.req.query('limit'), READ_LIMITS.findings);
    c.header(LIMIT_HEADER, String(limit));

    const groups = findingsByFile(found.state.gateVerdicts, c.req.query('file'));
    // Bounded across groups rather than within one, so a single file with ten
    // thousand lint errors cannot make this response unbounded.
    let budget = limit;
    const bounded = [];
    for (const group of groups) {
      if (budget <= 0) break;
      bounded.push({ file: group.file, findings: group.findings.slice(0, budget) });
      budget -= group.findings.length;
    }
    return c.json(bounded, 200);
  })

  /**
   * KAR-15.6 AC6 — `GET /api/runs/:id/criteria`: F7.4's acceptance board.
   *
   * Driven by the spec's criteria rather than by the verdicts, so a criterion
   * nothing has judged appears as `pending` rather than not appearing at all —
   * and every constraint gets a row of its own, because a board built from
   * `acceptanceCriteria` alone is silent about the prohibitions while every
   * gate reads green.
   *
   * `sealTaskSpec` is what turns the latest amended *draft* into the contract
   * now in force; a run nobody has amended is judged against `run.created.spec`.
   */
  .get('/runs/:id/criteria', async (c) => {
    const found = resolveRun(c);
    if ('response' in found) return found.response;

    const spec = await currentSpec(found.view, found.runId);
    if (spec === null) {
      return c.json(
        ...apiError('not_found', 'this run has no TaskSpec yet, so it has no criteria', {
          detail: { runId: found.runId },
        }),
      );
    }

    return c.json(
      acceptanceBoard({
        criteria: spec.acceptanceCriteria,
        constraints: spec.constraints,
        verdicts: boardVerdicts(found.view, found.runId, READ_LIMITS.gates.cap),
        specHash: spec.specHash,
      }),
      200,
    );
  })

  /**
   * KAR-15.6 AC6 — `GET /api/runs/:id/diff?node=|worktree=|cumulative=1`, as
   * `text/x-patch`.
   *
   * Produced by **git**, never assembled here. A patch composed by string
   * concatenation renders convincingly in a diff viewer and applies to nothing,
   * and the only thing that can tell the two apart is `git apply`
   * (`../../test/integration/run-diff-api.test.ts` makes git the judge).
   *
   * The three selectors are mutually exclusive rather than defaulted, because
   * *"the diff"* means three different things and a caller that got the wrong
   * one would have no way to notice: `node` is one node's worktree, `worktree`
   * names one directly, and `cumulative=1` is the repository the run was
   * created against, diffed from the commit it started at — which is the only
   * one of the three that answers *"what has this run done in total"*.
   *
   * A `worktree` this run never held is refused. The daemon is bearer-token
   * protected, but the agents it spawned are inside that boundary
   * (docs/15-security-model.md §3), and an endpoint that would run
   * `git -C <anything>` is a repository reader with a different name.
   */
  .get('/runs/:id/diff', async (c) => {
    const found = resolveRun(c);
    if ('response' in found) return found.response;

    const target = diffTarget(c, found.view, found.runId, found.state);
    if ('response' in target) return target.response;

    const patch = await worktreePatch(target.dir, target.base);
    if (patch === null) {
      return c.json(
        ...apiError('internal', 'git could not produce a diff for that worktree', {
          detail: { dir: '<worktree>' },
        }),
      );
    }

    c.header('Content-Type', 'text/x-patch; charset=utf-8');
    return c.body(patch, 200);
  })

  /**
   * KAR-15.6 AC7 — `GET /api/artifacts/:sha`, and `HEAD` beside it.
   *
   * Content addressing is what makes both of these safe. The bytes behind a
   * sha256 cannot change, so `immutable` is a fact rather than a gamble, and a
   * `Range` fetched in pieces cannot be stitched together out of two different
   * versions of a file.
   *
   * `Accept-Ranges: bytes` is on every response including the `HEAD`, because
   * that is how a client discovers it may ask for a slice at all.
   */
  .get('/artifacts/:sha', (c) => serveArtifact(c, 'GET'))
  .on('HEAD', '/artifacts/:sha', (c) => serveArtifact(c, 'HEAD'))

  /**
   * KAR-15.6 AC8 — `GET /api/providers`: the adapters this machine has, with
   * the versions and capability manifests the probe recorded.
   *
   * Read out of the `provider_capabilities` history rather than re-probed: a
   * `GET` that spawned five vendor binaries would be a `GET` with side effects,
   * and the probe is keyed on (provider, version, binary sha256) precisely so
   * that the answer is a fact about this machine that survives a restart.
   * A provider nothing has probed is reported as `installed: false` rather than
   * omitted — *"gemini is not installed"* is the answer the operator needs.
   */
  .get('/providers', (c) => {
    const view = ledgerView();
    if (view === null) return notReady(c);

    return c.json(
      Object.keys(PROVIDER_SPECS).map((provider) => {
        // The newest row, not the oldest: the history is ordered oldest first,
        // and "what is installed now" is its last entry (see `probedVersion`).
        const row = view.providerCapabilities(provider).at(-1);
        if (row === undefined) {
          return {
            provider,
            installed: false,
            version: null,
            binarySha256: null,
            probedAt: null,
            capabilities: null,
          };
        }
        return {
          provider,
          installed: true,
          version: row.version,
          binarySha256: row.binarySha256,
          probedAt: row.probedAt,
          // The entire `initialize` response, unmodified — the manifest is the
          // vendor's own answer and DeFlow never paraphrases it.
          capabilities: JSON.parse(row.capsJson) as unknown,
        };
      }),
      200,
    );
  })

  /**
   * KAR-15.6 AC8 — `POST /api/providers/doctor`: re-probe, then run the
   * conformance battery.
   *
   * A `POST` because it is the one provider route with effects: it spawns
   * every recorded vendor binary, records whatever the probe found, and drives
   * real turns against each one. `GET /providers` reads the manifest and this
   * is what *writes* it, which is why the two are different verbs on different
   * paths rather than a `?refresh=1`.
   *
   * `../providers/doctor.ts` owns the work and is single-flight, so a
   * double-clicked button joins the run already in progress rather than
   * starting a second set of children. The response is one row per provider
   * with both halves of the answer — the row the re-probe recorded, and the
   * battery's per-assertion result including the skips and their reasons.
   */
  .post('/providers/doctor', async (c) => {
    // The write-side ports, because this route writes: the manifest row and
    // the `provider.probed` event both go through the daemon's one writer.
    const ports = intakePorts();
    if (ports === null) return notReady(c);

    return c.json(
      await runProviderDoctor({
        db: ports.db,
        clock: ports.clock,
        dataDir: ports.dataDir,
        epoch: ports.epoch,
        // The session the probe's own events hang off. A probe belongs to no
        // run and still has to be attributable (NF10); nothing appends
        // `run.created` for it, so it never becomes a run.
        runId: mintRunId(ports.clock.now(), ports.randomHex),
      }),
      200,
    );
  })

  /**
   * KAR-15.6 AC8 — `GET /api/config?cwd=`: `.DeFlow/config.yaml` as JSON.
   *
   * `cwd` names the workspace, and it is checked against the repositories this
   * ledger actually holds runs for rather than taken as given: the daemon is
   * bearer-token protected, but the agents it spawns are inside that boundary,
   * and a config endpoint that read any path on the machine would be a file
   * reader with a different name.
   */
  .get('/config', (c) => {
    const root = workspaceRoot(c);
    if ('response' in root) return root.response;

    return c.json({ cwd: root.cwd, config: loadWorkspaceConfig(root.cwd) }, 200);
  })

  /**
   * KAR-15.6 AC8 — `PATCH /api/config?cwd=`: a shallow merge, validated before
   * it is written.
   *
   * Validated rather than trusted, because §13's highest-severity configuration
   * risk is a value the operator believes is in force and is not: writing a
   * `pinReinjectTurns` of `nope` would leave the file unreadable and the
   * default silently in effect. A rejected patch changes nothing on disk.
   */
  .patch('/config', async (c) => {
    const root = workspaceRoot(c);
    if ('response' in root) return root.response;

    const body: unknown = await c.req.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json(
        ...apiError('invalid_request', 'the body is a JSON object of config keys to set', {
          detail: { field: '<root>' },
        }),
      );
    }

    const merged = { ...loadWorkspaceConfig(root.cwd), ...(body as Record<string, unknown>) };
    let validated: unknown;
    try {
      validated = parseDeFlowConfig(merged);
    } catch (error) {
      return c.json(
        ...apiError('schema_violation', 'that is not a valid .DeFlow/config.yaml', {
          detail: { reason: error instanceof Error ? error.message : String(error) },
        }),
      );
    }

    writeWorkspaceConfig(root.cwd, validated);
    return c.json({ cwd: root.cwd, config: validated }, 200);
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
   * The control-plane stream (KAR-15.3).
   *
   * The body lives in `./stream.ts` — the serving loop is a two-phase drain
   * with a park, a keepalive and a fatal path, and it is the largest single
   * thing in this file's neighbourhood — but the route stays *on this chain*,
   * because `hc<ApiType>` infers the client from the type of the chained
   * expression and a route registered on its own statement is invisible to it.
   */
  .get('/stream', (c) => serveStream(c))

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
