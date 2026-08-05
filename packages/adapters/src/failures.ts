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
import type { NodeFailure, ToNodeFailureContext } from '@DeFlow/core';
import { NodeFailureError, toNodeFailure } from '@DeFlow/core';
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
