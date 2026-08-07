/**
 * KAR-05.1 AC7 — the adapter's failure vocabulary.
 *
 * Adapter code never uses a thrown `Error` as its failure surface. It throws
 * `NodeFailureError`s tagged with a `reason` from the closed taxonomy and a
 * `class` chosen by the code that knows the situation, and every one of them
 * leaves through `toAdapterFailure` — one function, one boundary, one shape in
 * the ledger (docs/04-domain-model.md §8).
 *
 * Why tags rather than a lookup table on the way out: `class` is not derivable
 * from `reason`. A spawn that failed with `ENOENT` is permanent and one that
 * failed with `EMFILE` is transient, and only the code holding the errno knows
 * which. `@DeFlow/core`'s `toNodeFailure` already recognises a Node spawn
 * error structurally, so `spawnRefused` hands it the original rather than
 * re-deciding the class here.
 */
import type { NodeFailure, ProviderId, RateLimit, ToNodeFailureContext } from '@DeFlow/core';
import {
  NodeFailureError,
  rateLimitFailureTag,
  rateLimitMessage,
  rateLimitResetsAt,
  toNodeFailure,
} from '@DeFlow/core';
import * as acp from '@agentclientprotocol/sdk';
import type { FrameTooLargeReport } from './frame-guard.ts';

/**
 * The wire version DeFlow negotiates: the **integer** `1`, read from the SDK
 * rather than written down here.
 *
 * MCP's protocol version is a date string (`'2025-11-25'`). The two look
 * similar, are not, and a shared negotiation helper is the obvious mistake —
 * docs/07-provider-adapter-layer.md §2.2 forbids it, and
 * `test/adapter-shape.test.ts` keeps this the only place the number is stated.
 */
export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION;

/**
 * The agent answered `initialize` with a version DeFlow does not speak.
 *
 * Permanent, and never downgraded: a client that believes it negotiated
 * version 2 and is silently answered in version 1 finds out at the first frame
 * whose shape changed, arbitrarily far from the handshake. The offered value
 * is recorded exactly as it arrived — including a date-shaped string, which is
 * a bug worth being able to read back verbatim.
 */
export function handshakeMismatch(offered: unknown): NodeFailureError {
  return new NodeFailureError(
    `the agent answered initialize with protocolVersion ${JSON.stringify(offered)}; ` +
      `DeFlow speaks ACP protocol version ${ACP_PROTOCOL_VERSION} and does not downgrade`,
    {
      reason: 'adapter.handshake-failed',
      class: 'permanent',
      detail: { offered: offered as never, expected: ACP_PROTOCOL_VERSION },
    },
  );
}

/**
 * The child never started.
 *
 * The original `Error` is kept as the `cause` so the errno reaches
 * `toNodeFailure`'s spawn recogniser, which is what decides transient versus
 * permanent. Re-wrapping it into a tag here would throw that away and make
 * every spawn failure permanent.
 */
export function spawnRefused(path: string, cause: unknown): unknown {
  if (cause instanceof Error) {
    // Same object, one field richer: the recogniser reads `code`/`syscall`
    // off the thrown value, and a copy would need them copied too.
    return Object.assign(cause, {
      message: `${path} could not be spawned: ${cause.message}`,
    });
  }
  return new NodeFailureError(`${path} could not be spawned`, {
    reason: 'adapter.spawn-failed',
    class: 'permanent',
    detail: { path },
  });
}

/**
 * Nothing at any searched location is an executable file (KAR-05.3 AC4).
 *
 * Permanent, and deliberately *not* a raw `ENOENT`: the errno alone names
 * neither the vendor nor the paths, so the operator reading it in the ledger
 * three hours later cannot tell whether the CLI is missing, installed
 * somewhere DeFlow was not told about, or present without an execute bit. Each
 * candidate keeps its own errno for the same reason — an install and a `chmod`
 * are different fixes.
 */
export function resolutionFailed(
  provider: string,
  bin: string,
  searched: readonly { readonly path: string; readonly code: string }[],
): NodeFailureError {
  const where =
    searched.length === 0
      ? 'no location was configured to search'
      : `${searched.length} location${searched.length === 1 ? '' : 's'} searched`;
  return new NodeFailureError(
    `${provider}: no executable "${bin}" found — ${where}. DeFlow resolves every vendor binary ` +
      "from a configured location and never from PATH, because DeFlowd's PATH is not the user's " +
      'login-shell PATH',
    {
      reason: 'adapter.spawn-failed',
      class: 'permanent',
      detail: { provider, bin, searched: searched as never },
    },
  );
}

/**
 * The vendor CLI rejected the argv DeFlow invoked it with (KAR-05.3 AC5).
 *
 * Permanent: the same build of the same binary parses the same argv the same
 * way on the next attempt, and where a flag is mid-deprecation the one
 * fallback has already been spent by the time this is constructed. `stderr` is
 * the tail the child actually printed, which is what makes a flag rename
 * readable in the ledger rather than a guess.
 */
export function argvRejected(
  provider: string,
  attempts: readonly (readonly string[])[],
  stderr: string,
  exit: { readonly code: number | null; readonly signal: string | null },
): NodeFailureError {
  const tried = attempts.map((argv) => (argv.length === 0 ? '(no arguments)' : argv.join(' ')));
  return new NodeFailureError(
    `${provider} rejected the invocation DeFlow uses (tried ${tried.join(' then ')}) and exited ` +
      `with code ${exit.code ?? 'null'}; its flag surface has moved and the registry entry needs ` +
      're-verifying against --help',
    {
      reason: 'adapter.spawn-failed',
      class: 'permanent',
      detail: { provider, attempts: tried, stderr: stderr.slice(-2048), exitCode: exit.code },
    },
  );
}

/**
 * The registry was asked for an invocation it does not have — an argv variant
 * past the last one, or an adapter's environment without the companion binary
 * that environment exists to point at.
 */
export function registryRefused(
  message: string,
  detail: Record<string, unknown>,
): NodeFailureError {
  return new NodeFailureError(message, {
    reason: 'adapter.spawn-failed',
    class: 'permanent',
    detail,
  });
}

/**
 * KAR-05.8 AC3 — the exec shim was asked for an output format this vendor
 * does not have.
 *
 * Raised at **construction**, before a process exists, and that is the whole
 * assertion: a shim that assumes one streaming format across vendors would
 * emit the flag, spawn, and learn from a stderr line and a non-zero exit —
 * having spent a spawn to discover something the invocation table already
 * knew. Permanent, because the same build of the same binary parses the same
 * flag the same way on the next attempt.
 *
 * The supported set is in the message, spelled the way the vendor's own
 * `--help` spells it, so the operator reading the ledger can tell "DeFlow
 * asked for the wrong thing" from "the vendor dropped a format".
 */
export function unsupportedOutputFormat(
  provider: string,
  requested: string,
  supported: readonly string[],
): NodeFailureError {
  return new NodeFailureError(
    `${provider} has no --output-format ${requested}; it supports ${supported.join('|')}. ` +
      'The exec shim refuses at construction rather than emitting a flag the vendor will ' +
      'reject, because a spawn is not the cheapest way to read a table DeFlow already has',
    {
      reason: 'adapter.spawn-failed',
      class: 'permanent',
      detail: { provider, requested, supported: [...supported] },
    },
  );
}

/**
 * KAR-05.8 — the vendor's flags cannot express the permission level this node
 * was planned at.
 *
 * On the shim path DeFlow is not in front of the agent's file access, so the
 * vendor's own flag is the only enforcement there is. Where there is no flag
 * for the level, the honest answer is to refuse to schedule the node — the
 * alternative is picking the nearest flag and running at a level nobody chose,
 * which is the silent escalation F5.4 exists to prevent.
 *
 * `safety.permission-unschedulable`, matching what `admit` returns for the
 * same situation reached from the capability row: one reason, whether the
 * refusal came from the manifest or from the flag table.
 */
export function permissionInexpressible(
  provider: string,
  permission: string,
  expressible: readonly string[],
): NodeFailureError {
  return new NodeFailureError(
    `${provider} has no flag that expresses permission level ${permission} ` +
      `(it can express: ${expressible.join(', ')}), so DeFlow refuses to schedule the node ` +
      'rather than invoking it at whatever level the vendor happens to default to',
    {
      reason: 'safety.permission-unschedulable',
      class: 'permanent',
      detail: { provider, permission, expressible: [...expressible] },
    },
  );
}

/**
 * KAR-08.5 AC5 — a sandbox prerequisite is not installed, so the level cannot
 * be enforced.
 *
 * **The node does not start.** Claude Code's own behaviour without
 * `failIfUnavailable: true` is to fall back to running *unsandboxed*, silently
 * — and a run in which nothing looks wrong and nothing is enforced is worse
 * than a run that refused. So this fires before a process exists, and names
 * the dependency in the form somebody can install (`bubblewrap (bwrap)`, not
 * `bwrap`).
 *
 * Permanent: a second spawn finds the same `PATH` with the same gap in it.
 *
 * **The reason is `safety.permission-unschedulable`, and the cause is in the
 * detail.** EPIC-08-S21 words the scenario as a `node.failed` carrying
 * `sandbox-unavailable`, and that is what `detail.cause` says — but the reason
 * taxonomy is a closed union embedded in the shipped, content-hash-pinned
 * `DeFlow.plangraph.v1` schema (KAR-02.8, `schemas/CHANGELOG.md`), so adding a
 * member to it is a `.v2` publication and a plan change, not a line in this
 * story. The existing member is the right one on the merits anyway: "the
 * provider cannot express the requested level" and "this machine cannot
 * enforce the requested level" are the same refusal, and the scheduler reads
 * `class` regardless. `cause` is what the node inspector renders and what
 * `docs/03-local-development.md`'s troubleshooting row is keyed on.
 */
export const SANDBOX_UNAVAILABLE_CAUSE = 'sandbox-unavailable';

export function sandboxUnavailable(
  dependency: string,
  displayName: string,
  ctx: { readonly platform: string; readonly permission: string; readonly searched: number },
): NodeFailureError {
  return new NodeFailureError(
    `${displayName} is required to enforce permission level ${ctx.permission} on ${ctx.platform} ` +
      `and was not found in any of the ${ctx.searched} directories on the resolved PATH; the node ` +
      'is refused rather than run unsandboxed',
    {
      reason: 'safety.permission-unschedulable',
      class: 'permanent',
      detail: {
        cause: SANDBOX_UNAVAILABLE_CAUSE,
        dependency,
        platform: ctx.platform,
        permission: ctx.permission,
      },
    },
  );
}

/**
 * A POSIX-only process operation, reached on Windows (KAR-05.9 AC5).
 *
 * Not a `NodeFailureError`, and deliberately not routed through
 * `toAdapterFailure`: this is not a node that failed, it is a daemon running
 * somewhere it cannot supervise a process tree at all. Windows has no process
 * groups — the path there is `taskkill /PID <pid> /T /F`, it was never tested,
 * and the POSIX result does not transfer (M3, NF5). The one response a caller
 * must not have is "the kill failed, try again", which is what a tagged
 * transient failure would invite.
 */
export class NotImplementedOnWin32 extends Error {
  /** Which POSIX operation was asked for. */
  readonly operation: string;

  constructor(operation: string) {
    super(
      `${operation} is not implemented on win32. Windows has no process groups: the path there ` +
        'is `taskkill /PID <pid> /T /F`, it has never been tested against a real agent tree, and ' +
        'the POSIX result does not transfer. Windows is M3 (NF5); until then DeFlowd must not ' +
        'claim a kill switch it does not have.',
    );
    this.name = 'NotImplementedOnWin32';
    this.operation = operation;
  }
}

/**
 * A pid that must never be negated and handed to `kill(2)` (KAR-05.9).
 *
 * 0 is the caller's own process group — DeFlowd and every agent it is
 * supervising — 1 is init, and a negative number is already a group, so
 * negating it would signal one process chosen by arithmetic. All three are
 * shapes a corrupt or half-written `process` row takes, and none of them is a
 * group DeFlow ever created. A `RangeError` subclass because that is what it
 * is; named because a bare one is unreadable once it has been serialised.
 */
export class UnsignalablePid extends RangeError {
  readonly pid: number;

  constructor(pid: number) {
    super(
      `killTree refuses pid ${pid}: only a pid DeFlowd spawned can be a process group leader. ` +
        "kill(-0) signals the caller's own process group — DeFlowd and every agent it is " +
        'supervising — and kill(-1) signals every process this user may signal.',
    );
    this.name = 'UnsignalablePid';
    this.pid = pid;
  }
}

/**
 * A line crossed the frame cap (KAR-05.4 AC1).
 *
 * **Permanent, and no recovery is attempted.** A frame that large means the
 * agent is misbehaving rather than merely verbose, and the next attempt would
 * read the same runaway output from the same build of the same binary. By the
 * time this is constructed the session is already being torn down.
 *
 * The first 4 KiB of the offending line rides along on `head` — as bytes,
 * because evidence is what actually arrived. `run-node.ts` turns it into the
 * failure's second evidence handle; it is deliberately not in `detail`, which
 * is JSON that every replay re-reads.
 */
export function frameTooLarge(report: FrameTooLargeReport): NodeFailureError {
  const error = new NodeFailureError(
    `the agent wrote ${report.bytes} bytes with no newline, over the ${report.limit}-byte frame ` +
      'cap; the session was aborted and the agent killed rather than buffered',
    {
      reason: 'adapter.frame-too-large',
      class: 'permanent',
      detail: { bytes: report.bytes, limit: report.limit },
    },
  );
  return Object.assign(error, { head: report.head });
}

/**
 * The agent wrote a complete line that is not JSON at all (conformance
 * assertion 7).
 *
 * A separate reason from `adapter.protocol-error` on purpose:
 * docs/04-domain-model.md §8 gives the two different `class` values and
 * therefore different scheduler decisions, and "not JSON" is the one an
 * adapter mid-release most often produces — a log line written to stdout
 * instead of stderr, or a banner ahead of the first frame.
 *
 * **Permanent, and the session ends.** The SDK's reader drops a line it cannot
 * parse and carries on, which is right for a transport library and wrong here:
 * a dropped frame is a hole in the transcript that the ledger keeps for ever
 * and every replay reproduces, under a node that reported success.
 *
 * The first 4 KiB ride along on `head`, exactly as `frameTooLarge` does it, so
 * `run-node.ts` can attach the bytes that actually arrived.
 */
export function malformedOutput(head: Uint8Array, bytes: number): NodeFailureError {
  const error = new NodeFailureError(
    `the agent wrote a ${bytes}-byte line that is not JSON; the session was torn down rather ` +
      'than continuing with a hole in the transcript',
    {
      reason: 'adapter.malformed-output',
      class: 'permanent',
      detail: { bytes },
    },
  );
  return Object.assign(error, { head });
}

/** The offending frame's first bytes, when `thrown` is a frame-cap abort. */
export function offendingFrameHead(thrown: unknown): Uint8Array | null {
  const head = (thrown as { head?: unknown } | null)?.head;
  return head instanceof Uint8Array ? head : null;
}

/** The shape a recording directory's name must have, quoted in every refusal. */
export const RECORDING_DIR_SHAPE = '<provider>@<version>';

/**
 * `DeFlow_RECORD=1` against a version that is not exact (KAR-05.7 AC6).
 *
 * A `NodeFailureError` and not a bare `Error` for the same reason as every
 * other exit in this package: it travels through `toAdapterFailure` into the
 * ledger, and a stack does not survive `JSON.stringify`, a daemon restart or
 * the node inspector. `adapter.spawn-failed` because it is decided *before*
 * the spawn — a capture that silently landed in a moving directory would look
 * exactly like a good golden until the day the vendor shipped, so the node is
 * refused instead.
 */
export class InvalidRecordingKey extends NodeFailureError {
  constructor(message: string, detail: Record<string, unknown>) {
    super(message, { reason: 'adapter.spawn-failed', class: 'permanent', detail });
    this.name = 'InvalidRecordingKey';
  }
}

/** JSON-RPC's "Method not found", which is how an agent refuses a method. */
export const METHOD_NOT_FOUND_CODE = -32601;

/**
 * Every JSON-RPC error code ACP has already given a meaning to, read off the
 * SDK's own constructors (`@agentclientprotocol/sdk` 1.3.0) rather than
 * written down as literals.
 *
 * It exists for one guard — `undeclarableRateLimitCode` — and the guard exists
 * because of `authRequired`. A caller that declared `-32000` to mean "rate
 * limited" would turn every permanent auth refusal into a `transient` quota
 * and retry it until the attempt budget ran out, which is exactly the
 * conflation KAR-14.4 AC9 forbids. Reading the codes from the SDK means a
 * version that assigns a new one narrows this set without anybody noticing it
 * had to.
 */
export const ACP_ASSIGNED_ERROR_CODES: readonly number[] = Object.freeze([
  acp.RequestError.parseError().code,
  acp.RequestError.invalidRequest().code,
  acp.RequestError.methodNotFound('').code,
  acp.RequestError.invalidParams().code,
  acp.RequestError.internalError().code,
  acp.RequestError.requestCancelled().code,
  acp.RequestError.authRequired().code,
  acp.RequestError.resourceNotFound('').code,
]);

/**
 * KAR-14.4 AC9 — the refusal for a rate-limit code that is not the caller's to
 * declare, or `null` when the declaration is fine.
 *
 * Raised **before the spawn**, beside the frame cap and the recording key and
 * for the same reason: this is a misconfiguration of DeFlow, and the honest
 * moment to say so is before a process exists and before a quota has been
 * spent. Discovering it in a `catch` means the mistake only shows up on the
 * one path where it does damage.
 */
export function undeclarableRateLimitCode(
  provider: ProviderId,
  codes: readonly number[],
): NodeFailureError | null {
  const taken = codes.filter((code) => ACP_ASSIGNED_ERROR_CODES.includes(code));
  if (taken.length === 0) return null;
  return new NodeFailureError(
    `${provider} declares JSON-RPC ${taken.join(', ')} as a rate-limit code, but ACP has already ` +
      'given those codes a meaning — reading one as a quota would classify a permanent refusal as ' +
      "a transient retry and spend the node's whole attempt budget on it. Declare a code from " +
      "JSON-RPC's implementation-defined range that ACP has not taken",
    {
      reason: 'adapter.spawn-failed',
      class: 'permanent',
      detail: { provider, declared: [...codes], assigned: [...ACP_ASSIGNED_ERROR_CODES] },
    },
  );
}

/** What the caller declared about this adapter's rate-limit signal. */
export interface AcpRateLimitContext {
  readonly provider: ProviderId;
  /**
   * The JSON-RPC error codes this adapter is known to answer with when the
   * vendor's quota is exhausted. **Empty by default, and DeFlow ships none.**
   */
  readonly codes: readonly number[];
}

/**
 * KAR-14.4 AC1 — the rate-limit signal on the ACP path, normalised to the same
 * `RateLimit` the shim path produces.
 *
 * **ACP has no rate-limit concept.** Verified against
 * `@agentclientprotocol/sdk` 1.3.0: every code the protocol assigns is a
 * transport or auth condition (`ACP_ASSIGNED_ERROR_CODES`), there is no
 * quota-shaped `session/update`, and no agent method reports remaining
 * headroom. Whether any ACP adapter surfaces rate-limit state *at all* is
 * still **Unverified** — it is one of the two questions roadmap §1's M0 ACP
 * spike is told to answer, and until it does, the honest degradation the epic
 * specifies is "classify and back off with full jitter", which is what an
 * undeclared error already gets.
 *
 * So this function guesses nothing. It reads exactly what the caller declared,
 * exactly as `rateLimitExitCodes` does on the shim path next door, and for the
 * same reason stated there: DeFlow does not invent a rate limit any more than
 * it invents a reset time. An adapter with no declared code produces no
 * `provider.rate_limited` on this path, and that absence is the honest signal
 * — not a `resetsAt` nobody stated.
 *
 * What it *does* normalise, when a declared code arrives:
 *
 *   - `raw` is `{ code, message, data }` verbatim, so a later build re-parses
 *     the vendor's own payload off the ledger without a re-run;
 *   - `resetsAt` is read through core's one converter, from `data.resetsAt` or
 *     from `data.rate_limit_info.resetsAt` — the two places the one verified
 *     vendor spelling could land — and is `null` otherwise;
 *   - the thrown failure carries `rateLimitFailureTag`, so `rateLimitOf` reads
 *     it back and `recordFailure` writes the `node_wake` row in the same
 *     transaction as `node.failed`, identically on both paths.
 */
export function acpRateLimit(
  error: unknown,
  ctx: AcpRateLimitContext,
): { readonly limit: RateLimit; readonly thrown: NodeFailureError } | null {
  if (ctx.codes.length === 0) return null;
  const record = asRecord(error);
  const code = record?.code;
  if (typeof code !== 'number' || !ctx.codes.includes(code)) return null;

  const message = typeof record?.message === 'string' ? record.message : '';
  const data = record?.data;
  const raw = { code, message, data };
  const limit: RateLimit = {
    provider: ctx.provider,
    resetsAt: rateLimitResetsAt(data) ?? rateLimitResetsAt(asRecord(data)?.rate_limit_info),
    raw,
  };
  return {
    limit,
    thrown: new NodeFailureError(rateLimitMessage(limit), rateLimitFailureTag(limit)),
  };
}

/** A JSON-RPC error is an object, and `RequestError` is one too — reading it
 * structurally is what makes the wire shape and the SDK's class the same input. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** `true` when `error` is a JSON-RPC `-32601`, however it was constructed. */
export function isMethodNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === METHOD_NOT_FOUND_CODE;
}

/**
 * The agent advertised a capability and then answered its method with
 * `-32601` (EPIC-05-S27).
 *
 * **`adapter.capability-missing`, not `adapter.protocol-error`.** The probed
 * row is the single input the entire routing layer trusts, and this is the
 * failure that says that input was wrong — which is a different fact, with a
 * different fix, from an agent that garbled a frame.
 *
 * **Permanent, and DeFlow does not downgrade.** Falling back to the replay
 * strategy on the first `-32601` would paper over the dishonesty and let a
 * broken adapter keep making routing promises it cannot keep; a row that lies
 * about one thing cannot be trusted about the rest. The failure is surfaced,
 * and re-routing is an explicit `PlanPatch` (EPIC-11).
 *
 * The message names both halves of the pairing, because the code alone does
 * not say which promise was broken.
 */
export function advertisedButUnimplemented(
  capability: string,
  method: string,
  path: string,
): NodeFailureError {
  return new NodeFailureError(
    `the agent advertised "${capability}" (${path}) and then answered ${method} with JSON-RPC ` +
      `${METHOD_NOT_FOUND_CODE} Method not found; the capability row DeFlow routed from is wrong, ` +
      'and DeFlow does not silently fall back to another strategy on a manifest it cannot trust',
    {
      reason: 'adapter.capability-missing',
      class: 'permanent',
      detail: { capability, method, path },
    },
  );
}

/** The agent broke the protocol in a way the session cannot continue past. */
export function protocolError(message: string, detail?: Record<string, unknown>): NodeFailureError {
  return new NodeFailureError(message, {
    reason: 'adapter.protocol-error',
    class: 'permanent',
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * The agent stopped answering: no stop frame inside the cancellation grace
 * window, measured on the injected `Clock`.
 *
 * Transient, because a wedged process is a property of this attempt and not of
 * the binary — the next attempt gets a fresh one.
 */
export function agentTimedOut(message: string, detail?: Record<string, unknown>): NodeFailureError {
  return new NodeFailureError(message, {
    reason: 'timeout',
    class: 'transient',
    ...(detail === undefined ? {} : { detail }),
  });
}

/** The agent exited before the turn finished. */
export function agentExited(code: number | null, signal: string | null): NodeFailureError {
  return new NodeFailureError(
    `the agent exited mid-turn (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
    {
      reason: 'agent.nonzero-exit',
      class: 'transient',
      detail: { code, signal },
    },
  );
}

/**
 * The one exit from "something threw" to "the ledger has a value".
 *
 * A thin, named pass-through to `@DeFlow/core`'s mapper rather than a second
 * mapper: this package's job is to make sure everything it raises arrives here
 * already tagged, and to give the adapter one importable name so a reviewer can
 * grep for the boundary.
 */
export function toAdapterFailure(thrown: unknown, ctx: ToNodeFailureContext): NodeFailure {
  return toNodeFailure(thrown, ctx);
}
