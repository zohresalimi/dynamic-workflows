# Research findings

> Part of the [Karvan architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

This is the evidence base. Every version pin, every "do not do X", and every architectural decision
in the rest of this document set traces back to something here. Where a claim in the [PRD](./prd.md)
turned out to be wrong, this document says so and says what replaced it.

The value of this document is entirely in the verified/unverified boundary. Read the markers.

---

## 1. Method, and what "verified" means here

All research was carried out on **2 August 2026** in a single Linux container (Node 22.22.2 available
as the execution runtime, git 2.43.0, x64). "Verified" means one of five things, and nothing weaker:

| Method | What it means |
|---|---|
| **Installed** | The package was fetched from npm and installed into a real `node_modules`; install time and failure modes are wall-clock observations. |
| **Unpacked** | The published tarball was extracted and its `package.json`, `dist/`, type declarations and bundled assets were read directly. |
| **Probed** | A real agent binary was spawned and a hand-written ndjson JSON-RPC `initialize` frame was written to its stdin; the response was parsed. |
| **Benchmarked** | Code was executed and timed, with the workload and PRAGMA settings recorded alongside the number. |
| **Read at a named commit** | A repository was cloned and source read at a specific SHA, rather than reading its documentation. |

Everything else — search-engine snippets, blog posts, release notes read second-hand — is marked
**Unverified** and must not be relied on without a spike.

### Honest limits of this research

- **One Linux container.** macOS-specific behaviour is untested: APFS `F_FULLFSYNC` (which is
  typically *slower* than Linux fsync, so the durability benchmarks in §4 are optimistic there),
  case-insensitive path collisions in worktree names, macOS 26 Tahoe Seatbelt regressions, and
  `ps -o lstart=` for process start times. Windows is untested entirely: no process groups, so the
  POSIX `detached: true` + `process.kill(-pid)` result does **not** transfer; `taskkill /T /F` is the
  documented path and was not exercised. Directory `fsync` is a documented no-op on Windows.
- **Several primary sources returned HTTP 403 to automated fetch** and were read only via
  search-engine indexing: `agentclientprotocol.com`, `arxiv.org/abs/*`, `docs.claude.com`,
  `opentelemetry.io`, `developer.mozilla.org`, `html.spec.whatwg.org` (the SSE spec),
  `www.dbos.dev`, `docs.temporal.io`, `docs.restate.dev`, `biomejs.dev`, `oxc.rs`, `vitest.dev`,
  `tsdown.dev`, `pnpm.io`, `developers.openai.com`. Where a fact rests on one of these it is flagged
  at the point of use. Where a shipped artifact could substitute for the docs (the ACP SDK's own
  `schema.json` and TypeScript doc comments, ELK's `Layered.melk`, Codex's `protocol.rs`), the
  artifact was read instead and that is noted.
- **No full agent prompt cycle was run.** `initialize` handshakes were completed live against five
  ACP agents, but no `session/new` → `session/prompt` → `session/update` → `session/cancel` round trip
  was executed, because doing so would consume the user's own vendor credentials and quota (AR-1
  means Karvan drives the user's real subscription). Streaming, permission-prompt and cancellation
  semantics in this document are read from the SDK types and the shipped schema, **not observed
  end to end**. This is the single riskiest unverified assumption in the whole research set and is
  the first M0 spike in [17-roadmap.md](./17-roadmap.md).
- **`api.npmjs.org` download counts were blocked**, so maintenance judgements rest on release
  cadence, commit activity and issue triage rather than adoption numbers.

---

## 2. Corrections to the PRD

This is the most important section. The [PRD](./prd.md) was written before this research existed;
these are the places where it is wrong, incomplete, or has been overtaken. They are ordered by how
much they change the design.

### Tier 1 — these change the design

| PRD ref | Claim | Verdict | What to do |
|---|---|---|---|
| §4.7, F3.1 | Claude Code speaks ACP | **CONTRADICTED** | `claude --help` (v2.1.220) contains zero ACP flags or subcommands — grepped, no hits. Claude Code reaches ACP only through the separate adapter package `@agentclientprotocol/claude-agent-acp@0.64.1`. Spawn the adapter, not the CLI. See [07-provider-adapter-layer.md](./07-provider-adapter-layer.md). |
| §4.7, F3.1 | Codex CLI speaks ACP | **CONTRADICTED** | `codex --help` (v0.146.0) lists no `acp` subcommand. Codex reaches ACP only via `@agentclientprotocol/codex-acp@1.1.9`. Codex does ship its own JSON-RPC protocol (`codex app-server`) and an MCP server mode (`codex mcp-server`) — neither is ACP. |
| F5.1 | Branch naming `karvan/<run-id>/<node-id>` | **CONTRADICTED — verified bug** | Git refs directory/file conflict. Verified on git 2.43: after `karvan/r1/n1` exists, `git branch karvan/r1` fails with `fatal: cannot lock ref 'refs/heads/karvan/r1': 'refs/heads/karvan/r1/n1' exists`. The scheme forecloses a run-level integration branch. Adopt flat `karvan/<runId>__<nodeId>` (D13). See [09-workspace-and-safety.md](./09-workspace-and-safety.md). |
| §4.6, F10.12 | "Copilot, Codex and Claude Code emit GenAI-convention telemetry natively" | **CONTRADICTED** | Grepping the shipping Claude Code 2.1.220 bundle (`cli.js`, 11.5 MB) returns **zero occurrences of the string `gen_ai.`**. It emits a vendor-private namespace on meter `com.anthropic.claude_code`: `claude_code.session.count`, `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.active_time.total`, etc. Codex is worse: per openai/codex#12913, `codex exec` emits traces and logs but **no metrics**, and `codex mcp-server` emits nothing — and `codex exec` is exactly the mode Karvan uses. **Karvan must emit `gen_ai.*` spans itself** (D16). See [13-observability-and-telemetry.md](./13-observability-and-telemetry.md). |
| §4.4 | DBOS is viable embedded (Postgres *or* SQLite) | **CONTRADICTED for TypeScript** | Read at commit `dfd600cc48537a69f3d57d28108a781bfb82c988` (2026-07-30): the only DB dependency is `pg`; `SystemDatabase` holds a `pg.Pool`; the migration runner types against `pg.ClientBase` and queries `information_schema`. A `sqlite3?: ReadonlyArray<string>` field exists on `DBMigration` and is referenced **nowhere else in `src/`** — a dead placeholder that a docs-only investigation would misread. npm `@dbos-inc/dbos-sdk@4.25.14` confirms the same dependency set. SQLite landed in DBOS **Go**, not TypeScript. Build the ledger (D7). |
| F4.8 | "A run may sleep for hours waiting on a human gate" (implying in-process timers) | **CONTRADICTED** | Node's max `setTimeout` delay is 2^31−1 ms (24.9 days). **Verified: passing `2**31` fires the callback after 1 ms** with only a `TimeoutOverflowWarning` on stderr. A 30-day gate would fire instantly. Timers also do not fire during laptop sleep and do not survive restart. Use a durable `node_wake(run_id, node_id, wake_at, reason)` table plus a ~1 Hz ticker — this collapses long gates, sleep/wake, restart and retry backoff into one mechanism. See [05-durable-execution.md](./05-durable-execution.md). |
| §9.2 | "better-sqlite3 has painful native-module install" (the implicit reason to hedge with libSQL) | **CONTRADICTED as of v13** | v13.0.0 migrated to N-API. The 13.0.2 tarball ships **8 prebuilt binaries** (`prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`), `gypfile: false`, and **no install script**. `npm i better-sqlite3@13.0.2` completed in **1 second**, zero compilation, zero node-gyp, zero prebuild-install network fetch. N-API means one binary works across Node versions. This is the single fact that settles the driver decision (D6). |
| §9.2 | node:sqlite is a safe default for the ledger | **CONTRADICTED** | Still **Stability 1.2 (Release Candidate)** on Node 24 and 26 — not Stable(2). Its API changed *inside* the 24.x LTS line: `createTagStore` 24.9, `setAuthorizer` 24.10, `defensive` 24.12/24.14, `limits` 24.15, `serialize`/`deserialize` 24.16. Verified on Node 22.22.2 that `setAuthorizer`, `createTagStore` and `serialize` are all `undefined` and bundled SQLite is 3.51.2 (vs better-sqlite3's pinned 3.53.4). For software distributed by `npx` onto whatever Node the user has, behaviour varying with the user's *patch* level is disqualifying. It also prints `ExperimentalWarning` on import. |
| F4.9, §9.3 | Replaying a 40-step multi-hour run needs snapshotting | **CONTRADICTED at realistic scale** | Measured: 500,000 events in a 193 MB SQLite file replay fully in **416 ms**; the control-plane subset (10,000 rows via a partial index) replays in **29 ms**. The real fix is separating agent I/O chunks from the control-plane ledger, not snapshotting. Ship the checkpoint hook as a pure optimization with a `checkpoint_version` invalidation guard; defer real snapshots until a run exceeds ~100k control-plane events. |
| §4.4, NF9 | Event-sourced durability requires deterministic replay of workflow logic (the Temporal/Restate model) | **CONTRADICTED for Karvan's architecture** | Because the plan is persisted **data** with stable `nodeId`s, the checkpoint-and-memoize model (Inngest/DBOS) applies and imposes no determinism constraint on orchestrator code. This eliminates the whole workflow-versioning problem class — no `patched()`, no step-hash `:n` counters, no `ctx.stack` code-change detection. The only remaining compatibility surface is the event payload schema, handled by an explicit `v` field plus upcasters (D7). |
| F4.1 | "An append-only ledger in SQLite gives monotonic sequence numbers" | **CONTRADICTED without AUTOINCREMENT** | Verified: with plain `INTEGER PRIMARY KEY`, inserting 1,2,3 → deleting 3 → inserting again yields **seq 3 again**. With `AUTOINCREMENT` the same sequence yields 1,2,4. The moment run retention/pruning exists, plain rowid silently corrupts every persisted SSE cursor and every `last_seq` checkpoint. `INTEGER PRIMARY KEY AUTOINCREMENT` on `event` and `io_chunk` is mandatory. |
| §6.3, D1 | Single daemon process implies no locking or fencing is needed | **CONTRADICTED** | A user running `npx karvan up` twice yields two daemons over one SQLite file. SQLite enforces one writer (verified: a second connection's `BEGIN IMMEDIATE` returns `SQLITE_BUSY`), but that does not stop two schedulers interleaving effect execution. A `flock` on the DB directory plus a `daemon_epoch` stamped on every write is required. |
| §4.5, F5.6 | The Kiro/AWS lesson is that approval gates didn't cover the moment of action | **CONFIRMED WITH CORRECTION** | The incident is real: 15 Dec 2025, AWS Cost Explorer, ~13-hour outage, mainland China; FT reported 20 Feb 2026 citing four sources; Amazon published a formal rebuttal. But per Amazon's own account the gate **existed and was on by default** — it was bypassed by the engineer's standing elevated production permissions. The sharper lesson is **ambient authority**, not gate placement. This ranks aggressive credential and environment scrubbing *above* the human gate as the load-bearing control. Rewrite F5.6 accordingly; see [15-security-model.md](./15-security-model.md). |
| §9.2, §6.3 | Terminal: `xterm.js`; Graph: `dagre` (implied by tutorials) | **CONFIRMED WITH CORRECTION — stale package names** | Unscoped `xterm` is frozen at 5.3.0 (2023-09-07); use `@xterm/xterm@^6.0.0`. Unscoped `dagre` is frozen at 0.8.5 (**2019-12-03**); use `@dagrejs/dagre@3.0.0`. Same trap for `radix-vue@1.9.17` (dead) → `reka-ui@2.10.1`, `jsdiff` (2014) → `diff@9.0.0`, `fast-json-patch@3.1.1` (2022-03-25) → `rfc6902@5.3.0`, `@microsoft/fetch-event-source@2.0.1` (2021) → `eventsource-client@1.2.0`. |
| §13 | "ACP fragments (no Microsoft adoption)" — Medium risk | **OUTDATED — RESOLVED FAVOURABLY** | Microsoft shipped **Intelligent Terminal 0.1 on 2 June 2026** with a native agent pane speaking ACP, auto-detecting Copilot, Claude Code, Codex CLI and Gemini CLI. Microsoft's own `agent-host-protocol` (AHP) is explicitly positioned as complementary — "AHP is a coordination layer. ACP is a communication layer. They compose naturally" — with AHP hosts speaking ACP downstream. The PRD's headline ACP risk has largely retired; D8 is on firmer ground than the PRD assumes. CLI shims stay as a permanent parallel path anyway. |
| §4.1 | Crystal and Vibe Kanban as live comparators | **OUTDATED** | Crystal was deprecated Feb 2026 and became **Nimbalyst** (paid, closed-source). Bloop (Vibe Kanban's company) shut down early 2026; the OSS project continues community-maintained, which the PRD already notes. **Sculptor (Imbue) is still active** (v0.30, May 2026) and remains the valid container-per-agent reference. |
| §9.2 | "Daemon: Node 22+" | **CONTRADICTED — too loose** | Node 22 entered maintenance 2025-10-21. Node 24 is Active LTS until 2026-10-20; Node 26 is Current (since 2026-05-05). pnpm 11 requires Node ≥22.13; tsdown requires `^22.18 \|\| >=24.11`. Set `engines: { node: '>=24' }` (D2) and CI on 24 and 26. |

### Tier 2 — these change an implementation detail

| PRD ref | Claim | Verdict | What to do |
|---|---|---|---|
| §9.2 | "SSE with `Last-Event-ID` gives free resumable streams" | **CONFIRMED WITH CORRECTION** | Browsers send `Last-Event-ID` **only on automatic reconnect**, never on a fresh `new EventSource()` after a page reload, and `EventSource` cannot set custom headers at all. The endpoint must also accept an explicit `?from=<seq>` query param. Sequence gaps are expected (rolled-back transactions burn AUTOINCREMENT values), so the resume contract is "strictly greater than cursor", never "cursor + 1". See [11-api-and-realtime.md](./11-api-and-realtime.md). |
| NF4 | "WAL mode gives durability across crashes" | **CONFIRMED, QUALIFIED** | Verified for process crash: SIGKILL mid-write at `synchronous=NORMAL` recovered all **45,339** committed rows with `PRAGMA integrity_check` = `ok`. But NORMAL does not fsync the WAL per commit, so a kernel panic or power cut can lose recent commits. `FULL` costs ~23× on per-event transactions (979 vs 22,982 ev/s measured). Document the trade; do not call NORMAL "durable" without qualification. |
| F5.1 | "Git will not check the same branch out twice" | **CONFIRMED, INCOMPLETE in three ways** | (a) `git worktree add --force` **bypasses the check entirely** and creates exactly the corruption the rule exists to prevent — never pass `--force` to `worktree add`; restrict it to `worktree remove`. (b) The main checkout counts as an occupant, so `git worktree add <path> master` fails when the user is sitting on master — the most common real-world hit, on the very first run. (c) The actual error string is `fatal: '<branch>' is already used by worktree at '<path>'`, not the "already checked out at" that blog posts quote. Pre-check `git worktree list --porcelain -z`; do not parse error messages. |
| F5.3 | Path-scope declarations, violations detected on completion | **CONFIRMED, DEMOTE** | `git merge-tree --write-tree` is ground truth and requires no agent compliance; declared scopes are a plan-time *prediction* (D14). Also: under ACP, `ToolCallLocation.path` lets you enforce scope **at request time** rather than detecting a violation after the fact — strictly better than the PRD's "detected on completion". Capture merge-tree's exit code directly (0 = clean, 1 = conflict); piping it through anything destroys the signal. |
| F5.4 | "Where a provider cannot express the requested level, Karvan refuses to schedule" | **PARTIALLY PRACTICAL AS WRITTEN** | As a per-vendor flag-capability matrix this is a permanent maintenance burden (the PRD's own G7). Under D8 it largely dissolves: Karvan enforces the ladder itself at `session/request_permission` + `fs/*` + `terminal/*`. Narrow the rule to one capability bit: does the adapter support ACP-mediated execution at all? |
| F5.4 | The four-level ladder maps onto real CLIs | **CONFIRMED — one of the best-evidenced decisions in the PRD** | Claude Code: `read`→`sandbox.filesystem` read-only + no `allowedDomains`; `worktree`→default `allowWrite=cwd`; `worktree+net`→ + `network.allowedDomains`; `full`→`bypassPermissions`. Codex: `read-only` / `workspace-write` (network_access=false) / `workspace-write` (network_access=true) / `danger-full-access`. Both express all four levels natively. |
| F6.6 | Compaction events carry "before/after token counts... and what was dropped, with handles to the full original" | **CONFIRMED for Karvan's own compaction; CONTRADICTED for the vendor's** | Claude Code's `compact_boundary` event carries only `{trigger, pre_tokens}` — no post-count, no dropped list, no handle. Encode the gap with a `fidelity: 'exact' \| 'partial'` discriminator on `context.compacted` rather than fabricating a number. A chart with an invented "after" value is worse than an honest gap. See [08-context-and-memory.md](./08-context-and-memory.md). |
| §4.6 | "As of v1.41 the spec defines agent, workflow, tool and model spans" | **NEEDS UPDATE** | The span/metric content is right; the governance changed underneath it. In semconv **v1.42.0 (12 June 2026)** every `gen_ai.*` attribute, metric, event and span was deprecated in the main repo and moved to `open-telemetry/semantic-conventions-genai`. That repo has **no releases and no tags** as of 2 Aug 2026 (verified — its releases page is empty). Consequence: the PRD's instruction to "pin the semconv version" is **not presently satisfiable for `gen_ai.*`**. The main repo is at v1.43.0. |
| §4.6 | "Most `gen_ai.*` attributes still carry Development stability badges" | **CONFIRMED and then some** | Every `gen_ai.*` attribute inspected is Development, and they live in the `/incubating` import subpath. There is no 1.0. Names do change: `gen_ai.system` → `gen_ai.provider.name` (renamed v1.37.0); both still ship side by side in the JS package (confirmed locally), gated by `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`. |
| §9.2 | "Process control: `node-pty`" | **CONFIRMED ALIVE, WRONG CHOICE** | `node-pty@1.1.0` (2026-07-16) is maintained, but its install script is `node scripts/prebuild.js \|\| node-gyp rebuild` — it **silently falls back to compiling** and was verified to fail outright in a toolchain-less environment, which breaks `npx karvan up` on any machine without build tools. `@lydell/node-pty@1.2.0-beta.14` uses npm-native per-platform `optionalDependencies` and installed in **514 ms** with zero compilation; a real pty was spawned and `/dev/pts/0` confirmed. Also: **no TTY is required for any agent process** — ACP and every headless mode is a pure pipe protocol across all five agents probed. A pty is needed only for Karvan's own `terminal/*` implementation. |
| F5.7 | "One control stops every child process in a run immediately" | **CONFIRMED ACHIEVABLE, two verified traps** | (a) `process.kill(pid, sig)` with a **positive** pid kills only the direct child and orphans grandchildren (verified: two `sleep` grandchildren survived and reparented to PID 1). You must spawn with `detached: true` and kill the group with `process.kill(-pid, sig)`. (b) Verifying the kill with plain `ps` produces a **false negative** — killed grandchildren linger as zombies (state `Z`, ppid 1) until init reaps them, and zombie reaping lags badly inside containers. Filter out `Z` state. Under ACP there is also `terminal/kill`. |
| F3.7 | "Deterministic mock provider" | **CONFIRMED, UNDER-SPECIFIED** | A mock *adapter* is not enough. F3.4's conformance battery (timeout, cancellation, non-zero exit, malformed output) tests the **subprocess boundary**; a mocked `child_process` tests the mock. Ship a real mock ACP **binary** on PATH as a first-class package (D17). See [14-testing-strategy.md](./14-testing-strategy.md). |
| F5.8 | Container isolation as P1 opt-in | **CONFIRMED — for a reason the PRD doesn't state** | Containerising breaks vendor CLI credential storage. **Correction to the raw research:** the fix is *not* bind-mounting `~/.claude`. Anthropic's documented path is to authenticate fresh *inside* the container and persist it in a named Docker volume — `"mounts": ["source=claude-code-config-${devcontainerId},target=/home/node/.claude,type=volume"]` plus `"containerEnv": {"CLAUDE_CONFIG_DIR": "/home/node/.claude"}`. That **strengthens** AR-1 by isolating credentials from the host keychain. The residual risk runs the other way: under `--dangerously-skip-permissions` a malicious repo can exfiltrate the credentials stored inside the container, which is why the reference config pairs the flag with an egress allowlist. |
| §6.3 | "Phone on the same Wi-Fi" | **UNVERIFIED AS SAFE** | Binding beyond 127.0.0.1 exposes an unauthenticated orchestrator with `full` permission capability to the local network. A localhost bind is also not a boundary — any local process, and any web page via DNS rebinding, can reach `127.0.0.1:7777`. Require a bearer token and validate `Origin` **from the first commit**; retrofitting auth after the UI exists is much worse. |
| §4.7 | "Is there an ACP conformance/test kit?" | **CONFIRMED NEGATIVE** | The spec repo has no `conformance/` or `compliance/` directory (top-level dirs: `.github`, `agent-client-protocol-schema`, `docs`, `schema-generator`, `schema`, `scripts`), and `@agentclientprotocol/conformance`, `acp-conformance` and `@agentclientprotocol/test-kit` all 404 on npm. **Web search will confidently tell you one exists** — that assertion is a conflation with an unrelated academic "Agent Control Protocol" admission-control spec on arXiv. The shipped `schema/schema.json` (262 `$defs`) is the practical substitute, plus the third-party `acpx` CLI and `ACP-inspector`. |
| §4.7 | ACP "has a current spec version" | **CONFIRMED WITH CORRECTION** | The wire version is the **integer `1`**, negotiated via `protocolVersion` in `initialize` (verified: `PROTOCOL_VERSION = 1` in the SDK, and all five live agents returned `protocolVersion: 1`). Package/release versions are artifact versions and explicitly **not** the compatibility signal. Note MCP's version is a date string (`'2025-11-25'`) — do not share a version-negotiation helper between the two layers. An unstable v2 (`PROTOCOL_VERSION = 2`) ships behind an experimental subpath and **removes `fs/*` and `terminal/*` from the client**. |
| §4.7 | "Official TypeScript packages for implementing an ACP client" | **CONFIRMED — but the circulating package name is stale** | Current: `@agentclientprotocol/sdk@1.3.0`, one package implementing both client and agent sides. `@zed-industries/agent-client-protocol@0.4.5` is verified deprecated with an explicit rename notice, as are `@zed-industries/claude-code-acp@0.16.2` and `@zed-industries/codex-acp@0.16.0`. Any tutorial older than roughly late 2025 names the dead packages. |
| §4.7, F3.1 | ACP gives "sessions, streaming, permission-gated tool execution, client-provided fs and terminal" | **CONFIRMED, and more valuable than stated** | Verified `CLIENT_METHODS` from the shipped SDK: `session/request_permission`, `session/update`, `fs/read_text_file`, `fs/write_text_file`, `terminal/{create,output,release,wait_for_exit,kill}`, `mcp/{connect,message,disconnect}`, `elicitation/{create,complete}`. Only `session/request_permission` and `session/update` are **mandatory**; `fs/*` and `terminal/*` are gated on capabilities you advertise. `PermissionOptionKind = allow_once \| allow_always \| reject_once \| reject_always`; `ToolKind = read \| edit \| delete \| move \| search \| execute \| think \| fetch \| switch_mode \| other`; `ToolCallLocation = {path, line?}`. This also solves the permission-ladder mapping and makes the safety model unit-testable without vendor CLIs. |
| F4.2, F3.1 | (implicit) vendor session resume underpins durability | **CONTRADICTED — uneven capability** | Probed live from each agent's `initialize` response. `session.resume`: claude-agent-acp **yes**, codex-acp **yes**, opencode **yes**, `copilot --acp` **no**, `gemini --acp` **no**. Gemini returned no `sessionCapabilities` key at all; Copilot returned `sessionCapabilities: { list: {} }` and nothing else. Karvan's own ledger is the sole source of truth; vendor resume is a token-cost optimization selected at runtime from the probed capability, never a hardcoded table. Also: `session/load` ≠ `session/resume` — `load` streams the entire conversation history back as `session/update` notifications, which floods a days-long run. |
| F6.4 | "Anthropic's multi-agent system... token usage explains most of the performance variance" | **CONFIRMED, with a precision note** | The figure is **~80%**, and it is specific to their BrowseComp evaluation — do not generalise it to coding workloads without saying so. Condensed returns are in the ~1,000–2,000 token range; the lead-Opus/subagent-Sonnet configuration outperformed single-agent Opus by 90.2% on their internal research eval at roughly 15× the token cost of a normal chat turn. Karvan's 500–2,000 token return budget is **practitioner consensus, not a controlled study** — treat it as a tunable default, not an established finding. |
| F6.9 | "Handoff contracts as schemas" needs to be built | **CONFIRMED — partly free** | Claude Code 2.1.220 ships `--json-schema <schema>` ("JSON Schema for structured output validation"), the result envelope carries a `structured_output` field, and there is a dedicated failure subtype `error_max_structured_output_retries` — the CLI already does bounded internal repair against your schema before giving up. It also ships `--max-budget-usd <amount>` (feeds F4.6/F9.2) and `--session-id <uuid>`, which lets Karvan *supply* a deterministic session ID — exactly what F4.3's idempotency keys want. |
| §9.2, F10.1 | Graph: `@vue-flow/core`; Charts: `d3`; Diff: `shiki` | **CONFIRMED, with refinements** | `@vue-flow/core@1.48.2` peers `vue ^3.3.0`, ships proper ESM (345 KB raw `.mjs`), and the a11y surface (`aria-live`, `aria-label`, `aria-describedby`, `aria-roledescription`, `useKeyPress`) is real — verified in the bundle. The `d3` metapackage is 7.9.0 (2024-03-12, no v8); use submodules as a maths library and render with Vue SVG. Shiki is at 4.4.1, and two 4.x packages map onto PRD requirements the PRD didn't know existed: `@shikijs/stream` ("useful for highlighting text streams like LLM outputs") for F10.6, and `@shikijs/magic-move` for the F7.5 repair loop. Name the diff view concretely: `@git-diff-view/vue@0.1.7`. |
| §9.2, NF6 | "npx karvan up. No database server, no Docker" | **CONFIRMED ACHIEVABLE** | With better-sqlite3's prebuilts (1 s install, no gyp), a tsdown bundle inlining all `@karvan/*`, and the Vite build shipped as plain files under `dist/ui/`, the tarball has **one** native dependency and no DB, no Docker, no build step at install time. Worktrees, merge-tree conflict detection, process-group kill and both vendor CLI sandboxes (Seatbelt on macOS; bubblewrap + socat on Linux) all run without Docker. |
| NF3 | "UI interactive < 1s on localhost" | **PLAUSIBLE BUT CONTINGENT** | Binding constraints: keep ELK (~1.6 MB) off the initial chunk via a worker, lazily import ~12 Shiki grammars rather than the bundled entry, and lazy-route the terminal and diff views. Budget ~200 KB gzip for the initial shell and route-split everything else. |
| NF9, NF10 | Deterministic core; every UI state traceable to ledger events | **CONFIRMED, with discipline requirements** | NF9 means time enters through an injected `Clock` port, never `Date.now()`/`setTimeout` — which also means most scheduler tests need no fake timers (and `vi.useFakeTimers()` while a child process is alive **deadlocks**, because the process's real I/O never arrives). NF10 means structured logs (pino) must never become a second event store. Two sinks, two purposes, enforced in review. |

### Tier 3 — confirmed as written

`§4.7` ACP exists as described (Zed Industries, Apache-2.0, JSON-RPC 2.0 as newline-delimited JSON
over stdin/stdout; project moved from the `zed-industries` GitHub org to its own `agentclientprotocol`
org; ACP Registry co-launched with JetBrains, Jan 2026) · `§4.7` Gemini (`gemini --acp`, v0.53.1),
Copilot (`copilot --acp`, v1.0.77) and OpenCode (`opencode acp`, v1.18.11) all speak ACP — verified by
live handshake · `§4.7` MCP transports: stdio and Streamable HTTP are current, legacy HTTP+SSE is
officially deprecated as of the 2026-07-28 spec with a 12-month offramp · `§4.1` "unique per-session
branch names or detached HEAD are mandatory" — both workarounds verified working · `F5.2` serialize
writes, parallelize reads — independently corroborated across 2026 multi-agent guidance · `G6` the
binary permission model is a real gap and the four-level ladder is the right fix · `§9.4` the
`.karvan/` repo layout is compatible with everything found (add a separate global dir for daemon
state so `.karvan/` can be `.gitignore`d wholesale) · `§9.2` Vue 3 + Vite + TS (Vue 3.5.40 stable,
Vite 8.2.0 Rolldown) · `§6.3` Tauri 2 for the M3 shell — nothing in the stack blocks it; keep to
non-Chrome-only APIs since Tauri uses WKWebView/WebKitGTK · `§7.10 F10.9` the Gantt is ~150 lines of
`d3-scale` + Vue SVG, no chart library needed · `§13` "visualization scoped to nine P0 views, not a
design system" — the concrete expression is vendored shadcn-vue components you own, not PrimeVue.

### Tier 4 — unverified; do not state as fact

| Claim | Status |
|---|---|
| Cursor speaks ACP (§4.7 implies the registry covers it) | **UNVERIFIED.** No first-party Cursor ACP adapter surfaced on npm or in the ACP ecosystem. The npm name `cursor-agent` resolves to a stale v1.0.3 from 2025-01-10 that is almost certainly unrelated. All Cursor flags in this research come from documentation only. |
| Goose and Aider adapter flags (F3.2) | **UNVERIFIED.** Documentation only. Goose appears to have changed GitHub org (Linux Foundation handoff). Aider's cadence has clearly slowed and sources disagree on the current version (0.86.2/Feb-2026 vs last tag v0.86.0/Aug-2025). **Recommend dropping Aider from v1.** |
| The MCP TypeScript SDK implements the 2026-07-28 spec | **CONTRADICTED, unresolved.** The official MCP blog states all four Tier-1 SDKs shipped support on release day. But `@modelcontextprotocol/sdk@1.30.0` (published 2026-07-27, one day *before*) has `LATEST_PROTOCOL_VERSION = '2025-11-25'`, `SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`, and grepping the whole `dist` for `'2026-07-28'` returns zero hits. There is no `next`/`beta` dist-tag. Karvan's stdio transport is unaffected either way. |
| A separate Anthropic Agent SDK credit pool as of 2026-06-15 (bears on §5.1) | **UNVERIFIED and contested.** One search result claimed third-party agent paths (ACP, Agent SDK, `claude -p`) meter against a *separate* credit pool distinct from interactive usage; several 2026 articles state the credit went live on 15 June with Pro $20 / Max5x $100 / Max20x $200. The PRD says it was **paused** on that date. Could not be corroborated from a primary Anthropic source. This materially affects the cost model — confirm directly against Anthropic's docs before designing around it. |
| "No npm package does visual DAG diffing" (F10.2 marquee-feature framing) | **UNVERIFIABLE.** A negative existence claim. Registry searches surfaced only non-visual matches (`@casfa/dag-diff`, `graphology-dag`, `d3-dag`, the `@ipld/dag-*` codecs, generic object/JSON differs) and general graph renderers. State it as **"none found"**, never as "none exists". |
| "The plan scrubber is about 200 lines" | **UNVERIFIABLE, and looks optimistic.** An effort estimate, not a checkable fact. Given the enumerated pieces — identity contract, content hashing, node+edge set diff, union-graph layout with a position cache keyed by `(runId, versionA, versionB)`, a cross-version layout, a JSON-Patch field panel, the version rail and keyboard stepping — do not plan against this number. |
| ELK gives "layout stability across versions" | **UNSUPPORTED.** ELK publishes no cross-version layout-stability guarantee anywhere in its docs, changelogs or option metadata, and ELK Layered's release notes routinely change heuristics. `considerModelOrder.strategy = NODES_AND_EDGES` does make output a deterministic function of input model order — stability across *runs on the same elkjs version*, which is the cheap lever worth taking. Cross-time stability requires an **exact** elkjs pin plus a golden-layout regression test over a fixed plan fixture. |
| Vue Flow's performance ceiling (~300–500 smooth, stalls past ~2000) | **ESTIMATE, not measured.** No official Vue Flow benchmark exists; the numbers are extrapolated from React Flow guidance plus the identical one-DOM-subtree-per-node architecture. Plan graphs of 40–200 nodes sit comfortably inside the smooth band; the memory/data-flow view (F10.4) is where facts × reads/writes could reach thousands of edges. Measure with a 400-node stress fixture in week one. |

---

## 3. The verified version manifest

Consult this table before running `pnpm add`. **Verified 2026-08-02** — versions and publish dates
come from direct `registry.npmjs.org` queries; the "what was verified" column says what was actually
checked beyond existence.

### Adapter layer and process control

| Package | Version | Published | What was verified |
|---|---|---|---|
| `@agentclientprotocol/sdk` | **1.3.0** (exact pin) | — | Tarball unpacked. `PROTOCOL_VERSION = 1`; `AGENT_METHODS`/`CLIENT_METHODS`/`PROTOCOL_METHODS`; `StopReason`, `ClientCapabilities`, `AgentCapabilities`, `SessionCapabilities`, `SessionUpdate` union, `McpServer` 4-way union; `dist/v2/schema` has `PROTOCOL_VERSION = 2`; `LineBuffer` has **no max line length** (OOM hazard). |
| `@agentclientprotocol/claude-agent-acp` | 0.64.1 | 2026-08-02 | Live `initialize` handshake. Returned `authMethods: []` — already authenticated from the user's own credential store, which is AR-1 working as intended. |
| `@agentclientprotocol/codex-acp` | 1.1.9 | — | Live `initialize` handshake. `mcpCapabilities.acp: false`. |
| `@zed-industries/agent-client-protocol` | 0.4.5 | — | **Deprecated rename.** Do not use. |
| `@zed-industries/claude-code-acp` | 0.16.2 | 2026-03-26 | **Deprecated rename**, five months stale. |
| `@zed-industries/codex-acp` | 0.16.0 | — | **Deprecated rename.** |
| `@modelcontextprotocol/sdk` | **1.30.0** | 2026-07-27 | Unpacked. `LATEST_PROTOCOL_VERSION = '2025-11-25'`; server/client transport listing; `McpServer` API surface. Heavy dep tree (express 5, hono, cors, jose, ajv, eventsource, pkce-challenge, express-rate-limit) — import deep subpaths only. |
| `@lydell/node-pty` | 1.2.0-beta.14 | 2026-07-26 | **Installed in 514 ms**, zero compilation, per-platform npm `optionalDependencies`. Spawned bash in a real pty; `tty` returned `/dev/pts/0`, `$COLUMNS` 80, clean `{exitCode:0, signal:0}`. Still a **beta of a community fork** — keep it optional with a no-TTY fallback. |
| `node-pty` | 1.1.0 | 2026-07-16 | Install script is `node scripts/prebuild.js \|\| node-gyp rebuild`; **verified to fail** in a toolchain-less environment. Rejected. |
| `execa` | 10.0.1 | 2026-07-31 | `forceKillAfterDelay` does **not** fire when you call `subprocess.kill()` with an explicit signal; the tree-kill option is the separate `killDescendants`; `cleanup: true` does **not** apply to `detached` subprocesses. |
| `tree-kill` | 1.2.2 | 2022-06-27 | Effectively frozen. Fine to use, but isolate behind your own `killTree()`. |
| `acpx` | 0.13.0 | — | Third-party headless ACP CLI client; practical substitute for the nonexistent conformance kit. |

**Agent binaries probed (this is a test fixture, not a constant — regenerate it):**
`@anthropic-ai/claude-code` **2.1.220** · `@openai/codex` **0.146.0** · `@google/gemini-cli` **0.53.1** ·
`@github/copilot` **1.0.77** · `opencode-ai` **1.18.11**. Two of these were published the same day they
were probed.

### Persistence and durability

| Package | Version | Published | What was verified |
|---|---|---|---|
| `better-sqlite3` | **13.0.2** | 2026-07-29 | Tarball unpacked (11.4 MB): 8 N-API prebuilds, `gypfile: false`, **no install script**. Installed in **1 s**, 27 MB `node_modules`. Bundles **SQLite 3.53.4** with **FTS5 compiled in**; `bm25()` ranking works out of the box; `db.loadExtension` present. Only runtime dep `node-addon-api@^8`. |
| `@types/better-sqlite3` | ^9.6.0 | 2026-08-01 | better-sqlite3 v13 does **not** bundle types. The DefinitelyTyped major lags the package major — **unverified** whether it covers `db.explain()` and `stmt.toString()`, both new in v13. |
| `@libsql/client` | 0.17.4 | 2026-06-15 | Rejected: async API, drags in `libsql` native + `@libsql/hrana-client` network machinery for a sync story Karvan does not need. |
| `@tursodatabase/database` | 0.7.2 | 2026-07-30 | Rejected: 0.x with **6 releases in 8 days**. Revisit 2027. |
| `node-sqlite3-wasm` | 0.8.60 | 2026-07-28 | Documented as a pure-JS escape hatch for exotic platforms only. WAL over a WASM VFS is not a durability bet. |
| `@dbos-inc/dbos-sdk` | 4.25.14 | 2026-07-30 | Rejected. Dependencies: `pg, ws, yaml, commander, superjson, serialize-error` — no SQLite driver. |
| `drizzle-orm` | 0.45.2 latest / 1.0.0-rc.4 | 2026-03-27 / 2026-06-27 | Mid-major transition since June. Do not adopt for the ledger during this window. |
| `reflow-ts` | 0.5.0 | 2026-06-10 | 4 published versions total. Named only as **evidence that no mature SQLite-backed TS durable engine exists** — not evaluated on merit. |

### Toolchain

| Package | Version | Notes |
|---|---|---|
| `typescript` | **6.0.3** (pinned, D3) | 7.0.2 is `latest` but unpacked: it ships **`bin/tsc` only — no `tsserver`, no public compiler API**. `vue-tsc@3.3.9`/Volar and `typescript-eslint@8.65.0` (peer `typescript >=4.8.4 <6.1.0`, verbatim) both fail on it. The TS7 support request was closed as not planned. Stable programmatic API targeted for TS 7.1, ~Oct 2026 — **date unverified from a Microsoft primary source**. |
| `pnpm` | 11.18.0 | Requires Node ≥22.13, pure ESM, SQLite store index. Native release management (`pnpm change` / `pnpm lane`) shipped in 11.13 — **verified only from release-note summaries**. |
| `vite` | 8.2.0 | Rolldown default. `build.rollupOptions` → `build.rolldownOptions`; `cssMinify` switched to Oxc; Yarn PnP unsupported. Unpacked: `middlewareMode?: boolean \| { server: HttpServer }` (D10). |
| `vitest` | 4.1.10 | Unpacked: `test.projects`, `defineProject` present, **`defineWorkspace` absent** (removed in v4). `toMatchFileSnapshot`, `expect.addSnapshotSerializer`, `onTestFinished` all present. 5.0.0-beta.7 exists — do not chase it. |
| `tsdown` | 0.22.14 (exact pin) | Unpacked: `engines ^22.18.0 \|\| >=24.11.0`, peer `typescript ^5 \|\| ^6 \|\| ^7`. Still 0.x — expect config churn. `tsup@8.5.1` (2025-11-12) and `unbuild@3.6.1` (2025-08-15) are dead ends. |
| `@biomejs/biome` | 2.5.6 | **Correction:** `.vue` support is not merely "experimental" — it is **off by default**, gated behind `"html": { "experimentalFullSupportEnabled": true, "formatter": { "enabled": true } }`. Without it `biome check` silently no-ops on `.vue` files. |
| `oxlint` | 1.76.0 | **Correction:** type-aware linting went stable in **1.75.0**; 1.76.0 is merely the current latest. `--type-aware` is a real flag; peer `oxlint-tsgolint >=7.0.2001`. Lints only the `<script>` block of `.vue` files — `eslint-plugin-vue` template rules are explicitly not a compatibility target. |
| `oxlint-tsgolint` | 7.0.2001 | Versioning scheme is `TypeScript 7.0.2 + tsgolint patch 001`; 59/61 targeted typescript-eslint type-aware rules. 12–18× faster than ESLint + typescript-eslint on four large codebases (M4 Pro) — **vendor benchmark, not reproduced here**. |
| `eslint` / `eslint-plugin-vue` / `typescript-eslint` | 10.8.0 / 10.10.0 / 8.65.0 | Deferring ESLint is not just scope: `eslint-plugin-vue@10.10.0` peers `@typescript-eslint/parser ^7\|\|^8`, which transitively re-imports the `typescript <6.1.0` constraint. |
| `hono` / `@hono/node-server` | 4.12.33 / 2.0.12 | `hono/streaming`'s `streamSSE` supports per-event `id`. |
| `pino` / `pino-pretty` | 10.3.1 / 13.1.3 | Operator diagnostics only. Never a second event store (NF10). |
| `zod` | 4.4.3 | |
| `publint` / `@arethetypeswrong/cli` | 0.3.22 / 0.18.5 | Add to the release script; test the tarball with `pnpm pack` + `npx ./karvan-x.y.z.tgz up` in a clean tmpdir. |
| `@types/node` | 26.1.2 | |
| `playwright` | 1.62.1 | |
| `memfs` | 4.64.0 | **Worthless downstream of a `spawn`** — real `git` and real vendor CLIs cannot see a virtual filesystem. Use `fs.mkdtemp(os.tmpdir())`. |

### Frontend

| Package | Version | Published | Notes |
|---|---|---|---|
| `vue` | 3.5.40 | 2026-07-16 | 3.6.0-rc.2 exists (2026-07-22) — **do not ship on it**; 3.6 rewrites the reactivity core and Vue Flow's compatibility is unverified by either project. |
| `vue-router` / `pinia` | 5.2.0 / 4.0.2 | 2026-07-15 | vue-router 5 is a non-breaking transition release; Pinia 4 is ESM-only with a separate `@vue/devtools-api`. |
| `@vue-flow/core` | 1.48.2 | 2026-01-28 | Peer `vue ^3.3.0`; 345 KB raw `.mjs`; a11y attributes and `useKeyPress` confirmed in the bundle. **Six months without a release, effectively one maintainer — the single largest third-party risk in the frontend.** Wrap in a `GraphCanvas` facade. |
| `@xterm/xterm` | ^6.0.0 | 2025-12-22 | Plus `@xterm/addon-fit@0.11.0`, `addon-webgl@0.19.0`, `addon-serialize@0.14.0`, `addon-search@0.16.0`. **`@xterm/addon-canvas` was removed in v6** — renderer is DOM or WebGL only. Also removed: `windowsMode`, `fastScrollModifier`; `overviewRulerWidth` moved under `overviewRuler`. Unscoped `xterm` is frozen at 5.3.0. |
| `elkjs` | 0.12.0 (exact pin) | 2026-07-17 | Tarball unpacked. `elk-worker.min.js` = **1,595,334 bytes**; `elk.bundled.js` = **1,609,707 bytes**. No `exports` map, so deep imports (`elkjs/lib/elk-api`, `elkjs/lib/elk-worker.min.js`) resolve. `workerFactory` is a supported construction path; the worker self-registers its message handler in worker scope. All 12 ELK option IDs confirmed as literal strings in the bundle. |
| `@dagrejs/dagre` / `@dagrejs/graphlib` | 3.0.0 / 4.0.1 | 2026-03-22 | Real `exports` map, dual CJS/ESM confirmed. Unscoped `dagre` is 0.8.5, **2019-12-03**. Note the Vue Flow docs' repl pins `@dagrejs/dagre@1.1.2`, two majors behind — copied example code targets an older API. |
| `shiki` + `@shikijs/*` | 4.4.1 | 2026-07-31 | Use `createHighlighterCore` from `@shikijs/core` + `@shikijs/engine-javascript` with ~12 lazily-imported langs. The bundled entry pulls every grammar (multi-MB). |
| `@git-diff-view/vue` | 0.1.7 (exact pin, no caret) | 2026-07-13 | Pre-1.0. Read the changelog before bumping. |
| `rfc6902` | 5.3.0 | 2026-07-23 | Maintained (5.2.0 2026-02-27). `fast-json-patch@3.1.1` last shipped **2022-03-25** — dead. |
| `ohash` | 2.0.11 | 2025-03-04 | **Confirmed:** `src/serialize.ts` sorts keys (`Object.keys(object).sort((a,b) => a.localeCompare(b))`), map/set entries sorted via a compare fn. **Caveat:** the README promises only "best efforts" at stable serialization and says explicitly it is not for security. Fine for a change-detection content hash; not for anything needing stability across versions. |
| `eventsource-client` | 1.2.0 | — | fetch + WebStreams based; supports headers, arbitrary methods, configurable reconnection, `initialLastEventId`, and runs in Node so the CLI shares the client module. `@microsoft/fetch-event-source@2.0.1` (2021-04-25) is abandoned despite topping search results. |
| `reka-ui` / `shadcn-vue` | 2.10.1 / 2.8.1 | — | `radix-vue@1.9.17` is the dead predecessor name. |
| `tailwindcss` + `@tailwindcss/vite` | 4.3.3 | — | |
| `@vueuse/core` | 14.4.0 | — | |
| `@tanstack/vue-virtual` | 3.13.35 | — | For the full-log viewer. Never stream an archive into xterm. |
| `echarts` / `vue-echarts` | 6.1.0 / 8.0.1 | 2026-05-19 | P1 only (F10.11). Import from `echarts/core` with explicit registration: ~150 KB, not 1 MB. |
| `d3-*` submodules | `d3-scale` 4.0.2, `d3-shape` 3.2.0, `d3-array` 3.2.4, `d3-axis` 3.0.0, `d3-time-format` 4.1.0 | — | The `d3` metapackage is 7.9.0 (2024-03-12, no v8). Use as a maths library only — never mix `d3-selection` into Vue components. |

### Context, telemetry and safety

| Package | Version | Notes |
|---|---|---|
| `@opentelemetry/sdk-node` | 0.221.0 | |
| `@opentelemetry/exporter-trace-otlp-http` | 0.221.0 | |
| `@opentelemetry/semantic-conventions` | 1.43.0 | 130 `GEN_AI` exports enumerated locally from `/incubating`, including the `gen_ai.operation.name` value set (`chat`, `create_agent`, `embeddings`, `execute_tool`, `generate_content`, `invoke_agent`, `invoke_workflow`, `retrieval`, `text_completion`) and `gen_ai.usage.cache_read/cache_creation.input_tokens`. Both `gen_ai.provider.name` and the deprecated `gen_ai.system` ship side by side. |
| `gpt-tokenizer` | 3.4.0 | Fastest pure-JS BPE; encodings `r50k_base`, `p50k_base`, `p50k_edit`, `cl100k_base`, `o200k_base`, `o200k_harmony`. **Undercounts Claude tokens by ~15–20% on prose and more on code and non-English** (Anthropic's own docs). Self-calibrate against Tier-1 actuals. |
| `@anthropic-ai/tokenizer` | 0.0.4 | **A trap.** Implements only the Claude 1/2-era BPE, wrong for every current model, but the package name looks authoritative. There is no public exact tokenizer for Claude 3+; the only exact path is the credentialed `/v1/messages/count_tokens` endpoint, which AR-1 puts off-limits on the subscription path. |
| `ajv` / `ajv-formats` | 8.20.0 / 3.0.1 | |
| `secretlint` | 13.0.4 | Node-native, pluggable, programmatic API, JSON/SARIF output. Use `gitleaks`' 150+ regexes as a **ruleset donor**, not a runtime dependency. **Do not use trufflehog** — its verification feature makes outbound calls carrying candidate secrets to third-party APIs, which violates NF1 outright. |
| `sqlite-vec` | 0.1.9 stable / 0.1.10-alpha.4 | Deferred entirely by D15. Single-maintainer, pre-1.0 after two years, last commit 2026-05-18, open issue asking whether it is maintained. `sqlite-vss` is deprecated by its own author. |
| `simple-git` | 3.36.0 | **No worktree API** — grep of its `.d.ts` for `worktree` returns zero hits. |
| `isomorphic-git` | 1.40.0 | **No worktree support at all** — full runtime export list enumerated. Cannot create worktrees the real `git` CLI will honour. |
| `nodegit` | 0.27.0 / 0.28.0-alpha.38 | Abandoned for this purpose; needs node-gyp; libgit2 still lacks relative-worktree support. |
| `dugite` | 3.2.2 | The one defensible alternative (ships a known-good git). ~40 MB — fights `npx karvan up`. |
| `@devcontainers/cli` | 0.88.0 (2026-07-22) | P1. `devcontainer up`/`exec` both require `--workspace-folder`. |
| `@anthropic-ai/sandbox-runtime` | 0.0.67 | OS-level isolation with **no Docker** — may satisfy the F5.8 use case while preserving NF6. |
| Apple `container` | **1.2.0** (2026-07-29) | Correction: not 1.0.0. 1.1.0 landed 2026-07-06. Three releases in under two months. Still macOS 26 + Apple Silicon only, so the P1 deferral stands — but track quarterly, not annually. |
| system `git` | **≥ 2.38** required, **≥ 2.45** preferred | 2.38 for `merge-tree --write-tree`; 2.45 for stable `worktree list --porcelain -z`. Check in `karvan doctor`. |

---

## 4. Measured numbers

Every number below was produced by running code. Read the conditions before trusting one.

### SQLite ledger benchmarks

**Conditions:** better-sqlite3 13.0.2 on Node 22.22.2, Linux container, likely overlayfs,
`journal_mode=WAL`, `synchronous=NORMAL` unless stated. **Absolute fsync-sensitive numbers will
differ on macOS APFS**, which uses `F_FULLFSYNC` and is typically *slower* for fsync than Linux —
re-run before fixing the `synchronous=` setting. The relative shape should hold.

| Measurement | Result |
|---|---|
| 500,000 events, one combined table | 193 MB on disk, inserted in 4.8 s |
| Full replay scan, all 500k rows | **416 ms** |
| Control-plane-only replay, 10,000 rows via partial index | **29 ms** (`EXPLAIN QUERY PLAN` confirms `SEARCH … USING INDEX event_run_ctl`) |
| 1,000 SSE tail queries (`WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500`) | **196 ms total, ~0.2 ms each**, served by a covering index |
| Append throughput, one transaction per event, `synchronous=NORMAL` | **22,982 ev/s** |
| Append throughput, one transaction per event, `synchronous=FULL` | **979 ev/s** — a **~23×** penalty |
| Batched appends | ~7× improvement over per-event transactions |
| WAL growth while one lazy `iterate()` cursor stayed open across 20k writes | **82.6 MB** `-wal` file; `wal_checkpoint(TRUNCATE)` returned `{busy:0, log:0, checkpointed:0}` and reclaimed nothing until the cursor closed |
| SIGKILL mid-write, then reopen | **45,339** committed rows all present, `PRAGMA integrity_check` = `ok` |
| `VACUUM INTO` on the 193 MB database | **1,007 ms** — an acceptable pre-migration safety net |
| `db.backup()` on the same database | **1,633 ms** |
| Second connection's `BEGIN IMMEDIATE` during a write | `SQLITE_BUSY` — one writer only, confirmed |
| `setTimeout(2**31)` | Callback fired after **1 ms** with only a `TimeoutOverflowWarning` |

**What these numbers mean:** a 40-node multi-hour run produces on the order of 2k control-plane
events. Replaying that is single-digit milliseconds. Spend the complexity budget on effect
reconciliation and the scheduler, not on a snapshot subsystem. (**Unverified assumption:** the ~2k
figure assumes per-step control events. If a node emits per-tool-call events instead, this could be
10–100× higher. Instrument control-plane events per run early and revisit past ~100k.)

### Install timings

**Conditions:** linux-x64, npm, warm registry, inside the container.

| Package | Result |
|---|---|
| `better-sqlite3@13.0.2` | **1 second**, 27 MB `node_modules`, zero compilation, zero node-gyp, zero prebuild-install fetch |
| `@lydell/node-pty@1.2.0-beta.14` | **514 ms**, prebuilt, real `/dev/pts/0` verified |
| `node-pty@1.1.0` | **Failed** — fell back to `node-gyp rebuild` in a toolchain-less environment |

**Caveat:** better-sqlite3's install was measured on linux-x64 only. The tarball demonstrably contains
`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linuxmusl-{x64,arm64}` and `win32-{x64,arm64}` binaries,
but none of them could be executed here. **Verify on the author's macOS machine before committing.**

### xterm.js scrollback arithmetic

Read out of the `@xterm/xterm@6.0.0` source, not from a blog: `BufferLine` allocates
`new Uint32Array(3 * cols)` = **12 bytes per cell**. Default option is `scrollback: 1000`.
`MAX_BUFFER_SIZE = 4294967295`.

| At 200 columns | Memory |
|---|---|
| One line | ~2.4 KB raw, ~2.6 KB with object overhead |
| 5,000 lines (the recommended cap) | ~13 MB |
| 10,000 lines | ~26 MB |
| 100,000 lines | **~260 MB per terminal** |

With several node terminals open, that is a dead tab. Set `scrollback: 5000` and never raise it; the
browser terminal is a live tail, not the archive. Separately, browsers cap WebGL contexts at roughly
8–16, so undisposed terminals silently kill rendering in the oldest ones — `dispose()` on unmount and
restore via `@xterm/addon-serialize`.

### Frame and stream sizes

| Measurement | Result |
|---|---|
| A *trivial* `claude -p "say ok"` turn | emitted a single **16,024-byte** JSON line (the `system/commands_changed` frame) |
| Node stream `highWaterMark` on this machine | **65,536** bytes |
| Linux `/proc/sys/fs/pipe-max-size` | **1,048,576** bytes |
| `elkjs` worker bundle | **1,595,334** bytes (`elk-worker.min.js`); **1,609,707** bytes (`elk.bundled.js`) |
| `@vue-flow/core` ESM bundle | **345 KB** raw |
| Claude Code 2.1.220 `cli.js` | **11.5 MB**, containing **zero** occurrences of `gen_ai.` |

Design consequences: enforce your own **8 MiB** frame cap upstream of the ACP SDK (whose `LineBuffer`
has none), spill single event payloads over ~**256 KiB** to a content-addressed blob store, and keep a
**1 MiB** ring buffer per ACP terminal. Consume child stdout with `for await (const chunk of …)`, never
`.on('data')` with an `async` handler — the latter is flowing mode with an unbounded in-memory queue,
and awaiting a SQLite write inside it buffers everything in RAM.

### Claude Code internals (decoded from the shipping bundle)

**Verified 2026-08-02** by reading `/opt/node22/lib/node_modules/@anthropic-ai/claude-code/cli.js` at
version **2.1.220**. These are **private implementation details with no compatibility guarantee and
they will change** — this is exactly PRD risk G7. Assert them in the F3.4 conformance suite so drift
is caught by `karvan doctor`, and read `modelUsage[m].contextWindow` / `maxOutputTokens` from the
result envelope at runtime rather than hardcoding.

```
effectiveWindow   = contextWindow - min(maxOutputTokens, 20_000)   // WUY = 20000
autoCompactThresh = effectiveWindow - 13_000                       // fhA = 13000
warningBuffer     = 20_000 (GUY)   errorBuffer = 20_000 (ZUY)   blockingBuffer = 3_000 (VhA)
summariser bounds = { minTokens: 10_000, maxTokens: 40_000, minTextBlockMessages: 5 }
```

For a 200k window with 32k max output: effective 180k, auto-compaction firing at 167k, i.e. ~83.5% of
the raw window. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is applied as
`Math.min(pct * effectiveWindow, defaultThreshold)` — **it can only make compaction fire earlier,
never later**, which happens to be the direction F6.6 wants. Note a compaction summary can itself eat
40k tokens.

Also decoded: the `compact_boundary` event shape (`{trigger, pre_tokens}` only); the result-envelope
zod schema, in which `usage` is typed `z.unknown()` (a raw passthrough — **use `modelUsage` instead**,
which is typed and includes `contextWindow`); the `claude_code.*` metric registration on meter
`com.anthropic.claude_code`; and the `/context` category taxonomy (System prompt, System tools, MCP
tools, Agents, Slash commands, Skills, memory files, then `userMessageTokens`,
`assistantMessageTokens`, `toolCallTokens`, `toolResultTokens`, `attachmentTokens`, free space,
autocompact buffer) — worth copying for F10.5's stacked bar, because it will line up visually with
what the user sees inside Claude Code.

---

## 5. The adversarial verification pass

A separate fact-check pass re-examined ten load-bearing claims from the recommendations against
primary sources. Where it disagrees with the research, **the verification pass wins**.

**CONFIRMED (4):**

- **`ohash@2.0.11` gives stable key ordering.** Source confirms sorted keys and sorted map/set
  entries. Qualified: the README promises only "best efforts" and disclaims security use.
- **`rfc6902@5.3.0` is maintained** — two releases in six months (5.3.0 2026-07-23, 5.2.0 2026-02-27).
- **`fast-json-patch` last shipped 2022** — 3.1.1, timestamp 2022-03-25, nothing since.
- **arXiv 2406.05560 is "A Shape Change Enhancing Hierarchical Layout for the Pairwise Comparison of
  Directed Acyclic Graphs"** (Guckes, Schäpers, Pohl, Kerren, von Landesberger; 2024-06-08).
  Note the paper's technique is the **opposite** of how it was framed: it deliberately *amplifies*
  shape change by swapping changed subgraphs outward to make diffs salient. It is not a
  position-pinning layout, so do not cite it as support for one.

**CORRECTED (5):**

| Claim as written | Correction |
|---|---|
| "Biome's `.vue` support is experimental" | Not merely experimental — **off by default**. Requires `"html": { "experimentalFullSupportEnabled": true, "formatter": { "enabled": true } }` in `biome.json`. Without it `biome check --write` silently no-ops on `.vue` files rather than mangling them. Also: type-aware linting went stable in **oxlint 1.75.0**, not 1.76.0; and `noVueDuplicateKeys` was promoted in Biome **2.4**, not 2.5 (2.5's Vue work was a different batch of 16 rules). |
| "The Vue Flow docs example still imports `dagre`" | **Factually false.** `bcakmakoglu/vue-flow` master already imports `@dagrejs/dagre` in both layout examples. The only residual staleness is prose linking to `github.com/dagrejs/dagre` by the name "dagre", and a repl CDN pin at `@dagrejs/dagre@1.1.2` (two majors behind 3.0.0), so copied example code targets an older API. **The real reason to avoid unscoped `dagre` is simply that it has not shipped since 2019-12-03.** |
| ELK `layerChoiceConstraint` + `positionChoiceConstraint` pins layout | The option IDs are real and correctly spelled, but the mechanism as described **will not work**. `layerChoiceConstraint` "is not part of any of ELK Layered's default configurations and is only evaluated as part of the `InteractiveLayeredGraphVisitor`" — you must set `org.eclipse.elk.interactiveLayout=true`, and ELK's own docs note the constraints need a *second* layout run. `semiInteractive` derives order from **`org.eclipse.elk.position`**, not from `positionChoiceConstraint`, requires `crossingMinimization.strategy == LAYER_SWEEP`, and targets *parents*, not nodes. There are open reports of constraints not being respected in elkjs specifically (kieler/elkjs#327, eclipse/elk#883). **Make the union-graph-laid-out-once approach the primary mechanism for the plan scrubber; treat interactive constraints as an experiment to spike.** |
| "Animate with your own `translate3d` on the node wrapper" | Self-contradictory. Vue Flow's `NodeWrapper` writes an inline `transform: translate(...)` on `.vue-flow__node` and **overwrites yours on every position update**. Add only `transition: transform 200ms ease-out` and let Vue Flow's own transform writes animate. Guard it: disable during drag and during viewport pan/zoom, or every interaction gets a 200 ms lag. |
| "Container isolation: devcontainers, bind-mount `~/.claude`; Apple `container` is at 1.0.0" | Four fixes. (1) Apple `container` is at **1.2.0** (2026-07-29); 1.1.0 landed 2026-07-06. macOS 26 + Apple Silicon only, so the P1 deferral survives, but track quarterly. (2) **Do not bind-mount `~/.claude`** — Anthropic's docs advise against mounting host secrets. Authenticate fresh inside the container and persist in a named Docker volume, or inject a short-lived `CLAUDE_CODE_OAUTH_TOKEN`. This *strengthens* AR-1. (3) Drop the `@dagger.io/dagger@0.21.8` citation from the container-use bullet — that npm package is the Dagger TS SDK, not container-use's dependency (container-use is a Go binary). (4) Anthropic's recommended install path is the Dev Container **Feature** `ghcr.io/anthropics/devcontainer-features/claude-code:1.0`, not the reference container, which their docs describe as "a working example rather than a maintained base image". Pin the CLI version inside it and set `DISABLE_AUTOUPDATER=1` for reproducibility. |

**UNVERIFIABLE (2) — these must never be stated as fact:**

1. **"No npm package does visual DAG diffing as of mid-2026."** A negative existence claim that cannot
   be proven from primary sources. Registry searches found no counterexample, but the honest phrasing
   is **"none found"**.
2. **"The plan scrubber is about 200 lines."** An effort estimate, not a checkable fact, and it looks
   optimistic against the pieces actually enumerated. Do not plan against it.

---

## 6. What remains unverified

Each row is an open risk with the specific check that closes it. These become M0 spikes in
[17-roadmap.md](./17-roadmap.md).

| # | Open question | Area | Closing check |
|---|---|---|---|
| U1 | **No full ACP prompt cycle was ever run.** Streaming, permission-prompt and cancellation semantics are read from the SDK and spec, not observed. | Adapter | Run `session/new` → `session/prompt` → `session/update` → `session/cancel` end to end against Claude and Codex adapters. **The riskiest single assumption in the whole research set.** |
| U2 | Whether ACP surfaces token usage, compaction events or context-window state **at all**. If it does not, D8 silently costs F9.1 and F10.5. | Adapter / Context | Inspect `session/update` payloads during U1. Non-obvious tradeoff — check explicitly alongside the M0 kill criterion. |
| U3 | MCP SDK ↔ 2026-07-28 spec skew (SDK 1.30.0 ships `2025-11-25`; the blog claims Tier-1 support shipped). | Adapter | Re-check npm dist-tags before building on the stateless core, `Mcp-Method`/`Mcp-Name` routing headers, or the removal of `Mcp-Session-Id`. Karvan's stdio transport is unaffected either way. |
| U4 | ACP **v2 timing**. The v2 schema ships as `schema.unstable.json` and removes `fs/*` and `terminal/*` from the client. No announced timeline. | Adapter | Watch the spec repo. If v2 stabilizes during the build, the fs/terminal work moves to MCP. |
| U5 | Cursor CLI — could not be installed or probed; all flags are documentation-only. | Adapter | Install the real Cursor CLI before committing to a Cursor adapter. |
| U6 | Goose and Aider flags are documentation-only; Aider's version is disputed. | Adapter | Drop Aider from v1. Verify Goose after its org handoff settles. |
| U7 | `@lydell/node-pty` is a **beta of a community fork** (1.2.0-beta.14). | Adapter | Re-check for a stable release; keep it an `optionalDependency` with a no-TTY fallback. |
| U8 | **Windows process-tree termination untested.** No process groups on Windows. | Adapter / Safety | Verify the `taskkill /T /F` path when Windows support begins (M2/M3). |
| U9 | macOS fsync behaviour — all durability numbers came from Linux + overlayfs. | Persistence | Re-run the append benchmark on the author's laptop before fixing `synchronous=`. |
| U10 | better-sqlite3 prebuilts were only **executed** on linux-x64. | Persistence | Install and open a DB on macOS (Apple Silicon, and Intel if relevant). |
| U11 | `@types/better-sqlite3@9.6.0` lags the package major; coverage of `db.explain()` and `stmt.toString()` unconfirmed. | Persistence | Low impact — worst case a small local `.d.ts` augmentation. |
| U12 | The "~2k control-plane events per run" assumption behind "no snapshotting needed". | Persistence | Log control-plane events per run from day one; revisit if any run exceeds ~100k. |
| U13 | WHATWG SSE spec text could not be read (403). `Last-Event-ID` semantics rest on search summaries plus prior knowledge. | Realtime | Spot-check against the spec before implementing the resume endpoint. Low risk — long-stable spec. |
| U14 | Per-vendor `supportsResume` for the **CLI shim** path (only Claude Code's `--resume` was confirmed, and via search). | Adapter | Probe each shim during the conformance suite build. |
| U15 | Node's "no TypeScript inside `node_modules`" rule vs pnpm workspace symlinks — the one load-bearing assumption in the zero-build dev loop, reasoned about but not executed. | Tooling | 10-minute spike: two packages, `exports: './src/index.ts'`, run `node packages/daemon/src/main.ts`. Fallback is `tsx watch`. |
| U16 | TypeScript 7.1 timing (~Oct 2026) — could not be confirmed from a Microsoft primary source. | Tooling | If it slips, the TS 6.0.3 pin holds longer. If it lands, flip the workspace once and re-verify vue-tsc, typescript-eslint and oxlint-tsgolint together. |
| U17 | Feature/status claims for Biome, oxc, Vitest, tsdown and pnpm came from search summaries (all five sites 403'd). Versions and package internals were verified from tarballs. | Tooling | Re-read the official docs before committing config. |
| U18 | `pnpm/action-setup@v6` and `actions/setup-node@v6` are "current" per search summaries only. | CI | Check the latest tags before pinning. A newer combined `pnpm/setup` action also exists, unevaluated. |
| U19 | **elkjs + Vite 8 worker wiring** — could not run a build. elkjs's own README acknowledges GWT-transpilation bundler friction. | Frontend | M0 spike alongside the ACP spike. Fallback: `@dagrejs/dagre` for the live graph, ELK only for cached scrubber layouts. |
| U20 | **Vue Flow with Vue 3.6** — peer range allows it, but 3.6 rewrites reactivity (alien-signals) and Vue Flow's store leans on it. No compatibility statement from either project. | Frontend | Do not upgrade until Vue Flow publishes a release naming 3.6. |
| U21 | **Vue Flow bus factor** — 1.48.2 shipped 2026-01-28; six months, effectively one maintainer, no roadmap. | Frontend | Mitigate now with a `GraphCanvas` facade (one day). Re-check release activity before M2. |
| U22 | Vue Flow's performance ceiling is an extrapolation, not a measurement. | Frontend | 400-node stress fixture in week one, before committing F10.4 to Vue Flow. |
| U23 | xterm.js v6 breaking-change list was read via a summarizer that got the release date wrong (reported 2024-12-22; npm says 2025-12-22). | Frontend | Re-read the real changelog before writing terminal code. |
| U24 | The **GenAI semconv repo has no releases**, so there is no schema URL to pin. The most volatile dependency in the observability area. | Telemetry | Re-check `open-telemetry/semantic-conventions-genai` releases at the start of M2. Dual-emit during any transition. |
| U25 | Claude Code internals (compaction constants, `compact_boundary` shape, `modelUsage` fields, `claude_code.*` metrics) come from **one version's bundle**, statically. No `claude -p` call was executed. | Context / Telemetry | Validate empirically in M0; assert all of them in the conformance suite. Particularly unconfirmed: whether `structured_output` is populated in every success case. |
| U26 | Token accounting for Copilot, Gemini/Antigravity, Cursor and OpenCode — **unknown whether they report usage in machine-readable output at all**. Only Claude Code and Codex were verified. | Context | Make `tokenAccounting: 'exact' \| 'estimated' \| 'none'` an explicit field in the F3.5 capability manifest, and degrade the UI honestly when it is `none`. |
| U27 | The 500–2,000 token subagent return budget is practitioner consensus, not a controlled study. | Context | Tune from Karvan's own F10.11 data. |
| U28 | Codex's CLI **flag surface** (`-s/--sandbox`, `-a/--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`) is secondary-source only; the sandbox/approval **enum values** are primary-verified from `codex-rs/protocol/src/protocol.rs`. | Safety | Run `codex --help` and `codex exec --help` against 0.146.0 before coding the shim. |
| U29 | Codex's new `SandboxPolicy::ExternalSandbox { network_access }` — potentially ideal (lets Codex skip its own sandbox when Karvan provides isolation, avoiding nesting), but **how to select it from the CLI or config.toml is unknown**, or whether it is user-selectable at all. | Safety | Investigate — it could meaningfully simplify the layering. |
| U30 | Codex's `AskForApproval::Granular(GranularApprovalConfig)` is newer than most documentation, and `on-failure` is now merely an alias for `on-request`. | Safety | A direct argument for the ACP path over flag-driving. |
| U31 | Claude Code sandbox settings are **version-gated at fine granularity** (`filesystem.disabled` ≥2.1.216, `credentials` ≥2.1.187, `mask` mode ≥2.1.199, `strictAllowlist` ≥2.1.219, classifier routing ≥2.1.218). | Safety | Karvan must detect the CLI version and degrade the ladder accordingly, or fail closed. Exactly the G7 burden. |
| U32 | **macOS 26 Tahoe Seatbelt regressions** — zsh 5.9 reads `hw.*` sysctls not in the allowlist, causing sandbox init failures across Claude Code (issues #55849, #26095, #49820) and Cursor. Whether 2.1.220 fixes it is unverified. | Safety | Test on Tahoe before promising `worktree`-level enforcement on current macOS. |
| U33 | **Ubuntu 24.04+ AppArmor** blocks bubblewrap's user namespaces by default (`kernel.apparmor_restrict_unprivileged_userns=1`), silently breaking Linux sandboxing until `/etc/apparmor.d/bwrap` is installed. | Safety | Must be a `karvan doctor` check. |
| U34 | git worktree behaviour on **macOS/APFS** untested — case-insensitivity could cause path collisions for node ids differing only in case. | Safety | Sanitize ids to a single case. |
| U35 | **Submodules across worktrees untested.** Git's submodule support in linked worktrees has historically been incomplete. | Safety | Prototype early if target repos use submodules. |
| U36 | Whether `git worktree lock` survives a macOS sleep/wake cycle, and whether the stale-lock release path handles recycled pids after a long suspend. | Safety | Real testing across sleep. |
| U37 | ACP adapters for Claude Code and Codex are **bridges, not first-party vendor implementations**. Their fidelity to the underlying CLI is the main risk to D8. | Adapter | Target the F3.4 conformance suite at the **adapters**, not just the CLIs. |
| U38 | The specific pnpm worktree config keys (pnpm.io 403'd). The store-sharing mechanism itself is long-established. | Tooling | Check the page before documenting keys. |
| U39 | The Anthropic subscription / Agent-SDK-credit situation (see Tier 4 above) — sources conflict with PRD §5.1. | Policy | Confirm against Anthropic's own docs. Affects §9 economics and F9.4. |

---

## 7. Papers and primary sources

### The three arXiv papers cited in the PRD — all confirmed to exist

**Fetch caveat that applies to all three:** `arxiv.org` and `export.arxiv.org` both returned 403 to
automated fetch from this environment, and Bash egress blocked `export.arxiv.org` by allowlist.
Titles, IDs, authors, abstract text and the quantitative claims below were returned **consistently
across independent search queries**, i.e. confirmed via search-engine indexing of the arXiv abstract
and HTML pages — **not** by reading the PDFs. Treat the specific numbers as high-confidence but
secondhand, and **re-verify before quoting them publicly**.

**arXiv 2606.22528 — "Governance Decay: How Context Compaction Silently Erases Safety Constraints in
Long-Horizon LLM Agents."** Shiyang Chen (Beijing Institute of Technology), submitted 21 June 2026,
currently v2. Introduces the **ConstraintRot** benchmark with deterministic tool-call violation
grading. Across **1,323 episodes over seven model families**, the constraint-violation rate is **0%**
with the policy fully in context and rises to **30%** after compaction, reaching **59%** for the worst
model. Crucially the paper also supplies the mitigation F6.6 already assumes: **Constraint Pinning**
extracts governance constraints into a pinned buffer exempt from compaction, re-injected verbatim
after every compaction step with integrity checking, restoring the violation rate to **0% across all
seven models** at negligible cost. This is the direct evidence base for
[08-context-and-memory.md](./08-context-and-memory.md).

**arXiv 2605.08580 — "Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon
Agents."** Zhuofu Chen, Rui Pan, Yinwei Dai, Ravi Netravali (Princeton). Code at
`github.com/chenzhuofu/slipstream`. The PRD's one-line description is accurate. Core argument:
compaction normally runs synchronously on the critical path and degrades accuracy through a
"structural validation gap" — the compactor cannot know what the agent will need later. Slipstream
runs the compactor asynchronously while the agent continues on the *original* context, so the
candidate summary and the agent's real next steps are generated independently from the same
pre-compaction state; the real trajectory then becomes an independent validation signal. Reported:
**accuracy +6.4–8.8%** over synchronous compaction, **end-to-end latency reduced up to 39.7%**, with
the accuracy gain attributed to the validation rather than the asynchrony.

**arXiv 2605.18747 — "Code as Agent Harness."** Led by Xuying Ning with ~42 co-authors, May 2026.
A **survey of ~197 papers** in three layers: harness interface (code as the connective tissue between
agent reasoning, action and environment modelling), harness mechanisms (planning, memory, tool use for
long-horizon execution), and feedback-driven control. Companion repo
`github.com/YennNing/Awesome-Code-as-Agent-Harness-Papers`. **It is a survey, not an empirical
result** — cite it as a taxonomy/landscape reference, never as evidence for a specific design claim.

### Two additional 2026 preprints found during this research

Same fetch caveat: **confirmed via search-engine indexing, not read directly.** Both are single-author
or small-team preprints with **no independent replication**. They are strong prior art; neither should
be cited as validated evidence.

**arXiv 2604.20911 — "Omission Constraints Decay While Commission Constraints Persist in Long-Context
LLM Agents."** 4,416 trials, 12 models, 8 providers. Reports a **Security-Recall Divergence**:
omission compliance (prohibitions) falls from **73% at turn 5 to 33% at turn 16**, while commission
compliance (requirements) holds at **100%**. Worse, the asymmetry is invisible to standard monitoring
because commission-type audit signals stay healthy. Two design consequences, both cheap: re-inject
pinned constraints on a **turn interval**, not only on compaction; and **restate every prohibition as
a positive requirement** mechanically in the packet builder ("only write files under `src/checkout/**`"
survives context pressure far better than "do not write outside `src/checkout/**`"). **Recommend
adding this to the PRD's source list** — it is a distinct failure mode from compaction deletion and
needs its own mitigation.

**arXiv 2606.23752 — "ESAA-Conversational: An Event-Sourced Memory Layer for Continuity, Handoff, and
Curation Across Heterogeneous LLM Coding Agents"** (22 June 2026). Direct prior art for Karvan's
ledger-plus-projection design.

**arXiv 2606.12329 — "PROJECTMEM: A Local-First, Event-Sourced Memory and Judgment Layer for AI Coding
Agents"** (University of Utah). Code at `github.com/riponcm/projectmem`. Source of the
**"Memory-as-Governance" pre-action gate** idea, which is genuinely worth stealing. Their existence
also means the local-first event-sourced agent memory space is getting crowded — worth a competitive
re-scan before M2.

### Primary sources read directly (not via search)

- `@agentclientprotocol/sdk@1.3.0` tarball — `package.json` exports/peerDeps, `dist/schema/index.js`,
  `dist/v2/schema/index.js`, `dist/acp.d.ts`, `dist/schema/types.gen.d.ts`, `dist/line-buffer.js`,
  `dist/examples/client.js`. (The docs site `agentclientprotocol.com` 403'd, so spec text was read
  from the shipped schema and TypeScript doc comments instead.)
- `@modelcontextprotocol/sdk@1.30.0` tarball — `types.js` protocol constants, transport listing,
  `server/mcp.d.ts`, dependency tree.
- `dbos-inc/dbos-transact-ts` cloned at commit `dfd600cc48537a69f3d57d28108a781bfb82c988` (2026-07-30).
- `openai/codex` — `codex-rs/protocol/src/protocol.rs` (`SandboxPolicy` including `ExternalSandbox`,
  `NetworkAccess`, `WorkspaceWrite`; `AskForApproval` including `Granular`).
- `eclipse-elk/elk` — `plugins/org.eclipse.elk.alg.layered/.../Layered.melk` for option defaults;
  `elkjs@0.12.0` tarball for the shipped option-ID strings.
- `@xterm/xterm@6.0.0` tarball — `BufferLine` allocation, `scrollback` default, `MAX_BUFFER_SIZE`.
- `@vue-flow/core@1.48.2` tarball — exports map, `.d.ts` option surface, a11y attributes in the bundle.
- `typescript@7.0.2` vs `typescript@6.0.3` tarballs — `bin` contents.
- `vite@8.2.0`, `vitest@4.1.10`, `tsdown@0.22.14`, `@dagrejs/dagre@3.0.0` tarballs.
- `/opt/node22/lib/node_modules/@anthropic-ai/claude-code/cli.js` at v2.1.220.
- `@opentelemetry/semantic-conventions@1.43.0` `/incubating` exports, enumerated locally.
- `nodejs.org/api/sqlite.html` (v22, v24, v26 variants), `nodejs.org/api/typescript.html`,
  `nodejs.org/api/cli.html`, `nodejs/Release` `schedule.json`.
- `github.com/open-telemetry/semantic-conventions/releases` and
  `github.com/open-telemetry/semantic-conventions-genai/releases` (verified empty).
- `code.claude.com/docs/en/sandboxing.md`, `/worktrees.md`, `/cli-reference.md`.
- `microsoft/agent-host-protocol` — `docs/guide/ahp-and-acp.md`.
- `sindresorhus/execa` — `docs/termination.md`.
- `inngest/inngest` — `docs/SDK_SPEC.md`.
- `aboutamazon.com/news/aws/aws-service-outage-ai-bot-kiro` — Amazon's official rebuttal.
- Local empirical work: git 2.43.0 worktree and refs experiments; SQLite benchmarks; process-group
  kill experiments with PGID observation; install timings; `setTimeout` overflow; five live ACP
  `initialize` handshakes.

---

**Related:** [PRD](./prd.md) · [Architecture overview](./01-architecture-overview.md) ·
[Tech stack](./02-tech-stack.md) · [Durable execution](./05-durable-execution.md) ·
[Provider adapter layer](./07-provider-adapter-layer.md) · [Roadmap](./17-roadmap.md)

[← Back to index](./README.md)
