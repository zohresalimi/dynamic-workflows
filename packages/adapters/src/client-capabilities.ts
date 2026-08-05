/**
 * What DeFlow tells an agent it can do, and nothing more
 * (docs/07-provider-adapter-layer.md §2.4).
 *
 * The set is deliberately minimal and deliberately *stated* rather than
 * assembled: an agent reads `clientCapabilities` once, at `initialize`, and
 * every later `fs/*` or `terminal/*` call it makes is gated on what it read.
 * Advertising a capability DeFlow has not wired up produces a request nothing
 * answers, which the agent experiences as a hang rather than as an error.
 *
 * `mcp/*` and `elicitation/*` are absent at M1 for a measured reason:
 * `mcpCapabilities.acp` was not advertised true by a single probed agent
 * (§7), so the code to serve them would be code no agent would ever call.
 *
 * Frozen because this object goes on the wire: a caller that "just added one
 * field" for a test would change the handshake for every provider.
 *
 * The `acp.ClientCapabilities` annotation is load-bearing rather than
 * decorative: `ctx.request('initialize', …)` infers its params from the method
 * literal, and a `clientCapabilities` value that arrives as a *reference*
 * rather than as a fresh object literal only matches the typed overload when
 * it is already the SDK's own type. Without it the call silently resolves to
 * the untyped `request<Response = unknown>` overload and the handshake
 * response comes back as `unknown` — which is how a `protocolVersion` check
 * quietly stops being type-checked.
 */
import type * as acp from '@agentclientprotocol/sdk';

/** The `clientCapabilities` block of every `initialize` request DeFlow sends. */
export const CLIENT_CAPABILITIES: acp.ClientCapabilities = Object.freeze({
  fs: Object.freeze({ readTextFile: true, writeTextFile: true }),
  terminal: true,
});

/**
 * Who the agent thinks it is talking to. Vendors put this in their own logs
 * and in their telemetry, so it is DeFlow's name and DeFlow's version — not
 * the SDK's, which is an artefact version and not a compatibility signal
 * (§2.2).
 */
export const CLIENT_INFO = Object.freeze({ name: 'DeFlow', version: '0.1.0' });
