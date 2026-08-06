# EPIC-04: Deterministic mock agent

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-04-mock-agent-flows.md)

|                      |                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-04                                                                                                                           |
| **Status**           | Not started                                                                                                                       |
| **Priority**         | P0                                                                                                                                |
| **Milestone**        | M1                                                                                                                                |
| **Workstream**       | W2 (see [roadmap §2.2](../../17-roadmap.md))                                                                                      |
| **Size**             | ~11 days across 6 stories                                                                                                         |
| **Depends on**       | EPIC-01, EPIC-02                                                                                                                  |
| **Blocks**           | EPIC-05, EPIC-06, EPIC-08                                                                                                         |
| **PRD requirements** | F3.7, F3.4, F3.2, F4.2, NF9                                                                                                       |
| **Architecture**     | [07-provider-adapter-layer.md §13](../../07-provider-adapter-layer.md), [14-testing-strategy.md §3](../../14-testing-strategy.md) |

## Goal

At the end of this epic DeFlow owns two **real executables** — `DeFlow-mock-agent` (an ACP agent) and
`packages/testkit/bin/fake-agent.ts` (a CLI exec-shim agent) — that can be dropped onto a temporary
`PATH` and driven by a declarative script to reproduce, deterministically and in milliseconds, every
behaviour a vendor agent can exhibit: streaming at a scripted cadence, tool-call status transitions,
permission requests, filesystem and terminal callbacks, a mid-turn hang, a mid-turn `process.exit(1)`,
a malformed JSON line, a schema-invalid frame, a single 10 MB line, an arbitrary `agentCapabilities`
profile, and byte-reproducible ids under `--seed`. Every one of those is offline, free, and repeatable
on demand.

## Why this matters

The three properties DeFlow claims — durable execution, provider neutrality and diagnosability — are
all properties of what happens when an agent subprocess misbehaves. You cannot iterate on that against
a real vendor CLI: it costs quota, it takes minutes per cycle, it needs credentials, and **crash, hang
and malformed-frame scenarios are not reproducible on demand** ([adapter layer §13](../../07-provider-adapter-layer.md)).
Without this epic, the entire durability design in [05-durable-execution.md](../../05-durable-execution.md)
and the whole permission ladder in [09-workspace-and-safety.md](../../09-workspace-and-safety.md)
remain theory, and the crash-fuzz test in [testing strategy §11](../../14-testing-strategy.md) — the
test that proves the thesis — has nothing deterministic to crash. The roadmap puts **W2 before W3**
for exactly this reason: the mock binary is what makes the adapter layer testable without spending
credits.

The alternative — mocking `child_process.spawn` — tests the mock. It leaves the argv construction, the
stream parser, the backpressure, the frame cap, the timeout and the kill path entirely unexercised,
which is precisely the surface where the bugs live.

## Scope

**In scope:**

- `@DeFlow/mock-agent` as a real package with a `DeFlow-mock-agent` bin, built on the _agent_ side of
  `@agentclientprotocol/sdk@1.3.0` (`acp.agent({…})`), shipping inside the `DeFlow` tarball as a second
  bin (see [repo layout §D17 note](../../16-repo-layout.md)).
- A declarative scenario file format covering all ten required behaviours of
  [adapter layer §13](../../07-provider-adapter-layer.md).
- The five pathological behaviours: hang forever, `process.exit(1)` mid-turn, malformed JSON line,
  valid-JSON-but-schema-invalid frame, and a single 10 MB line.
- A `--capabilities <profile>` flag that lets one binary impersonate any row of the §5 capability
  matrix.
- `--seed` determinism for every generated id and timestamp.
- `--replay recordings/<provider>@<ver>/<case>.ndjson` so a captured real session becomes a mock
  provider.
- `@DeFlow/testkit`'s `fake-agent` binary emitting Claude-Code-shaped `stream-json` and Codex-shaped
  JSONL, plus the SIGTERM-ignoring and no-output-at-all cases.
- The vitest fixture that symlinks either binary onto a tmp `PATH` under a vendor name.

**Out of scope:**

- The ACP **client** that talks to these binaries — EPIC-05 (KAR-05.1).
- The frame-size guard, blob spilling and backpressure enforcement themselves — EPIC-05 (KAR-05.4).
  This epic ships the _stimulus_; EPIC-05 ships the _defence_.
- Recording real sessions (`pnpm test:record` against authenticated CLIs) — EPIC-05 (KAR-05.7). This
  epic only consumes recordings.
- The crash-fuzz harness that orchestrates `kill -9` of DeFlowd — EPIC-06 (KAR-06.9). This epic ships
  the per-invocation side-effect log that harness asserts against.
- The permission ladder policy function the mock's permission requests exercise — EPIC-08.
- Golden ledger fixtures for the UI — EPIC-16 (KAR-16.5).

## Definition of Ready (epic level)

- [ ] EPIC-01 is Done: pnpm workspace, `erasableSyntaxOnly` TypeScript, and the four vitest project
      slices (`unit`, `integration`, `e2e`, `web`) exist and run.
- [ ] EPIC-02 has emitted `.DeFlow/schemas/` so the fake exec-shim's `result` envelope and the mock's
      structured output have something to be invalid against.
- [ ] `@agentclientprotocol/sdk@1.3.0` installs and its `./schema/schema.json` subpath export resolves
      (verified subpath list in [adapter layer §2.1](../../07-provider-adapter-layer.md)).
- [ ] M0-S1 has produced at least one raw ndjson capture from a live agent, so KAR-04.5's replay format
      is being designed against real bytes rather than an invention.

## Definition of Done (epic level)

- [ ] All six stories are Done.
- [ ] Every scenario in [EPIC-04 flows](../flows/EPIC-04-mock-agent-flows.md) passes as an automated
      test in the project slice its `Automated at:` line names.
- [ ] `DeFlow-mock-agent --help` runs from a `pnpm pack`ed tarball installed into a clean tmpdir — it is
      a shipped bin, not a test helper.
- [ ] Two invocations of the same scenario at the same `--seed` produce byte-identical ndjson on stdout.
- [ ] A purity test asserts `packages/mock-agent/src/**` imports nothing from `@DeFlow/*`
      ([repo layout R1](../../16-repo-layout.md)).
- [ ] No `Unverified` claim in [adapter layer §13](../../07-provider-adapter-layer.md) remains open for
      this area; the `agentCapabilities` profiles are generated from the §5 matrix fixture rather than
      typed by hand.
- [ ] The whole epic's test suite runs offline, with no vendor CLI installed and no credential present.

## User stories

### KAR-04.1 — Mock agent binary speaking ACP over a real subprocess

|                 |                                                 |
| --------------- | ----------------------------------------------- |
| **Status**      | Ready                                           |
| **Priority**    | P0                                              |
| **Size**        | M                                               |
| **Depends on**  | EPIC-01                                         |
| **PRD**         | F3.7, NF9                                       |
| **Verified by** | EPIC-04-S1, EPIC-04-S2, EPIC-04-S3, EPIC-04-S21 |

**As** the engineer building DeFlow, **I want** a real `DeFlow-mock-agent` executable that completes a
full ACP prompt cycle over stdin/stdout, **so that** every layer above it — spawn, argv, ndjson framing,
the `nextUpdate()` pull loop, teardown — is exercised for real without a vendor CLI, credentials or
network.

This is `packages/mock-agent`, built on `acp.agent({…})` from `@agentclientprotocol/sdk@1.3.0` (exact
pin, no caret — the package went 0.4.5 → 1.3.0 and changed npm scope _and_ GitHub org in about ten
months). Transport is `acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))`.
It answers `initialize` with `protocolVersion: 1` — **the integer, not a date string** — plus an
`agentCapabilities` block, then `session/new`, `session/prompt`, and emits `session/update`
notifications. `--seed` drives a seeded id factory and a synthetic clock so every `sessionId`,
`toolCallId` and `ts` is reproducible. Per [adapter layer §13](../../07-provider-adapter-layer.md) it
must depend on **nothing** in the workspace: if it imported `@DeFlow/core`, a domain-model bug would be
mirrored on both sides of the wire and cancel itself out.

**Acceptance criteria**

1. `DeFlow-mock-agent` is a resolvable bin with a `#!/usr/bin/env node` shebang and an executable mode
   bit, and runs from a `pnpm pack`ed tarball in a clean tmpdir with no build step.
2. Given a client sending `initialize`, the response carries `protocolVersion: 1` (integer) and an
   `agentCapabilities` object; sending `protocolVersion: 2` gets a version-mismatch error rather than a
   silent downgrade.
3. A `session/new` request returns a `sessionId`; a subsequent `session/prompt` yields at least one
   `agent_message_chunk` `session/update` and then a `PromptResponse` with `stopReason: 'end_turn'`.
4. Two invocations of the same scenario file with the same `--seed` produce byte-identical stdout after
   normalising nothing — the bytes match exactly.
5. `packages/mock-agent/package.json` declares `@agentclientprotocol/sdk` as its only dependency, and a
   test asserts no source file under `packages/mock-agent/src/` contains an import matching `@DeFlow/`.
6. The process exits 0 on a clean `session/close` and closes stdout without truncating a partial frame.

**Test plan (TDD)** — write these tests first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                        | Red when                                            |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | integration | `spawn(MOCK_AGENT_BIN, [], {stdio:['pipe','pipe','pipe']})`, hand-write an `initialize` frame to stdin, assert the parsed reply has `protocolVersion === 1` | No binary exists; spawn fails with ENOENT           |
| 2   | integration | Same fixture, then `session/new` → assert a non-empty `sessionId` in the result                                                                             | Method unimplemented; JSON-RPC `-32601` returned    |
| 3   | integration | `session/prompt` → collect frames until `stopReason`; assert ≥1 `agent_message_chunk` precedes `stopReason: 'end_turn'`                                     | No updates emitted                                  |
| 4   | integration | Run the same scenario twice with `--seed 42`, `Buffer.compare` the two stdout captures → 0                                                                  | Ids come from `crypto.randomUUID()`                 |
| 5   | unit        | Glob `packages/mock-agent/src/**/*.ts`, assert no source contains `from '@DeFlow/`                                                                          | The package imports `@DeFlow/core` for its id types |
| 6   | integration | `pnpm pack` the `DeFlow` package into a tmpdir, `npx ./DeFlow-*.tgz` exposes `DeFlow-mock-agent --help` with exit 0                                         | The bin is missing from `files` / `bin`             |

**Notes / risks** — resolve and store the **absolute** path to the binary in the fixture rather than
relying on `PATH` lookup at spawn time. DeFlowd's `PATH` at daemon start differs from the user's login
shell, and the tests should reflect the production rule
([adapter layer §4.3](../../07-provider-adapter-layer.md)).

---

### KAR-04.2 — Scripted scenario format

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| **Status**      | Not started                                                 |
| **Priority**    | P0                                                          |
| **Size**        | M                                                           |
| **Depends on**  | KAR-04.1                                                    |
| **PRD**         | F3.7, F3.4                                                  |
| **Verified by** | EPIC-04-S4, EPIC-04-S5, EPIC-04-S6, EPIC-04-S7, EPIC-04-S22 |

**As** the engineer writing adapter and orchestrator tests, **I want** to describe an agent's whole turn
in a declarative script file, **so that** a new test case is a data file rather than a new binary and
the scenario reads as the specification of what the daemon must survive.

The script drives behaviours 1–4 of [adapter layer §13](../../07-provider-adapter-layer.md): a `plan`
update followed by N `agent_message_chunk`s at a scripted per-chunk delay; `tool_call` →
`tool_call_update` transitions covering **every** `ToolCallStatus` value; `session/request_permission`
with per-`optionId` branching including the `{ outcome: 'cancelled' }` case; and outbound calls back
into the client for `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`,
`terminal/wait_for_exit`, `terminal/kill` and `terminal/release`. Delays are expressed in the script and
realised against the mock's own clock — they must be _real_ sleeps, because
[testing strategy §8](../../14-testing-strategy.md) forbids fake timers while a child process is alive.
Each invocation also appends `{runId, nodeId, attempt, idempotencyKey}` to
`$DeFlow_SIDE_EFFECT_LOG`, which is what turns the crash-fuzz test's "was an effect executed twice?"
question into a duplicate-key check on a text file rather than an inference.

**Acceptance criteria**

1. A scenario is a single file (JSON or JSONC) selected by `--scenario <path>` or `$DeFlow_MOCK_SCENARIO`;
   an unreadable or schema-invalid scenario exits non-zero with a one-line diagnostic on stderr and
   emits no ACP frames.
2. A `chunks` step emits N `agent_message_chunk` notifications with the declared `delayMs` between them,
   and the observed inter-arrival times at the client are within tolerance of the script — chunks do
   **not** arrive as one burst at the end.
3. A `toolCall` step emits a `tool_call` followed by `tool_call_update` notifications covering every
   status value the ACP schema defines, in the declared order, carrying a `ToolCallLocation` with a
   `path`.
4. A `permission` step issues `session/request_permission` with the declared options and branches on the
   returned `optionId`; a `{ outcome: 'cancelled' }` response takes the declared `onCancelled` branch and
   still terminates the turn with a `stopReason`.
5. A `clientCall` step invokes any of the seven `fs/*` and `terminal/*` client methods and records the
   client's response into the script's own trace, so a test can assert the agent _saw_ the rejection.
6. Every invocation appends exactly one line to `$DeFlow_SIDE_EFFECT_LOG` when the variable is set, and
   the line contains the four idempotency fields verbatim from argv/env.
7. Scenario files used by the suite live in one directory and are validated against their own JSON Schema
   in a unit test, so a typo in a scenario fails fast rather than producing a mysterious empty turn.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                                      | Red when                                      |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | unit        | Scenario parser rejects an unknown step `type` with a message naming the step index                                                                                                       | Parser accepts anything and no-ops            |
| 2   | integration | Script three chunks at `delayMs: 50`; client timestamps each arrival; assert monotonic gaps ≥40 ms and ≥1 gap before the stop frame                                                       | All three frames land in one read             |
| 3   | integration | Drive a `toolCall` step; assert the received `session/update` sequence's status field equals the full declared status list in order                                                       | Only `pending`/`completed` are emitted        |
| 4   | integration | Client answers a permission request with `reject_once`; assert the agent takes the `onRejected` branch and the turn ends with the declared `stopReason`                                   | Agent ignores the outcome and continues       |
| 5   | integration | Client answers with `{ outcome: 'cancelled' }`; assert no deadlock and a terminal `stopReason` within the 30 s integration timeout                                                        | Agent awaits an `optionId` that never arrives |
| 6   | integration | Script a `terminal/create` + `terminal/output` + `terminal/wait_for_exit` + `terminal/release` sequence against a stub client; assert all four were called in order                       | Only `create` is implemented                  |
| 7   | integration | Run the same node twice with the same `ikey`; assert the side-effect log has two lines with an identical `idempotencyKey` (this is the _stimulus_ the crash-fuzz assertion later forbids) | No log is written                             |

**Notes / risks** — real sleeps make these tests genuinely slow if the scenario library gets careless.
Keep scripted delays in the tens of milliseconds; the point is to prove frames arrive incrementally, not
to simulate a real agent's latency.

---

### KAR-04.3 — Pathological behaviours: hang, mid-turn crash, malformed frame, oversized line

|                 |                                                               |
| --------------- | ------------------------------------------------------------- |
| **Status**      | Not started                                                   |
| **Priority**    | P0                                                            |
| **Size**        | S                                                             |
| **Depends on**  | KAR-04.2                                                      |
| **PRD**         | F3.4, F3.7, F4.2, F4.4                                        |
| **Verified by** | EPIC-04-S8, EPIC-04-S9, EPIC-04-S10, EPIC-04-S11, EPIC-04-S12 |

**As** the engineer who has to trust a run that lasts three days, **I want** the mock agent to hang,
crash, lie and flood on command, **so that** the durability design is exercised on every commit instead
of being discovered by a real user's failed multi-hour run.

**This is the story that pays for the whole epic.** These five behaviours — items 5–8 of
[adapter layer §13](../../07-provider-adapter-layer.md) — are the exact cases the durability design
exists to handle, and they cannot be produced on demand any other way. Each maps onto a specific
`NodeFailureReason` in [04-domain-model.md §8](../../04-domain-model.md) that EPIC-05 and EPIC-06 must
produce: `hangForever` → `timeout` and the cancellation path; `exit` → `agent.nonzero-exit` and orphan
reaping; `malformedLine` → `adapter.malformed-output`; `invalidFrame` → `adapter.protocol-error`;
`hugeLine` → `adapter.frame-too-large`. The last two are deliberately distinct: one is not JSON at all,
the other is perfectly good JSON that fails validation against `@agentclientprotocol/sdk/schema/schema.json`
(**262 `$defs`**, verified 2026-08-02). A parser that conflates them cannot report honestly.

**Acceptance criteria**

1. `hangForever` stops emitting mid-turn and never writes another byte, never exits, and does not close
   stdout — the client must observe a genuinely wedged agent, not an EOF.
2. `hangForever` still responds to `session/cancel`: it flushes any declared trailing `session/update`
   notifications and then answers the prompt with `stopReason: 'cancelled'`, per
   [adapter layer §2.5](../../07-provider-adapter-layer.md). A variant `hangForeverIgnoringCancel`
   ignores the cancel entirely, so the SIGTERM escalation path has a target.
3. `exit` calls `process.exit(1)` after the declared number of frames, mid-frame if the scenario says so,
   leaving a partially-written line on stdout.
4. `malformedLine` writes a line that is not JSON at all (unbalanced brace) followed by a newline, and
   then — if the scenario says so — continues with valid frames, so the client's recovery-vs-teardown
   decision is testable.
5. `invalidFrame` writes syntactically valid JSON that fails `ajv` validation against `schema.json` — for
   example a `session/update` whose `sessionUpdate` discriminator is an unknown string.
6. `hugeLine` writes a **single 10 MB line** with no embedded newline, in chunks, so the client's byte
   counter sees it grow past a cap rather than arriving atomically.
7. A `noNewline` variant writes ≥10 MB and **never emits `\n` at all** — the wedged-agent case that the
   SDK's unbounded `LineBuffer` cannot defend against.
8. Every pathological behaviour is reachable from a scenario file and from a dedicated CLI flag, so a
   human can reproduce a reported bug in one command.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                           | Red when                                                           |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | integration | Spawn with `hangForever`; assert no stdout data for 500 ms and `child.exitCode === null`                                                       | The mock exits or closes stdout on an unknown step                 |
| 2   | integration | `hangForever` + client sends `session/cancel`; assert declared trailing updates arrive **after** the cancel and then `stopReason: 'cancelled'` | The mock tears down on cancel and the prompt promise never settles |
| 3   | integration | `hangForeverIgnoringCancel`; assert the process is still alive 1 s after the cancel (the SIGTERM path's target)                                | The mock honours cancel unconditionally                            |
| 4   | integration | `exit` mid-turn; assert `exitCode === 1`, `signal === null`, and the last stdout line is truncated (no trailing `\n`)                          | Exit is clean and the frame is complete                            |
| 5   | integration | `malformedLine`; assert stdout contains a line that `JSON.parse` throws on, and that a subsequent valid frame follows                          | Only well-formed frames are emitted                                |
| 6   | unit        | `invalidFrame` output parses as JSON **and** fails `ajv.compile(schema.json)` validation                                                       | The frame validates — the scenario is not actually invalid         |
| 7   | integration | `hugeLine`; count bytes to the first `0x0a` on stdout, assert ≥ 10 × 1024 × 1024                                                               | The payload is chunked with newlines and never exceeds the cap     |
| 8   | integration | `noNewline`; read 5 s of stdout, assert zero `0x0a` bytes and ≥ 8 MiB read                                                                     | A newline is emitted and the buffer drains                         |

**Notes / risks** — write the 10 MB payload with a generated repeating pattern rather than random bytes,
or `--seed` reproducibility breaks and the recorded fixtures balloon in git. Keep the payload
generatable, never checked in.

---

### KAR-04.4 — Configurable capability advertisement

|                 |                          |
| --------------- | ------------------------ |
| **Status**      | Not started              |
| **Priority**    | P0                       |
| **Size**        | S                        |
| **Depends on**  | KAR-04.1                 |
| **PRD**         | F3.5, F3.7               |
| **Verified by** | EPIC-04-S13, EPIC-04-S14 |

**As** the engineer implementing resume, routing and refusal, **I want** the mock agent to advertise any
`agentCapabilities` block on demand, **so that** the uneven provider matrix stops being an
integration-test problem and becomes a unit-test problem.

This is item 9 of [adapter layer §13](../../07-provider-adapter-layer.md) — _"the one people skip and
regret"_ — and it is worth saying explicitly what it buys. The measured matrix of
[§5](../../07-provider-adapter-layer.md) is genuinely uneven: `claude-agent-acp@0.64.1` supports resume,
fork, list, delete and `additionalDirectories`; `codex-acp@1.1.9` resumes but cannot fork and returns
`mcp.sse: false` and `mcp.acp: false`; `copilot --acp@1.0.77` returns `sessionCapabilities: { list: {} }`
and **cannot resume**; `gemini --acp@0.53.1` returns **no `sessionCapabilities` key at all**, only
`loadSession: true`. **Two of five cannot resume.** Without this flag, "does `ResumeByReplay` work on a
Gemini-shaped profile?" requires an installed and authenticated Gemini CLI and a real prompt cycle. With
it, that question is a **40 ms unit test that runs on every commit** — which matters because
`ResumeByReplay` is the durability path for 40% of the supported providers and must never rot.

The profiles are **generated from the §5 matrix fixture, not typed by hand**, so a `DeFlow doctor`
re-probe that finds a changed capability set automatically changes what the tests exercise.

**Acceptance criteria**

1. `--capabilities <name>` selects a named profile; `--capabilities-file <path>` supplies an arbitrary
   JSON block. The selected block is returned verbatim inside the `initialize` response's
   `agentCapabilities`.
2. The named profiles are `claude`, `codex`, `opencode`, `copilot`, `gemini` and `mock-full`, generated at
   build time from the capability-matrix fixture — a unit test asserts the generated profiles equal the
   fixture, so a stale hand-edit fails CI.
3. The `gemini` profile omits `sessionCapabilities` entirely (not an empty object), and the `copilot`
   profile emits `sessionCapabilities: { list: {} }` — the two shapes that break naive optional-chaining.
4. A `--dishonest-capabilities` mode advertises a capability and then answers the corresponding request
   with JSON-RPC `-32601 Method not found`, so assertion 6 of the conformance battery
   ([§11.3](../../07-provider-adapter-layer.md)) has something to catch.
5. Selecting an unknown profile name exits non-zero listing the available names; it never falls back to a
   default, because a silent fallback would make a whole test file green for the wrong reason.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                              | Red when                                          |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | unit        | Generated profiles deep-equal the parsed capability-matrix fixture rows                                                                           | Profiles are a hardcoded literal that has drifted |
| 2   | integration | `--capabilities gemini` → `initialize` response has no `sessionCapabilities` key (`'sessionCapabilities' in caps === false`)                      | The mock always emits a full block                |
| 3   | integration | `--capabilities copilot` → `sessionCapabilities` deep-equals `{ list: {} }`                                                                       | An empty object is normalised away                |
| 4   | integration | `--capabilities codex` → `mcpCapabilities.sse === false` and `mcpCapabilities.acp === false`, as literal `false` not absent                       | Absent is treated as equivalent to false          |
| 5   | integration | `--capabilities claude --dishonest-capabilities session.resume` advertises `resume: true`, then answers `session/resume` with error code `-32601` | The mock honours everything it advertises         |
| 6   | integration | `--capabilities does-not-exist` exits non-zero and stderr lists the six valid names                                                               | Unknown names silently select `mock-full`         |

**Notes / risks** — the profiles are a **snapshot of 2026-08-02, and two of the five versions were
published the day they were probed**. Treat a profile diff in a PR as signal, not noise: it means a
vendor changed what it can do, and the routing layer's assumptions changed with it.

---

### KAR-04.5 — Recording replay as a provider

|                 |                          |
| --------------- | ------------------------ |
| **Status**      | Not started              |
| **Priority**    | P0                       |
| **Size**        | M                        |
| **Depends on**  | KAR-04.1                 |
| **PRD**         | F3.4, F3.7, F4.9         |
| **Verified by** | EPIC-04-S15, EPIC-04-S16 |

**As** the engineer maintaining five adapters against vendor CLIs that churn monthly, **I want**
`DeFlow-mock-agent --replay <file>` to serve a captured real session, **so that** a recorded conversation
with a real, authenticated agent becomes a free CI provider and a flag-churn detector.

The recording format is fixed by [adapter layer §11.4](../../07-provider-adapter-layer.md):
`recordings/<provider>@<exact-version>/<case>.ndjson`, one JSON object per line,
`{"t": <msOffset>, "dir": "in" | "out", "msg": { … }}`. Replay reads the file, emits every `dir: "out"`
frame at its recorded offset (or as fast as possible under `--replay-speed max`), and asserts that
incoming frames match the recorded `dir: "in"` frames **modulo JSON-RPC `id` and `_meta`** — those are
the only two fields a client is entitled to differ on. Keying the directory on the exact version means a
vendor bump produces a **visible new directory in a PR** rather than silently invalidating old goldens.
Producing the recordings is EPIC-05's job (`DeFlow_RECORD=1` teed at the transport, never in the parser);
this story only consumes them.

**Acceptance criteria**

1. `--replay <file>` completes a full prompt cycle driven entirely by the file, with no scenario file
   present.
2. Outgoing frames are compared to the recorded inbound frames after stripping JSON-RPC `id` and `_meta`;
   a mismatch exits non-zero and prints a unified diff of the two frames, naming the line number in the
   ndjson file.
3. `--replay-speed real|max` selects between honouring the recorded `t` offsets and emitting as fast as
   the pipe allows; `max` is the CI default.
4. A recording whose directory name does not parse as `<provider>@<version>` is rejected at startup with a
   message naming the expected shape — this is what keeps the version key from rotting into `latest`.
5. A truncated recording (the file ends mid-turn, as a real crashed capture would) terminates the session
   with a declared `stopReason` rather than hanging, and says so on stderr.
6. Replaying the same file twice produces byte-identical stdout, independent of `--seed`, because every
   id comes from the file.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                        | Red when                                                  |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | integration | Hand-write a 6-line ndjson fixture; `--replay` it; assert the client observes the recorded chunk texts in order and a terminal `stopReason` | The flag is unimplemented                                 |
| 2   | unit        | Frame comparator treats two frames differing only in `id` and `_meta` as equal, and two differing in `params.sessionId` as unequal          | The comparator does a naive `deepEqual`                   |
| 3   | integration | Replay with a deliberately altered client request; assert exit code ≠ 0 and stderr contains the ndjson line number                          | Mismatches are ignored                                    |
| 4   | integration | Directory named `claude-agent-acp` (no `@version`) → startup error naming `<provider>@<version>`                                            | Any directory name is accepted                            |
| 5   | integration | Truncate the fixture mid-turn; assert the process terminates within 2 s with a non-`end_turn` `stopReason`                                  | The replay hangs waiting for a frame that will never come |
| 6   | integration | Replay twice, `Buffer.compare` stdout → 0                                                                                                   | Timestamps are regenerated rather than read from the file |

**Notes / risks** — recordings are the only artefact in this epic that a real credential touched. They
must be reviewed for secrets before they enter git, and `pnpm test:record` never runs in CI
([testing strategy §4](../../14-testing-strategy.md)).

---

### KAR-04.6 — Fake exec-shim agent for the CLI fallback path

|                 |                                                    |
| --------------- | -------------------------------------------------- |
| **Status**      | Not started                                        |
| **Priority**    | P0                                                 |
| **Size**        | M                                                  |
| **Depends on**  | KAR-04.2                                           |
| **PRD**         | F3.2, F3.4, F5.7                                   |
| **Verified by** | EPIC-04-S17, EPIC-04-S18, EPIC-04-S19, EPIC-04-S20 |

**As** the engineer building the non-ACP fallback, **I want** a second fake binary that emits
Claude-Code-shaped `stream-json` and Codex-shaped JSONL, **so that** the exec-shim parser family and the
SIGKILL escalation path are testable without the ACP protocol in the way.

This is `packages/testkit/bin/fake-agent.ts` with a `#!/usr/bin/env node` shebang, reading its scenario
from `$DeFlow_FAKE_SCENARIO` ([testing strategy §3.2](../../14-testing-strategy.md)). Same idea as the
mock agent, different wire format. Its scenario vocabulary must cover the full F3.4 conformance battery:
scripted stdout chunks with delays; `--output-format json` and `stream-json` including the verified
Claude Code `result` envelope (`{"type":"result","subtype":"success","is_error":false,"stop_reason":…,
"total_cost_usd":…,"usage":{…},"modelUsage":{…},"permission_denials":[],"result":"…"}`); malformed JSON;
non-zero exit; **exit without any output at all**; hang forever; **ignore SIGTERM**, so the SIGKILL
escalation is genuinely exercised; write files into the worktree so path-scope detection has something to
detect; emit a permission refusal; and a single 10 MB line.

Two verified vendor behaviours must be reproducible because a shim that gets them wrong fails in
production: Claude Code **requires `--verbose` alongside `-p --output-format stream-json`** (without it
the process exits printing `Error: When using --print, --output-format=stream-json requires --verbose`),
and **Copilot has no `stream-json` at all** — `text|json` only.

**Acceptance criteria**

1. `fake-agent` is a real executable readable from `$PATH` under any vendor name the fixture symlinks it
   to, and selects its wire dialect from `$DeFlow_FAKE_DIALECT` (`claude-stream-json` | `codex-jsonl` |
   `copilot-json`).
2. Under `claude-stream-json`, invoking without `--verbose` alongside `-p --output-format stream-json`
   exits non-zero printing the exact string
   `Error: When using --print, --output-format=stream-json requires --verbose`.
3. Under `claude-stream-json`, every emitted line carries a `session_id` and a unique `uuid`, and the
   final line is a `result` envelope with the verified field set; a scenario can set
   `subtype: 'error_max_structured_output_retries'` so `agent.schema-repair-exhausted` has a source.
4. Under `copilot-json`, requesting `stream-json` exits non-zero — a shim that assumes a uniform
   `stream-json` must fail here, loudly.
5. A `rate_limit_event` frame with a `resetsAt` value can be scripted, so backoff scheduling has a real
   input to parse.
6. `ignoreSigterm` installs a no-op `SIGTERM` handler and keeps running; `noOutput` exits 0 having written
   zero bytes to stdout and stderr; `spawnGrandchildren` backgrounds two `sleep 300` children so the
   process-tree kill fixture has a real tree.
7. `writeFiles` writes declared paths relative to `cwd`, including at least one **outside** the worktree,
   so path-scope violation detection has a positive case.
8. Same side-effect-log contract as KAR-04.2: one line per invocation with the four idempotency fields.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                                                                                            | Red when                                                               |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | integration | Symlink `fake-agent` to `<tmp>/bin/claude`, spawn with `-p --output-format stream-json` and no `--verbose`; assert exit ≠ 0 and stderr matches the exact error string                                                                           | The guard is absent                                                    |
| 2   | integration | With `--verbose`; assert every stdout line parses as JSON, all carry `session_id`, and the `uuid` set has no duplicates                                                                                                                         | `uuid` is constant across lines                                        |
| 3   | unit        | The scripted `result` envelope validates against the recorded Claude Code result shape fixture                                                                                                                                                  | Fields are invented rather than taken from the verified envelope       |
| 4   | integration | `$DeFlow_FAKE_DIALECT=copilot-json` with `--output-format stream-json`; assert exit ≠ 0                                                                                                                                                         | The fake accepts every format for every dialect                        |
| 5   | integration | `noOutput` scenario; assert exit 0 and zero bytes on both stdout and stderr                                                                                                                                                                     | The fake always prints a banner                                        |
| 6   | integration | `ignoreSigterm` + `spawnGrandchildren`, `detached: true`; send `process.kill(-pid,'SIGTERM')`, assert all four processes still present and **not** in state `Z` after 1 s; then `SIGKILL` the group and assert the only survivors are `Z`-state | The handler is not installed, or the assertion counts zombies as alive |
| 7   | integration | `writeFiles` with a path outside the worktree; assert the file exists at the resolved absolute path                                                                                                                                             | Paths are silently confined                                            |
| 8   | integration | `hugeLine` under `codex-jsonl`; assert one line ≥ 10 MB                                                                                                                                                                                         | The dialect chunks output                                              |

**Notes / risks** — this story is the epic's designated **scope-cut candidate**.
[Adapter layer §8.5](../../07-provider-adapter-layer.md) makes a defensible case for skipping the exec
shim entirely at M1 and supporting only ACP-reachable providers — five of the six PRD targets. If
KAR-05.8 is cut, this story reduces to the SIGTERM-ignoring, no-output and process-tree fixtures only
(size XS), because those are needed by EPIC-08's kill switch regardless of which adapter path exists.
Do not cut it entirely: the kill-path fixtures have no other home.

---

## Risks

| Risk                                                                                                                                                         | Impact                  | Mitigation                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **~11 days of tooling before a single real agent runs.** For a solo builder alongside a job and a degree, that is a long time without user-visible progress. | High (morale, schedule) | The roadmap explicitly sequences W2 before W3 and notes W1/W2 can be worked in the same week as a break from reducer work. KAR-04.1 + KAR-04.3 + KAR-04.4 (≈5 days) unblock EPIC-05 on their own; 04.5 and 04.6 can trail.                     |
| **The mock agent drifts from real agent behaviour**, so a green suite means nothing.                                                                         | High (silent)           | KAR-04.5 is the antidote: golden recordings from real CLIs replay through the same binary. Layer A schema conformance (KAR-05.7) validates the mock's own frames against `schema.json`, so the mock cannot emit something no real agent could. |
| **Capability profiles rot.** The §5 matrix is a snapshot; two of five versions were published the day they were probed.                                      | High                    | KAR-04.4 generates profiles from the fixture rather than hand-writing them, and `DeFlow doctor` regenerates the fixture. A profile diff in a PR is the intended signal.                                                                        |
| **Real sleeps make the suite slow.**                                                                                                                         | Medium                  | Cap scripted delays at tens of milliseconds. `pool: 'forks'` isolates leaked children so one slow scenario cannot poison neighbours.                                                                                                           |
| Recordings could leak repository content or secrets from the developer's real sessions.                                                                      | Medium                  | Review before committing; `pnpm test:record` is manual and never runs in CI. Redaction proper is M2 (F5.9).                                                                                                                                    |

**Requirement coverage note.** F3.3 (direct API adapter) has no story in this epic and none in EPIC-05
either — [adapter layer §12](../../07-provider-adapter-layer.md) scopes it to M2 with no verified package
selection, and the mock agent has nothing to say about it. **Settled on 2026-08-06: F3.3 moved to M2 and
PRD §11's M1 line was amended to `F3.1, F3.2, F3.4–F3.7`**, so this is no longer a gap in the M1 line at
all. See [board §7.1](../board.md) and `KAR-05.10`, retained in the EPIC-05 file as the M2 specification.

---

**Related:** [Flows](../flows/EPIC-04-mock-agent-flows.md) · [Board](../board.md) ·
[Provider adapter layer](../../07-provider-adapter-layer.md) ·
[Testing strategy](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
