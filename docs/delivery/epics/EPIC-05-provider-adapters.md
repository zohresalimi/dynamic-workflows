# EPIC-05: Provider adapter layer

> Part of the [Karvan delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-05-provider-adapters-flows.md)

| | |
|---|---|
| **Epic ID** | EPIC-05 |
| **Status** | Not started |
| **Priority** | P0 |
| **Milestone** | M1 |
| **Workstream** | W3 (see [roadmap §2.2](../../17-roadmap.md)) |
| **Size** | ~28 days across 9 stories (~24 with KAR-05.8 deferred) |
| **Depends on** | EPIC-00 (S1), EPIC-02, EPIC-03, EPIC-04 |
| **Blocks** | EPIC-06, EPIC-08, EPIC-09, EPIC-10, EPIC-11, EPIC-14, EPIC-18 |
| **PRD requirements** | F3.1, F3.2, F3.4, F3.5, F3.6, F4.3, F5.7, NF6, NF7, NF9 |
| **Architecture** | [07-provider-adapter-layer.md](../../07-provider-adapter-layer.md) |

## Goal

At the end of this epic `@karvan/adapters` turns heterogeneous vendor binaries into **one internal event
vocabulary**, without ever holding a credential. Karvan is an ACP client that can `initialize`,
`session/new`, `session/prompt` and stream `session/update` notifications through a pull loop that awaits
the durable append; it probes each installed agent's real capabilities and persists them; it spawns each
vendor by the resolved absolute path with the vendor's own correct invocation; it survives a 10 MB frame
and a wedged agent that never emits a newline; it resumes a node either natively or by replaying the
ledger, depending on what the agent actually advertised; it exposes workflow tools over MCP without
touching the user's config; and a two-layer conformance suite tells you the day a vendor release breaks
any of it.

## Why this matters

This is the highest-churn layer in Karvan and the one where research most sharply contradicted the PRD.
Two corrections are load-bearing: **Claude Code and Codex do not speak ACP** (verified absent from
`claude --help` v2.1.220 and `codex --help` v0.146.0 — grepped, zero hits) and reach it only through
`@agentclientprotocol/claude-agent-acp@0.64.1` and `@agentclientprotocol/codex-acp@1.1.9`; and **two of
five providers cannot resume at all**, so `session/resume` is a token-cost optimisation and never the
durability mechanism.

PRD gap G7 — adapter brittleness — is the reason this epic has a conformance story rather than a single
"write the adapters" story. Codex CLI shipped 0.107 → 0.146 in roughly a year with flag and output
changes; Gemini's unpaid tier migrated to a different CLI in June 2026. Three flag breakages were already
visible in the release set on 2026-08-02. Without the conformance suite, flag churn is detected by a user's
failed three-hour run instead of by CI.

And without KAR-05.4, karvand OOMs. That is not theoretical: the SDK's `LineBuffer` has no maximum line
length, karvand is a long-lived daemon supervising runs for days, and a trivial `claude -p "say ok"` turn
already emits a single 16,024-byte line.

## Scope

**In scope:**

- The ACP client on `@agentclientprotocol/sdk@1.3.0` (exact pin), wire `protocolVersion: 1`, built with
  the modern builder API and the `session.nextUpdate()` pull loop.
- Runtime capability probing persisted to the `provider_capabilities` table, and version/sha256 pinning.
- The provider registry and per-vendor spawn strategies for the five ACP-reachable targets.
- The 8 MiB frame guard, `for await` backpressure, 256 KiB blob spilling and the 1 MiB `terminal/*` ring
  buffer.
- `ResumeNative` and `ResumeByReplay` behind one `ResumeStrategy` interface, selected from the probed row.
- The `karvan-mcp` stdio bin and the MCP host over a Unix domain socket.
- The two-layer conformance suite: `ajv` schema conformance over recorded frames, and
  `providerContract(adapterFactory)` parameterised over adapters. Plus the `KARVAN_RECORD=1` transport tee.
- `detached: true` spawn, three-stage cancellation, `killTree()` and orphan reaping with a PID-reuse guard.
- The CLI exec shim fallback (scope-cut candidate — see KAR-05.8).

**Out of scope:**

- The permission ladder policy itself, path-scope enforcement, the command allowlist and environment
  scrubbing — EPIC-08. This epic builds the **transport-neutral service layer with two thin fronts** those
  policies plug into, and keeps **no business logic in the ACP handlers**.
- A *matrix* of direct API providers (Anthropic, OpenAI, Google, OpenRouter, Bedrock, Vertex, Ollama/vLLM)
  — M2. KAR-05.10 delivers exactly one, `read`-level, as the minimum that satisfies F3.3 and proves the
  adapter abstraction is not merely ACP-shaped. Breadth is a later problem.
- Auth-shadowing detection (F3.8) — EPIC-08 (KAR-08.8) and `karvan doctor` (EPIC-18, KAR-18.4).
- Provider re-routing on exhaustion recorded as a `PlanPatch` (F3.9) — EPIC-11 (KAR-11.6) and EPIC-14.
- The planner's provider-selection logic (F2.7) — EPIC-11. This epic supplies the capability row it reads.
- ACP v2. All five agents negotiate v1; v2 ships as `schema.unstable.json` with no announced timeline. The
  two-fronts split is how v2 becomes a swap rather than a rewrite.
- Cursor, Goose, Aider and Antigravity adapters. All four are unverified;
  [§8.4](../../07-provider-adapter-layer.md) recommends dropping Aider outright and the roadmap drops Cursor
  from M1.

## Definition of Ready (epic level)

- [ ] **M0-S1 is Done and green.** A full `session/new` → `prompt` → `update` → `cancel` cycle has been
      observed against `claude-agent-acp` and one native-ACP agent. This is A0-1, the riskiest unverified
      assumption in the project, and the kill criterion attaches to it.
- [ ] M0-S1 answered the two side questions: does ACP surface token usage or compaction at all, and is
      `structured_output` actually populated on success.
- [ ] EPIC-04 stories KAR-04.1, KAR-04.3 and KAR-04.4 are Done — the client cannot be developed against
      anything else without spending quota.
- [ ] EPIC-03's `Db` port and append path exist, because the pull loop awaits a real durable write.
- [ ] EPIC-02 has emitted `.karvan/schemas/` and the `NodeFailureReason` union, so adapter failures map onto
      typed reasons rather than thrown `Error`s.

## Definition of Done (epic level)

- [ ] All nine stories are Done, or KAR-05.8 is explicitly deferred with the decision recorded on the board.
- [ ] Every scenario in [EPIC-05 flows](../flows/EPIC-05-provider-adapters-flows.md) passes as an automated
      test at the level its `Automated at:` line names.
- [ ] `providerContract()`'s eight assertions pass against every capability profile of the mock agent on
      every commit, and against every installed real CLI under an `@live` tag.
- [ ] Layer A validates every recorded frame in `recordings/` against
      `@agentclientprotocol/sdk/schema/schema.json` in CI.
- [ ] The capability matrix exists **only** as a generated fixture; a grep proves no source file contains a
      hardcoded per-vendor capability table.
- [ ] A `soak` test streams 200 MB of agent output through a real subprocess with the daemon's RSS bounded
      and no frame lost.
- [ ] Every `Unverified` claim in [adapter layer](../../07-provider-adapter-layer.md) that M1 depends on is
      either closed or has an open row in the risks table below naming what closes it.

## User stories

### KAR-05.1 — ACP client: initialize, session lifecycle, streaming updates

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-04.1, KAR-04.2, EPIC-03 |
| **PRD** | F3.1, F4.1, NF9 |
| **Verified by** | EPIC-05-S1, EPIC-05-S2, EPIC-05-S3, EPIC-05-S4, EPIC-05-S5 |

**As** Karvan, **I want** to drive any ACP-speaking agent through one client implementation, **so that**
five vendors cost one integration instead of five, and every file access and command execution passes
through Karvan on the way.

Build with the **modern builder API**, not the legacy `ClientSideConnection` class — the `Client`
interface's `extMethod`/`extNotification` members are marked `@deprecated` in favour of it. Transport is
`acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))`. Register
`session/request_permission`, `fs/read_text_file` and `fs/write_text_file` as request handlers that do
nothing but unwrap params, call the service layer and wrap the result — **~15 lines each, no business
logic**, because ACP v2 deletes all of `fs/*` and `terminal/*` from the client and pushes them onto MCP.

**The `session.nextUpdate()` pull loop is the single most important API detail in this layer.** It is a
pull loop, not a callback registration, and that difference is load-bearing twice over: it gives natural
backpressure (Karvan does not request the next frame until it has finished with the current one, the OS
pipe fills at 64 KiB and the agent blocks in `write()`), and it is the only legal place to `await` the
SQLite append. A callback-style `Client.sessionUpdate` handler gives you nowhere to do that, and awaiting
inside a flowing-mode handler buffers the rest of the stream in RAM.

**Acceptance criteria**

1. `initialize` negotiates `protocolVersion` as the **integer** `1`; a response with any other value fails
   the session with `NodeFailure { reason: 'adapter.handshake-failed', class: 'permanent' }` rather than
   attempting a downgrade.
2. `clientCapabilities` advertised are exactly `{ fs: { readTextFile: true, writeTextFile: true }, terminal: true }`
   at M1; `mcp/*` and `elicitation/*` are not implemented and not advertised.
3. `session/new` is called with `cwd` set to the node's worktree path and the `mcpServers` array from
   KAR-05.6; the returned `sessionId` is recorded in the ledger with the `node.started` event.
4. Each `session/update` notification is translated into a Karvan event and **durably appended before**
   `nextUpdate()` is called again — a test asserts the append completed by observing the ledger's `seq`.
5. On `session/cancel`, the loop **keeps running** until the stop frame arrives; trailing `session/update`
   notifications emitted after the cancel are appended, not discarded, and the prompt resolves with
   `stopReason: 'cancelled'`.
6. No ACP handler contains conditional logic beyond param unwrapping — verified by a line-count assertion
   on `packages/daemon/src/services/fronts/acp-*.ts`.
7. Adapter code never constructs a thrown `Error` as its failure surface; every failure exits through the
   one mapper that produces a `NodeFailure` with a closed `reason`, a `class`, a one-line `message` and
   `evidence` handles.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Client against `karvan-mock-agent`: assert `initialize` result's `protocolVersion === 1` and `typeof === 'number'` | No client exists |
| 2 | integration | Mock configured to answer `protocolVersion: 2`; assert `NodeFailure.reason === 'adapter.handshake-failed'` and no session is opened | The client accepts any version |
| 3 | integration | Full turn against a file-backed SQLite ledger; assert `event` rows for every `agent_message_chunk` in `seq` order matching arrival order | Events are batched or reordered |
| 4 | integration | Instrument the append with a 5 ms delay; assert `nextUpdate()` is not called until the append resolves | The loop reads ahead |
| 5 | integration | 200 chunks of 8 KiB with a slow consumer; assert daemon RSS growth < 32 MiB and all 200 chunks appended | Flowing mode buffers everything |
| 6 | integration | `hangForever` mock + `session/cancel`; assert the two trailing updates are in the ledger **and** `stopReason === 'cancelled'` | The reader is torn down on cancel and the prompt never resolves |
| 7 | unit | `toNodeFailure(thrown)` maps an unmapped throw to `{ reason: 'internal' }` with the stack captured as a handle | Unmapped throws escape as `Error` |
| 8 | unit | Each `fronts/acp-*.ts` file is under 40 lines and contains no `if` on a permission level | Policy leaked into the ACP handler |

**Notes / risks** — this story sits directly on top of A0-1. If M0-S1 did not actually complete a prompt
cycle, streaming, permission-prompt and cancellation semantics are read from the spec and SDK types, not
observed, and this story's estimate is optimistic.

---

### KAR-05.2 — Runtime capability probing and the persisted manifest

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-05.1, KAR-04.4 |
| **PRD** | F3.5, F3.6 |
| **Verified by** | EPIC-05-S6, EPIC-05-S7, EPIC-05-S8, EPIC-05-S9, EPIC-05-S27 |

**As** the planner, **I want** every routing decision to read a row that was probed from the actual binary
on this machine, **so that** Karvan never schedules a node onto an adapter that cannot honour it, and never
believes a documentation claim over a handshake.

Karvan already performs `initialize`. Persist its **full, unmodified** response:

```sql
CREATE TABLE provider_capabilities (
  provider       TEXT    NOT NULL,   -- 'claude' | 'codex' | 'gemini' | 'copilot' | 'opencode' | 'mock'
  version        TEXT    NOT NULL,   -- from `--version`, verbatim
  binary_sha256  TEXT    NOT NULL,   -- sha256 of the resolved entry file
  binary_path    TEXT    NOT NULL,   -- ABSOLUTE, as resolved
  caps_json      TEXT    NOT NULL,   -- the entire initialize response, unmodified
  probed_at      INTEGER NOT NULL,
  PRIMARY KEY (provider, version, binary_sha256)
) STRICT;
```

The primary key is three-part on purpose: a version bump or a rebuilt binary writes a **new row**, so the
history of what an installed agent could do is preserved and a diff is visible. A `provider.probed` event
records the same facts in the ledger. **The measured matrix is a test fixture, never a hardcoded constant**
— two of the five versions in it were published the same day they were measured, and it will be wrong
within a month.

**Acceptance criteria**

1. Probing spawns the adapter, sends `initialize`, stores `caps_json` byte-for-byte as received, and
   terminates the process — it never sends `session/new`, so probing costs no quota.
2. `version` is the verbatim `--version` output and `binary_sha256` is the sha256 of the resolved entry
   file; `binary_path` is absolute.
3. A `provider.probed` event carrying `{ provider, version, capsJson, binarySha256 }` is appended to the
   ledger for every probe.
4. Re-probing an unchanged binary is a no-op on the table (the PK already exists); re-probing after a version
   bump inserts a second row and leaves the first intact.
5. A capability query API answers `canResume`, `canFork`, `supportsTerminal`, `mcpAcp` and
   `mediatedExecution` **only** from the stored row; a grep asserts no source file contains a literal
   per-vendor capability table.
6. Absent, `{}` and explicit `false` are three distinct answers. `caps.session?.resume` on Gemini's response
   (no `sessionCapabilities` key at all) must not be conflated with Codex's explicit `mcp.acp: false`.
7. A node whose `requires` set is not satisfied by the row is **refused scheduling** with
   `NodeFailure { reason: 'adapter.capability-missing', class: 'permanent' }` before any process is spawned.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Probe `karvan-mock-agent --capabilities claude` against file-backed SQLite; assert `caps_json` parses to the exact initialize response | The probe normalises the response |
| 2 | integration | Probe each of the five profiles; assert five rows with distinct PKs and the expected `resume`/`fork`/`list` answers | Profiles are collapsed |
| 3 | unit | `canResume(geminiRow) === false` where the row has no `sessionCapabilities` key; `canResume(codexRow) === true` | Optional chaining returns `undefined` and is coerced truthy somewhere |
| 4 | unit | `mcpAcp(codexRow) === false` distinguishable from `mcpAcp(claudeRow) === undefined` | The two are flattened |
| 5 | integration | Probe twice with the same binary; assert exactly one row and one `provider.probed` event pair handled idempotently | Duplicate PK insert throws |
| 6 | integration | Change the mock's reported `--version`; assert a second row and both rows readable | The row is updated in place, losing history |
| 7 | unit | `admit(node, row)` for a node requiring `session.fork` against the `codex` row returns `adapter.capability-missing` | Admission passes and fails later at runtime |
| 8 | unit | Repo grep: no file under `packages/adapters/src/` matches a literal provider→capability map | A convenience constant was added |

**Notes / risks** — A0-9. This is the highest-value *silent* risk in the layer: a stale matrix does not
produce an error, it produces a wrong routing decision hours into a run. Regenerating the fixture on every
`karvan doctor` run (EPIC-18) and weekly in CI is what closes it.

---

### KAR-05.3 — Provider registry and spawn strategies per vendor

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-05.1 |
| **PRD** | F3.1, F3.6, NF7 |
| **Verified by** | EPIC-05-S10, EPIC-05-S11, EPIC-05-S12 |

**As** Karvan, **I want** each vendor's correct invocation encoded once in a registry, **so that** the
naive assumption "every agent speaks ACP the same way" cannot leak into the spawn path.

This is the verified provider table, and getting it wrong means building the wrong spawn logic for the two
most important providers:

| Vendor | Path | Package @ version | Spawn |
|---|---|---|---|
| Gemini CLI | native ACP | `@google/gemini-cli@0.53.1` | `<abs>/gemini --acp` |
| GitHub Copilot CLI | native ACP | `@github/copilot@1.0.77` | `<abs>/copilot --acp` |
| OpenCode | native ACP | `opencode-ai@1.18.11` | `<abs>/opencode acp --cwd <worktree>` |
| Claude Code 2.1.220 | **adapter required** | `@agentclientprotocol/claude-agent-acp@0.64.1` | `<abs>/claude-agent-acp` |
| Codex CLI 0.146.0 | **adapter required** | `@agentclientprotocol/codex-acp@1.1.9` | `CODEX_PATH=<abs>/codex <abs>/codex-acp` |

OpenCode's is a **subcommand, not a flag**. `codex-acp` honours a **`CODEX_PATH`** environment variable to
select the Codex binary — use it rather than relying on lookup. Gemini's `--experimental-acp` still exists
but `--help` marks it *"(deprecated, use --acp instead)"*: use `--acp` and fall back only if argv parsing
fails. Every binary is resolved to an absolute path at probe time, persisted in the capability row, and
passed explicitly.

**Acceptance criteria**

1. A `ProviderSpec` per vendor declares `{ id, kind: 'native' | 'adapter', resolve(), argv(ctx), env(ctx) }`;
   adding a vendor is one entry, not a new code path.
2. Each spec's `argv` output matches the verified table exactly, asserted against a golden snapshot so a
   change to any vendor's invocation shows as a diff in review.
3. `env(ctx)` for Codex sets `CODEX_PATH` to the resolved absolute Codex binary; no spec relies on `PATH`.
4. Resolution failure produces `NodeFailure { reason: 'adapter.spawn-failed' }` naming the vendor and the
   paths searched — never a bare ENOENT.
5. Gemini attempts `--acp` first; if the child exits with an argv-parse error within the handshake window,
   the registry retries once with `--experimental-acp` and records that it did so.
6. A missing or unauthenticated provider degrades the plan rather than killing the run (NF7): the registry
   reports availability, and `authMethods` from `initialize` is surfaced to the operator as a shell command
   to run themselves.
7. Copilot's `authMethods` entry carrying `_meta["terminal-auth"]` is rendered as a command for the user;
   Karvan **never runs it and never captures its output** (AR-1, NF2), asserted by a test that no adapter
   code path spawns anything from an `authMethods` payload.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `argv()` per vendor matches an inline snapshot: `['--acp']`, `['acp','--cwd',wt]`, `[]`, etc. | Specs are ad-hoc strings at call sites |
| 2 | unit | Codex spec's `env()` contains `CODEX_PATH` pointing at an absolute path | `CODEX_PATH` is omitted |
| 3 | integration | Symlink the mock as `opencode`; assert the spawned argv contains the `acp` subcommand before `--cwd` | The subcommand is passed as a flag |
| 4 | integration | Point a spec at a non-existent path; assert `adapter.spawn-failed` with the attempted path in `detail` | Raw ENOENT propagates |
| 5 | integration | Mock rejects `--acp` with an argv-parse error; assert exactly one retry with `--experimental-acp` and a recorded note | No fallback, or an infinite retry |
| 6 | unit | Repo grep: no adapter source calls `spawn` with a bare command name | Someone reintroduced `PATH` lookup |
| 7 | unit | Feed a Copilot-shaped `authMethods` with `_meta['terminal-auth']`; assert the result is a rendered string and that no spawn occurred | Karvan tries to be helpful and runs the login command |

**Notes / risks** — the adapters for the two most important providers are **community-maintained bridges,
not first-party vendor implementations** (A0-2). Their fidelity to the underlying CLI is the main risk to
the ACP-first thesis, which is why KAR-05.7's conformance battery must target the adapters, not just the
natively-ACP agents.

---

### KAR-05.4 — Frame-size guard, backpressure and blob spilling

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-05.1, KAR-04.3 |
| **PRD** | F3.4, F4.2, NF3, NF6 |
| **Verified by** | EPIC-05-S3, EPIC-05-S13, EPIC-05-S14, EPIC-05-S15, EPIC-05-S16, EPIC-05-S17, EPIC-05-S18 |

**As** the operator of a daemon that supervises runs for days, **I want** karvand to survive an agent that
emits an enormous frame or no newline at all, **so that** one misbehaving vendor release cannot take down
every run on the machine.

This is its own story because it defends against a **verified hazard with no upstream mitigation**:
`@agentclientprotocol/sdk`'s `LineBuffer` (`dist/line-buffer.js`) has **no maximum line length**. Reading
the implementation, `push()` accumulates chunks into a private `#pending` array and only emits when it
finds a `0x0a` byte. An agent that never emits a newline — buggy, wedged, or emitting one enormous tool
result — grows that array until karvand OOMs. Measured environment defaults on the same machine, 2026-08-02:
Node stream `highWaterMark` = **65536** bytes; Linux `/proc/sys/fs/pipe-max-size` = **1048576**.

Three mitigations, all in this story:

1. **A byte-counting `TransformStream` interposed between the child's stdout and `ndJsonStream()`**,
   counting bytes since the last newline. On exceeding **8 MiB**, abort the session with a structured
   `FrameTooLarge` error and `killTree()` the agent, logging the first 4 KiB for diagnosis. **Do not try to
   recover** — a frame that large means the agent is misbehaving.
2. **Consume with `for await`, never `.on('data')`.** Async iteration pauses the reader and the child blocks
   in `write()`. Flowing mode plus an awaited SQLite write is an unbounded in-memory queue.
3. **Spill payloads over ~256 KiB** to `~/.karvan/blobs/<sha256[0:2]>/<sha256>`, storing only
   `{sha256, bytes, mime, head, tail}` in SQLite — head and tail being the first and last ~2 KiB so the UI
   renders a preview without touching disk.

Also cap `terminal/output` on the way **in** with a per-terminal ring buffer (1 MiB) and report truncation
honestly — the ACP terminal output response is designed for exactly this.

**Acceptance criteria**

1. A single line exceeding 8 MiB aborts the session with
   `NodeFailure { reason: 'adapter.frame-too-large', class: 'permanent' }`, `killTree()`s the agent, and
   attaches the first 4 KiB of the offending frame as an evidence handle.
2. A line of 8 MiB minus one byte is delivered intact — the boundary is asserted from both sides.
3. An agent that writes ≥ 8 MiB with **no newline at all** trips the same guard; the counter is "bytes since
   last newline", not "size of a completed frame".
4. Daemon RSS growth is bounded under a producer that outruns the consumer by 10×, over at least 200 MB of
   total output.
5. Any single event payload over 256 KiB is written to a content-addressed blob path and replaced in the
   event row by `{sha256, bytes, mime, head, tail}` with `head` and `tail` at most 2 KiB each.
6. Two identical payloads produce one blob file and two references — verified across three retry attempts of
   the same failing test log, which is the common real case.
7. `terminal/output` is bounded at 1 MiB per terminal; when truncated, the response reports truncation
   explicitly rather than silently returning a prefix.
8. A repo grep asserts no adapter source uses `.on('data'` on a child stream.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Mock `hugeLine` at 10 MB; assert `adapter.frame-too-large`, the child's pgid has no non-`Z` members, and the evidence handle resolves to exactly 4096 bytes | No cap; the daemon accumulates |
| 2 | integration | Frame of exactly 8388607 bytes; assert delivery and a parsed notification | Off-by-one rejects a legal frame |
| 3 | integration | Frame of exactly 8388609 bytes; assert `FrameTooLarge` | Off-by-one accepts an illegal frame |
| 4 | integration | Mock `noNewline` writing 64 KiB every 10 ms; assert the guard fires within 8 MiB and the daemon does not OOM | The guard counts frames, not bytes since newline |
| 5 | integration | 200 MB soak with a 5 ms per-event consumer delay; sample `process.memoryUsage().rss`, assert bounded growth and zero lost events | Flowing mode; RSS tracks total bytes |
| 6 | integration | 300 KiB `tool_call_update` content; assert the `event` row stores no payload over ~4 KiB and the blob file exists at the sha-derived path | Raw output lands in the event log |
| 7 | integration | Append the same 300 KiB payload three times; assert one file on disk, three rows referencing it | No content addressing |
| 8 | integration | Agent polls `terminal/output` for a command emitting 5 MB; assert the returned buffer ≤ 1 MiB and the truncation flag set | Unbounded ring buffer |
| 9 | unit | Repo grep for `.on('data'` under `packages/adapters/src` returns nothing | Someone "simplified" the reader |

**Notes / risks** — assertion 5's bound is what keeps crash-recovery replay fast. **Replay time is a
function of event-log size, and un-spilled tool output is what makes it explode** (F4.2, NF3). If this story
is descoped, EPIC-06's resume path degrades silently over the life of a long run rather than failing
visibly.

---

### KAR-05.5 — Resume strategies: native and replay

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-05.2, EPIC-03 |
| **PRD** | F3.5, F4.2, F4.5, NF4 |
| **Verified by** | EPIC-05-S19, EPIC-05-S20, EPIC-05-S21 |

**As** Karvan, **I want** two resume strategies behind one interface selected from the probed capability
row, **so that** a run survives crash, restart and laptop sleep on **every** provider, not just the three
that can resume.

```ts
interface ResumeStrategy {
  resume(runId: RunId, nodeId: NodeId, ctx: AgentCtx): Promise<SessionHandle>
}
class ResumeNative   implements ResumeStrategy { /* session/resume; skip re-sending context */ }
class ResumeByReplay implements ResumeStrategy { /* session/new + replay packet from the ledger */ }

const strategy = caps.session.resume ? new ResumeNative() : new ResumeByReplay()
```

The design rule this implements is unambiguous: **Karvan's own SQLite ledger is the sole source of truth
for a run. Every prompt Karvan sends must be reconstructible from that log alone. `session/resume` is a
token-cost optimisation, never the durability mechanism.** `ResumeByReplay` is needed anyway for the exec
shim path, so building it costs nothing extra.

Two traps. First, **`session/load` is not `session/resume`**: `loadSession` is universally `true` and
semantically different — it streams the entire conversation history back as `session/update` notifications
and will flood a days-long run. Prefer `resume`; if you must `load`, discard the replayed notifications you
already have and **dedupe on your own event ids, never the agent's**. Second, **on resume, if the recorded
vendor version differs from the current one, refuse by default**. Session-file formats and resume semantics
are internal vendor details that change without notice; resuming a Codex 0.146 session under 0.150 is not a
supported operation by anyone, and the failure mode is not a clean error — it is a subtly corrupted context
that poisons the rest of a multi-hour run.

**Acceptance criteria**

1. Strategy selection reads only the probed capability row. No vendor name appears in the selection logic.
2. `ResumeNative` issues `session/resume` with the stored `sessionId` and does **not** re-send the context
   packet; the ledger records that a native resume was used.
3. `ResumeByReplay` issues `session/new` and reconstructs the prompt entirely from ledger events, producing
   a byte-identical packet to the one recorded in `context.built` for that attempt.
4. Both strategies produce the same observable node outcome for the same scripted agent behaviour — the
   only difference is token cost, which is recorded.
5. On resume, if the current binary's `version` or `binary_sha256` differs from what `node.started` recorded,
   the resume is **refused** with a typed failure and an operator prompt; an explicit opt-in flag proceeds
   and records that it did.
6. `session/load` is never used as a substitute for resume. If it is used deliberately, deduplication is
   keyed on Karvan's own event ids and a test proves no duplicate ledger row results.
7. A resume after a simulated crash uses the same code path as a daemon restart: close the database,
   construct a fresh engine over the same file, resume.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `select(row)` returns `ResumeNative` for the claude/codex/opencode rows and `ResumeByReplay` for copilot/gemini | Selection is a vendor switch |
| 2 | integration | `--capabilities gemini`, run to mid-turn, `db.close()`, fresh engine over the same file, resume; assert the node completes and no `session/resume` frame was ever sent | Replay is unimplemented and the node restarts from zero silently |
| 3 | integration | `--capabilities claude`; assert a `session/resume` frame is sent and the context packet is **not** re-transmitted | Native resume re-sends everything |
| 4 | integration | Compare the reconstructed replay packet against the `context.built` payload for that attempt; assert byte equality | Reconstruction drifts from what was originally sent |
| 5 | integration | Bump the mock's reported `--version` between the crash and the resume; assert refusal with the recorded and current versions in `detail` | Resume proceeds across a version change |
| 6 | integration | Same, with the opt-in flag; assert the resume proceeds and an event records the override | The opt-in is impossible |
| 7 | integration | Force a `session/load` path; feed the same notification twice; assert one ledger row | Dedupe keys on the agent's ids |

**Notes / risks** — this is where KAR-04.4 pays off. Without the capability profiles, testing
`ResumeByReplay` needs an installed, authenticated Copilot or Gemini CLI and a real multi-minute turn; with
them it is a fast integration test on every commit. Given that this is the durability path for **two of the
five providers**, it needs that coverage continuously.

---

### KAR-05.6 — MCP host exposing workflow tools to agents

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-05.1, EPIC-03 |
| **PRD** | F3.1, F6.5, F2.4, NF6 |
| **Verified by** | EPIC-05-S22, EPIC-05-S23, EPIC-05-S24 |

**As** an agent working on a Karvan node, **I want** workflow-level tools — read a `Fact`, pull an artifact
by handle, propose a `PlanPatch` — regardless of which vendor I am, **so that** the orchestration layer is
reachable from inside the agent's own tool loop rather than only between turns.

`@modelcontextprotocol/sdk@1.30.0` (published 2026-07-27, `engines.node >= 18`). **Pick stdio**, injected
via `mcpServers` in `session/new`. The reasoning is all from the live probes: stdio is the **untagged
default variant** of the `McpServer` union and needs no capability flag, so all five agents accept it;
`mcpCapabilities.acp` was **not advertised true by a single agent** (codex-acp explicitly returned
`acp: false`), so the elegant tunnel-over-ACP path is specified but implemented nowhere; legacy HTTP+SSE is
officially deprecated as of the 2026-07-28 MCP spec; and stdio avoids binding a port.

```ts
mcpServers: [{
  name: 'karvan',
  command: process.execPath,                    // the exact node running karvand
  args: [karvanMcpEntry, '--socket', socketPath, '--run', runId],
  env: [{ name: 'KARVAN_RUN_TOKEN', value: oneTimeToken }],
}]
```

Ship `karvan-mcp` as a **second bin in the same published `karvan` package**: a thin shim with
`StdioServerTransport` on one side and a **Unix domain socket** back to karvand on the other. Use a UDS, not
a TCP port — karvand is already local and a UDS gets filesystem permissions for free instead of needing a
loopback auth scheme. Injecting via `session/new` is the ACP-native way to give an agent Karvan-specific
tools **without touching the user's global MCP config**, which Karvan must never mutate.

**Acceptance criteria**

1. Every `session/new` carries an `mcpServers` entry of the untagged stdio shape with `command` equal to
   `process.execPath`, and a one-time `KARVAN_RUN_TOKEN` scoped to that run.
2. A test asserts the user's vendor CLI configuration files are byte-identical before and after a run.
3. `karvan-mcp` connects to karvand over a UDS whose parent directory is mode `0700`; a connection presenting
   a wrong or expired token is refused and the refusal is logged.
4. `@modelcontextprotocol/sdk` is imported **only** through the deep subpaths
   `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js`; a test asserts
   no root-package import exists anywhere in the workspace.
5. The M1 tool set is registered with `registerTool` and both `inputSchema` and `outputSchema`; calling a
   tool round-trips to karvand and back with the result visible in the ledger.
6. When the plan advances and a new phase unlocks tools, `sendToolListChanged()` is emitted rather than
   requiring a new session.
7. `karvan-mcp` exits when its stdin closes, so an agent's death does not leave a shim holding a socket.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Capture the mock's received `session/new` params; assert the `mcpServers[0]` shape has no `type` discriminant and `command === process.execPath` | An `http` or `acp` variant was chosen |
| 2 | integration | Snapshot `~/.claude.json` (or the fixture's stand-in) before and after a run; assert byte equality | Karvan writes to the user's MCP config |
| 3 | integration | Spawn `karvan-mcp` with a bad token; assert the socket connection is refused and karvand logs it | The token is not checked |
| 4 | unit | Repo grep: no import of `'@modelcontextprotocol/sdk'` at package root | Root import pulls express and hono into the runtime |
| 5 | integration | Mock agent calls a registered workflow tool through the shim; assert the corresponding ledger event and the tool result reaching the agent | The shim does not relay |
| 6 | integration | Advance the plan phase; assert a `notifications/tools/list_changed` frame reaches the agent | Tools are static per session |
| 7 | integration | Kill the mock agent; assert the `karvan-mcp` process exits within 2 s and the socket is released | The shim leaks |

**Notes / risks** — the MCP SDK is **not lightweight**: its dependencies include `express@^5.2.1`,
`hono@^4.11.4`, `cors`, `jose`, `ajv`, `eventsource`, `pkce-challenge`, `express-rate-limit` and more. For a
stdio-only server nearly all of it is dead weight that still lands in `node_modules` and slows
`npx karvan up` (NF6). Deep subpath imports keep it from *loading*; if install size becomes a real problem,
vendoring a ~200-line stdio-only MCP server is a viable later move. Silver lining: `ajv` arrives
transitively, so KAR-05.7's schema validator is free.

---

### KAR-05.7 — Adapter conformance suite and golden recordings

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-05.1, KAR-05.2, KAR-05.4, KAR-04.5 |
| **PRD** | F3.4, F3.6 |
| **Verified by** | EPIC-05-S25, EPIC-05-S26, EPIC-05-S27, EPIC-05-S28 |

**As** the sole maintainer of five adapters against CLIs that churn monthly, **I want** a two-layer
conformance suite, **so that** flag and wire churn is detected by CI on a commit rather than by a user's
failed three-hour run.

**There is no official ACP conformance kit.** Verified negative, 2026-08-02: the
`agentclientprotocol/agent-client-protocol` repo has no `conformance/`, `compliance/` or `tests/` directory,
and `@agentclientprotocol/conformance`, `acp-conformance` and `@agentclientprotocol/test-kit` all 404 on
npm. Web search will confidently assert otherwise; that claim conflates it with an unrelated academic
protocol also abbreviated ACP. **Do not chase it.** So the suite is ours, in two layers.

**Layer A — schema conformance, every commit.** Tee every frame in both directions **at the transport
level** and validate against `@agentclientprotocol/sdk/schema/schema.json` (**262 `$defs`**, verified) with
`ajv`. Free, offline, and it fires the instant an upstream SDK bump changes the wire shape.

**Layer B — behavioural contract, parameterised over adapters.** One vitest suite,
`providerContract(adapterFactory)`, run against the mock agent on every commit and against real agents
nightly behind an `@live` tag, asserting:

| # | Assertion |
|---|---|
| 1 | `initialize` returns `protocolVersion === 1` |
| 2 | `session/new` returns a `sessionId` |
| 3 | A trivial prompt yields ≥1 `agent_message_chunk`, then a `PromptResponse` with `stopReason === 'end_turn'` |
| 4 | `session/cancel` mid-turn yields `stopReason === 'cancelled'` — **and the client tolerates `session/update` notifications arriving after the cancel** |
| 5 | A permission request round-trips; a client-side cancel produces `RequestPermissionOutcome { outcome: 'cancelled' }` |
| 6 | **Capability honesty** — call a method the agent did *not* advertise and assert JSON-RPC `-32601` |
| 7 | Malformed JSON line → structured adapter error, session torn down, no daemon crash |
| 8 | Oversized frame → `FrameTooLarge`, `killTree()`, no OOM |

**Acceptance criteria**

1. `KARVAN_RECORD=1` tees raw stdout, stderr, exit code and inter-chunk timing to
   `recordings/<provider>@<exact-version>/<case>.ndjson`, one `{"t","dir","msg"}` object per line. **The tee
   lives in the transport, never in the adapter's parsing logic** — an adapter-level tee records your
   normaliser's interpretation, which is precisely the class of change you need to detect.
2. Layer A runs over the whole recorded corpus in CI and fails on any frame that does not validate against
   `schema.json`, naming the file, line and JSON pointer.
3. Layer B is a single exported function taking an adapter factory, so adding an adapter adds one call site.
4. Layer B runs against all six mock capability profiles on every commit, and against installed real CLIs
   only under an `@live` tag that CI never selects.
5. Assertion 6 (capability honesty) is exercised by `--dishonest-capabilities`, and its failure message names
   the capability and the method.
6. Recordings are keyed on the **exact** agent version so a bump produces a visible new directory rather
   than silently invalidating old goldens.
7. Both layers of assertion run on each recording: raw frames for conformance, plus a snapshot of the
   **normalised** Karvan event vocabulary through the normalising serializer. Snapshotting only the
   normalised form is less brittle and also less sensitive — it will not catch an upstream change the
   normaliser happens to swallow.
8. `pnpm test:record` is manual and documented as never running in CI; it costs real quota against the
   developer's own subscription and is nondeterministic by construction.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | contract | Layer A over a fixture recording containing one deliberately schema-invalid frame; assert failure naming the line and JSON pointer | No validator wired |
| 2 | contract | Layer A over the mock agent's own emitted frames; assert every frame validates — the mock cannot emit something no real agent could | The mock invents frames |
| 3 | contract | `providerContract(mockFactory('claude'))` — all eight assertions pass | Contract suite does not exist |
| 4 | contract | `providerContract` over all six profiles as a parameterised table; assert per-profile pass and that capability-dependent assertions skip with a recorded reason rather than silently | Profiles are not parameterised |
| 5 | contract | Dishonest profile; assert assertion 6 fails with a message naming `session.resume` and `session/resume` | Capability honesty is not checked |
| 6 | integration | `KARVAN_RECORD=1` on a mock run; assert the ndjson file exists with both directions and monotonic `t` offsets | The tee is in the adapter and only records `out` |
| 7 | unit | Normalised-event snapshot through the serializer; assert timestamps, ULIDs, durations and absolute paths are normalised | Snapshot churns on every run |
| 8 | integration | Recording directory named without `@version`; assert the suite errors rather than silently skipping | Goldens rot into `latest` |

**Notes / risks** — the normalising snapshot serializer must be registered in `test/setup.ts` **before the
first snapshot is written**, or every snapshot is churn and the mechanism becomes noise you learn to `-u`
past. `karvan doctor` (EPIC-18, KAR-18.4) is the natural home for running Layer B against the user's
actually-installed CLI versions.

---

### KAR-05.8 — CLI exec shim fallback adapter

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-04.6, KAR-05.5, KAR-05.9 |
| **PRD** | F3.2, F3.4 |
| **Verified by** | EPIC-05-S29 |

*(scope-cut candidate — see [adapter layer §8.5](../../07-provider-adapter-layer.md) and
[roadmap](../../17-roadmap.md))*

**As** Karvan, **I want** a documented, permanently-retained fallback that drives a vendor CLI by flags and
parses its headless output, **so that** an agent with no ACP path, or an ACP adapter broken by a vendor
release, degrades rather than blocks.

The shim gives up ACP's mediation — Karvan no longer sits in the path of every file access and command
execution — and falls back to per-vendor flags. **That is the real cost of the fallback, not the parsing.**
On this path a node's permission level is expressed through the vendor's own flags, and where the vendor
cannot express the requested level, Karvan **refuses to schedule** (`safety.permission-unschedulable`)
rather than silently escalating.

Every flag below was read from the installed binary's own `--help` on 2026-08-02:

- **Claude Code 2.1.220**: `-p/--print`, `--output-format text|json|stream-json`,
  `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--session-id <uuid>`
  (client-chosen, **verified honoured verbatim in every emitted frame**), `-r/--resume [id]`,
  `--json-schema <schema>`, `--max-budget-usd`, `--mcp-config`, `--strict-mcp-config`. **`--verbose` is
  REQUIRED alongside `-p --output-format stream-json`** or the process exits printing
  `Error: When using --print, --output-format=stream-json requires --verbose`.
  **`--permission-prompt-tool` is no longer in `--help`.**
- **Codex CLI 0.146.0**: `codex exec [PROMPT]`, `--json`, `-o/--output-last-message`,
  `--output-schema <FILE>`, `-s/--sandbox read-only|workspace-write|danger-full-access`, `-C/--cd`,
  `--skip-git-repo-check`, `--ephemeral`, resume via `codex exec resume [SESSION_ID]` or `--last`.
  **`--full-auto` is gone.**
- **Gemini CLI 0.53.1**: `-p/--prompt`, `-o/--output-format text|json|stream-json`,
  `--approval-mode default|auto_edit|yolo|plan`, `--session-id`, `-r/--resume latest|<index>`.
  **`--allowed-tools` is deprecated in favour of `--policy`/`--admin-policy`.**
- **Copilot CLI 1.0.77**: `-p/--prompt`, `--output-format text|json` — **no `stream-json`** — `--stream on|off`,
  `--session-id`, `--allow-all-tools` (required for non-interactive), `--secret-env-vars`.
- **OpenCode 1.18.11**: `opencode run [message..] --format default|json`, `-c/--continue`, `-s/--session`,
  `--fork`, plus `opencode export`/`import` for durable session snapshots.

**Acceptance criteria**

1. Each shim's argv is generated from a per-vendor spec and snapshotted, so a flag change is a review diff.
2. The Claude Code shim always passes `--verbose` when `--output-format stream-json` is requested, and a
   test proves the guard by asserting the exact vendor error string is never produced.
3. The Copilot shim **rejects** a `stream-json` request at construction time rather than emitting it — a
   shim that assumes a uniform `stream-json` breaks on Copilot.
4. Each `stream-json` line's `uuid` is the event-log dedup key on this path; replaying the same output twice
   produces one set of ledger rows.
5. The Claude Code `result` envelope is parsed into `TokenUsage` with `source: 'vendor-reported'`, and
   `subtype: 'error_max_structured_output_retries'` maps to `agent.schema-repair-exhausted`.
6. `rate_limit_event` frames are parsed and their `resetsAt` scheduled around rather than retried blindly.
7. The 8 MiB frame guard and 256 KiB blob spilling from KAR-05.4 apply on this path too — it is the same
   transport-level guard, not a second implementation.
8. A node requiring mediated execution (`mediatedExecution: false` on this adapter) is refused scheduling
   with `safety.permission-unschedulable`.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Per-vendor argv snapshots for a read-only node and a worktree-write node | Flags are assembled inline |
| 2 | integration | Fake agent as `claude`, `stream-json` requested; assert `--verbose` is present in the spawned argv | The guard is missing |
| 3 | integration | Copilot spec asked for `stream-json`; assert a construction-time error naming `text|json` | The shim emits an unsupported flag |
| 4 | integration | Feed the same recorded `stream-json` output twice; assert one ledger row per `uuid` | Dedup keys on line index |
| 5 | unit | Parse the verified `result` envelope; assert `TokenUsage.source === 'vendor-reported'` and every field mapped | Estimated and reported figures are mixed |
| 6 | unit | `subtype: 'error_max_structured_output_retries'` maps to `agent.schema-repair-exhausted` with `class: 'permanent'` | Mapped to a generic failure |
| 7 | integration | Fake agent emits a `rate_limit_event`; assert a `provider.rate_limited` event with `resetsAt` | The frame is ignored |
| 8 | integration | Fake agent emits a 10 MB line on the shim path; assert `adapter.frame-too-large` | The guard is ACP-only |
| 9 | unit | `admit(node requiring mediation, shimRow)` returns `safety.permission-unschedulable` | Silent escalation |

**Notes / risks** — **this story is the epic's designated scope cut.**
[§8.5](../../07-provider-adapter-layer.md) argues plainly for skipping the exec shim entirely at M1 and
supporting only ACP-reachable providers — Claude, Codex, Gemini, Copilot and OpenCode, five of the six PRD
targets, everything except Cursor. It removes an entire per-vendor parser family, the highest-churn code in
the project, from the M1 critical path. The counter-argument is thin: `ResumeByReplay` is needed anyway
(KAR-05.5) and the verified flag tables above are the expensive part and are already captured. **Add the
shim when a user actually demands Cursor, Goose or Aider.** If it is cut, F3.2 is knowingly unmet at M1 and
that must be recorded on the board, not left implicit.

---

### KAR-05.9 — Process lifecycle: detached spawn, cancellation, orphan reaping

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-05.1, KAR-04.6 |
| **PRD** | F4.4, F5.7, F4.2 |
| **Verified by** | EPIC-05-S4, EPIC-05-S30, EPIC-05-S31, EPIC-05-S32 |

**As** the operator, **I want** one control that stops every child process in a run and a daemon that never
leaves an orphan behind, **so that** the kill switch is real and a crashed karvand does not leave agents
editing a worktree it no longer supervises.

Use `node:child_process.spawn` directly for agents — no pty is needed, verified across all five ACP
handshakes over plain `spawn(cmd, args, { stdio: ['pipe','pipe','pipe'] })`. `execa@10.0.1` is fine sugar
elsewhere; this is the most safety-critical code in the daemon and should stay explicit.

**`detached: true` is mandatory**, verified by measurement rather than inference. With Node's default
`detached: false`, a bash script that backgrounds two children put the grandchildren's PGID in **karvand's
own process group** — `child.kill('SIGTERM')` killed only bash, both grandchildren kept running in state `S`,
and you cannot group-kill because signalling that group would kill karvand itself. With `detached: true`,
the grandchildren's PGID equalled `child.pid` and `process.kill(-child.pid, 'SIGTERM')` terminated the
entire subtree. Most tutorials get this wrong and the non-detached case is actively dangerous.

Three-stage cancellation: `session.cancel()` awaiting `stopReason: 'cancelled'` (the only stage that
produces a clean transcript, and the `nextUpdate()` loop must keep running through it), then
`process.kill(-pid, 'SIGTERM')` with a 5 s grace, then `process.kill(-pid, 'SIGKILL')` with 2 s before
escalating a ledger failure.

`detached: true` means **the agent survives karvand's death**, which is not optional to handle. Persist
`{runId, nodeId, pid, pgid, started_at, binary_sha256}` at spawn; on boot, for every non-terminal row, reap
the orphan — but **guard against PID reuse by comparing process start time**, never by trusting a bare PID
across a reboot (`/proc/<pid>/stat` field 22 on Linux; `ps -o lstart= -p <pid>` on macOS).

**Acceptance criteria**

1. Every agent spawn uses `detached: true` with `stdio: ['pipe','pipe','pipe']`; a repo grep asserts no
   agent spawn omits it.
2. All descendants of a spawned agent share a pgid equal to the child's pid.
3. Cancellation runs the three stages in order, and stage 1's trailing `session/update` notifications are
   appended to the ledger before the process signal is sent.
4. **Any kill-verification assertion excludes `Z`-state processes.** After a successful group SIGKILL, `ps`
   still lists grandchildren in state `Z` with `ppid=1` — already dead, awaiting reaping by init. A naive
   check concludes the kill failed when it did not.
5. `killTree(pid)` is a single abstraction with a POSIX implementation at M1 and a Win32 stub that throws
   `not implemented on win32` — Windows is M3 and the POSIX result does **not** transfer.
6. A `process` row is written at spawn inside the same transaction as `node.started`, and is cleared on
   clean exit.
7. On daemon boot, every non-terminal `process` row is reconciled: if the pid exists **and** its start time
   matches, the tree is killed; if the start time differs, the row is discarded as a PID reuse and logged;
   if the pid is gone, any `git worktree lock` it held is released.
8. A run cancelled while five agents are live leaves zero non-`Z` processes in any of the five pgids within
   the 5 s + 2 s window.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Spawn `bash -c 'sleep 300 & sleep 300 & sleep 300; wait'` detached; read `ps -eo pid,pgid,stat`; assert all four share `pgid === child.pid` | `detached` is false and pgid is karvand's |
| 2 | integration | Group SIGKILL, then filter `$3 !~ /Z/`; assert zero survivors; assert the unfiltered count is non-zero (proving the filter is load-bearing) | The assertion counts zombies as alive |
| 3 | integration | `process.kill(child.pid, 'SIGKILL')` with a **positive** pid; assert both grandchildren alive with `ppid === 1` — the regression test against "simplifying" the kill path | The positive-pid path is treated as equivalent |
| 4 | integration | `ignoreSigterm` fake agent; assert SIGTERM at t=0, still alive at t=5 s, gone by t=7 s, and a ledger failure escalated | No escalation timer |
| 5 | integration | Cancel a live turn; assert the trailing updates are in the ledger with `seq` **less than** the cancellation event | Signals are sent before the flush is consumed |
| 6 | integration | Write a `process` row with a pid that exists but a mismatched `started_at`; boot; assert the row is discarded and nothing is killed | A recycled pid gets killed — potentially an unrelated user process |
| 7 | integration | Write a row whose pid is gone and which holds a locked worktree; boot; assert `git worktree unlock` was run | Stale locks accumulate |
| 8 | unit | `killTree` on `process.platform === 'win32'` throws a typed not-implemented error | A POSIX path silently no-ops on Windows |

**Notes / risks** — zombie reaping is prompt under launchd and systemd but **can lag badly inside
containers**, so the `Z`-filter bites hardest in exactly the environment where you cannot attach a
debugger. `tree-kill@1.2.2` does the Windows work and is tiny but was last published 2022-06-27 and is
effectively frozen — vendor or wrap it, never depend on it directly.

---

### KAR-05.10 — Direct API adapter on a user-supplied key *(added)*

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-05.2, KAR-05.7 |
| **PRD** | F3.3 |
| **Verified by** | EPIC-05-S33, EPIC-05-S34, EPIC-05-S35 |

**As** an engineer whose employer supplies a company API key, **I want** Karvan to drive a provider through
its HTTP API when I explicitly hand it a credential, **so that** I can use Karvan where no vendor CLI is
installed or authenticated, and so that provider-neutrality means *provider*-neutral rather than
*CLI*-neutral.

This story exists to close a coverage gap the reconciled board found: **F3.3 is a P0 requirement inside
PRD §11's M1 line (F3.1–F3.7), and without this story the backlog does not deliver M1 as the PRD defines
it.** The architecture deliberately scopes it to M2 ([§12](../../07-provider-adapter-layer.md)) on two
grounds — no package selection was verified on 2026-08-02, and it inverts the AR-1 credential posture.
Both objections are real, and the minimal story below is shaped to respect them rather than to overrule
them.

The scope is deliberately one vendor, not a matrix. Its purpose is as much architectural proof as
capability: the capability manifest and the conformance battery were both designed against ACP, and until
a non-ACP, non-subprocess adapter passes them, "adapter abstraction" is an untested claim. A single direct
adapter is the cheapest way to find out whether the abstraction is provider-neutral or merely ACP-shaped.

**AR-1 is not weakened by this story and the acceptance criteria enforce that.** AR-1 forbids Karvan
*possessing* a credential it was not explicitly given. A key the operator hands over in an explicit,
per-provider opt-in is a different thing from Karvan reading a vendor's token file — and the distinction
must be visible in the product, not just in this paragraph.

**Acceptance criteria**

1. The adapter is inert unless the operator opts in explicitly per provider in `.karvan/config.yaml`.
   Absence of the opt-in key means the provider is not offered, even when a matching `*_API_KEY` is
   present in the environment.
2. The key is read at spawn time from the configured source and is never persisted to the ledger, the
   artifact store, a log line, an OTel span, or a run report. A grep of a completed run's entire on-disk
   footprint for the key's value returns zero hits.
3. The adapter's capability manifest row is produced by the same probe path as an ACP adapter's
   (KAR-05.2), and declares `mediatedExecution: false` — so the permission ladder refuses to schedule
   `worktree` and above onto it, per the narrowed rule in
   [09-workspace-and-safety.md](../../09-workspace-and-safety.md). At M1 this adapter is `read`-level only.
4. The adapter passes the KAR-05.7 conformance battery unmodified. Any assertion that fails only because
   the adapter is not a subprocess is a defect in the battery, not an exemption for the adapter — fix the
   battery.
5. `tokenAccounting: 'exact'` on the manifest row, since the API returns usage directly, and the UI
   distinguishes it from the `'estimated'` ACP path (F9.1).
6. Using this adapter emits a `provider.direct_api.used` event carrying the provider and the config key
   that authorised it, so a run's own ledger records that a credential path was taken.
7. `karvan doctor` reports the adapter as configured-and-reachable, unconfigured, or configured-but-failing,
   and never prints the key.

**Test plan (TDD)** — write these first and observe each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Provider registry omits the direct adapter when the config opt-in is absent, even with `ANTHROPIC_API_KEY` set in `process.env` | Registry offers any provider whose env key happens to exist |
| 2 | unit | Capability manifest row for the direct adapter asserts `mediatedExecution: false` and `tokenAccounting: 'exact'` | Manifest is hardcoded per transport rather than per adapter |
| 3 | unit | Permission policy refuses to schedule a `worktree`-level node onto an adapter with `mediatedExecution: false` | Ladder only knows about ACP adapters |
| 4 | contract | The KAR-05.7 battery runs green against the direct adapter with no per-adapter branches | Battery asserts on subprocess-shaped behaviour |
| 5 | integration | Against a local HTTP stub: a full turn completes, usage is recorded exactly, and `provider.direct_api.used` is in the ledger | No event; or usage recorded as estimated |
| 6 | integration | Redaction sweep — run a full turn against the stub with a sentinel key, then grep the ledger, blobs, logs, spans and report for the sentinel | Key appears anywhere on disk |
| 7 | e2e | `karvan doctor` reports the adapter's three states and never echoes the key | Doctor prints the key or crashes when unconfigured |

**Notes / risks** — the package choice is deliberately left open; select it during the story and record it
in [02-tech-stack.md](../../02-tech-stack.md) with the pin policy, since nothing here was verified on
2026-08-02. **If you would rather not build this at M1, the alternative is legitimate and cheaper: amend
PRD §11 to read `F3.1, F3.2, F3.4–F3.7` and move F3.3 to M2 with the AR-1 reasoning attached.** What is not
legitimate is leaving F3.3 in the M1 line with nothing delivering it — that is how a plan quietly stops
matching its product definition. Whichever way it goes, record the decision.

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **~28 days across 9 stories — far over the ~15-day guidance for one epic.** This is the largest epic in M1 and it sits on the critical path (W3 gates W4, which gates everything else). | **Critical (schedule)** | Two named reductions: defer KAR-05.8 per [§8.5](../../07-provider-adapter-layer.md) (−4 to 5 days, and F3.2 goes knowingly unmet at M1), and land KAR-05.6 after KAR-05.7 so the MCP host is not blocking the conformance suite. The remaining ~19 days are irreducible: they *are* the provider-neutrality thesis. Do not attempt to compress KAR-05.4 — it is the availability story. |
| **A0-1: the full ACP prompt cycle has never been executed against any agent.** Streaming, permission prompts and cancellation are spec-read, not observed. | **Critical** | M0-S1 is a hard Definition-of-Ready gate on this epic, and the project's kill criterion attaches to it. Do not start KAR-05.1 with S1 open. |
| **A0-2: the Claude Code and Codex ACP adapters are community-maintained bridges, not first-party.** Their fidelity to the underlying CLI is unproven, and they are the two most important providers. | High | KAR-05.7's battery targets the **adapters**, not just the natively-ACP agents. Golden recordings keyed on the exact adapter version make a fidelity regression a visible diff. |
| **A0-9: the capability matrix is a snapshot of 2026-08-02 and two of five versions were published that day.** A stale matrix produces a wrong routing decision, not an error. | High (silent) | KAR-05.2 makes it a probed row with a three-part PK; `karvan doctor` regenerates it; CI re-probes weekly. |
| **A0-3: whether ACP surfaces token usage or compaction at all is unverified.** If it does not, the ACP-first path silently costs F9.1 and F10.5. | High | Answered explicitly in M0-S1. Fallback is `tokenAccounting: 'estimated'` on the ACP path with the UI degrading honestly rather than fabricating a number. |
| **Vendor flag churn.** Three breakages were already visible on 2026-08-02 (`--permission-prompt-tool`, `codex exec --full-auto`, Gemini's `--experimental-acp` and `--allowed-tools`). Assume every vendor flag moves within 6 months. | High | Monthly `--help` capture diffed against the recorded baseline; conformance suite on `doctor`; KAR-05.3's argv snapshots turn a change into a review diff. |
| **A0-4: ACP v2 removes `fs/*` and `terminal/*` from the client**, with no announced timeline. | Medium | The two-fronts split in KAR-05.1: transport-neutral services with ~15-line ACP fronts and ~15-line MCP fronts. About an hour of work now; avoids rewriting the most security-sensitive code in the daemon. |
| **A0-6: `@lydell/node-pty` is `1.2.0-beta.14`,** a beta of a community fork and the only native dependency. | Medium | Only Karvan's own `terminal/*` needs a pty; no agent does. Pin exactly, keep it an `optionalDependency`, ship a plain-`spawn` no-TTY fallback so a platform without a prebuild degrades rather than failing installation. |
| **A0-10: Windows process-tree termination untested.** POSIX `detached: true` + `process.kill(-pid)` does not transfer. | Medium (M3) | `killTree()` abstraction from day one with an explicit Win32 not-implemented throw. Windows is NF5/M3. |
| **MCP SDK weight slows `npx karvan up` (NF6).** | Medium | Deep-subpath imports only, asserted by a repo grep. Vendoring a ~200-line stdio-only server is the escape hatch. |

**Requirement coverage notes.** F3.3 (direct API adapter) is covered by **KAR-05.10**, added after the
reconciled board found it was the only P0 requirement in PRD §11's M1 line with no story delivering it.
The architecture scopes it to M2 ([§12](../../07-provider-adapter-layer.md)) on two real grounds — no
package selection was verified on 2026-08-02, and it inverts the AR-1 credential posture — so KAR-05.10 is
deliberately minimal: one vendor, `read`-level only, explicit per-provider opt-in, with a mechanical
sentinel test proving the key never reaches disk. **If the author would rather not build it at M1, the
correct alternative is to amend PRD §11 to `F3.1, F3.2, F3.4–F3.7` and move F3.3 to M2 — not to leave the
requirement in the M1 line uncovered.** Record whichever decision is taken.

F3.2 (CLI exec shim) is covered only by **KAR-05.8**, which is also this epic's named scope-cut candidate.
Those two facts are in tension: cutting it leaves a P0 requirement met only by KAR-04.6, which is a test
fake rather than a product adapter. Prefer the epic's other reduction lever (sequencing KAR-05.6 after
KAR-05.7) and keep the shim.

F3.8 (auth shadowing) and F3.9 (quota-aware re-routing) are P1 and live in EPIC-08 and EPIC-11/14
respectively; this epic supplies the capability row and the `provider.rate_limited` event they consume.

---

**Related:** [Flows](../flows/EPIC-05-provider-adapters-flows.md) · [Board](../board.md) ·
[Provider adapter layer](../../07-provider-adapter-layer.md) ·
[Testing strategy](../../14-testing-strategy.md) · [Durable execution](../../05-durable-execution.md)

[← Back to the delivery plan](../README.md)
