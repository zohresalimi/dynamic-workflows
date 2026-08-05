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
