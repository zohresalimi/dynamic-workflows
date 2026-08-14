# EPIC-04 flows — Deterministic mock agent

> Behavioural specification for [EPIC-04](../epics/EPIC-04-mock-agent.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                    | Description                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Test harness**         | A vitest spec in the `unit` or `integration` project slice. It plays the role DeFlowd plays in production: it spawns the binary, writes frames to its stdin and reads frames from its stdout |
| **Mock agent**           | The `deflow-mock-agent` executable — a real child process speaking ACP over ndjson                                                                                                           |
| **Fake exec-shim agent** | `packages/testkit/bin/fake-agent.ts`, symlinked onto a tmp `PATH` under a vendor name, speaking a vendor's own headless wire format                                                          |
| **Scenario file**        | The declarative script that tells either binary what to do                                                                                                                                   |
| **Recording**            | A captured real session at `recordings/<provider>@<version>/<case>.ndjson`                                                                                                                   |

## Preconditions common to all flows

```gherkin
Background:
  Given a temp directory created with fs.mkdtemp(path.join(os.tmpdir(), 'DeFlow-'))
  And DeFlow_KEEP_TMP is honoured so a failed run leaves the directory for inspection
  And "<tmp>/bin" is prepended to PATH with the binary under test symlinked into it
  And the harness holds the resolved ABSOLUTE path to the binary, never relying on PATH lookup at spawn
  And the child is spawned with stdio ['pipe','pipe','pipe'] and detached: true
  And no vendor CLI is installed, no credential is present and no network is reachable
  And no test in this file uses vi.useFakeTimers() while a child process is alive
```

> The `detached: true` default is not incidental. It is the production spawn mode
> ([adapter layer §9.3](../../07-provider-adapter-layer.md)) and testing under `detached: false` would
> exercise a process-group topology DeFlowd never creates.

## Flow index

| Scenario    | Title                                                           | Verifies | Type       |
| ----------- | --------------------------------------------------------------- | -------- | ---------- |
| EPIC-04-S1  | Happy path: a full ACP prompt cycle over a real subprocess      | KAR-04.1 | Happy path |
| EPIC-04-S2  | Byte-reproducible output under `--seed`                         | KAR-04.1 | Happy path |
| EPIC-04-S3  | Spawned by resolved absolute path, never by PATH lookup         | KAR-04.1 | Edge case  |
| EPIC-04-S4  | Scripted streaming cadence arrives incrementally                | KAR-04.2 | Happy path |
| EPIC-04-S5  | `tool_call` walks every status value                            | KAR-04.2 | Happy path |
| EPIC-04-S6  | Permission request branches per outcome, including `cancelled`  | KAR-04.2 | Edge case  |
| EPIC-04-S7  | Client callbacks: `fs/*` and the full `terminal/*` lifecycle    | KAR-04.2 | Happy path |
| EPIC-04-S8  | Hang forever mid-turn, and cancel through it                    | KAR-04.3 | Failure    |
| EPIC-04-S9  | `process.exit(1)` mid-turn leaves a truncated frame             | KAR-04.3 | Failure    |
| EPIC-04-S10 | A malformed JSON line                                           | KAR-04.3 | Failure    |
| EPIC-04-S11 | Valid JSON that is schema-invalid                               | KAR-04.3 | Failure    |
| EPIC-04-S12 | A single 10 MB line, and an agent that never emits a newline    | KAR-04.3 | Failure    |
| EPIC-04-S13 | Capability profiles across the five verified adapters           | KAR-04.4 | Edge case  |
| EPIC-04-S14 | A profile that advertises what it will not honour               | KAR-04.4 | Failure    |
| EPIC-04-S15 | Replaying a golden recording as a provider                      | KAR-04.5 | Happy path |
| EPIC-04-S16 | Recording directories keyed on the exact version                | KAR-04.5 | Edge case  |
| EPIC-04-S17 | Fake exec-shim: the Claude Code `stream-json` envelope          | KAR-04.6 | Happy path |
| EPIC-04-S18 | Fake exec-shim: exit with no output at all                      | KAR-04.6 | Failure    |
| EPIC-04-S19 | Fake exec-shim: ignoring SIGTERM, and the zombie false negative | KAR-04.6 | Failure    |
| EPIC-04-S20 | Fake exec-shim: dialect mismatches and a permission refusal     | KAR-04.6 | Edge case  |
| EPIC-04-S21 | The mock agent imports nothing from the workspace               | KAR-04.1 | Edge case  |
| EPIC-04-S22 | The per-invocation side-effect log                              | KAR-04.2 | Recovery   |

---

## EPIC-04-S1 — Happy path: a full ACP prompt cycle over a real subprocess

**Verifies:** KAR-04.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The mock agent completes an ACP turn as a real child process

  Scenario: initialize, session/new, prompt, stop
    Given the harness spawns "deflow-mock-agent --scenario fixtures/scenarios/hello.json --seed 42"
    And the child's stdin and stdout are wrapped with acp.ndJsonStream
    When the harness sends "initialize" with protocolVersion 1 and clientCapabilities
         { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
    Then the response carries protocolVersion equal to the integer 1, not the string "1"
    And the response carries an "agentCapabilities" object
    And the response carries "authMethods": [] because the mock needs nothing from DeFlow
    When the harness sends "session/new" with cwd set to the temp worktree path
    Then the response carries a non-empty "sessionId"
    When the harness sends "session/prompt" with a single text block
    Then at least one "session/update" notification arrives with sessionUpdate "agent_message_chunk"
    And the prompt response carries stopReason "end_turn"
    When the harness sends "session/close" and closes stdin
    Then the child exits with code 0 and signal null
    And the last line written to stdout ends with a newline
```

**Notes:** `protocolVersion` being the **integer 1** is load-bearing. MCP's protocol version is a date
string (`'2025-11-25'`) and the two look similar enough that a shared negotiation helper is a real
temptation — [adapter layer §2.2](../../07-provider-adapter-layer.md) forbids it. Assert on the type,
not just the value. `authMethods: []` mirrors what `claude-agent-acp@0.64.1` actually returned, which is
AR-1 working as intended.

---

## EPIC-04-S2 — Byte-reproducible output under `--seed`

**Verifies:** KAR-04.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Seeded determinism

  Scenario: The same seed produces the same bytes
    Given the scenario "fixtures/scenarios/tool-call-walk.json" which generates
          a sessionId, three toolCallIds and eight timestamps
    When the harness runs "deflow-mock-agent --scenario tool-call-walk.json --seed 42" twice,
         capturing raw stdout into buffers A and B
    Then Buffer.compare(A, B) returns 0 with no normalisation applied
    And A contains no value matching the UUID v4 pattern produced by crypto.randomUUID

  Scenario: A different seed produces different ids
    When the harness runs the same scenario with "--seed 43"
    Then the captured sessionId differs from the "--seed 42" run
    And the number of emitted frames is identical
```

**Notes:** Byte-identity — not snapshot-equality after normalisation — is the bar, because this is what
makes the crash-fuzz test's pre-crash side deterministic so that _the only variable is where the knife
lands_ ([testing strategy §11](../../14-testing-strategy.md)). Frame count staying constant across seeds
proves the seed drives ids and clock only, not control flow.

---

## EPIC-04-S3 — Spawned by resolved absolute path, never by PATH lookup

**Verifies:** KAR-04.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Absolute-path resolution mirrors production

  Scenario: The fixture resolves and stores an absolute path
    Given "<tmp>/bin/claude" is a symlink to the mock agent binary
    And the fixture exposes agentPath as "<tmp>/bin" + path.delimiter + process.env.PATH
    When the harness resolves the binary for spawning
    Then the resolved value is an absolute path beginning with the temp directory
    And path.isAbsolute(resolved) is true

  Scenario: A daemon-shaped PATH does not find the binary
    Given the child is spawned with env.PATH set to "/usr/bin:/bin" only,
          simulating DeFlowd started from a launchd or systemd unit
    When the harness spawns the stored absolute path
    Then the child starts normally
    When the harness instead spawns the bare name "claude"
    Then spawn fails with ENOENT
    And the failure is the one a NodeFailure with reason "adapter.spawn-failed" must be built from
```

**Notes:** DeFlowd's `PATH` at daemon start differs from the user's login shell — a silent,
machine-specific failure that presents as "works for me"
([adapter layer §4.3](../../07-provider-adapter-layer.md)). The second scenario is the regression test
that stops anyone simplifying the resolution step away.

---

## EPIC-04-S4 — Scripted streaming cadence arrives incrementally

**Verifies:** KAR-04.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Scripted chunk cadence

  Scenario: Chunks arrive one at a time, not in one burst
    Given a scenario with steps:
      | type   | count | delayMs |
      | plan   | 1     | 0       |
      | chunks | 5     | 50      |
    When the harness prompts and records a client-side timestamp for each session/update
    Then the first notification has sessionUpdate "plan"
    And five notifications with sessionUpdate "agent_message_chunk" follow
    And the whole turn takes at least 190 ms, the agent's four sleeps
    And all four consecutive inter-arrival gaps are >= 10 ms
    And no two chunks share an arrival timestamp

  Scenario: The reader stalls while the consumer is slow
    Given the same scenario with 200 chunks of 8 KiB each
    And the harness awaits a 5 ms simulated durable write between each nextUpdate() call
    When the turn runs to completion
    Then every chunk is delivered exactly once, in order, with none dropped
    And the harness has drained over 512 KiB of the turn while the consumer is five chunks in
```

**Amended 2026-08-05** (EPIC-05 gate): the first scenario used to assert every inter-arrival gap at
>= 40 ms and flaked at **39.89 ms** under a loaded integration slice. Arrival timestamps are the
*reader's*: descheduling this process for a few milliseconds delays chunk N and leaves chunk N+1
already buffered, moving time out of one gap and into its neighbour — a 39.9 ms gap sits next to a
60 ms one, and the agent did nothing different. "It slept" is therefore asserted on the turn's total
duration, which no amount of reader lateness can shorten, and the per-gap floor is left only to
catch a burst (measured at **0.1 ms** per gap when `delayMs` is 0, a hundredfold margin).

**Amended 2026-08-07** (EPIC-09 gate): the second scenario used to close on "the harness's peak RSS
growth stays under 32 MiB", and that assertion could never have caught what it was written for.
`spawnMockAgent` tees the child's stdout with `child.stdout.on('data')`, and attaching a `data`
listener *is* flowing mode — the harness drains the pipe as fast as the kernel fills it, so the agent
is never blocked in `write()` here whatever the session does. Measured: by the time the consumer has
handled 5 of the 200 chunks the harness has already drained **1.49–1.68 MB** of the turn's
**1,682,049** bytes. The assertion passed because 1.6 MiB of payload cannot reach 32 MiB, not because
backpressure held. What it actually measured was V8 heap growth over the loop's ~1 s, spread
**12.1–17.0 MiB** across identical isolated runs and **38.5 MiB** beside a full suite — noise wider
than its own budget, which is the red the gate opened on. RSS is now sampled and not asserted on,
exactly as [EPIC-05-S9's soak](../../../packages/adapters/test/integration/backpressure-soak.test.ts)
already records for the same quantity at the same layer.

The replacement is exact and in bytes of stream: the reader runs far ahead of the consumer, which is
what makes the exactly-once and in-order assertions above a claim about a genuinely stalled reader.
The 512 KiB threshold separates two regimes three-quarters of a megabyte apart rather than tuning a
budget — a backpressured pull-loop reader could hold at most ~110 KiB (five taken frames, one 64 KiB
pipe, one frame in hand), this harness holds 1.49–1.68 MB, and the spread is only how far the
*producer* got before the consumer reached its fifth chunk (100% of the turn idle, 88.7% beside a
full suite). Checked red against a trickling producer (`delayMs: 3` → 59,224 bytes in flight).

**Notes:** The second scenario is the pull loop's whole point. `session.nextUpdate()` is a pull loop, not
a callback registration — DeFlow does not request the next frame until it has finished with the current
one, the OS pipe fills at 64 KiB (measured `highWaterMark`, 2026-08-02) and the agent blocks in `write()`
([adapter layer §2.3](../../07-provider-adapter-layer.md)). It is also the only legal place to `await` the
SQLite append. Flowing mode in the *product* is caught where it is observable through the real
transport and measured in bytes of read-ahead — EPIC-05-S3 · AC4,
[`pull-loop.test.ts`](../../../packages/adapters/test/integration/pull-loop.test.ts) — not here, where
the harness is in flowing mode by construction.

---

## EPIC-04-S5 — `tool_call` walks every status value

**Verifies:** KAR-04.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Tool call status transitions

  Scenario Outline: Every ToolCallStatus is reachable
    Given a scenario with a toolCall step declaring kind "<toolKind>"
          and statuses "<statusPath>"
    When the harness prompts and collects every session/update for that toolCallId
    Then the first notification has sessionUpdate "tool_call"
    And subsequent notifications have sessionUpdate "tool_call_update"
    And the observed status sequence equals "<statusPath>" exactly, in order
    And every notification carries a ToolCallLocation with a non-empty "path"

  Examples:
    | toolKind | statusPath                        |
    | read     | pending,in_progress,completed     |
    | edit     | pending,in_progress,completed     |
    | execute  | pending,in_progress,failed        |
    | search   | pending,completed                 |
    | delete   | pending,in_progress,completed     |
    | move     | pending,in_progress,failed        |
    | think    | pending,completed                 |
    | fetch    | pending,in_progress,completed     |
    | other    | pending,failed                    |
```

**Notes:** `ToolKind` is verified from `dist/schema/types.gen.d.ts` as
`'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'switch_mode'|'other'`, and it maps
almost one-to-one onto the permission ladder. `ToolCallLocation.path` is what gives path-scope enforcement
**at request time** rather than as post-hoc detection (F5.3) — so a scenario that omits it would leave
EPIC-08's best lever untested.

---

## EPIC-04-S6 — Permission request branches per outcome, including `cancelled`

**Verifies:** KAR-04.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: session/request_permission round trip

  Scenario Outline: The agent honours the client's decision
    Given a scenario with a permission step offering options
          allow_once, allow_always, reject_once and reject_always
    And branch labels onAllowed, onRejected and onCancelled
    When the harness answers the request with "<response>"
    Then the agent takes the "<branch>" branch
    And the turn terminates with stopReason "<stopReason>"
    And the process exits without the harness having to kill it

  Examples:
    | response                                       | branch      | stopReason |
    | { outcome: 'selected', optionId: 'allow_once' }   | onAllowed   | end_turn   |
    | { outcome: 'selected', optionId: 'allow_always' } | onAllowed   | end_turn   |
    | { outcome: 'selected', optionId: 'reject_once' }  | onRejected  | refusal    |
    | { outcome: 'selected', optionId: 'reject_always' }| onRejected  | refusal    |
    | { outcome: 'cancelled' }                          | onCancelled | cancelled  |

  Scenario: The client never answers
    Given the harness receives session/request_permission and deliberately does not reply
    When 2 seconds elapse on the real clock
    Then the agent is still alive and has emitted no further session/update notifications
    And the harness can still cancel the turn cleanly
```

**Notes:** `RequestPermissionOutcome` is verified as
`{ outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }`. The `cancelled` variant is the one
implementations forget, and an agent that awaits an `optionId` that never arrives deadlocks the whole
node. The final scenario is the stimulus for the approval-queue timeout path in EPIC-13.

---

## EPIC-04-S7 — Client callbacks: `fs/*` and the full `terminal/*` lifecycle

**Verifies:** KAR-04.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The agent calls back into the client

  Scenario: All seven client methods are exercised in one turn
    Given the harness registers stub handlers for fs/read_text_file, fs/write_text_file,
          terminal/create, terminal/output, terminal/wait_for_exit, terminal/kill and terminal/release
    And a scenario with clientCall steps for each, in that order
    When the harness prompts
    Then each of the seven handlers is invoked exactly once
    And the invocation order matches the scenario order
    And terminal/release is invoked after terminal/wait_for_exit

  Scenario: The agent records what the client answered
    Given the fs/write_text_file stub responds with a JSON-RPC error carrying
          message "path outside worktree"
    When the harness prompts
    Then the agent's declared onClientError branch is taken
    And the agent emits an agent_message_chunk containing the client's error message verbatim
    And the turn ends with a stopReason rather than hanging

  Scenario: The agent does not call methods the client did not advertise
    Given the harness sends initialize with clientCapabilities { fs: { readTextFile: true } } only
    When a scenario step requests fs/write_text_file
    Then the agent skips the step and emits a diagnostic chunk naming the missing capability
    And no fs/write_text_file request is ever written to stdout
```

**Notes:** These seven methods are exactly where the permission ladder lives — DeFlow sits in the path of
every file access and every command execution, which is what collapses an N-vendors × M-levels matrix into
one pure policy function ([adapter layer §1](../../07-provider-adapter-layer.md),
[testing strategy §10](../../14-testing-strategy.md)). The third scenario matters because ACP v2 **removes
all seven from the client** and pushes them onto MCP; an agent that calls unadvertised methods would mask
that migration.

---

## EPIC-04-S8 — Hang forever mid-turn, and cancel through it

**Verifies:** KAR-04.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A wedged agent

  Scenario: The agent stops emitting and does not exit
    Given a scenario whose third step is "hangForever"
    When the harness prompts and reads stdout
    Then two agent_message_chunk notifications arrive
    And no further bytes arrive on stdout for 500 ms
    And child.exitCode is null and child.signalCode is null
    And stdout has NOT been closed — the client observes a wedge, not an EOF

  Scenario: Cancel flushes the tail and then stops the turn
    Given the agent is in the hangForever state
    And the scenario declares two trailing updates to flush on cancel
    When the harness sends session/cancel
    Then the harness receives the two trailing session/update notifications
    And only afterwards does the prompt response arrive with stopReason "cancelled"
    And the harness's nextUpdate() loop was kept running throughout

  Scenario: An agent that ignores cancel
    Given a scenario whose step is "hangForeverIgnoringCancel"
    When the harness sends session/cancel and waits 1 second
    Then no prompt response has arrived
    And the process is still alive
    And this is the state the SIGTERM escalation in KAR-05.9 must resolve
```

**Notes:** The middle scenario encodes a spec requirement that is easy to get backwards: a client
**should keep accepting `session/update` notifications after sending `session/cancel`**
([adapter layer §2.5](../../07-provider-adapter-layer.md)). A client that tears down its reader on cancel
loses the tail of the turn and may deadlock waiting for the prompt response. Stage 1 of the three-stage
cancellation is the only stage that produces a clean transcript.

---

## EPIC-04-S9 — `process.exit(1)` mid-turn leaves a truncated frame

**Verifies:** KAR-04.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Mid-turn crash

  Scenario: The agent dies with a half-written line
    Given a scenario with three chunk steps and an "exit" step configured
          { code: 1, afterFrames: 2, truncateMidFrame: true }
    When the harness prompts and reads stdout to EOF
    Then the child exit code is 1 and the signal is null
    And the final line of stdout does not end with 0x0a
    And JSON.parse of that final line throws
    And the prompt response never arrives

  Scenario: Grandchildren survive the agent's own exit
    Given the scenario also runs "spawnGrandchildren" before exiting
    And the child was spawned with detached: true
    When the agent exits 1
    Then the grandchildren are reparented to ppid 1
    And their pgid still equals the dead child's pid
    And this row is what the orphan reaper in KAR-05.9 must find in SQLite on the next daemon boot
```

**Notes:** The truncated final line is deliberate. A crash-recovery path that assumes every line it reads
is complete will produce `adapter.malformed-output` for what is actually
`agent.nonzero-exit` — two different `NodeFailureReason`s with two different `class` values and therefore
two different scheduler decisions ([domain model §8](../../04-domain-model.md)).

---

## EPIC-04-S10 — A malformed JSON line

**Verifies:** KAR-04.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Not JSON at all

  Scenario: An unbalanced brace on its own line
    Given a scenario with a "malformedLine" step emitting `{"jsonrpc":"2.0","method":`
          followed immediately by a newline
    When the harness reads stdout
    Then a complete line is received
    And JSON.parse of that line throws a SyntaxError
    And this is the input from which a NodeFailure with reason "adapter.malformed-output"
        and class "permanent" must be constructed

  Scenario: Valid frames follow the malformed one
    Given the scenario continues with two well-formed agent_message_chunk steps
    When the harness reads to the end of the turn
    Then the two subsequent frames are byte-valid JSON
    And the test asserts the client's policy explicitly: the session is torn down at the
        malformed line and the subsequent frames are NOT delivered to the ledger
```

**Notes:** The second scenario exists to make the recovery policy a _decision_ rather than an accident.
The architecture's position is that a malformed frame tears the session down; this scenario is where that
is written down and checked, so nobody later adds a "skip and continue" that silently drops half a turn.

---

## EPIC-04-S11 — Valid JSON that is schema-invalid

**Verifies:** KAR-04.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Syntactically fine, semantically wrong

  Scenario: An unknown sessionUpdate discriminator
    Given a scenario with an "invalidFrame" step emitting a session/update notification
          whose params.update.sessionUpdate is "agent_thought_stream_v3"
    When the harness reads the frame
    Then JSON.parse succeeds
    And ajv, compiled against @agentclientprotocol/sdk/schema/schema.json, reports the frame invalid
    And the reported error path names params.update.sessionUpdate
    And this is the input for a NodeFailure with reason "adapter.protocol-error"

  Scenario Outline: Other schema violations
    Given an "invalidFrame" step of variant "<variant>"
    When the harness validates the frame against schema.json
    Then validation fails
    And the failure is distinguishable from a JSON.parse failure

  Examples:
    | variant                                            |
    | tool_call missing the required toolCallId          |
    | permission option with an unknown PermissionOptionKind |
    | prompt response with stopReason "finished"         |
    | ToolCallLocation whose path is a number            |
```

**Notes:** `adapter.protocol-error` and `adapter.malformed-output` are **separate reasons** in the domain
model for a reason: one means the agent is broken, the other means the agent and the SDK disagree about
the wire shape — typically after an upstream SDK bump. `schema.json` has **262 `$defs`** (verified
2026-08-02) and is the only conformance oracle that exists; there is no official ACP conformance kit, and
searching for one leads to an unrelated academic protocol also abbreviated ACP.

---

## EPIC-04-S12 — A single 10 MB line, and an agent that never emits a newline

**Verifies:** KAR-04.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Framing hazards

  Scenario: One enormous line
    Given a scenario with a "hugeLine" step of 10 MB, written in 64 KiB chunks
    When the harness counts bytes received before the first 0x0a
    Then the count is at least 10485760
    And the payload is a generated repeating pattern, not random bytes, so --seed still holds
    And this is the stimulus for the 8 MiB FrameTooLarge cap in KAR-05.4

  Scenario: An agent that never emits a newline at all
    Given a scenario with a "noNewline" step writing 64 KiB every 10 ms indefinitely
    When the harness reads for 5 seconds
    Then zero 0x0a bytes have been received
    And at least 8 MiB has been received
    And the SDK's LineBuffer, left to itself, would still be accumulating with no frame emitted
    And the harness kills the process group to end the test
```

**Notes:** This is the verified hazard behind KAR-05.4. `@agentclientprotocol/sdk`'s `LineBuffer`
(`dist/line-buffer.js`) has **no maximum line length** — `push()` accumulates chunks into a private
`#pending` array and only emits on finding a `0x0a`. DeFlowd is a long-lived daemon supervising runs for
days, so this is a real availability bug. For scale: a _trivial_ `claude -p "say ok"` turn emitted a single
**16,024-byte** line (the `system/commands_changed` frame), and real turns that read a large file routinely
produce multi-megabyte single lines. The `noNewline` case is the nastier of the two because no cap on
_frame_ size helps if the frame never completes — only a byte counter since the last newline does.

---

## EPIC-04-S13 — Capability profiles across the five verified adapters

**Verifies:** KAR-04.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: One binary impersonates any row of the capability matrix

  Scenario Outline: The advertised block matches the measured matrix
    Given the mock agent is started with "--capabilities <profile>"
    When the harness sends initialize
    Then the response's agentCapabilities.sessionCapabilities.resume is "<resume>"
    And .fork is "<fork>"
    And .list is "<list>"
    And mcpCapabilities.acp is "<mcpAcp>"
    And the whole block deep-equals the corresponding row of the capability-matrix fixture

  Examples:
    | profile  | resume  | fork    | list    | mcpAcp  |
    | claude   | yes     | yes     | yes     | absent  |
    | codex    | yes     | absent  | yes     | false   |
    | opencode | yes     | yes     | yes     | absent  |
    | copilot  | absent  | absent  | yes     | absent  |
    | gemini   | absent  | absent  | absent  | absent  |

  Scenario: Gemini's shape has no sessionCapabilities key at all
    Given the mock agent is started with "--capabilities gemini"
    When the harness sends initialize
    Then ('sessionCapabilities' in response.agentCapabilities) is false
    And response.agentCapabilities.loadSession is true

  Scenario: Copilot's shape is a nearly-empty object, not an absent key
    Given the mock agent is started with "--capabilities copilot"
    When the harness sends initialize
    Then response.agentCapabilities.sessionCapabilities deep-equals { list: {} }

  Scenario: Codex distinguishes explicit false from absent
    Given the mock agent is started with "--capabilities codex"
    Then mcpCapabilities.sse === false and mcpCapabilities.acp === false as literal booleans

  Scenario: An unknown profile is fatal
    When the mock agent is started with "--capabilities antigravity"
    Then the process exits non-zero
    And stderr lists claude, codex, opencode, copilot, gemini and mock-full
    And no initialize response is ever emitted
```

**Notes:** This is the story that turns the uneven provider matrix from an integration-test problem into a
**unit-test problem**. Without it, "does `ResumeByReplay` work on a Gemini-shaped profile?" needs an
installed, authenticated Gemini CLI and real quota; with it, it is a 40 ms test on every commit — and it
has to be, because **two of five providers cannot resume**, so `ResumeByReplay` is the durability path for
40% of the matrix.

The three shape variants matter individually. Absent-key (Gemini), empty-object (Copilot) and explicit-
`false` (Codex) are three different things that naive optional chaining flattens into one, and flattening
them is how a router concludes an agent can do something it cannot. The examples table is generated from
the fixture, so when `deflow doctor` re-probes and a vendor's capabilities change, this table changes with
it and the diff is the alert.

---

## EPIC-04-S14 — A profile that advertises what it will not honour

**Verifies:** KAR-04.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A lying capability manifest

  Scenario: Advertised resume, unimplemented resume
    Given the mock agent is started with
          "--capabilities claude --dishonest-capabilities session.resume"
    When the harness sends initialize
    Then agentCapabilities.sessionCapabilities.resume is true
    When the harness sends session/resume with a previously returned sessionId
    Then the response is a JSON-RPC error with code -32601
    And the error message is "Method not found"
    And this is exactly what assertion 6 of the conformance battery must catch

  Scenario Outline: Dishonesty across capabilities
    Given the mock agent advertises "<capability>" and is told not to honour it
    When the harness calls the corresponding method
    Then a JSON-RPC -32601 error is returned rather than a malformed success

  Examples:
    | capability            | method            |
    | session.fork          | session/fork      |
    | session.list          | session/list      |
    | session.delete        | session/delete    |
    | additionalDirectories | session/new       |
```

**Notes:** The capability row is _the single input the entire routing layer trusts_
([adapter layer §11.3](../../07-provider-adapter-layer.md)). If it lies, the planner schedules work onto an
adapter that cannot do it, and the failure surfaces hours later inside a node instead of at admission time.
`-32601` rather than a malformed success is the distinction worth asserting: a JSON-RPC error is a clean
`adapter.capability-missing`; a malformed success is silent corruption.

---

## EPIC-04-S15 — Replaying a golden recording as a provider

**Verifies:** KAR-04.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: A captured real session becomes a free provider

  Scenario: A recording drives a full turn
    Given a recording at recordings/claude-agent-acp@0.64.1/simple-edit.ndjson
    And each line has the shape {"t": <msOffset>, "dir": "in"|"out", "msg": { ... }}
    When the harness spawns
        "deflow-mock-agent --replay recordings/claude-agent-acp@0.64.1/simple-edit.ndjson
         --replay-speed max"
    Then every "out" frame in the file is emitted to stdout in file order
    And the harness observes the recorded chunk texts in the recorded order
    And the turn ends with the recorded stopReason
    And no scenario file was supplied

  Scenario: Client frames are compared modulo id and _meta
    Given the harness sends a session/prompt whose JSON-RPC id differs from the recorded one
    And whose _meta block differs from the recorded one
    When the replay compares the incoming frame with the recorded "in" frame
    Then the frames are considered equal
    And the replay continues

  Scenario: A genuine client divergence fails loudly
    Given the harness sends a session/prompt with a different prompt text
    When the replay compares the frames
    Then the process exits non-zero
    And stderr contains a unified diff of expected versus actual
    And stderr names the ndjson line number of the recorded frame

  Scenario: A truncated recording does not hang
    Given the recording file ends mid-turn, as a crashed capture would
    When the replay reaches EOF with no stop frame
    Then the session terminates within 2 seconds with a non-"end_turn" stopReason
    And stderr states that the recording was truncated
```

**Notes:** `id` and `_meta` are the only two fields a client is entitled to differ on
([adapter layer §11.4](../../07-provider-adapter-layer.md)). The tee that produces these recordings must
live in the **transport, never in the adapter's parsing logic** — an adapter-level tee records your
interpretation of the bytes, which is precisely the class of change you need to detect. That is KAR-05.7's
responsibility; this scenario only proves the consumption side.

---

## EPIC-04-S16 — Recording directories keyed on the exact version

**Verifies:** KAR-04.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Version-keyed goldens

  Scenario: A directory without a version is rejected
    Given a recording at recordings/claude-agent-acp/simple-edit.ndjson
    When the mock agent is started with --replay against it
    Then the process exits non-zero before emitting any frame
    And stderr names the required shape "<provider>@<version>"

  Scenario: A version bump is visible as a new directory
    Given recordings/claude-agent-acp@0.64.1/ exists with three cases
    And a re-record against 0.65.0 writes recordings/claude-agent-acp@0.65.0/
    When the conformance suite enumerates recording directories
    Then both directories are discovered and replayed independently
    And no golden under @0.64.1 was modified

  Scenario: Determinism does not depend on --seed
    When the same recording is replayed twice without --seed
    Then Buffer.compare of the two stdout captures returns 0
```

**Notes:** Keying on the exact version is what makes a vendor bump _a visible new directory in a PR_ rather
than a silent invalidation of every existing golden. Three flag breakages were already visible in the
current release set as of 2026-08-02 — Claude Code's `--permission-prompt-tool` gone from `--help`, Codex's
`exec --full-auto` gone, and Gemini's `--experimental-acp` and `--allowed-tools` both deprecated.
Re-recording is how you find the fourth one before a user's three-hour run does.

---

## EPIC-04-S17 — Fake exec-shim: the Claude Code `stream-json` envelope

**Verifies:** KAR-04.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The non-ACP fallback's fake binary

  Scenario: --verbose is required alongside stream-json
    Given "<tmp>/bin/claude" is a symlink to packages/testkit/bin/fake-agent.ts
    And DeFlow_FAKE_DIALECT is "claude-stream-json"
    When the harness spawns it with "-p 'say ok' --output-format stream-json"
    Then the process exits non-zero
    And stderr is exactly
        "Error: When using --print, --output-format=stream-json requires --verbose"

  Scenario: With --verbose the envelope is emitted
    When the harness spawns it with "-p 'say ok' --output-format stream-json --verbose"
    Then every stdout line parses as JSON
    And every line carries a "session_id"
    And the set of per-line "uuid" values has no duplicates
    And the line types include system/init, assistant and result in that relative order
    And the final line has type "result", subtype "success", is_error false,
        and carries total_cost_usd, usage, modelUsage and permission_denials

  Scenario: --output-format json succeeds without --verbose
    When the harness spawns it with "-p 'say ok' --output-format json"
    Then the process exits 0
    And stdout is a single JSON document

  Scenario Outline: Failure subtypes are scriptable
    Given the scenario declares resultSubtype "<subtype>"
    When the turn completes
    Then the final result line's subtype is "<subtype>"
    And it is the input for a NodeFailure with reason "<reason>"

  Examples:
    | subtype                                | reason                         |
    | success                                | (none — node completes)        |
    | error_max_structured_output_retries    | agent.schema-repair-exhausted  |
    | error_during_execution                 | agent.nonzero-exit             |
```

**Notes:** The `--verbose` requirement is verified by execution, and it is easy to miss because
`--output-format json` succeeds fine without it. Each line's `uuid` is **the shim path's event-log dedup
key** — the equivalent of the ACP notification id, and what makes replay-after-crash idempotent (F4.3). A
fake that emits a constant `uuid` would let a broken dedup implementation pass.

---

## EPIC-04-S18 — Fake exec-shim: exit with no output at all

**Verifies:** KAR-04.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Silence

  Scenario: Exit zero having written nothing
    Given DeFlow_FAKE_SCENARIO selects the "noOutput" scenario
    When the harness spawns the fake agent and reads both streams to EOF
    Then the exit code is 0
    And stdout is zero bytes
    And stderr is zero bytes
    And the adapter must produce a typed failure rather than an empty successful NodeResult

  Scenario: Exit non-zero having written nothing
    Given the "noOutput" scenario with exitCode 2
    Then the exit code is 2
    And both streams are empty
    And this maps to NodeFailure reason "agent.nonzero-exit" with class "transient"
```

**Notes:** "Exit 0 with no output" is the case that produces a node which looks successful and carries
nothing — the worst possible outcome, because it propagates an empty result downstream instead of failing.
It is explicitly listed in the F3.4 conformance battery
([testing strategy §3.2](../../14-testing-strategy.md)) and it has no natural cause in a scripted happy
path, which is why it needs its own scenario.

---

## EPIC-04-S19 — Fake exec-shim: ignoring SIGTERM, and the zombie false negative

**Verifies:** KAR-04.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The kill-escalation fixture

  Scenario: SIGTERM is ignored, SIGKILL is not
    Given the "ignoreSigterm" scenario, which installs a no-op SIGTERM handler
    And the "spawnGrandchildren" step, which backgrounds two `sleep 300` children
    And the fake agent was spawned with detached: true
    When the harness reads pid, pgid and stat for the process tree via
         `ps -eo pid,pgid,stat`
    Then all four processes share a pgid equal to the child's pid
    When the harness sends process.kill(-child.pid, 'SIGTERM') and waits 1 second
    Then all four processes are still listed and none is in state Z
    When the harness sends process.kill(-child.pid, 'SIGKILL') and waits 500 ms
    Then no process in that pgid is in a non-Z state
    And the filter used is `ps -eo pid,pgid,stat | awk -v g=$PGID '$2==g && $3 !~ /Z/'`

  Scenario: A positive-pid kill leaves the grandchildren alive
    Given the same tree
    When the harness sends process.kill(child.pid, 'SIGKILL') with a POSITIVE pid
    Then the direct child is gone
    And both grandchildren are still in state S
    And their ppid is now 1
    And this scenario is the regression test that stops anyone simplifying the kill path
```

**Notes:** The zombie filter is the trap that costs hours. **Verified by measurement:** after a
_successful_ group SIGKILL, `ps` still lists the grandchildren — in state **`Z`** with `ppid=1`, already
dead and awaiting reaping by init. A naive "did the kill work?" assertion concludes the group kill failed
when it did not. Zombie reaping is prompt under launchd and systemd but can lag badly inside containers,
so this bites hardest exactly where you cannot attach a debugger.

The positive-pid scenario encodes the other verified result: with `detached: false` the grandchildren land
in **DeFlowd's own process group**, so you cannot group-kill them without killing the daemon.

---

## EPIC-04-S20 — Fake exec-shim: dialect mismatches and a permission refusal

**Verifies:** KAR-04.6 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Vendors are not uniform

  Scenario: Copilot has no stream-json
    Given DeFlow_FAKE_DIALECT is "copilot-json"
    When the harness spawns it with "-p 'say ok' --output-format stream-json"
    Then the process exits non-zero
    And a shim that assumed a uniform stream-json across vendors fails here, loudly

  Scenario: Copilot's supported formats
    Given DeFlow_FAKE_DIALECT is "copilot-json"
    When the harness spawns it with "-p 'say ok' --output-format json"
    Then the process exits 0 and stdout is a single JSON document

  Scenario: A rate limit event carries a resetsAt
    Given DeFlow_FAKE_DIALECT is "claude-stream-json"
    And the scenario emits a rate_limit_event with rate_limit_info.resetsAt set 900 seconds ahead
    When the harness parses the stream
    Then a line with type "rate_limit_event" is present
    And its resetsAt value is readable as an epoch timestamp
    And this is the input a backoff scheduler must use instead of retrying blindly

  Scenario: A permission refusal on the shim path
    Given the scenario emits a permission_denials entry in the result envelope
    Then the final result line's permission_denials array is non-empty
    And it names the denied tool

  Scenario: Writing outside the worktree
    Given the "writeFiles" scenario declares "../outside.txt" relative to cwd
    When the fake agent runs with cwd set to the worktree
    Then the file exists at the resolved absolute path outside the worktree
    And path-scope violation detection has a genuine positive case to find
```

**Notes:** Copilot's `--output-format` is verified as `text|json` only — there is no `stream-json`. This is
the single most likely place for a shim to make a silently wrong uniformity assumption, so the fake must
refuse rather than emulate. The `writeFiles` escape case is the only way to test path-scope detection
without the mediation layer in front of it; on the ACP path DeFlow would have refused the write at
`fs/write_text_file` and the violation would never reach the filesystem.

---

## EPIC-04-S21 — The mock agent imports nothing from the workspace

**Verifies:** KAR-04.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The mock agent is an independent oracle

  Scenario: No workspace imports
    Given every file matched by packages/mock-agent/src/**/*.ts
    When the test reads each file's source
    Then no file contains an import specifier starting with "@DeFlow/"
    And packages/mock-agent/package.json's dependencies has exactly one key,
        "@agentclientprotocol/sdk"
    And that value is the exact string "1.3.0" with no caret or tilde

  Scenario: The deprecated package is not reachable
    Then no file in the workspace imports "@zed-industries/agent-client-protocol"
    And no file imports "@zed-industries/claude-code-acp" or "@zed-industries/codex-acp"
```

**Notes:** If the mock imported `@DeFlow/core`, a bug in the domain model would be mirrored on both sides
of the wire and cancel itself out — the mock would agree with the daemon about something they were both
wrong about ([adapter layer §13](../../07-provider-adapter-layer.md),
[repo layout R1](../../16-repo-layout.md)). The exact pin without a caret is warranted because the SDK went
0.4.5 → 1.3.0 **and** changed npm scope **and** changed GitHub org inside about ten months. All three
`@zed-industries/*` names are deprecated renames, and any cached knowledge older than late 2025 names them.

---

## EPIC-04-S22 — The per-invocation side-effect log

**Verifies:** KAR-04.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Making "executed twice" observable

  Scenario: One line per invocation
    Given DeFlow_SIDE_EFFECT_LOG points at "<tmp>/effects.log"
    And the fixture invokes the agent with runId "r1", nodeId "n3", attempt 1
        and idempotencyKey "r1/n3/1/0"
    When the invocation completes
    Then the log file has exactly one line
    And that line contains runId "r1", nodeId "n3", attempt 1 and idempotencyKey "r1/n3/1/0" verbatim

  Scenario: A duplicate is a duplicate key, not an inference
    Given the same node is invoked twice with the identical idempotencyKey
    When the harness groups the log by idempotencyKey
    Then one key has a count of 2
    And the crash-fuzz assertion "no effect was executed twice" is a duplicate-key check
        on a text file rather than an inference from the ledger

  Scenario: A retry is not a duplicate
    Given the node is invoked with attempt 1, idempotencyKey "r1/n3/1/0"
    And then with attempt 2, idempotencyKey "r1/n3/2/0"
    When the harness groups by idempotencyKey
    Then every key has a count of 1
    And this distinguishes failure-retry (new attempt, re-execute) from
        crash-resume (same attempt, memoise)

  Scenario: The variable is optional
    Given DeFlow_SIDE_EFFECT_LOG is unset
    When the agent runs
    Then no file is created and the turn is unaffected
```

**Notes:** This is the fixture that makes assertion (a) of the crash-fuzz test checkable at all
([testing strategy §11](../../14-testing-strategy.md)). The third scenario encodes the distinction the
whole effect journal rests on: crash-resume and failure-retry are **different operations** with different
idempotency keys, and a fake that logged only `(runId, nodeId)` would make them indistinguishable.

---

**Related:** [EPIC-04](../epics/EPIC-04-mock-agent.md) · [Board](../board.md) ·
[Provider adapter layer](../../07-provider-adapter-layer.md) ·
[Testing strategy](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
