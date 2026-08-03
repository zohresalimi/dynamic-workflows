# ADR 0004: ACP-first adapter layer, CLI exec shims as the documented fallback

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

The adapter layer is the highest-churn surface in the system, and Open Dynamic Workflow's version of
it (bespoke shell-argument shims per vendor) is the PRD's gap G7. The churn is not hypothetical —
three concrete breakages are visible in the *current* release set. **Verified 2026-08-02**, by
reading each installed binary's own `--help`:

- Claude Code 2.1.220: `--permission-prompt-tool` is gone (grepped, zero hits).
- Codex CLI 0.146.0: `exec --full-auto` is gone.
- Gemini CLI 0.53.1: `--experimental-acp` is deprecated in favour of `--acp`, and `--allowed-tools`
  is marked `[DEPRECATED: Use Policy Engine instead]`.

ACP (Agent Client Protocol) is the standard answer: Apache-2.0, JSON-RPC 2.0 as newline-delimited
JSON over a child's stdin/stdout, explicitly modelled on LSP, turning N×M agent-editor integrations
into N+M. An ACP client gets sessions, streaming updates, permission negotiation, and client-provided
filesystem and terminal access from every ACP-speaking agent through one integration.

It also fits AR-1 exactly: the agent process holds the credential, Karvan only speaks JSON-RPC to it
over a pipe ([ADR 0003](./0003-never-hold-provider-credentials.md)).

**The load-bearing finding is not what the naive assumption suggests.** Running a real `initialize`
handshake against each binary on 2026-08-02 showed that the two most important agents do *not* speak
ACP themselves, while three lesser ones do:

| Vendor | How you actually reach it | Verified |
|---|---|---|
| Gemini CLI `@google/gemini-cli@0.53.1` | `gemini --acp` (native) | 2026-08-02 |
| GitHub Copilot CLI `@github/copilot@1.0.77` | `copilot --acp` (native) | 2026-08-02 |
| OpenCode `opencode-ai@1.18.11` | `opencode acp` (native, subcommand not flag) | 2026-08-02 |
| **Claude Code** | **`@agentclientprotocol/claude-agent-acp@0.64.1`** (first-party adapter; no native ACP in `claude --help`) | 2026-08-02 |
| **Codex CLI** | **`@agentclientprotocol/codex-acp@1.1.9`** (first-party adapter; no native ACP in `codex --help`) | 2026-08-02 |

Both adapters live under the same official `agentclientprotocol` GitHub org as the spec, and both
were published on 2026-08-02 — actively maintained. They supersede the deprecated
`@zed-industries/claude-code-acp@0.16.2` and `@zed-industries/codex-acp@0.16.0`.

Capability is also uneven and cannot be hardcoded. From the same probes: `session.resume` is
advertised by claude-agent-acp, codex-acp and opencode, and **not** by Copilot or Gemini.

## Decision

**Karvan is an ACP client. `@agentclientprotocol/sdk` is pinned at exactly `1.3.0`, targeting wire
`protocolVersion: 1`.** Exact pinning, not caret: this package went 0.4.5 → 1.3.0 *and* changed npm
scope *and* changed GitHub org inside about ten months.

Concretely:

- **Spawn plan is per-vendor and derived from the probe, not from a table in the docs.** Three
  vendors get the binary directly; Claude Code and Codex get their first-party adapter binary, with
  the vendor binary's **absolute** path passed explicitly (e.g. `CODEX_PATH`) — karvand's `PATH` at
  daemon-start differs from the user's login shell.
- **Capability manifests are derived from the `initialize` response and persisted**, never
  hardcoded (AR-5). Resume is two strategies behind one interface — `ResumeNative` where the agent
  advertises `session.resume`, `ResumeByReplay` where it does not — selected at runtime.
- **Vendor session resume is an optimisation, never the durability mechanism.** Karvan's own ledger
  is the sole source of truth; every prompt must be reconstructible from it alone
  ([ADR 0006](./0006-journaled-dag-state-machine-not-deterministic-replay.md)).
- **CLI exec shims are retained permanently as a parallel path, not a temporary bridge** (F3.2). The
  verified flag tables live in [07-provider-adapter-layer.md](../07-provider-adapter-layer.md). They
  are the answer for Cursor (no ACP found) and for the risk that ACP fragments.
- **The conformance suite is ours to build.** **Verified negative, 2026-08-02:** there is no official
  ACP conformance kit — the spec repo has no `conformance/`, `compliance/` or `tests/` directory, and
  `@agentclientprotocol/conformance`, `acp-conformance` and `@agentclientprotocol/test-kit` all 404
  on npm. Web search asserts one exists; that is a conflation with an unrelated academic "Agent
  Control Protocol". What does exist is the shipped `schema/schema.json` (262 `$defs`), which is the
  conformance oracle for F3.4.

Karvan also hosts an MCP stdio server injected via ACP `session/new`, so workflow-level tools reach
every vendor ([ADR 0013](./0013-delegate-sandboxing-to-vendor-clis.md) explains why that boundary
matters for safety).

## Consequences

### Positive
- One client implementation covers five of six target vendors, with permission prompts, fs/terminal
  delegation, streaming and cancellation already specified (F3.1).
- Karvan sits in the path of every `fs/*` and `terminal/*` call, which is what makes the permission
  ladder (F5.4) one policy function instead of an N-vendors × M-levels matrix
  ([09-workspace-and-safety.md](../09-workspace-and-safety.md)).
- The whole safety model becomes unit-testable with zero vendor CLIs installed, because a fake ACP
  *agent* is ~150 lines ([ADR 0017](./0017-mock-agent-binary-as-a-shipped-package.md)).

### Negative
- Two extra pinned dependencies (`claude-agent-acp`, `codex-acp`) sit between us and our two most
  important providers. They are adapters, not first-party vendor code, and must be covered by the
  conformance suite and version-pinned.
- Two of five probed agents cannot resume, so `ResumeByReplay` is not optional.
- The SDK's `LineBuffer` has **no maximum line length** (**verified 2026-08-02** by reading
  `dist/line-buffer.js`) — an agent that never emits a newline will OOM a long-lived daemon. Karvan
  interposes its own 8 MiB frame cap upstream of `ndJsonStream()`.

### Neutral
- Cursor, Goose and Aider could not be verified and stay on the shim path or out of scope. Aider is
  deprioritised.

## Alternatives considered

- **CLI exec shims only, ODW-style.** Rejected as the primary path: this is precisely G7, and the
  three current breakages above are what it costs. Retained as the fallback.
- **Hand-roll JSON-RPC over ndjson.** Genuinely feasible — the protocol is small and the SDK has zero
  runtime dependencies. Rejected because the generated `schema/schema.json` and TypeScript types are
  wanted regardless, so the SDK is nearly free.
- **Codex's `codex app-server`** (its own JSON-RPC-over-stdio protocol, with `generate-ts` and
  `generate-json-schema` subcommands). Higher fidelity to Codex's real feature set; rejected as a
  second protocol to implement and maintain for one vendor.
- **Adopt ACP v2 now.** Rejected: its schema file is literally named `schema.unstable.json`, and all
  five probed agents negotiated `protocolVersion: 1`; none offered 2.

## Revisit when

**ACP v2 lands and agents start negotiating it.** This is the concrete trigger and it is not
cosmetic. **Verified 2026-08-02** by diffing `dist/schema/index.js` against `dist/v2/schema/index.js`:
v2's `CLIENT_METHODS` **drops `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
`terminal/output`, `terminal/release`, `terminal/wait_for_exit` and `terminal/kill` entirely** —
filesystem and terminal access move onto MCP. It also renames `authenticate` → `auth/login`,
`logout` → `auth/logout`, and drops `session/load` and `session/set_mode` agent-side.

That relocates two of the four things a client must implement, and both are where Karvan's
permission enforcement lives. So the fs and terminal logic is written **now** as a transport-neutral
service with two thin fronts — one wired to v1's ACP client methods, one exposed as MCP tools — with
no business logic (path sandboxing, workspace-root enforcement, output capture, blob spilling) in
the ACP handler functions. When v2 lands, re-point the second front and delete the first.

Secondary trigger: **Microsoft ships first-party VS Code ACP support** (settles the standard, and
the shim path can be de-emphasised) **or ships a competitor** (ACP fragments, and the shim path
becomes load-bearing). Track quarterly.

---
[← ADR index](./README.md) · [Architecture docs](../README.md)
