# EPIC-05 flows — Provider adapter layer

> Behavioural specification for [EPIC-05](../epics/EPIC-05-provider-adapters.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor              | Description                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Operator**       | The engineer driving DeFlow — cancels a run, approves a version-change override, reads the failure               |
| **DeFlowd**        | The local daemon. Here specifically: the ACP client, the provider registry, the transport guard and the MCP host |
| **Provider agent** | A vendor binary or ACP adapter reached as a detached child process over ndjson on stdin/stdout                   |
| **Mock agent**     | `deflow-mock-agent` standing in for any provider, with a selectable capability profile (EPIC-04)                 |
| **Ledger**         | The file-backed SQLite `event`, `io_chunk`, `effect` and `provider_capabilities` tables                          |
| **deflow-mcp**     | The stdio MCP shim the agent spawns, talking back to DeFlowd over a Unix domain socket                           |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a git repository on branch "main"
  And a real file-backed SQLite ledger at "<tmp>/.DeFlow/DeFlow.db" opened with
      PRAGMA journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000
  And the mock agent binary is on PATH, symlinked under the vendor name under test
  And DeFlowd holds the resolved ABSOLUTE path to every provider binary
  And every agent is spawned with { detached: true, stdio: ['pipe','pipe','pipe'] }
  And time enters the engine through an injected Clock port
  And no fake timers are installed while a child process is alive
  And no vendor credential is present and no network is reachable
```

> `:memory:` SQLite is not permitted in any scenario in this file. It cannot exercise WAL, cannot be
> reopened after a simulated crash, and hides ordering bugs — which is exactly what the resume scenarios
> below test.

## Flow index

| Scenario    | Title                                                            | Verifies           | Type       |
| ----------- | ---------------------------------------------------------------- | ------------------ | ---------- |
| EPIC-05-S1  | Happy path: a full prompt cycle through the ACP client           | KAR-05.1           | Happy path |
| EPIC-05-S2  | `protocolVersion` is the integer 1, and a mismatch fails cleanly | KAR-05.1           | Failure    |
| EPIC-05-S3  | The pull loop awaits the durable append before asking for more   | KAR-05.1, KAR-05.4 | Edge case  |
| EPIC-05-S4  | Cancel mid-turn: the tail is flushed before the process dies     | KAR-05.1, KAR-05.9 | Recovery   |
| EPIC-05-S5  | A permission request round-trips, including a cancelled outcome  | KAR-05.1           | Edge case  |
| EPIC-05-S6  | The probe persists the entire `initialize` response              | KAR-05.2           | Happy path |
| EPIC-05-S7  | Probed capability rows across the five verified adapters         | KAR-05.2           | Edge case  |
| EPIC-05-S8  | A version bump writes a new row, never an update                 | KAR-05.2           | Edge case  |
| EPIC-05-S9  | A node is refused scheduling before a process is spawned         | KAR-05.2           | Failure    |
| EPIC-05-S10 | Spawn strategy per vendor                                        | KAR-05.3           | Happy path |
| EPIC-05-S11 | The adapter never searches PATH                                  | KAR-05.3           | Failure    |
| EPIC-05-S12 | Gemini's deprecated flag fallback, exactly once                  | KAR-05.3           | Edge case  |
| EPIC-05-S13 | A single 10 MB line trips the 8 MiB cap                          | KAR-05.4           | Failure    |
| EPIC-05-S14 | A wedged agent that never emits a newline                        | KAR-05.4           | Failure    |
| EPIC-05-S15 | The cap boundary, from both sides                                | KAR-05.4           | Edge case  |
| EPIC-05-S16 | Payloads over 256 KiB spill to content-addressed blobs           | KAR-05.4           | Happy path |
| EPIC-05-S17 | Identical output across three retries deduplicates               | KAR-05.4           | Edge case  |
| EPIC-05-S18 | `terminal/output` is ring-buffered and truncation is honest      | KAR-05.4           | Edge case  |
| EPIC-05-S19 | Resume strategy selected from the probed row                     | KAR-05.5           | Recovery   |
| EPIC-05-S20 | A vendor version change invalidates a resume                     | KAR-05.5           | Failure    |
| EPIC-05-S21 | `session/load` is not a substitute for `session/resume`          | KAR-05.5           | Edge case  |
| EPIC-05-S22 | MCP injected through `session/new`, user config untouched        | KAR-05.6           | Happy path |
| EPIC-05-S23 | A workflow tool call reaches DeFlowd over the UDS                | KAR-05.6           | Happy path |
| EPIC-05-S24 | A new phase unlocks tools without a new session                  | KAR-05.6           | Edge case  |
| EPIC-05-S25 | Layer A: every recorded frame validates against `schema.json`    | KAR-05.7           | Happy path |
| EPIC-05-S26 | Layer B: the behavioural contract over adapters                  | KAR-05.7           | Happy path |
| EPIC-05-S27 | An agent advertising a capability it does not honour             | KAR-05.7, KAR-05.2 | Failure    |
| EPIC-05-S28 | A golden recording keyed on the exact agent version              | KAR-05.7           | Edge case  |
| EPIC-05-S29 | Exec shim: per-vendor invocation and envelope                    | KAR-05.8           | Edge case  |
| EPIC-05-S30 | Detached spawn and the process group                             | KAR-05.9           | Edge case  |
| EPIC-05-S31 | Three-stage cancellation and the zombie false negative           | KAR-05.9           | Failure    |
| EPIC-05-S32 | Orphan reaping on boot with the PID-reuse guard                  | KAR-05.9           | Recovery   |
| EPIC-05-S33 | The direct API adapter stays inert without an explicit opt-in    | KAR-05.10          | Happy path |
| EPIC-05-S34 | A supplied key never reaches disk                                | KAR-05.10          | Failure    |
| EPIC-05-S35 | An unmediated adapter is refused write-capable work              | KAR-05.10          | Edge case  |

---

## EPIC-05-S1 — Happy path: a full prompt cycle through the ACP client

**Verifies:** KAR-05.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: One client drives any ACP agent

  Scenario: A node's turn runs end to end
    Given a run "r1" with a single agent node "n1" and a worktree at "<tmp>/wt/n1"
    And the provider row for "mock" advertises the "claude" capability profile
    When DeFlowd schedules "n1"
    Then a "node.scheduled" event is appended with provider "mock" and the node's permission level
    And the agent is spawned from the stored absolute path
    And an "initialize" request is sent carrying
        clientCapabilities { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
    And no "mcp" or "elicitation" client capability is advertised at M1
    And a "node.started" event is appended carrying binary { path, version, sha256 }
        BEFORE any side effect
    When the client sends "session/new" with cwd "<tmp>/wt/n1" and the DeFlow mcpServers entry
    Then the returned sessionId is recorded against the node
    When the client sends "session/prompt" with the assembled context packet
    Then each agent_message_chunk becomes one appended event, in arrival order, ordered by seq
    And the prompt resolves with stopReason "end_turn"
    And a "node.completed" event is appended carrying TokenUsage with an explicit "source"
    And the child process has exited and its pgid contains no non-Z processes
```

**Notes:** `node.started` is written **before** the side effect — that record is what makes at-least-once
recovery possible at all ([durable execution](../../05-durable-execution.md)). The client capability set is
deliberately minimal: `mcp/*` and `elicitation/*` are not implemented at M1 because `mcpCapabilities.acp`
was **not advertised true by a single probed agent**.

---

## EPIC-05-S2 — `protocolVersion` is the integer 1, and a mismatch fails cleanly

**Verifies:** KAR-05.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Version negotiation

  Scenario: The negotiated version is an integer
    When the client completes initialize against any profile
    Then the response's protocolVersion === 1
    And typeof protocolVersion === 'number'
    And the client asserts the type, not merely the value

  Scenario Outline: A non-1 response is a clean permanent failure
    Given the mock agent is configured to answer initialize with protocolVersion <version>
    When the client completes the handshake
    Then no session/new request is ever sent
    And a "node.failed" event is appended with
        failure.reason "adapter.handshake-failed" and failure.class "permanent"
    And failure.detail names the offered and expected versions
    And the child process is terminated

  Examples:
    | version      |
    | 2            |
    | 0            |
    | "2025-11-25" |

  Scenario: ACP and MCP version helpers are not shared
    Then no module exports a version-negotiation helper imported by both the ACP client
        and the MCP host
    And a repo grep finds no comparison of an ACP protocolVersion against a date-shaped string
```

**Notes:** ACP's `protocolVersion` is an **integer**; MCP's is a **date string** (`'2025-11-25'`). They look
similar, they are not, and a shared helper is the obvious mistake. The `"2025-11-25"` example is there
precisely to make that mistake fail a test. Package versions (`v1.3.0`, `v0.13.6`) are artefact versions and
are explicitly _not_ the compatibility signal.

---

## EPIC-05-S3 — The pull loop awaits the durable append before asking for more

**Verifies:** KAR-05.1, KAR-05.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Backpressure through nextUpdate()

  Scenario: The next frame is not requested until the append resolves
    Given the ledger's append is instrumented with a 5 ms delay and a call counter
    And the mock agent is scripted to emit 50 agent_message_chunks as fast as it can
    When the turn runs
    Then for every n, the (n+1)th call to session.nextUpdate() happens after
         the nth append has resolved
    And all 50 chunks are appended exactly once, in emission order

  Scenario: A slow consumer stalls the producer, it does not buffer it
    Given the mock agent emits 200 chunks of 8 KiB with no scripted delay
    And the consumer awaits a 5 ms durable write per chunk
    When the turn runs
    Then the daemon's RSS growth stays under 32 MiB
    And the child process is observed blocked in write() at least once
    And zero chunks are lost

  Scenario: Flowing mode is not reachable
    Then no source file under packages/adapters/src uses ".on('data'" on a child stream
    And the reader consumes stdout with "for await"
```

**Notes:** This is the single most important API detail in the layer. `session.nextUpdate()` is a **pull
loop, not a callback registration**. It gives natural backpressure — the reader stalls, the OS pipe fills at
64 KiB (measured `highWaterMark`, 2026-08-02) and the agent blocks in `write()` — and it is the only legal
place to `await` the SQLite append, because the event must be durable before DeFlow asks for more. With
`.on('data')` plus an `async` handler you are in flowing mode with an **unbounded in-memory queue**; Node
will happily buffer hundreds of MB while you await SQLite.

---

## EPIC-05-S4 — Cancel mid-turn: the tail is flushed before the process dies

**Verifies:** KAR-05.1, KAR-05.9 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Three-stage cancellation, stage 1

  Scenario: Trailing updates after the cancel are appended, not discarded
    Given the mock agent is in the "hangForever" state mid-turn
    And its scenario declares two trailing session/update notifications to flush on cancel
    When the operator triggers cancellation
    Then a "run.cancel.requested" event is appended with mode "cooperative"
    And session/cancel is sent at the protocol level FIRST
    And the nextUpdate() loop keeps running
    And the two trailing notifications are appended to the ledger
    And their seq values are LESS than the seq of the cancellation-completion event
    And the prompt resolves with stopReason "cancelled"
    And only then is process.kill(-child.pid, 'SIGTERM') sent
    And a "node.completed" event records result.status "cancelled" with by "user"

  Scenario: An agent that ignores the protocol cancel
    Given the mock agent is in the "hangForeverIgnoringCancel" state
    When the operator triggers cancellation
    Then no stopReason arrives within the grace window
    And after 5 seconds on the injected Clock, SIGTERM is sent to the process group
    And after a further 2 seconds, SIGKILL is sent
    And a "node.failed" event is appended with reason "timeout"
    And the transcript is marked incomplete rather than presented as clean
```

**Notes:** Stage 1 is the only stage that produces a clean transcript, and it only works if the reader keeps
running. A client that tears down its reader on cancel loses the tail of the turn and may deadlock waiting
for the prompt response. Asserting the **seq ordering** rather than merely the presence of the trailing
events is what makes "the tail arrived before we killed it" observable.

---

## EPIC-05-S5 — A permission request round-trips, including a cancelled outcome

**Verifies:** KAR-05.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: session/request_permission reaches the client

  Scenario: The client is actually asked
    Given the mock agent's scenario issues session/request_permission for a
          ToolKind "execute" with a ToolCallLocation path inside the worktree
    When the turn runs
    Then DeFlowd's registered handler is invoked with the request params
    And the handler returns a RequestPermissionOutcome
    And the agent's subsequent behaviour matches the returned optionId

  Scenario Outline: Every outcome shape is handled
    When the handler returns <outcome>
    Then the agent takes the corresponding branch
    And the turn reaches a terminal stopReason without the harness killing the process

  Examples:
    | outcome                                            |
    | { outcome: 'selected', optionId: 'allow_once' }    |
    | { outcome: 'selected', optionId: 'reject_always' } |
    | { outcome: 'cancelled' }                           |

  Scenario: The handler contains no policy
    Then packages/daemon/src/services/fronts/acp-fs.ts is under 40 lines
    And packages/daemon/src/services/fronts/acp-terminal.ts is under 60 lines
    And neither file branches on a permission level
    And both delegate to fs-service.ts / terminal-service.ts
```

**Notes:** The policy itself is EPIC-08. What this scenario locks down is the _shape_: transport-neutral
services with two thin fronts, and **no business logic in the ACP handlers**. ACP v2 deletes `fs/*` and
`terminal/*` from the client entirely and pushes them onto MCP; when that lands you re-point the MCP front
and delete the ACP one. The split is about an hour of work now and avoids rewriting the most
security-sensitive code in the daemon.

---

## EPIC-05-S6 — The probe persists the entire `initialize` response

**Verifies:** KAR-05.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Capability manifests are derived, never hardcoded

  Scenario: A probe writes one row and one event
    Given no row exists in provider_capabilities for provider "mock"
    When DeFlowd probes the provider
    Then the agent is spawned, sent initialize, and terminated
    And no session/new request was ever sent, so the probe costs no quota
    And exactly one row is inserted into provider_capabilities with
      | column        | value                                              |
      | provider      | "mock"                                             |
      | version       | the verbatim `--version` output                    |
      | binary_sha256 | the sha256 of the resolved entry file              |
      | binary_path   | an absolute path                                   |
      | caps_json     | the entire initialize response, byte-for-byte      |
      | probed_at     | ms epoch from the injected Clock                   |
    And a "provider.probed" event is appended carrying
        { provider, version, capsJson, binarySha256 }

  Scenario: Nothing is normalised on the way in
    Then JSON.parse(caps_json) deep-equals the response the agent actually sent
    And no key was renamed, defaulted, or dropped

  Scenario: The matrix exists only as data
    Then no source file under packages/adapters/src contains a literal
        provider-to-capability mapping
    And every routing query reads provider_capabilities
```

**Notes:** Persisting the response _unmodified_ is what lets a future DeFlow answer a question nobody thought
to ask today. The vendor documentation implies a different matrix than the one that was measured, and a
hardcoded table **will be wrong within a month** — two of the five versions in the 2026-08-02 snapshot were
published the same day they were probed.

---

## EPIC-05-S7 — Probed capability rows across the five verified adapters

**Verifies:** KAR-05.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The capability matrix as measured

  Scenario Outline: Each adapter's row answers the routing questions
    Given the mock agent runs with "--capabilities <profile>"
    When DeFlowd probes it and stores the row
    Then canResume(row) is <resume>
    And canFork(row) is <fork>
    And canList(row) is <list>
    And mcpAcp(row) is <mcpAcp>
    And loadSession(row) is true for every profile

  Examples:
    | profile  | resume | fork  | list  | mcpAcp    |
    | claude   | true   | true  | true  | undefined |
    | codex    | true   | false | true  | false     |
    | opencode | true   | true  | true  | undefined |
    | copilot  | false  | false | true  | undefined |
    | gemini   | false  | false | false | undefined |

  Scenario: Absent, empty and explicitly false are three different answers
    Given the "gemini" row, whose caps_json has NO sessionCapabilities key
    And the "copilot" row, whose sessionCapabilities is exactly { list: {} }
    And the "codex" row, whose mcpCapabilities.acp is the literal boolean false
    Then canResume(geminiRow) is false and the reason recorded is "capability-absent"
    And canFork(copilotRow) is false and the reason recorded is "capability-absent"
    And mcpAcp(codexRow) is false and the reason recorded is "capability-denied"
    And the three are distinguishable in the node inspector

  Scenario: Two of five cannot resume
    When DeFlowd summarises the probed rows
    Then exactly two of the five profiles report canResume false
    And those two are routed to ResumeByReplay by EPIC-05-S19
```

**Notes:** This table is the measured matrix of
[adapter layer §5](../../07-provider-adapter-layer.md), **verified 2026-08-02** against
`claude-agent-acp@0.64.1`, `codex-acp@1.1.9`, `opencode@1.18.11`, `copilot@1.0.77` and `gemini-cli@0.53.1`.
It is a **test fixture to re-probe, never a hardcoded constant**. Gemini returned **no
`sessionCapabilities` key at all**, only `loadSession: true`; Copilot returned
`sessionCapabilities: { list: {} }` and nothing else. Collapsing absent, empty and explicitly-`false` into
one falsy answer is how a router concludes an agent can do something it cannot — hence the second scenario
asserting the _reason_, not just the boolean.

---

## EPIC-05-S8 — A version bump writes a new row, never an update

**Verifies:** KAR-05.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Capability history survives an upgrade

  Scenario: Re-probing an unchanged binary is a no-op
    Given a row exists for ("mock", "1.0.0", "<sha>")
    When DeFlowd probes the same binary again
    Then the table still has exactly one row for that provider
    And probed_at is updated but caps_json is unchanged

  Scenario: A version bump inserts a second row
    Given a row exists for ("mock", "1.0.0", "<shaA>")
    When the binary is replaced and reports version "1.1.0" with sha "<shaB>"
    And DeFlowd probes it
    Then the table has two rows
    And the ("mock","1.0.0","<shaA>") row is byte-identical to before
    And two "provider.probed" events exist in the ledger

  Scenario: A rebuilt binary at the same version is also a new row
    Given the reported version stays "1.1.0" but the sha256 changes
    When DeFlowd probes it
    Then a third row is inserted
    And this is what catches a locally-patched or partially-installed binary
```

**Notes:** The three-part primary key `(provider, version, binary_sha256)` is deliberate. Updating in place
would destroy the record of what an agent could do at the time a run started — which is exactly what
EPIC-05-S20's resume guard needs to compare against.

---

## EPIC-05-S9 — A node is refused scheduling before a process is spawned

**Verifies:** KAR-05.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Admission control from the probed row

  Scenario Outline: A node whose requirements exceed the adapter is refused
    Given the provider row is the "<profile>" profile
    And node "n1" declares requires "<requirement>"
    When the scheduler evaluates "n1"
    Then no child process is spawned
    And a "node.failed" event is appended with
        failure.reason "adapter.capability-missing" and failure.class "permanent"
    And failure.detail names the requirement and the profile
    And the operator is offered re-routing rather than a silent stall

  Examples:
    | profile | requirement           |
    | codex   | session.fork          |
    | gemini  | session.list          |
    | copilot | session.delete        |
    | gemini  | additionalDirectories |

  Scenario: An adapter that cannot mediate execution is refused, not escalated
    Given the provider row reports mediatedExecution false
    And node "n1" requires permission level "worktree"
    When the scheduler evaluates "n1"
    Then the failure reason is "safety.permission-unschedulable"
    And the run is NOT silently escalated to a broader permission level
```

**Notes:** The capability row is _the single input the entire routing layer trusts_. Refusing before spawn
is what makes an unschedulable node a plan-time fact rather than an hour-three surprise. The second scenario
encodes F5.4's rule directly: where a provider cannot express the requested level, DeFlow **refuses to
schedule** rather than silently escalating — ODW's binary permission model is the documented hazard being
avoided.

---

## EPIC-05-S10 — Spawn strategy per vendor

**Verifies:** KAR-05.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The verified provider table, encoded once

  Scenario Outline: Each vendor is invoked its own way
    Given the provider "<vendor>" resolved to absolute path "<abs>"
    When DeFlowd spawns it for node "n1" with worktree "<wt>"
    Then the spawned command is "<command>"
    And the spawned argv is "<argv>"
    And the child env contains "<env>"
    And the spawn is detached with stdio ['pipe','pipe','pipe']

  Examples:
    | vendor      | command                  | argv                    | env                        |
    | gemini      | <abs>/gemini             | --acp                   | (no vendor-specific entry) |
    | copilot     | <abs>/copilot            | --acp                   | (no vendor-specific entry) |
    | opencode    | <abs>/opencode           | acp --cwd <wt>          | (no vendor-specific entry) |
    | claude      | <abs>/claude-agent-acp   | (none)                  | (no vendor-specific entry) |
    | codex       | <abs>/codex-acp          | (none)                  | CODEX_PATH=<abs>/codex     |

  Scenario: OpenCode's is a subcommand, not a flag
    Then the opencode argv's first element is the literal "acp"
    And it is not prefixed with "--"

  Scenario: Claude Code and Codex are not spawned directly
    Then no provider spec spawns "<abs>/claude" or "<abs>/codex" expecting ACP
    And a comment or test name records that both were verified ABSENT from
        `claude --help` v2.1.220 and `codex --help` v0.146.0
```

**Notes:** This inverts the naive assumption, and getting it wrong means building the wrong spawn logic for
the two most important providers. **Claude Code and Codex do not speak ACP** — verified by grepping both
`--help` outputs for zero hits — and reach it only through the `@agentclientprotocol/*` adapter packages,
both published 2026-08-02, both under the same official GitHub org as the spec. `codex-acp` honours
`CODEX_PATH` to select the Codex binary; use it rather than letting the adapter search.

---

## EPIC-05-S11 — The adapter never searches PATH

**Verifies:** KAR-05.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Absolute paths only

  Scenario: A daemon-shaped environment still finds the binary
    Given DeFlowd's own PATH is "/usr/bin:/bin", as under a launchd or systemd unit
    And the provider row's binary_path is "<tmp>/bin/claude-agent-acp"
    When DeFlowd spawns the provider
    Then the child starts and completes initialize

  Scenario: A missing binary is a typed failure, not a raw errno
    Given the provider row's binary_path points at a deleted file
    When DeFlowd spawns the provider
    Then a "node.failed" event is appended with reason "adapter.spawn-failed"
    And failure.message is one human-readable line naming the vendor
    And failure.detail includes the attempted absolute path
    And the raw ENOENT is captured as an evidence handle, not rendered as the message

  Scenario: A non-executable file is distinguished from a missing one
    Given binary_path points at a file with mode 0644
    Then the failure detail records EACCES rather than ENOENT

  Scenario: No bare command names anywhere
    Then no source file under packages/adapters/src calls spawn with a command
        that does not start with "/" or come from a capability row
```

**Notes:** DeFlowd's `PATH` at daemon-start differs from the user's login shell — a daemon started by a login
item, a systemd unit or `npx` inherits a different environment than an interactive terminal. This is a
silent, machine-specific failure that presents as "works for me", which is the worst kind to debug over a
GitHub issue.

---

## EPIC-05-S12 — Gemini's deprecated flag fallback, exactly once

**Verifies:** KAR-05.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Surviving a deprecation window

  Scenario: --acp is tried first
    Given the mock stands in for gemini and accepts "--acp"
    When DeFlowd spawns it
    Then the argv contains "--acp" and not "--experimental-acp"
    And no retry occurs

  Scenario: A fallback happens once and is recorded
    Given the mock stands in for gemini and exits with an argv-parse error on "--acp"
    When DeFlowd spawns it
    Then exactly one retry occurs, with "--experimental-acp"
    And an event records that the deprecated flag was used, with the vendor version
    And the operator sees a warning in the run header

  Scenario: A second failure is not retried again
    Given both flags produce an argv-parse error
    Then the node fails with reason "adapter.spawn-failed"
    And exactly two spawn attempts were made in total
```

**Notes:** Gemini's `--experimental-acp` still exists but `--help` marks it _"(deprecated, use --acp
instead)"_. The bounded single retry is the point: an unbounded fallback loop against a churning flag surface
turns a clear failure into a slow one. Recording that the deprecated path was taken is what makes the
monthly `--help` diff actionable.

---

## EPIC-05-S13 — A single 10 MB line trips the 8 MiB cap

**Verifies:** KAR-05.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The frame-size guard

  Scenario: An oversized frame aborts the session and kills the agent
    Given a byte-counting TransformStream sits between the child's stdout and ndJsonStream
    And the mock agent runs the "hugeLine" scenario emitting a single 10 MB line
    When the counter's bytes-since-last-newline exceeds 8388608
    Then the session is aborted with a structured FrameTooLarge error
    And killTree(child.pid) is called
    And a "node.failed" event is appended with reason "adapter.frame-too-large"
        and class "permanent"
    And the first 4096 bytes of the offending frame are stored as an evidence handle
    And no recovery is attempted — the agent is misbehaving, not merely verbose
    And the daemon's RSS never exceeded its pre-turn baseline by more than 16 MiB
    And after the kill, the child's pgid contains no processes in a non-Z state
```

**Notes:** **Verified hazard.** `@agentclientprotocol/sdk`'s `LineBuffer` (`dist/line-buffer.js`) has **no
maximum line length**: `push()` accumulates chunks into a private `#pending` array and only emits on finding
a `0x0a`. DeFlowd is a long-lived daemon supervising runs for days, so this is a real availability bug, not a
theoretical one. Measured scale: a _trivial_ `claude -p "say ok"` turn emitted a single **16,024-byte** JSON
line, and real turns that read a large file or capture a test log routinely produce multi-megabyte single
lines. The cap must be **upstream of the SDK** — bolting it onto the parsed frame is too late, because the
buffer has already grown.

---

## EPIC-05-S14 — A wedged agent that never emits a newline

**Verifies:** KAR-05.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The case a frame-size cap alone does not cover

  Scenario: 64 KiB every 10 ms, forever, with no 0x0a
    Given the mock agent runs the "noNewline" scenario
    When DeFlowd reads the stream
    Then zero complete frames are ever emitted by the SDK's LineBuffer
    And the byte counter still fires at 8388608 bytes since the last newline
    And the session is aborted with reason "adapter.frame-too-large"
    And killTree() terminates the agent
    And the guard fires within 3 seconds of the stream starting
    And the daemon's RSS growth stays under 16 MiB

  Scenario: The counter resets on every newline
    Given the agent emits 6 MiB, a newline, then 6 MiB, a newline
    Then two frames are delivered
    And the guard never fires
    And this proves the counter is "bytes since last newline", not "bytes total"
```

**Notes:** This is the scenario the naive implementation misses. If the guard measures the size of a
_completed frame_, an agent that never completes one is invisible to it — and that is precisely the wedged
or buggy agent the guard exists for. The second scenario is the necessary complement: a counter that never
resets would abort legitimate long-running turns.

---

## EPIC-05-S15 — The cap boundary, from both sides

**Verifies:** KAR-05.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: 8 MiB exactly

  Scenario Outline: The boundary is asserted from both directions
    Given the mock emits a single line of <bytes> bytes followed by a newline
    When DeFlowd reads the stream
    Then the outcome is "<outcome>"

  Examples:
    | bytes   | outcome                                  |
    | 8388607 | delivered and parsed as a valid frame     |
    | 8388608 | delivered and parsed as a valid frame     |
    | 8388609 | aborted with adapter.frame-too-large      |

  Scenario: The cap is configurable but defaults to 8 MiB
    Then the default maxFrameBytes is 8388608
    And a run may lower it but a test asserts it can never be set to 0 or Infinity
```

**Notes:** Off-by-one on a cap like this is the classic way to reject a legal frame from a real vendor, which
would look exactly like adapter breakage and send you hunting in the wrong place. Both sides of the boundary
need an explicit test.

---

## EPIC-05-S16 — Payloads over 256 KiB spill to content-addressed blobs

**Verifies:** KAR-05.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Keeping the event log small enough to replay

  Scenario: A large tool_call_update spills
    Given the mock emits a tool_call_update whose content is 300 KiB
    When DeFlowd appends the event
    Then the bytes are written to
         "~/.DeFlow/blobs/<sha256[0:2]>/<sha256>"
    And the event row stores only { sha256, bytes, mime, head, tail }
    And head is at most 2 KiB from the start
    And tail is at most 2 KiB from the end
    And the event row's payload is under 8 KiB
    And the UI can render a preview from head and tail without touching disk

  Scenario: A small payload does not spill
    Given the content is 100 KiB
    Then no blob file is created and the payload is stored inline

  Scenario: Raw agent stdout never enters the control plane
    Then raw stdout bytes are written to the io_chunk table with stream "agent_json"
    And the reducer never reads io_chunk
    And a replay of the run reads only the event table
```

**Notes:** **Replay time is a function of event-log size, and un-spilled tool output is what makes it
explode** (F4.2, NF3). Content-addressing also deduplicates, which matters more than it sounds — see the next
scenario. The `io_chunk` separation is the control-plane / data-plane split from
[durable execution §5](../../05-durable-execution.md): the reducer must never read it, which is the one rule
that keeps replay fast.

---

## EPIC-05-S17 — Identical output across three retries deduplicates

**Verifies:** KAR-05.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Content addressing earns its keep

  Scenario: The same failing test log across three attempts
    Given node "n1" fails and is retried twice, for three attempts in total
    And each attempt captures the byte-identical 400 KiB test-failure log
    When all three attempts have completed
    Then exactly one file exists under ~/.DeFlow/blobs/
    And three event rows reference the same sha256
    And the total bytes on disk are ~400 KiB, not ~1.2 MiB

  Scenario: A one-byte difference produces a second blob
    Given the third attempt's log differs by one byte
    Then two files exist and the third row references the new sha256
```

**Notes:** Three retry attempts producing the same failing test log is not a contrived case — it is the
_common_ case in a repair loop, which is why content addressing pays for itself immediately rather than
eventually.

---

## EPIC-05-S18 — `terminal/output` is ring-buffered and truncation is honest

**Verifies:** KAR-05.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Capping the agent's own terminal polling

  Scenario: A noisy build is bounded on the way in
    Given the agent calls terminal/create for a command emitting 5 MB with a progress bar
    And the agent polls terminal/output
    When DeFlowd answers
    Then the returned buffer is at most 1 MiB
    And the response reports truncation explicitly using the schema's truncation field
    And the full output is still available as a spilled blob handle

  Scenario: The ring buffer keeps the tail, not the head
    Given the command emits 3 MiB where the last 100 bytes contain the error
    When the agent polls terminal/output
    Then the returned buffer's final bytes are the error text
    And the truncation flag is set

  Scenario: Per-terminal, not global
    Given two concurrent terminals each emit 1.5 MiB
    Then each has its own 1 MiB ring buffer
    And neither evicts the other's content
```

**Notes:** The ACP `terminal/*` methods let the agent poll a long-running command, and a `yarn build` with a
progress bar can emit tens of MB. Keeping the **tail** rather than the head is the pragmatic choice: the
error is almost always at the end. The schema's terminal output response is designed for exactly this, so
reporting truncation honestly costs nothing and lying about it costs a debugging session.

---

## EPIC-05-S19 — Resume strategy selected from the probed row

**Verifies:** KAR-05.5 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Two strategies behind one interface

  Scenario Outline: The strategy follows the capability, not the vendor name
    Given the provider row is the "<profile>" profile
    And run "r1" node "n1" is mid-turn with 12 events appended
    When the daemon is stopped with db.close() and a fresh engine is constructed
        over the same ledger file
    And "n1" is resumed
    Then the selected strategy is "<strategy>"
    And "<resumeFrameSent>" describes whether a session/resume frame was sent
    And the node reaches "node.completed" with the same output as an uninterrupted run
    And no completed effect was executed a second time

  Examples:
    | profile  | strategy       | resumeFrameSent          |
    | claude   | ResumeNative   | yes, with the stored sessionId |
    | codex    | ResumeNative   | yes, with the stored sessionId |
    | opencode | ResumeNative   | yes, with the stored sessionId |
    | copilot  | ResumeByReplay | no — session/new is sent instead |
    | gemini   | ResumeByReplay | no — session/new is sent instead |

  Scenario: ResumeNative does not re-send the context packet
    Given the "claude" profile
    When "n1" is resumed
    Then the prompt sent after session/resume does not contain the pinned spec segments
    And a "budget.consumed" comparison shows fewer input tokens than a replay resume

  Scenario: ResumeByReplay reconstructs the packet from the ledger alone
    Given the "gemini" profile
    When "n1" is resumed
    Then the reconstructed packet is byte-identical to the packet recorded in the
        "context.built" event for that node and attempt
    And the reconstruction read no vendor session file and no vendor API

  Scenario: The selection logic names no vendor
    Then the strategy selector's source contains no string literal matching
        claude|codex|gemini|copilot|opencode
```

**Notes:** **Two of five providers cannot resume**, so `ResumeByReplay` is the durability path for 40% of the
matrix and must be exercised on every commit — which is only affordable because KAR-04.4 makes a Gemini-shaped
profile a flag rather than an installed, authenticated CLI. The governing rule:
**DeFlow's own SQLite ledger is the sole source of truth for a run; every prompt DeFlow sends must be
reconstructible from that log alone; `session/resume` is a token-cost optimisation, never the durability
mechanism.** The final scenario is the guard against someone "helpfully" special-casing a vendor when a
capability probe returns something surprising.

---

## EPIC-05-S20 — A vendor version change invalidates a resume

**Verifies:** KAR-05.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The poisoning guard

  Scenario: A version bump between crash and resume refuses by default
    Given "node.started" for r1/n1 recorded binary { version: "0.146.0", sha256: "<A>" }
    And the run was interrupted mid-turn
    When the daemon restarts and the resolved binary now reports "0.150.0" with sha256 "<B>"
    And "n1" is resumed
    Then no session/resume frame is sent
    And the node is suspended with a "human.requested" event
    And the prompt to the operator names the recorded version, the current version,
        and the risk of a subtly corrupted context
    And the default answer is to refuse

  Scenario: The operator opts in explicitly
    When the operator responds with the override option
    Then a "human.responded" event records the override
    And the resume proceeds with session/resume
    And the run header shows that a cross-version resume was permitted

  Scenario: A sha change at the same version also triggers the guard
    Given the version string is unchanged but binary_sha256 differs
    Then the same refusal path is taken

  Scenario: The guard does not fire on a matching binary
    Given both version and sha256 match what node.started recorded
    Then the resume proceeds without a human gate
```

**Notes:** Session-file formats and resume semantics are internal vendor details that change without notice.
Resuming a Codex 0.146 session under 0.150 **is not a supported operation by anyone**, and the failure mode
is not a clean error — it is a subtly corrupted context that poisons the rest of a multi-hour run. Refusing
by default and making the override an explicit, recorded human decision is the only honest handling. The
sha-only variant catches a locally-patched or partially-reinstalled binary that still reports the old
version string.

---

## EPIC-05-S21 — `session/load` is not a substitute for `session/resume`

**Verifies:** KAR-05.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: loadSession is universally true and semantically different

  Scenario: load is never chosen automatically
    Given a provider row where canResume is false and loadSession is true
    When "n1" is resumed
    Then ResumeByReplay is selected
    And no session/load request is sent

  Scenario: If load is used, the flood is bounded and deduped
    Given a diagnostic path deliberately issues session/load
    And the agent replays 400 historical session/update notifications
    When DeFlowd processes them
    Then deduplication is keyed on DeFlow's OWN event ids, not the agent's
    And the ledger gains zero duplicate rows for events already appended
    And a warning event records how many notifications were discarded

  Scenario: A days-long run is protected
    Given a run with 20,000 prior session/update notifications
    When session/load is attempted
    Then DeFlowd refuses with a typed error naming the notification count
    And the run continues via ResumeByReplay
```

**Notes:** `loadSession` is `true` on all five probed adapters, which makes it a tempting substitute. It is
not one: `session/load` **streams the entire conversation history back at you as `session/update`
notifications** while `session/resume` does not. For a days-long run it will flood you. Deduping on the
agent's ids rather than DeFlow's is the specific trap — the agent's ids are not stable across a reconnect.

---

## EPIC-05-S22 — MCP injected through `session/new`, user config untouched

**Verifies:** KAR-05.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Workflow tools without mutating the user's environment

  Scenario: The stdio variant is chosen
    When DeFlowd sends session/new
    Then params.mcpServers[0] has name "DeFlow"
    And it has NO "type" discriminant — it is the untagged stdio variant
    And command === process.execPath
    And args contain the deflow-mcp entry, "--socket <path>" and "--run <runId>"
    And env contains a DeFlow_RUN_TOKEN valid only for this run

  Scenario: The user's global MCP configuration is never written
    Given the fixture's stand-in vendor config files are hashed before the run
    When a full run completes
    Then every vendor config file hashes identically afterwards
    And no file under the fixture's HOME was created or modified by DeFlowd

  Scenario: The transport choice is justified by the probes
    Then no adapter uses the { type: "acp", serverId } McpServer variant
    And a test records that mcpCapabilities.acp was advertised true by zero probed agents
    And no code imports @modelcontextprotocol/sdk/server/sse.js or client/sse.js

  Scenario: Deep subpath imports only
    Then the workspace imports @modelcontextprotocol/sdk only via
        "/server/mcp.js" and "/server/stdio.js"
    And a root-package import fails the test
```

**Notes:** stdio is the **untagged default variant** of the four-way `McpServer` union and needs **no
capability flag**, so all five agents accept it. The elegant "tunnel MCP over the existing ACP pipe" path via
`mcp/connect` + `mcp/message` is specified but implemented nowhere — `mcpCapabilities.acp` was not advertised
true by a single agent, and codex-acp explicitly returned `acp: false`. Legacy HTTP+SSE is officially
deprecated as of the 2026-07-28 MCP spec with a 12-month offramp, so it must not be built on even though it
still ships in SDK 1.30.0. The root-import ban is about weight: the SDK pulls `express`, `hono`, `cors`,
`jose`, `eventsource` and more, nearly all dead weight for a stdio server that still slows `npx deflow up`.

---

## EPIC-05-S23 — A workflow tool call reaches DeFlowd over the UDS

**Verifies:** KAR-05.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: deflow-mcp as a thin shim

  Scenario: A tool round-trips
    Given the agent has spawned deflow-mcp from the session/new mcpServers entry
    And deflow-mcp has connected to DeFlowd over a Unix domain socket
    When the agent calls the "DeFlow.readFact" tool with a key
    Then the request crosses the UDS to DeFlowd
    And a "fact.read" event is appended naming the calling node
    And the tool result returns to the agent with a value matching the outputSchema

  Scenario: The socket is filesystem-protected, not port-protected
    Then the socket's parent directory mode is 0700
    And no TCP port was bound for MCP

  Scenario: A bad token is refused
    Given deflow-mcp presents a token from a different run
    When it connects
    Then the connection is refused
    And DeFlowd logs the refusal with the presented run id
    And no tool is served

  Scenario: The shim dies with its agent
    When the agent process is killed
    Then deflow-mcp observes stdin close and exits within 2 seconds
    And the socket file is released
```

**Notes:** A UDS rather than a TCP port because DeFlowd is already local: filesystem permissions come free
instead of needing a loopback auth scheme. The shim exiting on stdin close is what keeps a killed agent from
leaving a socket holder behind — otherwise every crashed node leaks a process.

---

## EPIC-05-S24 — A new phase unlocks tools without a new session

**Verifies:** KAR-05.6 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: sendToolListChanged

  Scenario: Tools appear when the plan advances
    Given the agent's session was created during the "analysis" phase
    And only read-oriented workflow tools were registered
    When the plan advances and the node enters the "implementation" phase
    Then DeFlowd calls sendToolListChanged()
    And the agent receives a notifications/tools/list_changed frame
    And a subsequent tools/list returns the newly available tools
    And no new ACP session was created

  Scenario: A tool removed by a phase change is no longer callable
    When a tool is withdrawn and sendToolListChanged() is emitted
    And the agent calls the withdrawn tool anyway
    Then the call returns a tool error rather than executing
    And an event records the attempt
```

**Notes:** Designing around `.sendToolListChanged()` avoids the alternative — tearing down and rebuilding the
ACP session every time the plan phase changes, which would discard the vendor's session context and turn a
cheap transition into an expensive one.

---

## EPIC-05-S25 — Layer A: every recorded frame validates against `schema.json`

**Verifies:** KAR-05.7 · **Type:** Happy path · **Automated at:** contract

```gherkin
Feature: Schema conformance, every commit

  Scenario: The whole recorded corpus validates
    Given ajv compiled against @agentclientprotocol/sdk/schema/schema.json
    And that schema contains 262 $defs
    When the suite validates every frame in every file under recordings/
    Then every frame validates
    And the suite runs offline with no vendor CLI installed

  Scenario: One bad frame fails loudly
    Given a fixture recording containing one frame whose sessionUpdate is unknown
    When the suite runs
    Then it fails
    And the message names the file, the line number and the failing JSON pointer

  Scenario: The mock agent's own frames validate
    Given a run against deflow-mock-agent with DeFlow_RECORD=1
    When Layer A validates the produced recording
    Then every frame validates
    And the mock therefore cannot emit a frame no real agent could

  Scenario: The tee is in the transport
    Then the recording contains raw frames in both directions
    And the tee is registered on the byte stream, not inside the normaliser
    And a test asserts a frame the normaliser does not understand is still recorded
```

**Notes:** **There is no official ACP conformance kit** — verified negative 2026-08-02: no `conformance/`,
`compliance/` or `tests/` directory in the spec repo, and `@agentclientprotocol/conformance`,
`acp-conformance` and `@agentclientprotocol/test-kit` all 404 on npm. Web search asserts otherwise by
conflating it with an unrelated academic protocol also abbreviated ACP. **Do not chase it.** What does exist
is `schema.json`, and `ajv` arrives transitively via the MCP SDK, so this layer costs nothing and fires the
instant an upstream SDK bump changes the wire shape.

The last scenario is the important discipline: **put the tee in the transport, never in the adapter** — an
adapter-level tee records what your normaliser already understood, which is precisely the class of change you
need to detect.

---

## EPIC-05-S26 — Layer B: the behavioural contract over adapters

**Verifies:** KAR-05.7 · **Type:** Happy path · **Automated at:** contract

```gherkin
Feature: providerContract(adapterFactory)

  Scenario Outline: The eight assertions across every capability profile
    Given providerContract is instantiated with a factory for profile "<profile>"
    When the suite runs
    Then assertion 1 holds: initialize returns protocolVersion === 1
    And assertion 2 holds: session/new returns a sessionId
    And assertion 3 holds: a trivial prompt yields >=1 agent_message_chunk then
        a PromptResponse with stopReason === 'end_turn'
    And assertion 4 holds: session/cancel mid-turn yields stopReason === 'cancelled'
        AND the client tolerates session/update notifications arriving after the cancel
    And assertion 5 holds: a permission request round-trips and a client-side cancel
        produces RequestPermissionOutcome { outcome: 'cancelled' }
    And assertion 6 holds: calling an unadvertised method returns JSON-RPC -32601
    And assertion 7 holds: a malformed JSON line produces a structured adapter error,
        the session is torn down, and the daemon does not crash
    And assertion 8 holds: an oversized frame produces FrameTooLarge, killTree() runs,
        and there is no OOM

  Examples:
    | profile   |
    | claude    |
    | codex     |
    | opencode  |
    | copilot   |
    | gemini    |
    | mock-full |

  Scenario: Capability-dependent assertions skip explicitly, never silently
    Given the "gemini" profile, which advertises no session.list
    When the suite reaches a list-dependent assertion
    Then the assertion is reported as skipped with the reason "capability-absent: session.list"
    And it is NOT reported as passed

  Scenario: Real CLIs run nightly, never in CI
    Then the real-adapter parameterisation is tagged "@live"
    And the CI configuration does not select that tag
    And a documented `pnpm test:record` is the only path that touches a real subscription
```

**Notes:** One suite, one call site per adapter. Assertion 4's second clause is the one implementations get
wrong: per the spec a client **should keep accepting `session/update` notifications after sending
`session/cancel`**, because the agent flushes its final updates before answering the prompt. The explicit
skip reporting matters more than it looks — a silently-skipped assertion on a capability-poor provider is
indistinguishable from a passing one, which is how you end up believing five adapters are covered when three
are.

---

## EPIC-05-S27 — An agent advertising a capability it does not honour

**Verifies:** KAR-05.7, KAR-05.2 · **Type:** Failure · **Automated at:** contract

```gherkin
Feature: Capability honesty

  Scenario: Advertised resume, unimplemented resume
    Given the mock runs with "--capabilities claude --dishonest-capabilities session.resume"
    And DeFlowd has probed it and stored a row where canResume is true
    When a node is resumed and ResumeNative sends session/resume
    Then the agent answers with JSON-RPC error code -32601
    And DeFlowd appends a "node.failed" event with reason "adapter.capability-missing"
    And failure.detail names the advertised capability and the method that failed
    And conformance assertion 6 fails for that adapter, naming session.resume

  Scenario Outline: Dishonesty across the routing-relevant capabilities
    Given the agent advertises "<capability>" and refuses "<method>"
    When DeFlowd exercises it
    Then a -32601 is observed and reported as a conformance failure

  Examples:
    | capability            | method         |
    | session.resume        | session/resume |
    | session.fork          | session/fork   |
    | session.list          | session/list   |
    | additionalDirectories | session/new    |

  Scenario: A dishonest adapter does not silently downgrade
    Then DeFlowd does NOT fall back to ResumeByReplay on the first -32601
    And the failure is surfaced, because a capability row that lies about one
        thing cannot be trusted about the rest
```

**Notes:** Assertion 6 _is_ the one that catches a lying capability manifest, **which is the single input the
entire routing layer trusts**. The last scenario encodes a deliberate product decision: an automatic
fallback would paper over the dishonesty and let a broken adapter keep making routing promises it cannot
keep. Fail, tell the operator, and let re-routing be an explicit `PlanPatch` (EPIC-11).

---

## EPIC-05-S28 — A golden recording keyed on the exact agent version

**Verifies:** KAR-05.7 · **Type:** Edge case · **Automated at:** contract

```gherkin
Feature: Version-keyed goldens make churn visible

  Scenario: Recording during a real capture
    Given DeFlow_RECORD=1 and an authenticated claude-agent-acp at 0.64.1
    When `pnpm test:record` runs the "simple-edit" case
    Then recordings/claude-agent-acp@0.64.1/simple-edit.ndjson is written
    And each line has the shape {"t": <msOffset>, "dir": "in"|"out", "msg": { ... }}
    And the t offsets are monotonically non-decreasing
    And both directions are present

  Scenario: A version bump is a new directory in the PR
    Given the adapter is upgraded to 0.65.0 and re-recorded
    Then recordings/claude-agent-acp@0.65.0/ appears as a new directory
    And no file under @0.64.1 is modified
    And the reviewer can diff the two directories to see what the vendor changed

  Scenario: Both layers of assertion run per recording
    When the suite replays a recording
    Then raw frames are asserted against schema.json (Layer A)
    And the NORMALISED DeFlow event vocabulary is asserted against a file snapshot
    And the snapshot passes through the normalising serializer so timestamps, ULIDs,
        durations, absolute paths, ports and worktree names are stable

  Scenario: The normalising serializer is registered before any snapshot exists
    Then test/setup.ts registers expect.addSnapshotSerializer
    And a test asserts the serializer normalises ts, runId and durationMs
```

**Notes:** Keying on the **exact** version means a bump produces a visible new directory rather than silently
invalidating old goldens. Snapshotting _only_ the normalised form is less brittle and also less sensitive —
it will not catch an upstream change your normaliser happens to swallow — hence both layers. Registering the
serializer before the first snapshot is written is non-negotiable: otherwise every snapshot churns on every
run and the mechanism becomes noise you learn to `-u` past, which is worse than having no snapshots.

---

## EPIC-05-S29 — Exec shim: per-vendor invocation and envelope

**Verifies:** KAR-05.8 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The CLI fallback, where vendors stop resembling each other

  Scenario Outline: Each vendor's headless invocation
    Given the fake exec-shim agent is symlinked as "<vendor>"
    When DeFlowd invokes the shim for a read-only node
    Then the argv is "<argv>"
    And the parsed output produces the internal event vocabulary

  Examples:
    | vendor   | argv                                                          |
    | claude   | -p <prompt> --output-format stream-json --session-id <uuid> --verbose |
    | codex    | exec --json --skip-git-repo-check -C <wt> <prompt>            |
    | gemini   | -p <prompt> --output-format stream-json --session-id <uuid>   |
    | copilot  | -p <prompt> --output-format json --allow-all-tools            |
    | opencode | run --format json <prompt>                                    |

  # Amended by KAR-12.2 (EPIC-12): the claude row gained `--session-id <uuid>`.
  # KAR-12.2 AC4 requires DeFlow to mint the reviewer's session id and pass it
  # on this path, and AC5 rests on the 2026-08-02 verification that Claude Code
  # honours a client-chosen `--session-id` verbatim in every emitted frame — so
  # a shim invocation that did not carry one would leave every node's session id
  # to be parsed back out of a frame, and independence uncheckable afterwards.

  Scenario: Claude Code's --verbose requirement is never violated
    Given the shim requests --output-format stream-json
    Then --verbose is always present in the argv
    And the vendor error
        "Error: When using --print, --output-format=stream-json requires --verbose"
        is never produced

  Scenario: Copilot has no stream-json
    When the Copilot spec is asked for stream-json
    Then construction fails with an error naming the supported formats "text|json"
    And no process is spawned

  Scenario: The uuid is the dedup key on this path
    Given a stream-json capture is fed to the parser twice
    Then one ledger row exists per distinct line uuid
    And replaying after a crash produces no duplicate events

  Scenario: The result envelope maps to typed outcomes
    Given the final line is {"type":"result","subtype":"<subtype>", ...}
    Then the mapped outcome is "<outcome>"

    Examples:
      | subtype                             | outcome                                     |
      | success                             | node.completed with TokenUsage source 'vendor-reported' |
      | error_max_structured_output_retries | node.failed reason agent.schema-repair-exhausted |

  Scenario: A rate limit is scheduled around, not retried into
    Given a rate_limit_event line with rate_limit_info.resetsAt 900 seconds ahead
    Then a "provider.rate_limited" event is appended carrying resetsAt
    And a node_wake row is written for that time rather than an immediate retry

  Scenario: The frame guard applies here too
    Given the fake agent emits a single 10 MB line on the shim path
    Then reason "adapter.frame-too-large" is produced by the SAME transport guard
    And there is not a second implementation of the cap

  Scenario: Mediation is lost, and that is refused rather than hidden
    Given the shim adapter's row reports mediatedExecution false
    And a node requires permission level "worktree"
    Then the node fails with reason "safety.permission-unschedulable"
```

**Notes:** **This whole story is a scope-cut candidate** — [§8.5](../../07-provider-adapter-layer.md) argues
for skipping the exec shim at M1 and supporting only ACP-reachable providers, which is five of the six PRD
targets. If it is cut, these scenarios are cut with it and F3.2 is knowingly unmet at M1.

Every flag above was read from the installed binary's own `--help` on 2026-08-02. Three churn warnings are
already live: Claude's `--permission-prompt-tool` is gone from `--help`, `codex exec --full-auto` is gone,
and Gemini's `--allowed-tools` is marked `[DEPRECATED: Use Policy Engine instead]`. The real cost of this
path is not the parsing — it is that DeFlow stops sitting in front of every file access and command
execution, which is why the last scenario refuses rather than degrades.

---

## EPIC-05-S30 — Detached spawn and the process group

**Verifies:** KAR-05.9 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: detached: true is mandatory

  Scenario: All descendants share the child's process group
    Given an agent that backgrounds two children
    And it was spawned with detached: true
    When the harness reads `ps -eo pid,pgid,stat` for the tree
    Then every process in the tree has pgid equal to the child's pid
    And process.kill(-child.pid, 'SIGTERM') reaches all of them

  Scenario: The non-detached case is actively dangerous
    Given the same agent spawned with detached: false
    Then the grandchildren's pgid equals DeFlowd's OWN process group
    And child.kill('SIGTERM') terminates only the direct child
    And both grandchildren remain in state S
    And signalling that group would kill DeFlowd itself
    And this scenario exists so nobody "simplifies" the spawn options

  Scenario: The spawn options are enforced structurally
    Then no source file under packages/adapters/src spawns an agent without detached: true
    And a unit test asserts the spawn helper's default options object

  Scenario: A process row accompanies node.started
    When an agent is spawned
    Then a row { runId, nodeId, pid, pgid, started_at, binary_sha256 } is written
        in the SAME transaction as the node.started event
```

**Notes:** **Verified by measurement, not inference.** A bash script backgrounding two children was spawned
both ways with real PGIDs observed via `ps -o pid=,stat=,pgid=`. The non-detached result is the dangerous one
and it is what most tutorials show. The same-transaction write of the process row is what makes orphan
reaping possible at all — a row written after the spawn can be lost to a crash in between.

---

## EPIC-05-S31 — Three-stage cancellation and the zombie false negative

**Verifies:** KAR-05.9 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The kill switch, and verifying it honestly

  Scenario: The three stages in order
    Given a live agent with two backgrounded grandchildren
    When the operator triggers the kill switch
    Then stage 1 sends session.cancel() at the protocol level and awaits
         stopReason 'cancelled'
    And stage 2 sends process.kill(-child.pid, 'SIGTERM') after stage 1 resolves
         or after its grace expires on the injected Clock
    And stage 3 sends process.kill(-child.pid, 'SIGKILL') 5 seconds later
    And if the group still has non-Z members 2 seconds after that,
        a "node.failed" event escalates the failure to the ledger

  Scenario: The zombie false negative
    Given a successful group SIGKILL has just been sent
    When the harness runs `ps -eo pid,pgid,stat`
    Then the grandchildren are STILL LISTED
    And they are in state Z with ppid 1 — already dead, awaiting reaping by init
    And the kill-verification assertion filters them out with
        `ps -eo pid,pgid,stat | awk -v g=$PGID '$2==g && $3 !~ /Z/'`
    And the filtered count is zero
    And the UNFILTERED count is greater than zero, proving the filter is load-bearing

  Scenario: A positive-pid kill is not equivalent
    When process.kill(child.pid, 'SIGKILL') is sent with a POSITIVE pid
    Then the direct child is gone
    And both grandchildren are alive in state S with ppid 1
    And this is the regression test that stops anyone simplifying the kill path

  Scenario: Five concurrent agents
    Given a run with five live agent nodes
    When the kill switch is triggered
    Then within 7 seconds every one of the five pgids has zero non-Z members
    And five "node.completed" events record result.status 'cancelled'
```

**Notes:** **Verified false negative.** After a _successful_ group SIGKILL, `ps` still lists the
grandchildren in state `Z` with `ppid=1`. A naive "did the kill work?" assertion concludes the group kill
failed when it did not — and this costs hours, because zombie reaping is prompt under launchd and systemd but
**can lag badly inside containers**, so it bites hardest in exactly the environment where you cannot attach a
debugger. Asserting that the _unfiltered_ count is non-zero is what proves the filter is doing real work
rather than passing vacuously.

---

## EPIC-05-S32 — Orphan reaping on boot with the PID-reuse guard

**Verifies:** KAR-05.9 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: detached: true means the agent survives DeFlowd's death

  Scenario: A live orphan is reaped
    Given a process row for r1/n1 with a pid that is still running
    And its recorded started_at matches the live process's start time
    When DeFlowd boots
    Then killTree(pid) is called for that process group
    And the row is marked terminal
    And an event records that an orphan was reaped

  Scenario: The PID-reuse guard
    Given a process row whose pid now belongs to an UNRELATED process
    And the recorded started_at does not match that process's start time
    When DeFlowd boots
    Then no signal is sent to that pid
    And the row is discarded as a PID reuse
    And the discard is logged with both start times
    And this is why the guard compares process start time and never a bare PID

  Scenario Outline: Reading the start time per platform
    Given the platform is "<platform>"
    Then the start time is read from "<source>"

    Examples:
      | platform | source                  |
      | linux    | /proc/<pid>/stat field 22 |
      | darwin   | ps -o lstart= -p <pid>    |

  Scenario: A dead orphan's worktree lock is released
    Given a process row whose pid no longer exists
    And that node held a locked git worktree
    When DeFlowd boots
    Then `git worktree unlock` is run for that worktree
    And the row is marked terminal

  Scenario: Windows is explicitly not implemented
    Given process.platform is 'win32'
    When killTree is called
    Then it throws a typed "not implemented on win32" error
    And no POSIX code path silently no-ops
```

**Notes:** `detached: true` means the agent survives DeFlowd's death, and that is **not optional to handle**.
Trusting a bare PID across a reboot is how an orphan reaper kills an unrelated user process, which is the
kind of bug that ends a tool's credibility in one incident. Windows has no process groups — the path there is
`taskkill /PID <pid> /T /F`, the POSIX result does **not** transfer, and it was not tested. `tree-kill@1.2.2`
does the job and is tiny but has been frozen since 2022-06-27, so vendor or wrap it, never depend on it
directly.

---

## EPIC-05-S33 — The direct API adapter stays inert without an explicit opt-in

**Verifies:** KAR-05.10 · **Type:** Happy path · **Automated at:** unit, integration

The dangerous default here is inference. An orchestrator that notices `ANTHROPIC_API_KEY` in the
environment and helpfully starts using it is exactly the AR-1 violation the project exists to avoid —
and it is also the documented billing failure mode, where the operator believes they are on their
subscription and are being charged per token. Presence of a key is not consent.

```gherkin
Feature: Direct API adapter opt-in

  Background:
    Given a DeFlow workspace initialised in a git repository
    And no vendor agent CLI is installed on PATH

  Scenario: A key in the environment does not enable a provider
    Given the environment contains ANTHROPIC_API_KEY with a valid-looking value
    And ".DeFlow/config.yaml" contains no "providers.anthropic.directApi" key
    When the operator runs "deflow doctor"
    Then the direct API adapter is reported as "unconfigured"
    And the provider registry offers no anthropic provider
    And planning a run fails validation with "no adapter satisfies node requirements"

  Scenario: An explicit opt-in enables it
    Given ".DeFlow/config.yaml" contains:
      """
      providers:
        anthropic:
          directApi:
            enabled: true
            keyEnv: ANTHROPIC_API_KEY
      """
    And the environment contains ANTHROPIC_API_KEY
    When the operator runs "deflow doctor"
    Then the direct API adapter is reported as "configured and reachable"
    And the capability manifest has a row for it with "mediatedExecution: false"
    And that row declares "tokenAccounting: 'exact'"
    And the reported key value is masked in every line of doctor's output

  Scenario: Opted in but the key is absent
    Given the opt-in is present in ".DeFlow/config.yaml"
    And ANTHROPIC_API_KEY is not set in the environment
    When the operator runs "deflow doctor"
    Then the adapter is reported as "configured but failing"
    And the reason names the missing environment variable
    And the run is not started
```

**Notes:** the third scenario matters more than it looks. A misconfigured direct adapter must fail at
`doctor` time, not three hours into a run when the first node reaches it.

---

## EPIC-05-S34 — A supplied key never reaches disk

**Verifies:** KAR-05.10 · **Type:** Failure · **Automated at:** integration

This is the scenario that keeps AR-1 true in practice rather than in prose. DeFlow may hold a key in
memory for the duration of a call; it may never write one down. The test is mechanical and should stay
mechanical — a sentinel value and a grep over the entire on-disk footprint of a completed run.

```gherkin
Feature: Supplied credentials are never persisted

  Background:
    Given the direct API adapter is opted in for a stub provider
    And the key is the sentinel value "sk-DeFlow-SENTINEL-d41d8cd98f00b204"
    And a local HTTP stub stands in for the provider API

  Scenario: A completed run leaves no trace of the key
    Given a single-node plan whose node routes to the direct adapter
    When the run completes successfully
    Then the ledger contains a "provider.direct_api.used" event naming the provider and the config key
    And searching the ledger database for the sentinel returns no rows
    And searching every file under the blob store for the sentinel returns no matches
    And searching the run's pino log output for the sentinel returns no matches
    And searching the emitted OTel spans for the sentinel returns no matches
    And searching the generated run report for the sentinel returns no matches

  Scenario: The key is absent from a crash artefact
    Given the same plan
    When DeFlowd is SIGKILLed mid-request
    And the daemon restarts and replays the ledger
    Then searching the entire state directory for the sentinel returns no matches
    And the interrupted node is resumable
```

**Notes:** run the sweep over the _whole_ state directory, not a list of files you expect to be risky —
the point of a sentinel test is to catch the write you did not anticipate. The crash variant exists
because a half-written request buffer is precisely where a naive implementation leaks.

---

## EPIC-05-S35 — An unmediated adapter is refused write-capable work

**Verifies:** KAR-05.10 · **Type:** Edge case · **Automated at:** unit

The permission ladder is enforced at the ACP `fs/*` and `terminal/*` boundary. A direct API adapter has
no such boundary — there is no subprocess whose file access DeFlow mediates. So the ladder cannot be
enforced for it, and the narrowed "refuse to schedule" rule is exactly right: one capability bit, not a
per-vendor flag matrix.

```gherkin
Feature: Permission ladder refuses unmediated adapters

  Background:
    Given the direct API adapter is configured with "mediatedExecution: false"
    And an ACP adapter is available with "mediatedExecution: true"

  Scenario Outline: Scheduling by permission level
    Given a node declaring permission level "<level>"
    When the planner attempts to route it to the direct API adapter
    Then the outcome is "<outcome>"

    Examples:
      | level         | outcome                                              |
      | read          | scheduled                                            |
      | worktree      | refused: adapter cannot mediate filesystem access    |
      | worktree+net  | refused: adapter cannot mediate filesystem access    |
      | full          | refused: adapter cannot mediate filesystem access    |

  Scenario: Refusal happens at plan validation, not at execution
    Given a plan containing one "worktree"-level node routed to the direct API adapter
    When the plan is validated
    Then validation fails before any node is scheduled
    And the failure names the node, the requested level and the adapter's mediatedExecution value
    And no tokens have been spent

  Scenario: A mediated adapter is offered instead where one exists
    Given the same "worktree"-level node
    And an ACP adapter that satisfies the node's other requirements
    When the planner routes the node
    Then it is scheduled onto the ACP adapter
    And the routing decision records why the direct adapter was excluded
```

**Notes:** the second scenario is the valuable one — refusing at validation rather than at execution is
what makes this cheap. A refusal three hours in has already cost the run.

---

**Related:** [EPIC-05](../epics/EPIC-05-provider-adapters.md) · [Board](../board.md) ·
[Provider adapter layer](../../07-provider-adapter-layer.md) ·
[Durable execution](../../05-durable-execution.md) · [Testing strategy](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
