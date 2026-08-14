/**
 * KAR-05.6 AC1 — the `mcpServers` entry DeFlowd puts in every `session/new`.
 *
 * `McpServer` is a four-way union in the ACP schema:
 * `{type:"http"}` | `{type:"sse"}` | `{type:"acp"}` | `McpServerStdio`. The
 * stdio arm is the **untagged default** — no `type` key at all — and it is the
 * only one that needs no capability flag, which is why all five probed agents
 * accept it. The other three are each wrong for a specific reason recorded in
 * `test/mcp-transport-choice.test.ts`: `acp` was advertised by nobody, `sse` is
 * deprecated as of the 2026-07-28 MCP spec, and `http` would bind a port a UDS
 * makes unnecessary.
 *
 * `command` is `process.execPath` and not `"node"`: DeFlowd's `PATH` is not the
 * user's login-shell `PATH`, and the shim has to run on the *same* Node as the
 * daemon that wrote the socket it is about to open.
 *
 * Injecting here rather than writing `~/.claude.json` is the whole of AC2. The
 * user's global MCP configuration is theirs; a run that mutated it would leave
 * DeFlow's tools pointed at a dead socket the moment the run ended.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';

/** The name the agent sees the tool namespace under. */
export const MCP_SERVER_NAME = 'DeFlow';

/** The one-time, run-scoped credential the shim presents on the socket. */
export const RUN_TOKEN_ENV = 'DeFlow_RUN_TOKEN';

/**
 * The `deflow-mcp` entry point, absolute.
 *
 * A second bin of the published `deflow` package (docs/07-provider-adapter-layer.md
 * §7.2); it lives here because the MCP SDK is @DeFlow/daemon's dependency and
 * nobody else's. EPIC-18's bundler is what turns this path into the published
 * `dist/` one — resolved from `import.meta.url` rather than from `cwd` so it
 * survives that move without a lookup.
 */
export const DEFLOW_MCP_ENTRY = fileURLToPath(new URL('../../bin/mcp.ts', import.meta.url));

export interface McpServerEntryOptions {
  /** The shim's entry point. Defaults to `DEFLOW_MCP_ENTRY`. */
  readonly entry?: string;
  readonly socketPath: string;
  readonly runId: string;
  readonly token: string;
}

/**
 * The untagged stdio `McpServer` entry, ready to go into `session/new`.
 *
 * Typed as `McpServerStdio` and not as the `McpServer` union: the union's
 * other three arms are the ones this function exists to not return, and a
 * caller that had to narrow it before reading `command` would be narrowing a
 * decision that was already made.
 */
export function mcpServerEntry(options: McpServerEntryOptions): acp.McpServerStdio {
  return {
    name: MCP_SERVER_NAME,
    command: process.execPath,
    args: [
      options.entry ?? DEFLOW_MCP_ENTRY,
      '--socket',
      options.socketPath,
      '--run',
      options.runId,
    ],
    env: [{ name: RUN_TOKEN_ENV, value: options.token }],
  };
}
