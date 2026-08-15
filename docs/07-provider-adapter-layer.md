# Provider adapter layer

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This is the highest-churn layer in DeFlow and the one where the research most sharply contradicted the
assumptions in the PRD. Everything below marked **Verified 2026-08-02** was established by installing
the package, probing the live binary, or reading the shipped `dist/`. Everything else is marked
**Unverified** and must not be built on without a spike.

The layer lives in `@DeFlow/adapters` (see [repo layout](./16-repo-layout.md)). It has exactly one job:
turn five heterogeneous vendor binaries into one internal event vocabulary, without ever holding a
credential (AR-1).

---

## 1. Three adapter paths, and which is default

| Path               | Status                                                              | When used                                                                                                                             | PRD  |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **ACP client**     | **Default.** The primary and preferred path.                        | Any agent reachable over the Agent Client Protocol, natively or through a first-party adapter. Today that is all five target vendors. | F3.1 |
| **CLI exec shim**  | Documented fallback, retained permanently — not a temporary bridge. | Agents with no ACP path (Cursor, Goose, Aider), and as a degraded mode when an ACP adapter is broken by a vendor release.             | F3.2 |
| **Direct API SDK** | Opt-in only, never a default.                                       | The user explicitly supplies their own API key (personal or company), or points at a local Ollama/vLLM endpoint for offline work.     | F3.3 |

The ordering is not a preference, it is a consequence. Under ACP, DeFlow sits in the path of every
file access and every command execution as the implementer of `fs/*` and `terminal/*`, which is what
makes the permission ladder a single pure function rather than an N-vendors × M-levels flag matrix
(see [workspace and safety](./09-workspace-and-safety.md)). The exec shim gives up that mediation and
falls back to per-vendor flags; that is the real cost of the fallback, not the parsing.

The direct-API path exists because AR-1 §5.3 requires it as a first-class alternative, but it inverts
the credential posture: on that path DeFlow _does_ handle a key the user handed it. It is therefore
gated behind explicit per-provider configuration, it is never selected by auto-detection, and the UI
must label runs that used it. No package versions for this path were verified on 2026-08-02 —
**Unverified**, and it is scoped to M2, not M1.

---

## 2. The ACP client

### 2.1 Package

```jsonc
// packages/adapters/package.json
"dependencies": {
  "@agentclientprotocol/sdk": "1.3.0"   // EXACT pin, no caret
}
```

**Verified 2026-08-02.** `@agentclientprotocol/sdk@1.3.0`, published 2026-07-21, Apache-2.0, author
Zed Industries, repo `github.com/agentclientprotocol/typescript-sdk`. **Zero runtime dependencies**;
a single peer dependency `zod ^3.25.0 || ^4.0.0`, which is compatible with the MCP SDK's zod peer.
One package implements both the client and the agent side, which is what makes
[`@DeFlow/mock-agent`](#13-the-mock-agent-f37-d17) cheap to build.

**Do not use `@zed-industries/agent-client-protocol`.** **Verified 2026-08-02:** deprecated at v0.4.5
with the npm message _"This package has been renamed to @agentclientprotocol/sdk. Please migrate to
continue receiving updates."_ The project also moved GitHub orgs from `zed-industries` to
`agentclientprotocol`. Any tutorial, cached answer, or note older than roughly late 2025 names the
dead package.

The exact pin (not `^1.3.0`) is warranted: this package went 0.4.5 → 1.3.0 _and_ changed npm scope
_and_ changed GitHub org inside about ten months.

Subpath exports, **verified** from `package.json`: `.`, `./experimental/v2`,
`./experimental/http-client`, `./experimental/ws-client`, `./experimental/server`,
`./experimental/node`, `./schema/schema.json`, `./schema/v2/schema.unstable.json`.

### 2.2 Wire shape

**Verified 2026-08-02** by reading the shipped `dist/` and by sending hand-written frames to five live
agents:

- JSON-RPC 2.0 encoded as **newline-delimited JSON** over the child's stdin/stdout.
- `PROTOCOL_VERSION` is the **integer `1`**, not a date string. All five probed agents returned
  `protocolVersion: 1`.
- Package/release version numbers (`v1.3.0`, `v0.13.6`, …) are artefact versions and are explicitly
  _not_ the compatibility signal. Wire compatibility is determined solely by the negotiated
  `protocolVersion`.

> **Do not share a version-negotiation helper between ACP and MCP.** ACP's `protocolVersion` is an
> integer; MCP's is a date string (`'2025-11-25'`). They look similar and are not.

Transport construction:

```ts
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
);
```

### 2.3 The builder API and the `nextUpdate()` pull loop

Use the modern builder API. The legacy `ClientSideConnection` class is still exported, but the
`Client` interface's `extMethod` / `extNotification` members are marked `@deprecated` in favour of the
builder.

```ts
const result = await acp
  .client({ name: "DeFlow", version: "0.1.0" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
    brokerPermission(ctx.params),
  )
  .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
    fsService.readText(ctx.params),
  )
  .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
    fsService.writeText(ctx.params),
  )
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    await persistCapabilities(provider, init); // §6

    return ctx.buildSession(worktreePath).withSession(async (session) => {
      session.prompt(packet.text);
      for (;;) {
        const m = await session.nextUpdate(); // PULL-based, not a callback
        if (m.kind === "stop") return m.response; // { stopReason }
        await ledger.append(toDeFlowEvent(m.notification)); // safe to await here
      }
    });
  });
```

**`session.nextUpdate()` is the single most important API detail in this document.** It is a pull
loop, not a callback registration, and that difference is load-bearing for durability:

1. **Natural backpressure.** DeFlow does not request the next frame until it has finished with the
   current one. The reader stalls, the OS pipe fills at 64 KiB, and the agent blocks in `write()`.
2. **A legal place to `await` the SQLite append.** The event must be durable before DeFlow asks for
   more; the ledger is the source of truth for resume (see [durable execution](./05-durable-execution.md)).
   A callback-style `Client.sessionUpdate` handler gives you nowhere to do this — awaiting inside a
   flowing-mode handler buffers the rest of the stream in RAM. See §11.

If you take one thing from this layer into the implementation, take the pull loop.

### 2.4 Client methods: what is mandatory, what is optional

**Verified 2026-08-02** from `dist/schema/index.js` (`CLIENT_METHODS`, `AGENT_METHODS`,
`PROTOCOL_METHODS`).

| Method                                                                                              | DeFlow must implement?                            | Notes                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `session/request_permission`                                                                        | **Mandatory**                                     | The permission ladder's entry point. Auto-answered from policy; escalates to the UI only for gated categories. |
| `session/update`                                                                                    | **Mandatory**                                     | The streaming notification channel. Consumed via `nextUpdate()`.                                               |
| `fs/read_text_file`, `fs/write_text_file`                                                           | Optional — gated on `clientCapabilities.fs`       | Only called if DeFlow advertises them.                                                                         |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | Optional — gated on `clientCapabilities.terminal` | Only called if DeFlow advertises `terminal: true`.                                                             |
| `mcp/connect`, `mcp/message`, `mcp/disconnect`                                                      | Not implemented at M1                             | Requires `mcpCapabilities.acp`, which **no agent advertises** (§7).                                            |
| `elicitation/create`, `elicitation/complete`                                                        | Not implemented at M1                             |                                                                                                                |

Agent methods DeFlow calls: `initialize`, `authenticate`, `session/{new,load,prompt,cancel,set_mode,
set_config_option,list,delete,fork,resume,close}`, `providers/{list,set,disable}`, `logout`, `nes/*`,
`document/did*`, plus `$/cancel_request` at the protocol level.

Relevant types, **verified** from `dist/schema/types.gen.d.ts`:

```ts
type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";
type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };
type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
type ToolCallLocation = { path: string; line?: number };
type NewSessionRequest = {
  cwd: string;
  additionalDirectories?: string[];
  mcpServers: McpServer[];
};
```

`ToolKind` maps almost one-to-one onto the permission ladder, and `ToolCallLocation.path` gives
path-scope enforcement _at request time_ rather than as post-hoc detection (F5.3).

### 2.5 Cancellation semantics

Per the spec, a client **should keep accepting `session/update` notifications after sending
`session/cancel`** — the agent flushes its final updates before answering the prompt with
`stopReason: 'cancelled'`. A client that tears down its reader on cancel loses the tail of the turn
and may deadlock waiting for the prompt response. Keep the `nextUpdate()` loop running until you see
the stop frame.

---

## 3. ACP v2: target v1 today, but architect for the removal

**Verified 2026-08-02.** The SDK ships a second, parallel implementation under
`@agentclientprotocol/sdk/experimental/v2` with `PROTOCOL_VERSION = 2` and a schema file literally
named **`schema.unstable.json`**. All five agents probed live negotiate `protocolVersion: 1`; none
offered 2. **Target v1.**

The critical delta, **verified** by diffing `dist/schema/index.js` against `dist/v2/schema/index.js`:
v2's `CLIENT_METHODS` **drops `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
`terminal/output`, `terminal/release`, `terminal/wait_for_exit` and `terminal/kill` entirely.**
What remains client-side in v2 is only `session/request_permission`, `session/update`,
`mcp/{connect,message,disconnect}` and `elicitation/{create,complete}`. Filesystem and terminal access
are being pushed onto MCP. v2 also renames `authenticate` → `auth/login` and `logout` → `auth/logout`,
and drops `session/load` and `session/set_mode` from the agent side.

**The architectural consequence, and it is not optional:**

> Implement fs and terminal as a **transport-neutral service layer with two thin fronts** — one wired
> to the v1 ACP client methods, one exposed as MCP tools. Keep **no business logic** in the ACP
> handlers.

```
@DeFlow/daemon/src/services/
  fs-service.ts         path resolution, workspace-root enforcement, ladder check, ledger events
  terminal-service.ts   allowlist, pty lifecycle, ring buffer, blob spilling, ledger events
  fronts/acp-fs.ts        ~15 lines: unwrap ACP params -> fsService -> wrap ACP result
  fronts/acp-terminal.ts  ~30 lines
  fronts/mcp-fs.ts        ~15 lines: registerTool() -> fsService
  fronts/mcp-terminal.ts  ~30 lines
```

Path sandboxing, workspace-root enforcement, output capture and blob spilling live in the service.
When v2 lands, you re-point the MCP front and delete the ACP one. The split is roughly an hour of
work now and avoids a rewrite of the most security-sensitive code in the daemon.

**Unverified:** the v2 timeline. No announced date was found. Re-check quarterly.

---

## 4. Provider wiring — the load-bearing finding

This inverts the naive assumption, and getting it wrong means building the wrong spawn logic for the
two most important providers.

**Verified 2026-08-02** by running an actual `initialize` handshake against the real binary on a Linux
machine — installed from npm, raw ndjson probe, responses captured.

### 4.1 Native ACP — spawn the vendor binary directly

| Vendor             | Package @ version           | Spawn                                 |
| ------------------ | --------------------------- | ------------------------------------- |
| Gemini CLI         | `@google/gemini-cli@0.53.1` | `<abs>/gemini --acp`                  |
| GitHub Copilot CLI | `@github/copilot@1.0.77`    | `<abs>/copilot --acp`                 |
| OpenCode           | `opencode-ai@1.18.11`       | `<abs>/opencode acp --cwd <worktree>` |

Notes: Gemini's `--experimental-acp` still exists but `--help` marks it _"(deprecated, use --acp
instead)"_ — use `--acp` and fall back to `--experimental-acp` only if argv parsing fails. Copilot's
help text for the flag reads _"Start as Agent Client Protocol server"_. OpenCode's is a **subcommand,
not a flag**.

### 4.2 Adapter required — Claude Code and Codex do NOT speak ACP

**Verified absent** from `claude --help` (v2.1.220) and `codex --help` (v0.146.0) — grepped, zero
hits. The PRD's §4.7 claim that these speak ACP is **contradicted as stated**.

| Vendor              | Adapter package @ version                      | Bin                | Spawn                                    |
| ------------------- | ---------------------------------------------- | ------------------ | ---------------------------------------- |
| Claude Code 2.1.220 | `@agentclientprotocol/claude-agent-acp@0.64.1` | `claude-agent-acp` | `<abs>/claude-agent-acp`                 |
| Codex CLI 0.146.0   | `@agentclientprotocol/codex-acp@1.1.9`         | `codex-acp`        | `CODEX_PATH=<abs>/codex <abs>/codex-acp` |

Both adapters were published **2026-08-02** — the same day they were probed. Very actively maintained.
Both live under the same official `agentclientprotocol` GitHub org as the spec, so they are
first-party-ish, not community forks. Both supersede deprecated Zed-scoped names:
`@zed-industries/claude-code-acp` is deprecated at 0.16.2, `@zed-industries/codex-acp` at 0.16.0, each
with an explicit rename notice.

`codex-acp` honours a **`CODEX_PATH`** environment variable to select the Codex binary. Use it.

### 4.3 Always resolve and store an absolute path

> **Rule.** Resolve every vendor binary to an absolute path at probe time, persist it in the
> capability row, and pass it to the adapter explicitly (`CODEX_PATH`, or argv). Never let the adapter
> search `PATH`.

DeFlowd's `PATH` at daemon-start time differs from the user's login shell — a daemon started by a
login item, a systemd unit, or `npx` inherits a different environment than an interactive terminal.
This is a silent, machine-specific failure that presents as "works for me".

### 4.4 AR-1 in practice

**Verified 2026-08-02:** `claude-agent-acp` returned `"authMethods": []` in its `initialize` response
— it is already authenticated from the user's existing Claude Code credential store and needs nothing
from DeFlow. That is AR-1 working exactly as intended.

Copilot returned an `authMethods` entry carrying an `_meta["terminal-auth"]` block with the literal
`{command, args}` to run for login. **Surface that to the user as a shell command to run themselves.
Never run it on their behalf and never capture its output** (AR-1, NF2).

---

## 5. The capability matrix — a test fixture, not a constant

Measured live from each agent's `initialize` response on 2026-08-02.
`agentCapabilities.sessionCapabilities` and `mcpCapabilities`:

| adapter            | ver     | loadSession | resume  | fork   | list | close | delete | additionalDirectories | mcp.http | mcp.sse | mcp.acp |
| ------------------ | ------- | ----------- | ------- | ------ | ---- | ----- | ------ | --------------------- | -------- | ------- | ------- |
| `claude-agent-acp` | 0.64.1  | yes         | **YES** | YES    | yes  | yes   | yes    | yes                   | yes      | yes     | no      |
| `codex-acp`        | 1.1.9   | yes         | **YES** | no     | yes  | yes   | yes    | yes                   | yes      | `false` | `false` |
| `opencode acp`     | 1.18.11 | yes         | **YES** | YES    | yes  | yes   | no     | no                    | yes      | yes     | no      |
| `copilot --acp`    | 1.0.77  | yes         | **no**  | no     | yes  | no    | no     | no                    | yes      | yes     | no      |
| `gemini --acp`     | 0.53.1  | yes         | **no**  | **no** | no   | no    | no     | no                    | yes      | yes     | no      |

Gemini returned **no `sessionCapabilities` key at all** — only `loadSession: true`. Copilot returned
`sessionCapabilities: { list: {} }` and nothing else.

> **This table is a test fixture to re-probe, never a hardcoded constant.** Two of the five versions
> in it were published the same day they were measured. It will be wrong within a month.

### 5.1 The design rule that follows

**Two of five providers cannot resume at all.** A run must survive crash, restart and laptop sleep for
hours to days (NF4, F4.2). Therefore:

> **DeFlow's own SQLite ledger is the sole source of truth for a run.** Every prompt DeFlow sends must
> be reconstructible from that log alone. `session/resume` is a **token-cost optimisation**, never the
> durability mechanism.

Two strategies behind one interface, selected at runtime from the **probed** capability row (§6), not
from a hardcoded table:

```ts
interface ResumeStrategy {
  resume(runId: RunId, nodeId: NodeId, ctx: AgentCtx): Promise<SessionHandle>;
}

class ResumeNative implements ResumeStrategy {
  /* session/resume; skip re-sending context */
}
class ResumeByReplay implements ResumeStrategy {
  /* session/new + replay packet from the ledger */
}

const strategy = caps.session.resume
  ? new ResumeNative()
  : new ResumeByReplay();
```

`ResumeByReplay` is needed anyway for the CLI exec shim path, so building it costs nothing extra —
which is why the scope cut of "only support resume-capable providers" buys very little (§8.4).

### 5.2 `session/load` is not `session/resume`

`loadSession` is universally `true`, and it is **semantically different**. `session/load` streams the
entire conversation history back at you as `session/update` notifications; `session/resume` does not.
For a days-long run, `session/load` will flood you.

Prefer `resume`. If you must `load`, be ready to discard the replayed notifications you already have —
and **dedupe on your own event ids, not the agent's**.

---

## 6. Capability manifests: derived, never hardcoded (F3.5, F3.6)

DeFlow already performs `initialize`. Persist its **full** response.

```sql
CREATE TABLE provider_capabilities (
  provider       TEXT    NOT NULL,   -- 'claude' | 'codex' | 'gemini' | 'copilot' | 'opencode' | 'mock'
  version        TEXT    NOT NULL,   -- from `--version`, verbatim
  binary_sha256  TEXT    NOT NULL,   -- sha256 of the resolved entry file
  binary_path    TEXT    NOT NULL,   -- ABSOLUTE, as resolved (§4.3)
  caps_json      TEXT    NOT NULL,   -- the entire initialize response, unmodified
  probed_at      INTEGER NOT NULL,   -- ms epoch
  PRIMARY KEY (provider, version, binary_sha256)
) STRICT;
```

Every routing decision reads that row: _can I resume? can I fork? is `terminal` supported? does it
take `mcpCapabilities.acp`? does it advertise `mediatedExecution`?_ The planner (F2.7) must not
schedule a node onto an adapter that cannot honour its requirements, and "cannot" is defined by this
row, not by a constant in the source.

The measured matrix in §5 differs from what the vendor documentation implies. A hardcoded matrix will
be wrong within a month.

### 6.1 Version pinning and the poisoning guard

At session start, record into the event log: the resolved absolute binary path, the verbatim
`--version` output, and the sha256 of the entry file (F3.6).

> **On resume, if the recorded version differs from the current one, refuse by default** and require
> an explicit user opt-in.

Session-file formats and resume semantics are internal vendor details that change without notice.
Resuming a Codex 0.146 session under 0.150 is not a supported operation by anyone. The failure mode is
not a clean error; it is a subtly corrupted context that poisons the rest of a multi-hour run.

---

## 7. MCP host (D9)

DeFlow exposes workflow-level tools — read a `Fact`, pull an artifact by handle, propose a `PlanPatch`
— to every agent regardless of vendor.

**Verified 2026-08-02:** `@modelcontextprotocol/sdk@1.30.0`, published 2026-07-27,
`engines.node >= 18`.

### 7.1 Injection: stdio, via `mcpServers` in `session/new`

**Verified** from the ACP schema, `McpServer` is a four-way union:
`{type:"http", name, url, headers}` | `{type:"sse", name, url, headers}` | `{type:"acp", name,
serverId}` | `McpServerStdio` (`{name, command, args, env}` — the **untagged default variant**, no
`type` discriminant).

**Pick stdio.** The reasoning, all from the live probes:

- stdio is the untagged default and needs **no capability flag**, so all five agents accept it.
- `mcpCapabilities.acp` was **not advertised true by a single agent** (codex-acp explicitly returned
  `acp: false`). The elegant "tunnel MCP over the existing ACP pipe via `mcp/connect` + `mcp/message`"
  path is specified but implemented nowhere.
- Legacy HTTP+SSE is **officially deprecated as of the 2026-07-28 MCP spec**, with a 12-month
  offramp. Do not build on `server/sse.js` or `client/sse.js` even though they still ship in 1.30.0.
- That leaves stdio and Streamable HTTP; stdio avoids binding a port.

```ts
mcpServers: [
  {
    name: "DeFlow",
    command: process.execPath, // the exact node running DeFlowd
    args: [DeFlowMcpEntry, "--socket", socketPath, "--run", runId],
    env: [{ name: "DeFlow_RUN_TOKEN", value: oneTimeToken }],
  },
];
```

Injecting via `session/new` is the ACP-native way to give an agent DeFlow-specific tools **without
touching the user's global MCP config**. That matters: DeFlow must never mutate the user's vendor CLI
configuration.

### 7.2 The `deflow-mcp` bin

Ship `deflow-mcp` as a **second bin in the same published `deflow` package** (see
[repo layout](./16-repo-layout.md)). It is a thin shim: `StdioServerTransport` on one side, a **Unix
domain socket** (named pipe on Windows) back to DeFlowd on the other.

**Use a UDS, not a TCP port.** DeFlowd is already local, and a UDS gets filesystem permissions for
free instead of needing a loopback auth scheme. See [security model](./15-security-model.md).

Server API, **verified** from `dist/esm/server/mcp.d.ts`: `new McpServer(info, opts)`,
`.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, cb)`,
`.registerResource(...)`, `.registerPrompt(...)`, `.connect(transport)`, `.sendToolListChanged()`,
`.sendLoggingMessage(params, sessionId?)`. Transport: `new StdioServerTransport(stdin?, stdout?,
options?)` from `@modelcontextprotocol/sdk/server/stdio.js`.

`.sendToolListChanged()` is worth designing around: when the plan advances and a new phase unlocks new
workflow tools, push the change rather than requiring a new session.

### 7.3 Dependency-weight warning

**Verified:** the MCP SDK is **not** lightweight. Its `dependencies` include `express@^5.2.1`,
`hono@^4.11.4`, `@hono/node-server`, `cors`, `jose@^6.1.3`, `ajv`, `ajv-formats`, `eventsource`,
`pkce-challenge`, `zod-to-json-schema`, `cross-spawn`, `raw-body`, `express-rate-limit`.

For a stdio-only server nearly all of that is dead weight that still lands in `node_modules` and slows
`npx deflowai up` (NF6).

> **Mitigation: import only the deep subpaths** — `@modelcontextprotocol/sdk/server/mcp.js` and
> `@modelcontextprotocol/sdk/server/stdio.js` — so nothing HTTP-related is _loaded_ at runtime. If
> install size becomes a real problem, vendoring a ~200-line stdio-only MCP server is a viable later
> move.

Silver lining: `ajv` arrives transitively, so the JSON Schema validator needed for §12's conformance
layer is free.

### 7.4 Open risk: MCP version skew

**Unresolved contradiction.** The official MCP blog states all four Tier-1 SDKs support the 2026-07-28
spec revision as of release day. But **verified 2026-08-02**: the latest published
`@modelcontextprotocol/sdk` is 1.30.0, published 2026-07-27 — _one day before_ the spec release — and
its `LATEST_PROTOCOL_VERSION = '2025-11-25'` with
`SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`.
Grepping the whole `dist/` for the string `2026-07-28` returns **zero hits**. There is no `next` or
`beta` dist-tag.

Re-check before building anything that depends on the new stateless core, `Mcp-Method` / `Mcp-Name`
routing headers, or the removal of `Mcp-Session-Id`. **DeFlow's stdio transport is unaffected either
way**, which is a further argument for it.

---

## 8. The CLI exec shim fallback (F3.2)

Every flag below was read from the installed binary's own `--help` on 2026-08-02 unless marked
**Unverified**.

### 8.1 Claude Code 2.1.220 (`@anthropic-ai/claude-code`)

`-p/--print`; `--output-format text|json|stream-json`; `--input-format text|stream-json`; `--verbose`;
`--include-partial-messages`; `--replay-user-messages`;
`--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`; `--session-id <uuid>`
(client-chosen — **verified honoured verbatim in every emitted frame**); `-r/--resume [id]`;
`-c/--continue`; `--fork-session`; `--no-session-persistence`; `--mcp-config <...>`;
`--strict-mcp-config`; `--json-schema <schema>`; `--max-budget-usd <amt>`; `--add-dir`; `--tools`;
`--allowedTools` / `--disallowedTools`; `--include-hook-events`; `--agents <json>`; `--settings`;
`--setting-sources`; `--system-prompt` / `--append-system-prompt`; `--fallback-model`;
`--effort low|medium|high|xhigh|max`; `--bg/--background` (+ `claude agents` to manage); `--worktree`;
`--bare`; `--safe-mode`.

> **Gotcha, verified by execution.** `--verbose` is **REQUIRED** alongside
> `-p --output-format stream-json`. Without it the process exits printing
> `Error: When using --print, --output-format=stream-json requires --verbose`. Easy to miss because it
> succeeds fine with `--output-format json`.

> **Churn warning.** `--permission-prompt-tool` is **no longer in `--help`** (grepped, zero hits). Any
> design that routed permission prompts to a hosted MCP tool on this path must be re-verified.

**Verified `stream-json` envelope** — one JSON object per line, every line carrying `session_id` and a
unique `uuid`:

```jsonc
{"type":"system","subtype":"init", ...}
{"type":"system","subtype":"commands_changed"}
{"type":"system","subtype":"post_turn_summary"}
{"type":"active_goal"}
{"type":"assistant","message":{ /* Anthropic Message */ },"parent_tool_use_id":…,"request_id":…}
{"type":"rate_limit_event","rate_limit_info":{ /* incl. resetsAt */ }}
{"type":"result","subtype":"success","is_error":false,"stop_reason":…,"total_cost_usd":…,
 "usage":{…},"modelUsage":{…},"permission_denials":[],"terminal_reason":…,"result":"…"}
```

Two things to design around:

- **Each line's `uuid` is your event-log dedup key.** It is the shim path's equivalent of the ACP
  notification id, and it is what makes replay-after-crash idempotent (F4.3).
- **`rate_limit_event` is directly useful for a days-long orchestrator.** Parse `resetsAt` and
  schedule around it rather than retrying blindly (F9.4, F4.8).

### 8.2 Codex CLI 0.146.0 (`@openai/codex`)

`codex exec [PROMPT]` (alias `codex e`); `--json` (JSONL events to stdout); `-o/--output-last-message
<FILE>`; `--output-schema <FILE>` (JSON Schema constraining the final response — **use this for
structured plan extraction**); `-s/--sandbox read-only|workspace-write|danger-full-access`;
`--dangerously-bypass-approvals-and-sandbox`; `-C/--cd <DIR>`; `--add-dir`; `--skip-git-repo-check`;
`--ephemeral` (no session files on disk); `-m/--model`; `-c key=value` (TOML config override, dotted
paths); `--enable/--disable <FEATURE>`; `-i/--image`; `--color always|never|auto`.
Resume: `codex exec resume [SESSION_ID] [PROMPT]` or `codex exec resume --last`. Prompt via argv, or
`-` / piped stdin.

> **Churn warning.** `--full-auto` is **not** in `codex exec --help` any more. Use `-s` plus the
> bypass flag.

Also available: `codex mcp-server` (Codex _as_ an MCP server over stdio) and
`codex app-server --listen stdio://|unix://|ws://IP:PORT`.

### 8.3 Gemini, Copilot, OpenCode

**Gemini CLI 0.53.1** (`@google/gemini-cli`): `-p/--prompt` (headless);
`-o/--output-format text|json|stream-json`; `--approval-mode default|auto_edit|yolo|plan`;
`-y/--yolo`; `--session-id <uuid>`; `-r/--resume latest|<index>`; `--list-sessions`;
`--delete-session`; `--session-file <json>`; `--include-directories`; `--policy` / `--admin-policy`;
`-s/--sandbox`; `-w/--worktree`; `--allowed-mcp-server-names`.

> **Churn warning.** `--allowed-tools` is marked **[DEPRECATED: Use Policy Engine instead]**. The
> permission surface here is migrating to `--policy` / `--admin-policy`.

**Copilot CLI 1.0.77** (`@github/copilot`): `-p/--prompt <text>`; `--output-format text|json` —
**note: `json` only, there is no `stream-json`**; `--stream on|off`; `-s/--silent`; `--session-id
<id>`; `--continue`; `--allow-all-tools` (help text: _"required for non-interactive mode"_, env
`COPILOT_ALLOW_ALL`); `--allow-tool` / `--deny-tool` / `--allow-url` / `--deny-url`;
`--allow-all-paths` / `--allow-all-urls` / `--allow-all`; `--add-dir`; `-C <directory>`;
`--additional-mcp-config <json|@file>`; `--disable-builtin-mcps`;
`--log-level none|error|warning|info|debug|all`; `--max-ai-credits`; `--secret-env-vars` (strips named
vars from child envs **and** redacts them from output — worth mirroring in DeFlow, see F5.9);
`--share` / `--share-gist`; `--autopilot`.

> A shim that assumes a uniform `stream-json` across vendors **will break on Copilot**.

**OpenCode 1.18.11** (`opencode-ai`): `opencode run [message..] --format default|json`;
`-c/--continue`; `-s/--session <id>`; `--fork`; `-m/--model provider/model`; `--agent`; `--title`;
`-f/--file`; `--auto` (auto-approve); `--attach <url>`. Plus `opencode serve` (headless HTTP server),
and `opencode export <sessionID>` / `opencode import <file>`, which dump and restore session data as
JSON — genuinely useful as a durable snapshot hook.

### 8.4 Could not verify — treat as unconfirmed

| Agent                   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cursor**              | **Unverified.** Not installable from npm in a usable form: the npm name `cursor-agent` resolves to v1.0.3 last published **2025-01-10**, stale and almost certainly unrelated to Cursor's real CLI (distributed via an install script). Docs indicate `cursor-agent -p --output-format text\|json\|stream-json`, plus `--trust`, `--model`, `--resume`, and NDJSON "similar to Claude Code". Could not run it. **No ACP support found.** |
| **Goose**               | **Unverified.** Rust binary, not on npm. Docs indicate `goose run "<prompt>"` headless with text/json/stream-json output and resume via `--resume` / `-n <name>` / `--session-id <YYYYMMDD_hhmmss>` / `--path` / `--fork` / `--edit`. The project moved to the Linux Foundation and the canonical GitHub org appears to have changed — itself a churn risk.                                                                              |
| **Aider**               | **Unverified.** Not on npm (PyPI `aider-chat`). Release cadence has clearly slowed; sources conflict between "0.86.2, Feb 2026" and "last tag v0.86.0, Aug 2025" and this could not be resolved. No ACP support. **Recommendation: drop Aider from the v1 provider list.**                                                                                                                                                               |
| **Antigravity / `agy`** | **Unverified.** No first-party ACP. A community adapter `shubzkothekar/antigravity-acp` exists (Bun-based, ~29 stars, updated 2026-07-30). Not production-grade.                                                                                                                                                                                                                                                                         |

### 8.5 A legitimate scope cut

> **Option: skip the exec shim entirely at M1 and support only ACP-reachable providers.**

That is Claude, Codex, Gemini, Copilot and OpenCode — five of the six PRD targets, everything except
Cursor. It removes an entire per-vendor parser family, the highest-churn code in the project, from the
M1 critical path. Given the solo-build constraint (PRD §13, "scope explosion"), this is a defensible
and probably correct choice.

The counter-argument is thin: the shim's `ResumeByReplay` machinery is needed anyway (§5.1), and the
verified flag tables above are the expensive part and are already captured here. Add the shim when a
user actually demands Cursor, Goose or Aider. See [roadmap](./17-roadmap.md).

---

## 9. Child-process control

### 9.1 Plain `spawn` for agents — no TTY needed

**Verified 2026-08-02.** A real TTY is **not** required for the agent process. ACP mode and every
headless mode (`claude -p`, `codex exec`, `gemini -p`, `copilot -p`, `opencode run`) are pure stdio
pipe protocols. All five ACP handshakes ran over plain
`spawn(cmd, args, { stdio: ['pipe','pipe','pipe'] })` with no pty and no TTY.

Use `node:child_process.spawn` directly for agents. `execa@10.0.1` is fine sugar elsewhere, but this
is the most safety-critical code in the daemon and the logic should stay explicit and tested. (Note
also `execa`'s counterintuitive kill semantics, documented in
[workspace and safety](./09-workspace-and-safety.md).)

### 9.2 A pty only for DeFlow's own `terminal/*`

A pty **is** needed for DeFlow's implementation of the ACP `terminal/*` client methods: when the agent
asks DeFlow to run a shell command, many build tools change behaviour without a TTY (colour, progress
bars, `isatty` gating).

Use **`@lydell/node-pty`**, not `node-pty`. **Verified empirically:**

- `node-pty@1.1.0` (2026-07-16) has `scripts.install: "node scripts/prebuild.js || node-gyp rebuild"`
  — it downloads a prebuild and **falls back to compiling**. In a toolchain-less environment the
  prebuild fetch failed, `node-gyp rebuild` failed outright, and the package was left uninstallable.
  That directly breaks `npx deflowai up` (NF6).
- `@lydell/node-pty@1.2.0-beta.14` (2026-07-26) installed in **514 ms with zero compilation**, using
  npm-native per-platform `optionalDependencies`
  (`@lydell/node-pty-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-arm64,win32-x64}`). Runtime
  verified: spawned bash in a real pty, `tty` returned `/dev/pts/0`, `$COLUMNS` was 80, clean
  `{exitCode: 0, signal: 0}`.

Caveat: it is a `-beta.14` tag of a community fork. **Pin exactly, make it an `optionalDependency`,
and ship a plain-`spawn` fallback** so a platform without a prebuilt binary degrades to no-TTY rather
than failing installation.

### 9.3 `detached: true` is mandatory

**Verified by measurement, not inference.** A bash script that backgrounds two children was spawned
both ways, with real PGIDs observed via `ps -o pid=,stat=,pgid=`:

|                                    | Result                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `detached: false` (Node's default) | The grandchildren's PGID was **DeFlowd's own process group**. `child.kill('SIGTERM')` killed only bash; both grandchildren remained in state `S`, running. And you _cannot_ group-kill, because signalling that group would kill DeFlowd itself. |
| `detached: true`                   | Grandchildren's PGID equalled `child.pid`, and `process.kill(-child.pid, 'SIGTERM')` terminated the entire subtree.                                                                                                                              |

This is wrong in most tutorials and the non-detached case is actively dangerous.

### 9.4 Three-stage cancellation (F4.4, F5.7)

```ts
const child = spawn(bin, args, {
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  cwd,
  env,
});

// 1. protocol level — lets the agent flush final session/updates
await session.cancel(); // await stopReason 'cancelled'
// 2. process group, graceful
process.kill(-child.pid, "SIGTERM");
// 3. after ~5s grace
process.kill(-child.pid, "SIGKILL");
```

Stage 1 matters: it is the only stage that produces a clean transcript. Keep the `nextUpdate()` loop
running through it (§2.5).

### 9.5 The consequence: orphan reaping

`detached: true` means **the agent survives DeFlowd's death.** That is not optional to handle.

Persist `{runId, nodeId, pid, pgid, started_at, binary_sha256}` in SQLite at spawn. On daemon boot,
for every non-terminal row, reap the orphan — but **guard against PID reuse by comparing process start
time**, never by trusting a bare PID across a reboot:

- Linux: `/proc/<pid>/stat` field 22
- macOS: `ps -o lstart= -p <pid>`

Isolate all of this behind a single `killTree(pid)` with a POSIX and a Win32 implementation. Windows
has no process groups; the path there is `taskkill /PID <pid> /T /F`. `tree-kill@1.2.2` does this and
is tiny, but was **last published 2022-06-27** and is effectively frozen — so vendor it or wrap it,
never depend on it directly. Windows is deferred to M3 (NF5) and the POSIX result does **not** transfer
— it was **not tested**.

---

## 10. Frame-size and backpressure hazards

### 10.1 The SDK's line buffer is unbounded

**Verified hazard.** `@agentclientprotocol/sdk`'s `LineBuffer` (`dist/line-buffer.js`) has **no
maximum line length**. Reading the implementation: `push()` accumulates chunks into a private
`#pending` array and only emits when it finds a `0x0a` byte. An agent that never emits a newline —
buggy, wedged, or emitting one enormous tool result — grows that array until DeFlowd OOMs.

DeFlowd is a long-lived daemon supervising runs for days. This is a real availability bug, not a
theoretical one.

**Measured scale, 2026-08-02:** a _trivial_ `claude -p "say ok"` turn emitted a single **16,024-byte**
JSON line (the `system/commands_changed` frame). Real turns that read a large file or capture a test
log routinely produce multi-megabyte single lines. Environment defaults measured on the same machine:
Node stream `highWaterMark` = **65536** bytes; Linux `/proc/sys/fs/pipe-max-size` = **1048576**.

### 10.2 Three mitigations

**1. Enforce your own frame cap upstream of the SDK.** Interpose a byte-counting `TransformStream`
between the child's stdout and `ndJsonStream()` that counts bytes since the last newline. On exceeding
a hard limit — **suggest 8 MiB** — abort the session with a structured `FrameTooLarge` error and
`killTree()` the agent. Log the first 4 KiB for diagnosis. **Do not try to recover**: a frame that
large means the agent is misbehaving.

**2. Consume with `for await`, never `.on('data')`.**

```ts
for await (const chunk of child.stdout) { … }     // honours backpressure
```

Async iteration pauses the reader, the OS pipe fills at 64 KiB, and the child blocks in `write()`.
With `.on('data')` plus an `async` handler you are in flowing mode with an **unbounded in-memory
queue** — Node will happily buffer hundreds of MB while you await SQLite.

> **Never `await` a database write inside an `on('data')` handler.** The SDK's `session.nextUpdate()`
> pull loop is the correct pattern and is the main reason to prefer it over the callback-style
> `Client.sessionUpdate` handler (§2.3).

**3. Spill large payloads out of the event log.** For any single event payload over ~**256 KiB**
(typically `tool_call_update` content and `terminal/output`), write the bytes to
`~/.DeFlow/blobs/<sha256[0:2]>/<sha256>` and store only `{sha256, bytes, mime, head, tail}` in SQLite —
head and tail being the first and last ~2 KiB so the UI can render a preview without touching disk.

Content-addressing deduplicates repeated identical outputs, which is very common (the same failing
test log across three retry attempts). It also keeps the event log small enough that replaying a
multi-day run on restart stays fast — **replay time is a function of event-log size, and un-spilled
tool output is what makes it explode** (F4.2, NF3). See [durable execution](./05-durable-execution.md)
and [observability](./13-observability-and-telemetry.md).

Cap `terminal/output` on the way **in** as well. The ACP `terminal/*` methods let the agent poll a
long-running command, and a `yarn build` with a progress bar can emit tens of MB. Keep a ring buffer
per terminal (suggest 1 MiB) and report truncation honestly — the schema's terminal output response is
designed for exactly this.

---

## 11. The conformance suite (F3.4)

### 11.1 There is no official ACP conformance kit

**Verified negative, 2026-08-02.** The `agentclientprotocol/agent-client-protocol` repo's top-level
directories are `.github`, `agent-client-protocol-schema`, `docs`, `schema-generator`, `schema`,
`scripts`. There is **no `conformance/`, `compliance/` or `tests/` directory**, and
`@agentclientprotocol/conformance`, `acp-conformance` and `@agentclientprotocol/test-kit` all **404 on
npm**.

> **Trap.** Web search will confidently assert an official ACP conformance suite exists. It does not.
> That claim is a **conflation with a different, unrelated protocol also abbreviated ACP** — the
> academic "Agent Control Protocol" admission-control spec on arXiv. Do not chase it.

What does exist and is useful:

- **`@agentclientprotocol/sdk/schema/schema.json`** — the machine-readable wire schema, **verified to
  contain 262 `$defs`**. This is the conformance oracle.
- **`acpx`** (npm, v0.13.0; repo `openclaw/acpx`, ~3.1k stars, updated 2026-08-02) — a headless CLI
  ACP client. Useful for manually smoke-testing a provider without booting DeFlowd.
- **`venikman/ACP-inspector`** — a third-party ACP traffic debugger/validator. Unvetted; a reference,
  not a dependency.

### 11.2 Layer A — schema conformance, every commit

Tee every frame in both directions **at the transport level** and validate against `schema.json` with
`ajv` (already transitive via the MCP SDK, §7.3). Run it over the recorded corpus in CI. It is free,
offline, and fires the instant an upstream SDK bump changes the wire shape.

### 11.3 Layer B — behavioural contract, parameterised over adapters

One vitest suite, `providerContract(adapterFactory)`, run against the mock agent on every commit and
against real agents nightly behind an `@live` tag. See [testing strategy](./14-testing-strategy.md).

Required assertions:

| #   | Assertion                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `initialize` returns `protocolVersion === 1`                                                                                                            |
| 2   | `session/new` returns a `sessionId`                                                                                                                     |
| 3   | A trivial prompt yields ≥1 `agent_message_chunk`, then a `PromptResponse` with `stopReason === 'end_turn'`                                              |
| 4   | `session/cancel` mid-turn yields `stopReason === 'cancelled'` — **and the client tolerates `session/update` notifications arriving _after_ the cancel** |
| 5   | A permission request round-trips; a client-side cancel produces `RequestPermissionOutcome { outcome: 'cancelled' }`                                     |
| 6   | **Capability honesty** — call a method the agent did _not_ advertise and assert JSON-RPC `-32601`                                                       |
| 7   | Malformed JSON line → structured adapter error, session torn down, no daemon crash                                                                      |
| 8   | Oversized frame → `FrameTooLarge`, `killTree()`, no OOM (§10)                                                                                           |

Assertion 6 is the one that catches a lying capability manifest, which is the single input the entire
routing layer trusts (§6).

### 11.4 Golden ndjson recordings

Because ACP is ndjson, a recording is just the byte stream plus direction. **Put the tee in the
transport, never in the adapter** — an adapter-level tee records what your normaliser already
understood, which is precisely the class of change you need to detect.

```
recordings/<provider>@<version>/<case>.ndjson
# each line: {"t": <msOffset>, "dir": "in"|"out", "msg": { … }}
```

Replay is a `Stream` implementation reading the file, asserting outgoing frames match **modulo
JSON-RPC `id` and `_meta`**. Keying the directory on the **exact** agent version means a version bump
produces a visible new directory rather than silently invalidating old goldens.

Do both layers of assertion: raw frames for conformance, plus a snapshot of the _normalised_ DeFlow
event vocabulary for regression. Snapshotting only the normalised form is less brittle but also less
sensitive — it will not catch an upstream change your normaliser happens to swallow.

`deflow doctor` is the natural home for running Layer B against the user's actually-installed CLI
versions (F3.4, F3.6).

---

## 12. Direct API SDK path (F3.3)

When the user supplies their own key, DeFlow uses it for that provider. Three rules, all following
from AR-1 §5.3:

1. **Never auto-selected.** A provider only enters this path through explicit configuration naming the
   key source. Detection of an ambient key is _not_ consent to use it.
2. **Auth-shadowing must be surfaced loudly** (F3.8). `ANTHROPIC_API_KEY` present in the environment
   silently shadows subscription auth in Claude Code. The failure mode is "you thought you were on
   your subscription and you were being billed". `deflow doctor` must detect and report this, and the
   run header in the UI must show which auth mode each node used.
3. **Runs on this path are labelled in the ledger**, because their cost accounting (F9.1) is real
   currency rather than subscription quota, and the two must not be summed into one number.

Package selection for this path was **not verified** on 2026-08-02. Do not pin versions from memory.
Scoped to M2. See [roadmap](./17-roadmap.md).

---

## 13. The mock agent (F3.7, D17)

`@DeFlow/mock-agent` is a **first-class shipped package**, not a test helper. It exposes a bin
`deflow-mock-agent`, implemented with the _agent_ side of the same SDK (`acp.agent({…})` mirrors
`acp.client({…})`), driven by a declarative script file. No network, no credentials, no tokens.

It deliberately does **not** depend on `@DeFlow/core` — if it did, a bug in the domain model could be
mirrored on both sides of the wire and cancel itself out.

Ten required behaviours:

| #   | Behaviour                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Emit a `plan` update, then N `agent_message_chunk`s at a scripted cadence                                                                                                     |
| 2   | Emit `tool_call` → `tool_call_update` transitions covering every status value                                                                                                 |
| 3   | Issue `session/request_permission` and behave differently per chosen option, including the `cancelled` outcome                                                                |
| 4   | Call back into the client: `fs/read_text_file`, `fs/write_text_file`, `terminal/create` + `terminal/output` + `terminal/wait_for_exit` + `terminal/kill` + `terminal/release` |
| 5   | **Hang forever mid-turn** — exercises cancellation, timeouts, laptop-sleep recovery                                                                                           |
| 6   | **`process.exit(1)` mid-turn** — exercises crash recovery and orphan reaping (§9.5)                                                                                           |
| 7   | Emit a malformed JSON line, and a valid-JSON-but-schema-invalid frame                                                                                                         |
| 8   | Emit a **single 10 MB line** — exercises the framing cap (§10.2)                                                                                                              |
| 9   | **Advertise a configurable `agentCapabilities` block**                                                                                                                        |
| 10  | Honour `--seed` for all ids and timestamps, so runs are byte-reproducible                                                                                                     |
| 11  | **Serve a schema-bearing turn** — `--return-schema <file>` writes one document that validates against it, and nothing else (KAR-19.7)                                         |

Also ship `deflow-mock-agent --replay recordings/<provider>@<ver>/<case>.ndjson`, so a real captured
session becomes a mock provider for free.

> **Item 11 is what makes items 1–10 reachable from a real run.** Every schema-bearing turn — framing,
> recon, the planner, and every node with a `returns` contract — is admitted only onto a provider
> whose registry entry declares a `structuredOutputFlag` (`admitFraming`, KAR-10.2 AC3). Until the
> mock agent had one, the only entries that did were two vendor **exec-shim** paths, so a machine
> with no vendor CLI could not get past framing and F3.7's *"deterministic, free"* provider could
> serve none of the pipeline. The flag selects an **exec-shaped** invocation — one JSON document on
> stdout, no ACP transport opened, a non-zero exit and zero bytes for a schema it cannot serve — and
> `PROVIDER_SPECS.mock` declares that same exported constant, so the registry cannot claim a
> capability the binary does not have. The path is entered **only** when a schema is supplied, which
> is what keeps items 1–10 byte-identical to what they were before it existed.
>
> Two rules hold it honest. The document is a function of `(schema id, seed)` and nothing else — not
> the prompt, not the cwd, not the run's own context, because a mock that shaped its plan from what
> the caller wanted would be a second planner wearing a fixture's clothes. And a schema it has no
> generator for is **refused**, never approximated: an empty object validates against a permissive
> schema, so a caller that received one could not tell a served turn from an unserved one.

> **Item 9 is the one people skip and regret.** It turns the uneven capability matrix of §5 from an
> integration-test problem into a **unit-test problem** — you can exercise Gemini's no-resume profile
> and Claude's everything-on profile without installing or authenticating either. Given that two of
> five providers cannot resume, `ResumeByReplay` needs that coverage on every commit.

You cannot iterate on durable-execution correctness against real agents: it is too slow, it costs
tokens, and crash/hang/malformed-frame scenarios are not reproducible on demand. A scripted mock
collapses a multi-hour scenario into milliseconds and makes the whole daemon developable offline.

---

## 14. Pitfalls — what not to do

- **Do not install `@zed-industries/agent-client-protocol`, `@zed-industries/claude-code-acp` or
  `@zed-industries/codex-acp`.** All three are deprecated renames. Any cached knowledge older than
  late 2025 names the dead packages.
- **Do not assume Claude Code or Codex speak ACP.** They do not. They need the adapter packages in
  §4.2.
- **Do not hardcode the capability matrix.** Probe it, persist it, read it (§6).
- **Do not lean on `session/resume` for durability.** Two of five providers cannot resume.
- **Do not use `session/load` as a substitute for `resume`.** It replays the whole history at you as
  notifications and will flood a days-long run.
- **Do not spawn agents with `detached: false`.** Grandchildren land in DeFlowd's own process group and
  cannot be group-killed.
- **Do not use `child.stdout.on('data', asyncHandler)`.** Flowing mode plus an awaited SQLite write is
  an unbounded RAM queue.
- **Do not rely on the SDK's `LineBuffer` to bound anything.** It has no maximum line length.
- **Do not store raw tool output in the event log.** Spill over 256 KiB to content-addressed blobs, or
  crash-recovery replay time grows without limit.
- **Do not use `node-pty`.** It falls back to `node-gyp rebuild` and can leave the package
  uninstallable. Use `@lydell/node-pty`, pinned, optional, with a no-TTY fallback.
- **Do not build on MCP's legacy HTTP+SSE transport.** Deprecated as of the 2026-07-28 spec, 12-month
  offramp, still shipping in SDK 1.30.0.
- **Do not import `@modelcontextprotocol/sdk` from its package root.** Deep subpaths only, or express
  and hono load at runtime.
- **Do not put business logic in the ACP `fs/*` and `terminal/*` handlers.** v2 deletes those methods
  from the client entirely.
- **Do not assume a uniform `stream-json`.** Copilot offers `text|json` only.
- **Do not run `-p --output-format stream-json` without `--verbose`** on Claude Code.
- **Do not let an adapter search `PATH`.** DeFlowd's `PATH` is not the user's login shell's `PATH`.
- **Do not resume a session across a vendor version change** without explicit opt-in.
- **Do not go looking for the official ACP conformance kit.** It does not exist.

---

## 15. Open risks

| Risk                                                                                                                                                                                                                                                                                                                                                                                          | Status                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **End-to-end ACP cycle unproven.** `initialize` was verified live against all five agents, but a full `session/new` → `session/prompt` → `session/update` → cancel cycle was **not** completed against each (it consumes vendor credits and needs each vendor's auth). Streaming, permission-prompt and cancellation semantics are read from the spec and SDK types, not observed end to end. | **This is the riskiest unverified assumption in the layer. Close it in M0.**                                                 |
| **ACP v2 timing.** Schema is shipped but named `unstable`; no announced timeline. If v2 stabilises during the build, fs/terminal move to MCP.                                                                                                                                                                                                                                                 | Mitigated by the two-fronts split (§3).                                                                                      |
| **MCP SDK version skew.** SDK 1.30.0 declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` despite the blog claiming 2026-07-28 support.                                                                                                                                                                                                                                                          | Re-check. stdio is unaffected.                                                                                               |
| **Capability matrix staleness.** Snapshot of 2026-08-02; two of the five versions were published that same day.                                                                                                                                                                                                                                                                               | Mitigated by §6 — it is a fixture, not a constant.                                                                           |
| **`@lydell/node-pty` is `1.2.0-beta.14`,** a beta of a community fork.                                                                                                                                                                                                                                                                                                                        | Pin exactly; optional dependency; no-TTY fallback.                                                                           |
| **Cursor, Goose, Aider flags are documentation-only.**                                                                                                                                                                                                                                                                                                                                        | Verify by installing before committing to an adapter. Recommend dropping Aider.                                              |
| **Anthropic metering of third-party agent paths.** A search result claimed that as of 2026-06-15 ACP / Agent SDK / `claude -p` usage meters against a _separate_ Agent SDK credit pool distinct from interactive Claude Code usage. Could not be corroborated from a primary Anthropic source.                                                                                                | **Unverified.** Materially affects Claude-adapter economics; confirm directly before designing cost models around it (F9.4). |
| **Windows process-tree termination untested.** The POSIX `detached:true` + `process.kill(-pid)` result does not transfer.                                                                                                                                                                                                                                                                     | Verify when Windows work begins (M3, NF5).                                                                                   |

---

**Related:** [Durable execution](./05-durable-execution.md) · [Workspace and safety](./09-workspace-and-safety.md) · [Testing strategy](./14-testing-strategy.md) · [Tech stack](./02-tech-stack.md) · [Repo layout](./16-repo-layout.md)

[← Back to index](./README.md)
