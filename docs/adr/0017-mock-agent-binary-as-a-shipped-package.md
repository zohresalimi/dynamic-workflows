# ADR 0017: The mock agent is a real binary, and a shipped package

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

DeFlow's core competence is spawning external processes, speaking a wire protocol to them over
pipes, and surviving when they misbehave. The failure modes it exists to handle — crash mid-turn,
hang forever, laptop sleep, a malformed frame, a 10 MB single line, an agent that advertises no
resume capability — are precisely the ones you cannot reproduce on demand against a real vendor CLI.

You also cannot iterate on durable-execution correctness against real agents. It is slow, it costs
subscription quota, it is nondeterministic, and CI has no credentials. Given the stated constraint —
built solo, alongside a job and a degree — anything that requires a live provider to test will not
get tested.

The usual answer is to mock the module: stub `child_process.spawn` and return scripted output. That
tests the mock. It does not test the ndjson framing, the backpressure behaviour, the frame-size cap,
the timeout, the process-group kill, or the parser. Every one of those is where DeFlow's bugs will
actually live.

The research also produced a specific reason the fake must be a _binary_: **verified 2026-08-02**,
`detached: true` is mandatory for agent processes, because with `detached: false` the grandchildren's
PGID is **DeFlowd's own process group** — `child.kill('SIGTERM')` kills only the direct child, both
grandchildren survive, and you cannot group-kill without killing DeFlowd. With `detached: true`,
`process.kill(-child.pid, 'SIGTERM')` terminates the whole subtree. There is no way to test that
against a mocked module; it requires real processes with real process groups.

And a trap that follows from it: after a successful group SIGKILL, `ps` still lists the
grandchildren — in state **`Z` (zombie)** with `ppid=1`. Any "did the kill work?" assertion must
exclude `Z`-state processes, or it reports a false negative. That test needs a real process tree.

## Decision

**`@DeFlow/mock-agent` is a first-class package exposing a real binary (`deflow-mock-agent`),
implemented with the _agent_ side of `@agentclientprotocol/sdk` and driven by a declarative script
file. It ships; it is not a test helper.**

It must reproduce, deterministically and on demand:

1. A `plan` update, then N `agent_message_chunk`s at a scripted cadence.
2. `tool_call` → `tool_call_update` transitions through each status value.
3. `session/request_permission`, behaving differently per chosen option, including the `cancelled`
   outcome.
4. Calls back into the client: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
   `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`.
5. **Hang forever mid-turn** — exercises cancellation, timeouts, laptop-sleep recovery.
6. **`process.exit(1)` mid-turn** — exercises crash recovery and orphan reaping.
7. A malformed JSON line, and a valid-JSON-but-schema-invalid frame.
8. **A single 10 MB line** — exercises the 8 MiB frame cap.
9. **A configurable `agentCapabilities` block**, so Gemini's no-resume profile and Claude's
   everything-on profile can be simulated without installing either.
10. `--seed`, so all ids and timestamps are byte-reproducible.

Plus `deflow-mock-agent --replay recordings/<provider>@<ver>/<case>.ndjson`, so a real captured
session becomes a mock provider for free.

**Item 9 is the one people skip and regret.** It turns the uneven capability matrix from
[ADR 0004](./0004-acp-first-adapter-layer.md) — where two of five probed agents cannot resume at all
— from an integration-test problem into a unit-test problem.

**Why shipped, not test-only.** Three reasons, and they are the substance of this decision:

- **F3.7 makes a mock provider a product requirement**, not a testing convenience. ODW ships one and
  the PRD names it as a strength worth adopting outright.
- **`deflow doctor` and the F3.4 conformance suite run on the user's machine**, not just in CI. The
  battery — structured output, streaming, permission refusal, timeout, cancellation, non-zero exit,
  malformed output, token accounting — needs a known-good reference implementation present at
  runtime to have something to compare a real adapter against.
- **The replay harness is the demo tool.** `deflow replay <fixture.jsonl>` lets all nine P0 views be
  developed, demonstrated and regression-tested with no credentials, no cost and no waiting — and it
  is the answer to PRD §15.4's "how do you present this internally". A tool that only exists in
  `devDependencies` cannot do that.

The parallel decision on the CLI-shim side is the same: `packages/testkit/bin/fake-agent.ts`, a real
executable on a temporary `PATH`, never a mocked `spawn`. Both are described in
[14-testing-strategy.md](../14-testing-strategy.md), and the mock agent's protocol behaviour in
[07-provider-adapter-layer.md](../07-provider-adapter-layer.md).

## Consequences

### Positive

- **A multi-hour scenario collapses into milliseconds**, and the whole daemon becomes developable
  offline on a laptop with zero credentials.
- The recovery paths that are the entire point of event sourcing become testable, which is the
  difference between claiming F4.2 and demonstrating it.
- The permission ladder, path-scope enforcement, command allowlist and gate logic all become fast
  unit tests with no vendor CLI installed
  ([ADR 0013](./0013-delegate-sandboxing-to-vendor-clis.md)).
- Crash-fuzz in CI becomes cheap: spawn DeFlowd, `kill -9` at a random point in a scripted run,
  restart, assert no effect executed twice and `PRAGMA integrity_check` is `ok`.

### Negative

- **It is a second ACP implementation to maintain**, on the agent side rather than the client side,
  and it must track protocol changes alongside the client. Bounded by using the same SDK, whose
  `acp.agent({...})` mirrors `acp.client({...})`.
- Shipping it means it is in the published tarball and in the support surface. A user can run it and
  file bugs about it.
- A mock that drifts from reality is worse than no mock. Mitigated by golden ndjson recordings keyed
  on the exact agent version (`recordings/<provider>@<version>/<case>.ndjson`), so a vendor bump
  produces a visible new directory rather than silently invalidating old goldens.

### Neutral

- It is deterministic by construction (`--seed`), which is what makes ledger snapshots stable enough
  to commit as fixtures.

## Alternatives considered

- **Mock `child_process.spawn` / the adapter module.** Rejected: it tests the mock. It cannot
  exercise ndjson framing, backpressure, the frame cap, the timeout path, or process-group kill —
  and the `detached: true` finding above is unreachable without real processes.
- **Recording and replay only** (item 10 without items 1–9). Cheaper, and retained as a supplement —
  it is the flag-churn detector. Rejected as the whole answer: recordings only contain behaviour
  already observed, so they cannot produce the pathological cases (hang, mid-turn crash, oversized
  frame) that the durability design exists to handle.
- **Test-only, in `devDependencies`.** Rejected on the three shipped-reasons above; F3.7 alone
  settles it.
- **Integration tests against real CLIs only.** Rejected: costs money and quota per run, is
  nondeterministic, and cannot run in CI where no credentials exist. Retained as a nightly `@live`
  tagged suite, not as the inner loop.

## Revisit when

Two checkable triggers:

1. **An official ACP conformance kit appears.** **Verified negative 2026-08-02**: the spec repo has
   no `conformance/`, `compliance/` or `tests/` directory, and `@agentclientprotocol/conformance`,
   `acp-conformance` and `@agentclientprotocol/test-kit` all 404 on npm. (Be warned: web search
   asserts one exists — that is a conflation with an unrelated academic "Agent Control Protocol".)
   If a real one ships, the _behavioural_ half of the mock's job may be replaceable; the
   pathological-case half (hang, mid-turn crash, 10 MB frame, fake capability profiles) almost
   certainly will not be.
2. **ACP v2 lands** ([ADR 0004](./0004-acp-first-adapter-layer.md)'s trigger). v2 removes `fs/*` and
   `terminal/*` from the client, so mock-agent items 4 and the corresponding client handlers both
   move to MCP. The mock must be updated in the same change as the client, or it will silently
   validate a protocol nobody speaks.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
