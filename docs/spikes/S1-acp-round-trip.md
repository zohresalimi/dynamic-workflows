# S1 — ACP client completes a full prompt cycle against a real adapter

> Spike for [KAR-00.1](../delivery/epics/EPIC-00-foundation-spikes.md#kar-001--spike-acp-client-completes-a-full-prompt-cycle-against-a-real-adapter).
> Scenarios: [EPIC-00-S4 … EPIC-00-S10](../delivery/flows/EPIC-00-foundation-spikes-flows.md).
> Artefacts: [`spikes/s1-acp/`](../../spikes/s1-acp/),
> [`fixtures/capabilities/`](../../fixtures/capabilities/),
> [`fixtures/cli-flags/2026-08-04.json`](../../fixtures/cli-flags/2026-08-04.json),
> [`recordings/claude-agent-acp@0.64.1/`](../../recordings/), executed by
> [`test/integration/spike-s1-acp.test.ts`](../../test/integration/spike-s1-acp.test.ts) and
> [`test/spike-s1-acp-framing.test.ts`](../../test/spike-s1-acp-framing.test.ts).

**Date:** 2026-08-04. **Machine:** macOS 15 (darwin/arm64), Node 24.18.0.
**Timebox:** 4 working days. **Used:** under one day — recorded here because an overrun would have
been an A0-2 signal, and so is an underrun.

## The question

Can DeFlow, acting as an ACP client, complete a full prompt cycle — `initialize` → `session/new` →
`session/prompt` → streamed `session/update` → `session/request_permission` → `session/cancel` —
against a community adapter and against a natively-ACP agent, with streaming that actually
streams, permission mediation that actually reaches the client, and cancellation that does not
deadlock?

Before this spike, `initialize` had been verified live against all five ACP entry points
(2026-08-02) and all five negotiated wire `protocolVersion: 1`. **Everything past that step was
read out of `@agentclientprotocol/sdk@1.3.0`'s types and its shipped `schema/schema.json` (262
`$defs`), never executed** — because a prompt cycle costs vendor credits and needs each vendor's
auth. That is A0-1, graded **Critical**, and the PRD's M0 kill criterion attaches to it.

## Method

`spikes/s1-acp/run.ts --agent <name>` drives the six steps in one command, across two prompt turns
in one session: turn 1 asks for a file write, which produces a `session/request_permission` that is
answered `reject_once` and runs on to `end_turn`; turn 2 asks for a long enumeration and is
cancelled on the **second** streamed update of that turn.

Four things about the harness matter for what the numbers below are worth:

- **It is not built on the SDK's `ClientSideConnection`.** Two acceptance criteria are about
  behaviour the SDK does not have — an upstream frame cap, and continuing to drain the stream after
  the prompt promise has settled — and a client built on the SDK could not demonstrate either. The
  SDK is used for the one thing it is authoritative about: the wire schema.
- **The transport tees raw bytes, in both directions, with a client-side receipt timestamp, before
  anything parses them** (`recordings/<agent>@<version>/full-cycle.ndjson`). A recording of the
  parsed interpretation would record the client's opinion, and the client's opinion is the thing
  under test.
- **Every re-run replays that recording through the same client** rather than spending more quota,
  and the replay is gated on the client producing the same outbound frames, in the same order, with
  the same params shape. A client that stopped sending `mcpServers`, or that cancelled at a
  different point in the stream, stalls the replay instead of quietly passing. In replay mode time
  enters the client through the recording's own clock, so the streaming numbers reported are the
  ones measured live, never an artefact of how fast the replay runs.
- **AR-1 holds inside the spike.** The harness reads no token file, sets no auth environment
  variable, and passes `process.env` through untouched; the vendor binary runs under the author's
  own account via `npx <package>@<exact-version>`.

The four behaviours a vendor cannot be asked for on demand — a 10 MB line with no newline, an agent
that ignores `session/cancel`, an agent that flushes updates after a settled cancel, an agent whose
advertised capabilities contradict the snapshot — are produced by a real fake-agent **binary**
(`spikes/s1-acp/agents/fake-agent.ts`), spawned over the same pipes through the same framer.
Nothing anywhere in this spike mocks a module.

## Measurement

### The six steps, `claude-agent-acp@0.64.1`

| Step                         | Result | Observed                                                                                    |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `initialize`                 | ok     | `protocolVersion: 1`; `agentInfo @agentclientprotocol/claude-agent-acp 0.64.1`               |
| `session/new`                | ok     | `sessionId a54d92c7-…`; `mcpServers` accepted without error                                  |
| `session/prompt`             | ok     | turn 1 accepted, `stopReason: end_turn`                                                      |
| `session/update`             | ok     | 17 notifications, client-side receipt spread **6699 ms**                                     |
| `session/request_permission` | ok     | answered `reject_once`; the tool call ended `status: failed`; `forbidden.txt` never created |
| `session/cancel`             | ok     | `stopReason: cancelled` **6 ms** after the cancel; 1 trailing update accepted; transport live |

All 34 recorded frames validate against the ACP schema — both against the top-level envelope and
against the method-specific `$def` (`InitializeRequest/Response`, `NewSessionRequest/Response`,
`PromptRequest/Response`, `SessionNotification`, `RequestPermissionRequest`, `CancelNotification`).
There is **no official ACP conformance kit** — a verified negative that web search contradicts by
conflating ACP with an unrelated academic protocol of the same abbreviation — so the shipped
`schema.json` plus `ajv` is the only conformance signal that exists.

### Streaming is incremental (AC4, EPIC-00-S6)

17 `session/update` notifications, first to last **6699 ms** apart, against a 500 ms threshold. The
full inter-arrival list, in milliseconds, measured at the transport on receipt:

```
1544.3, 1.3, 509.6, 5.9, 1890.5, 7.7, 13.9, 0.0, 3.9, 921.2, 1.9, 507.8, 497.5, 360.7, 30.1, 402.4
```

The shape is the interesting part: the ~0–14 ms gaps are bursts of related frames (a
`usage_update` immediately followed by the `agent_message_chunk` it accounts for), and the
hundreds-of-milliseconds gaps are the model actually generating. Frames arrive as they happen.
F10.1 and F10.6 keep their premise, and EPIC-00-S6's second scenario (a burst at turn end) did not
occur and is not automated.

### MCP server acceptance (AC3)

`session/new` carried DeFlow's own stdio MCP server (`spikes/s1-acp/mcp-server.ts`). "No error" is
not evidence — an agent could ignore the argument entirely — so the server logs every method it is
asked for. It recorded `initialize`, `notifications/initialized`, `tools/list`
(`recordings/claude-agent-acp@0.64.1/mcp-handshake.txt`): the adapter really launched it and really
spoke MCP to it.

### The capability matrix, generated per agent (EPIC-00-S5)

| Agent                     | `session.resume` | `session.list` | `loadSession` | `mcp.http` | `mcp.sse` | `mcp.acp` |
| ------------------------- | ---------------- | -------------- | ------------- | ---------- | --------- | --------- |
| `claude-agent-acp@0.64.1` | yes              | yes            | yes           | yes        | yes       | no        |
| `gemini-cli@0.53.1`       | no               | no             | yes           | yes        | yes       | no        |

Both rows match the 2026-08-02 snapshot, and neither was taken from it: the fixtures under
`fixtures/capabilities/` are written from the observed `agentCapabilities` block, verbatim,
alongside a derived matrix. **A0-9's rule is enforced in code** — the snapshot appears in
`spikes/s1-acp/src/capabilities.ts` only as something to diff against, and a contradiction is
written to the fixture as observed and reported as a divergence rather than corrected into
agreement. That path is exercised by the `fake-divergent` agent binary, which advertises
`session.resume` its snapshot row denies; the harness writes `resume: true` and reports
`session.resume: snapshot no, observed yes`.

### `gemini-cli@0.53.1`: which step failed, and why

| Step             | Result  | Observed                                                    |
| ---------------- | ------- | ------------------------------------------------------------ |
| `initialize`     | ok      | `protocolVersion: 1`; `agentInfo gemini-cli 0.53.1`          |
| `session/new`    | failed  | `error -32000: Gemini API key is missing or not configured.` |
| everything after | blocked | no session                                                   |

This is **not a protocol failure**. `gemini --acp` negotiates version 1 and advertises its
capabilities before it needs credentials; it then refuses `session/new` because no Google account
is logged in on this machine and no `GEMINI_API_KEY` is set. AR-1 forbids the harness from setting
one, and OAuth login is interactive, so the cycle stops there by design rather than by defect. The
capability fixture for the agent is still generated from the observed `initialize` response, which
is what EPIC-00-S5 asks of it. Completing the remaining five steps against a second agent is
carried forward as an open item for EPIC-05 (KAR-05.2), to be run on a machine where a Gemini
account is already authenticated.

The kill criterion asks for the six steps on **at least one** agent. That bar is met, on the agent
the plan identified as the riskier of the two.

### Cancellation, graded (EPIC-00-S10)

Recorded frames around the cancel, with receipt times:

```
9130 in   session/update  usage_update            <- second update of turn 2
9130 out  session/cancel
9135 in   session/update  usage_update
9136 in   {"id":4,"result":{"stopReason":"cancelled", …}}
9137 in   session/update  session_info_update     <- trailing, after the promise settled
13139 out session/new                             <- liveness probe
13819 in  {"id":5,"result":{"sessionId":"e832feab-…"}}
```

`stopReason: cancelled` arrived 6 ms after the cancel. One `session/update` was flushed *after* the
prompt response, and was accepted; a subsequent `session/new` round-tripped, which is the proof the
read loop had not wedged. **Neither of EPIC-00-S10's first two scenarios occurred against a real
agent**, so neither is automated against one — the deadlock scenario and the trailing-flush-wedge
scenario are automated against fake-agent binaries instead, which is what makes them regressions
DeFlow can detect for ever rather than anecdotes about one vendor build.

The client-implementation rule the middle scenario encodes is now enforced by the client rather
than remembered: **the prompt promise resolving is not permission to stop reading the stream.**
`AcpClient` keeps dispatching after a response settles, and the harness counts what arrives
afterwards. This is the requirement KAR-05.9 (process lifecycle: detached spawn, cancellation,
orphan reaping) inherits.

### The frame cap (AC8, EPIC-00-S8)

`@agentclientprotocol/sdk@1.3.0`'s `LineBuffer` has **no maximum line length**, confirmed by
measurement rather than by reading: `spikes/s1-acp/probe-linebuffer.ts` pushes 10 MB containing no
`\n` into the real SDK class and reports `linesEmitted: 0, threw: false, pendingBytes: 10485760`.
Every byte is retained, indefinitely, and the class is not even reachable through the package's
`exports` map — consumers get it whether they want it or not, via `ndJsonStream()`.

**Cap chosen: 8 MiB (8388608 bytes)**, per
[01-architecture-overview.md §5](../01-architecture-overview.md) and
[07-provider-adapter-layer.md](../07-provider-adapter-layer.md), and now measured against a real
10 MB payload rather than picked. `CappedLineFramer` measures the *pending line* (not the chunk)
and throws `FrameTooLargeError { code: 'adapter.frame-too-large' }` on the byte that crosses the
cap, dropping the buffered tail as it goes; the client then tears the connection down. Against the
`fake-flood` binary the cap fired at 8454144 bytes — one 64 KiB pipe chunk past the cap, and 2 MB
short of what the agent was willing to send. `adapter.frame-too-large` is already the ledger's
name for this failure in [04-domain-model.md](../04-domain-model.md), so the spike and production
agree on the word.

**KAR-05.4** (frame-size guard, backpressure and blob spilling) is the consumer of this value.

### The CLI flag footguns (AC8, EPIC-00-S9)

`claude -p --output-format stream-json` without `--verbose` exits non-zero with exactly:

```
Error: When using --print, --output-format=stream-json requires --verbose
```

The `--help` baseline is captured in `fixtures/cli-flags/2026-08-04.json` by
`spikes/s1-acp/capture-cli-flags.ts`, so the monthly drift diff in
[roadmap §5](../17-roadmap.md) is a `diff` rather than a research exercise:

| Command      | Version               | Flag                       | Present |
| ------------ | --------------------- | -------------------------- | ------- |
| `claude`     | 2.1.220 (Claude Code) | `--permission-prompt-tool` | **no**  |
| `codex exec` | _not installed_       | `--full-auto`              | unknown |
| `gemini`     | 0.53.1                | `--acp`                    | yes     |
| `gemini`     | 0.53.1                | `--experimental-acp`       | yes (deprecated) |
| `gemini`     | 0.53.1                | `--allowed-tools`          | yes (deprecated) |

A flag that is unobservable because the binary is absent is recorded as `null`, never as `false` —
those are different facts, and a churn list that conflates them will invent findings.
The working assumption this baseline exists to serve, recorded verbatim:
**assume every vendor flag you depend on moves within 6 months.**

## What ACP does and does not surface (AC7)

- **Token usage: YES, and exactly.** Every prompt response carries
  `usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens }` —
  observed `{"inputTokens":4,"outputTokens":212,"cachedReadTokens":36391,"cachedWriteTokens":6009,"totalTokens":42616}`
  on the successful turn — and 8 `session/update` frames of kind `usage_update` arrived during the
  cycle carrying `{ used, size }` (context occupancy against a 1,000,000-token window) and, on two
  of them, `cost: { amount: 0.0836055, currency: "USD" }`. The `Usage` and `UsageUpdate` `$defs`
  are part of the protocol, not a vendor extension.
- **Compaction state: NO.** No frame in the recording carries a field named for compaction, and
  the string `compact` appears nowhere in the schema's 262 `$defs`. It does appear in the frame
  log — as the *name of a slash command* in `available_commands_update`, which is why a plain
  substring grep answers the wrong question and the check is written against key positions.
- **`structured_output`: NO, and structurally so.** It is absent from every result envelope in the
  recording **and from the ACP schema entirely** — zero occurrences across 262 `$defs`. There is
  no version of this protocol in which a vendor could populate it.

## Decision

**ACP-first is confirmed as a real integration path. GO.**

- **A0-1: closed.** The full cycle completed against `claude-agent-acp@0.64.1` — the community
  adapter, which the plan identified as the higher-risk of the two surfaces — with streaming that
  streams, permission mediation that reaches the client and is honoured, and cancellation that
  settles in 6 ms without wedging the transport. Struck through in the register below.
- **A0-2: re-weighted downward, not confirmed.** The failure mode this risk anticipated —
  community-bridge infidelity showing up as a broken cycle — did not occur. It was the *native*
  agent that could not get past `session/new`, and for a credentials reason rather than a protocol
  one. The conformance suite (F3.4) still targets the adapters, as planned; `KAR-05.8` (CLI exec
  shim fallback) stays a documented fallback and is **not** promoted to a first-class parallel
  path, because nothing observed here calls for one.
- **A0-3: closed, and the answer inverts the plan's assumption.** ACP surfaces token usage
  exactly, per turn and per session, and it surfaces cost. The roadmap's prescribed fallback —
  `tokenAccounting: 'estimated'` with degraded UI — **is not needed on this path**. The F3.5
  capability manifest value for `claude-agent-acp` is `tokenAccounting: 'exact'`. Compaction state
  is genuinely absent, so F10.5's context-budget visualisation must be built on `usage_update`'s
  `{ used, size }` (which is exactly what it needs).
  An absent value must be rendered as **unknown rather than as zero**:
  a zero looks like a measurement, and that is worse than a gap. The
  manifest value is per adapter and per version, read from the generated fixture, never a constant:
  `gemini-cli@0.53.1` is unmeasured here and must not inherit `'exact'` by association.
- **A4-2: confirmed absent.** `structured_output` is not in the protocol. F6.9's handoff-contract
  validation cannot lean on the vendor and needs DeFlow's own bounded repair loop. **KAR-09.9** is
  the affected story and should be sized on the assumption that it owns this end to end.
- **A0-9: enforced, not merely noted.** The capability matrix is generated per agent per exact
  version, and no capability constant appears in any source file.

Nothing in the plan changes as a consequence of a failure, because there was none; the two changes
above are consequences of the answer being *better* than assumed (A0-3) and of one agent being
unreachable for a non-protocol reason (Gemini). Both are carried into **KAR-00.7** as inputs.

### Fallbacks: which were taken

| Fallback the plan prepared                                  | Taken? |
| ----------------------------------------------------------- | ------ |
| `tokenAccounting: 'estimated'` on the ACP path (A0-3)       | **No** — usage is exact |
| Promote `KAR-05.8` CLI exec shim to a parallel path (A0-2)  | **No** — the adapter completed the cycle |
| Declare NO-GO on cancellation deadlock                       | **No** — cancellation settled in 6 ms |

### Open-risk register (from [roadmap §6](../17-roadmap.md)), as it stands after this spike

| Id       | Status                                                                                        |
| -------- | --------------------------------------------------------------------------------------------- |
| ~~A0-1~~ | ~~Full ACP prompt cycle never executed against any agent~~ — **closed 2026-08-04**             |
| A0-2     | Community adapter fidelity — **downgraded**: the adapter completed all six steps                |
| ~~A0-3~~ | ~~Whether ACP surfaces token usage or compaction is unverified~~ — **closed**: usage yes, compaction no |
| ~~A4-2~~ | ~~`structured_output` presence unconfirmed~~ — **closed: absent from the protocol**             |
| A0-9     | Capability matrix is a snapshot — **mitigated in code**: generated per version, diffed, never assumed |

## EPIC-00-S7's first scenario is **not applicable**, and that is the finding

[EPIC-00-S7](../delivery/flows/EPIC-00-foundation-spikes-flows.md#epic-00-s7--acp-surfaces-no-token-usage-so-tokenaccounting-degrades-honestly)'s
first scenario opens with _"Given the complete recorded frame log … When the developer greps it for
any token, usage, cost or compaction-shaped field / Then no such field is found"_. **Such fields
were found**, in quantity, so its Then clauses — record `A0-3: ACP surfaces no token accounting`,
prescribe `tokenAccounting: 'estimated'`, degrade F9.1 — describe a world that does not exist and
are not automated. What is automated in their place is the positive: the recording is asserted to
*contain* `usage_update`, the prompt result is asserted to carry a populated `usage` block, and the
manifest value is asserted to be `'exact'`. The honest-degradation requirement survives intact and
is asserted separately, because it is still needed wherever a value genuinely is missing —
compaction here, and any adapter whose manifest says `'none'` later.

Its second scenario (`structured_output` absent from a successful result) held exactly as written,
and is automated.

The same applies to EPIC-00-S6's second scenario (a burst at turn end) and EPIC-00-S10's first and
second scenarios (deadlock, and a wedge on the trailing flush): their Givens did not occur against
a real agent. The two cancellation ones are automated against fake-agent binaries — which is
stronger than leaving them unwritten, since it makes them permanent regression tests — while the
burst-at-turn-end branch has nothing to assert and is left unautomated on purpose.
