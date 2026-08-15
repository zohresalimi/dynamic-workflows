# EPIC-00: Foundation spikes

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-00-foundation-spikes-flows.md)

|                      |                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Epic ID**          | EPIC-00                                                                                                                                                                                                                                                                                                                                                      |
| **Status**           | Not started                                                                                                                                                                                                                                                                                                                                                  |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                                                                           |
| **Milestone**        | M0                                                                                                                                                                                                                                                                                                                                                           |
| **Workstream**       | M0 (see [roadmap §1](../../17-roadmap.md))                                                                                                                                                                                                                                                                                                                   |
| **Size**             | ~7.5 days across 7 stories (roadmap budgets 8–10 working days)                                                                                                                                                                                                                                                                                               |
| **Depends on**       | —                                                                                                                                                                                                                                                                                                                                                            |
| **Blocks**           | EPIC-01, and through it every other epic; directly also EPIC-03 (spike S5), EPIC-05 (spike S1) and EPIC-16 (spikes S3, S4)                                                                                                                                                                                                                                   |
| **PRD requirements** | F3.1, F3.2, F3.4, F3.5, F6.9, F9.1, F10.1, F10.2, F10.5, NF3, NF5, NF6, AR-1; PRD §11 M0 kill criterion                                                                                                                                                                                                                                                      |
| **Architecture**     | [17-roadmap.md §1](../../17-roadmap.md) (the seven spikes and the open-risks register), with supporting detail in [02-tech-stack.md](../../02-tech-stack.md), [03-local-development.md](../../03-local-development.md), [07-provider-adapter-layer.md](../../07-provider-adapter-layer.md), [12-frontend-architecture.md](../../12-frontend-architecture.md) |

## Goal

At the end of this epic every load-bearing assumption in the DeFlow architecture that was
_reasoned about but never executed_ has either been executed and recorded, or has been replaced by
its documented fallback. The deliverable is not code — it is seven decisions, each backed by a
re-runnable command or a measured number, plus one explicit go/no-go against the PRD's M0 kill
criterion. Nothing in EPIC-01 onwards starts until KAR-00.7 records a **GO**.

## Why this matters

The architecture documents mark specific claims **Unverified**, and the roadmap's open-risks
register (§6) grades four of them **Critical** or **High**: A0-1 (no full ACP prompt cycle has ever
been completed against any agent), A2-1 (Node's "no TypeScript inside `node_modules`" rule versus
pnpm's workspace symlinks — the single load-bearing assumption in the entire dev loop), A3-4 (elkjs
in a Vite 8 worker), and A1-1/A1-2 (every fsync benchmark ran on Linux; only `linux-x64` prebuilds
were ever executed). Each of these costs a day to test now and a fortnight to discover in month
three. A0-1 is worse than that: if the ACP prompt cycle does not work and the CLI shims are
unstable across two vendors, the provider-neutrality thesis — the thing that makes DeFlow legal
under AR-1 and different from every tool in PRD §4 — needs rethinking, and the correct action is to
stop rather than build eleven more epics on top of it.

The rule the roadmap sets for this epic, and the reason the flow file exists: **a spike is done
when it has produced either a working command you can re-run, or a written reason why the plan
changes. A spike that ends in "seems fine" has not run.**

## Scope

**In scope:**

- The seven M0 spikes from [roadmap §1](../../17-roadmap.md): S1 ACP round trip, S2 zero-build dev
  loop, S3 elkjs in a Vite worker, S4 Vite middleware mode with SSE and HMR on one port, S5
  better-sqlite3 prebuilds and the APFS fsync benchmark, S6 `@lydell/node-pty` platform coverage,
  S7 Biome's Vue formatter. (S5 and S6 are combined into KAR-00.5 — both are "does the native
  prebuild load on the machines we ship to".)
- A committed, re-runnable throwaway harness per spike under `spikes/<id>/`, outside the workspace
  globs so it never enters `pnpm -r` or the typecheck graph.
- A decision note per spike under `docs/spikes/S<n>-<slug>.md`, in a fixed shape: question,
  timebox, what was run, what was measured, decision, fallback taken or not taken, which open-risk
  id it closes.
- The first generated capability-matrix fixture (`fixtures/capabilities/<agent>@<version>.json`),
  which is the one artefact from this epic that survives into production use.
- The go/no-go decision itself, recorded as a dated note.

**Out of scope:**

- Any production code. Every spike directory is deleted or archived when EPIC-01 starts; the only
  things that carry forward are the decision notes and the capability fixture.
- The real ACP client, adapter registry and conformance suite — EPIC-05.
- The mock agent binary — EPIC-04. S1 talks to _real_ vendor adapters precisely because that is the
  thing a mock cannot verify.
- The real `vitest.config.ts`, `biome.json`, `.oxlintrc.json`, `lefthook.yml` and CI workflow —
  EPIC-01. S7 produces the _decision_ about Biome's `.vue` handling; EPIC-01 wires it into the hook.
- The real Vue Flow / ELK graph canvas — EPIC-16 (KAR-16.6). S3 answers "does it build", not
  "is it fast enough"; the 400-node measurement belongs in week one of W10.
- Windows. NF5 puts it at M3; the process-tree-kill spike is an M2 item (roadmap §4, A0-10).

## Definition of Ready (epic level)

- [ ] Node 24 and Node 26 are both installed and selectable (`fnm`/`nvm`/`mise`), because S2 and
      S5's matrices span both.
- [ ] `pnpm@11.18.0` installed via `npm i -g pnpm@11`. **Not** `corepack enable` — Corepack was
      removed from Node 25+ distributions.
- [ ] `git >= 2.38` (`merge-tree --write-tree` exists), preferred `>= 2.45`.
- [ ] At least two agent CLIs installed and authenticated on the author's own machine, under the
      author's own account, per AR-1: `@agentclientprotocol/claude-agent-acp@0.64.1` (the adapter
      path) and `gemini --acp` 0.53.1 (the cheapest native-ACP agent to authenticate).
- [ ] `docs/spikes/` exists with a `TEMPLATE.md` carrying the decision-note shape.
- [ ] A calendar timebox is agreed per spike, and the author has accepted that overrunning one is
      itself a recordable outcome.

## Definition of Done (epic level)

- [ ] All seven stories are `Done`.
- [ ] Every scenario in [the flow file](../flows/EPIC-00-foundation-spikes-flows.md) has been
      **executed and its outcome recorded**. Scenarios marked `Automated at: integration` or
      `contract` have additionally been committed as a re-runnable script under `spikes/`; the rest
      are recorded as measurements in the decision note. (Unlike every later epic, "the scenarios
      pass as automated tests" is not the bar here — an M0 scenario whose Then clause is
      "the fallback is adopted and recorded" passes by being answered, not by being green.)
- [ ] Every decision note names the open-risk id it closes, and the risk is struck through in a
      copy of [roadmap §6](../../17-roadmap.md) held in the note.
- [ ] These `Unverified` claims from the architecture docs are no longer unverified: A0-1, A0-3,
      A0-6, A1-1, A1-2, A2-1, A2-3, A3-4, A3-5, A4-2, and the runtime (not type-declaration)
      behaviour of `vite@8.2.0`'s `middlewareMode: { server }`.
- [ ] `fixtures/capabilities/` contains one generated file per probed agent, keyed on exact
      version, and **no capability constant appears in source anywhere**.
- [ ] KAR-00.7's go/no-go note is dated, signed and committed, and the board reflects it.

## User stories

### KAR-00.1 — Spike: ACP client completes a full prompt cycle against a real adapter

|                 |                                                                                     |
| --------------- | ----------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                         |
| **Priority**    | P0                                                                                  |
| **Size**        | L                                                                                   |
| **Depends on**  | KAR-00.2                                                                            |
| **PRD**         | F3.1, F3.4, F3.5, F6.9, F9.1, F10.5, AR-1                                           |
| **Verified by** | EPIC-00-S4, EPIC-00-S5, EPIC-00-S6, EPIC-00-S7, EPIC-00-S8, EPIC-00-S9, EPIC-00-S10 |

**As** the author, **I want** one throwaway script that drives a real ACP agent through
`initialize` → `session/new` → `session/prompt` → streamed `session/update` →
`session/request_permission` → `session/cancel`, **so that** the riskiest assumption in the project
— that ACP-first is a real integration path and not a spec-reading exercise — is settled before
eleven epics are built on it.

**Timebox: 4 working days.** The question: _can DeFlow, acting as an ACP client, complete a full
prompt cycle against a community adapter and against a natively-ACP agent, with streaming that
actually streams, permission mediation that actually reaches the client, and cancellation that does
not deadlock?_ The research verified `initialize` handshakes live against all five entry points on
2026-08-02 and confirmed all five negotiate wire `protocolVersion: 1` — but it never completed a
prompt cycle against any of them, because that costs vendor credits and needs each vendor's auth.
Everything past `initialize` is design-verified from `@agentclientprotocol/sdk@1.3.0`'s types and
its shipped `schema/schema.json` (262 `$defs`), not runtime-verified. This story closes A0-1, and
answers A0-3 (does ACP surface token usage or compaction at all?) and A4-2 (is `structured_output`
actually populated on success?) while the harness is warm.

Run against **two** agents, and the choice is deliberate:
`@agentclientprotocol/claude-agent-acp@0.64.1` because Claude Code does not speak ACP natively
(verified absent from `claude --help` v2.1.220) and the community _adapter_ is the real risk
surface (A0-2); and `gemini --acp` 0.53.1 because it is a native-ACP agent and the cheapest to
authenticate.

**Artefact left behind:** `spikes/s1-acp/run.ts` (re-runnable, takes `--agent`),
`fixtures/capabilities/claude-agent-acp@0.64.1.json` and
`fixtures/capabilities/gemini-cli@0.53.1.json` (generated, never hand-written — these become the
first version of the capability matrix fixture that EPIC-05 consumes), and
`docs/spikes/S1-acp-round-trip.md`.

**If it fails:** record precisely _which_ step failed for _which_ agent. Failure of the streaming,
permission or cancellation steps on **both** agents is half of the kill criterion and feeds
directly into KAR-00.7. Failure on the adapter but not the native agent is an A0-2 finding, not a
kill — it means the shim path (F3.2) carries more weight than the architecture assumed, and EPIC-05
re-weights KAR-05.8 accordingly.

**Acceptance criteria**

1. For each of the two agents, a single command completes all six steps and prints a table of what
   was observed at each.
2. `initialize` returns `protocolVersion: 1` and the full `agentCapabilities` block is written
   verbatim to a fixture file keyed on the agent's exact version.
3. `session/new` returns a session id, and DeFlow's own stdio MCP server is accepted in
   `mcpServers` without error.
4. **At least three** `session/update` notifications arrive incrementally — proven by client-side
   receipt timestamps whose spread exceeds 500 ms, not by eyeball and not by counting the frames
   after the fact.
5. `session/request_permission` reaches the client, and a `reject_once` outcome is honoured by the
   agent rather than ignored.
6. `session/cancel` produces a prompt response with `stopReason: 'cancelled'`, **and** the client
   continues to accept the trailing `session/update` notifications the agent flushes afterwards
   without deadlocking. This is the specific failure mode the kill criterion names.
7. The note answers, in one line each with evidence: does ACP surface token usage? does it surface
   compaction state? is `structured_output` populated on a success result?
8. The two known footguns are confirmed in this harness: `claude -p --output-format stream-json`
   exits with an error unless `--verbose` is also passed; and the SDK's `LineBuffer` has no maximum
   line length, so an agent that never emits `\n` grows it without bound. The harness imposes its
   own cap and records the value chosen.

**Test plan (TDD)** — for a spike, "red" means _the observation that would change the plan_. Write
the assertion before running the agent, so a pass is a pass and not a story told afterwards.

| #   | Level               | Test                                                                                                                                                                                | Red when                                                                                                                                     |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | contract (spike)    | Every received frame validates against `@agentclientprotocol/sdk/schema/schema.json` with `ajv`                                                                                     | Any frame fails validation → the SDK's types and the wire disagree; adapter work is larger than scoped                                       |
| 2   | integration (spike) | `initialize` → assert `protocolVersion === 1` and snapshot `agentCapabilities` to the fixture path                                                                                  | The negotiated version is not 1, or capabilities differ from the 2026-08-02 probe                                                            |
| 3   | integration (spike) | Collect `{receivedAt}` per `session/update`; assert `count >= 3 && max-min > 500ms`                                                                                                 | Frames arrive in one burst at turn end → streaming is a fiction and F10.6/F10.1 lose their premise                                           |
| 4   | integration (spike) | Respond `reject_once` to `session/request_permission`; assert the agent does not perform the action                                                                                 | The agent proceeds anyway → permission mediation does not reach the client (kill-criterion input)                                            |
| 5   | integration (spike) | Send `session/cancel` mid-turn; assert `stopReason: 'cancelled'` within 5 s **and** that ≥1 trailing `session/update` is accepted afterwards without the client's read loop wedging | The promise never settles → cancellation deadlocks (kill-criterion input)                                                                    |
| 6   | manual              | Grep the full recorded frame log for any token/usage/compaction-shaped field                                                                                                        | Nothing found → `tokenAccounting: 'none'` on the ACP path; F9.1 and F10.5 degrade honestly and that trade is now known, not discovered in W6 |
| 7   | integration (spike) | Run a prompt whose result should carry `structured_output`; assert the field is present and non-null                                                                                | Absent → F6.9's handoff-contract validation cannot lean on the vendor and needs its own repair loop                                          |
| 8   | integration (spike) | Feed the client a 10 MB frame with no trailing newline through the harness's own transport                                                                                          | Memory grows unbounded → confirms the `LineBuffer` footgun and fixes the cap value used from EPIC-05 onward                                  |

**Notes / risks** — This is the only spike that spends real vendor quota. Run it once, record
everything (`DeFlow_RECORD=1`-style tee at the transport, raw bytes, never the parsed
interpretation), and replay from the recording for every re-run. The recordings become the seed of
`recordings/<provider>@<exact-version>/` that EPIC-05's golden suite uses. AR-1 applies to the
spike as strictly as to production: the harness reads no token file, sets no auth environment
variable, and spawns the vendor binary under the author's own account.

---

### KAR-00.2 — Spike: zero-build dev loop through pnpm workspace symlinks

|                 |                                    |
| --------------- | ---------------------------------- |
| **Status**      | Ready                              |
| **Priority**    | P0                                 |
| **Size**        | S                                  |
| **Depends on**  | —                                  |
| **PRD**         | NF5, NF6                           |
| **Verified by** | EPIC-00-S1, EPIC-00-S2, EPIC-00-S3 |

**As** the author, **I want** to prove that `node packages/daemon/src/main.ts` can import a sibling
workspace package whose `exports` field points at `./src/index.ts`, **so that** the entire dev story
in [03-local-development.md](../../03-local-development.md) — no build step, no watch-build chain,
no stale `dist/`, goto-definition landing on real code — rests on an executed fact rather than a
plausible chain of reasoning.

**Timebox: half a day, and run it first.** The question: _does Node type-strip a `.ts` file that is
resolved through a pnpm workspace symlink inside `node_modules`?_ Node refuses to type-strip `.ts`
files resolved inside `node_modules`, and pnpm workspace links **are** symlinks in `node_modules`.
Node normally resolves the realpath first, which should make it work — but this was reasoned about,
never executed (A2-1, graded **High**). It is the one load-bearing assumption in the entire dev
loop, and it also decides how every other spike in this epic is written, which is why it goes
first.

**Artefact left behind:** `spikes/s2-zero-build/` containing two throwaway packages `a` and `b`
wired exactly as `packages/daemon` → `packages/core` will be, a `run.sh` that executes the matrix,
and `docs/spikes/S2-zero-build.md` recording the result per Node major.

**If it fails:** the fallback is `tsx@4.23.4` in watch mode, and — importantly — the dev-loop
document changes _before_ it is written into muscle memory. The `dev` script becomes
`tsx watch packages/daemon/src/main.ts`, KAR-01.3's acceptance criteria change, and the note
records that `node --watch` is no longer the crash-resume test described in
[03-local-development.md §5](../../03-local-development.md).

**Outcome (2026-08-04): it did not fail.** The fallback above was not taken, so EPIC-00-S2 — the
scenario that specifies it — is **not applicable** and is not automated; its Given never held. The
`Verified by` row still lists it because the scenario still exists and would become live if the
package layout ever stopped being symlinked. What is automated in its place is the counterfactual
(the `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` refusal is real, and the pnpm symlink is what
avoids it). See [`docs/spikes/S2-zero-build.md`](../../spikes/S2-zero-build.md) and the Outcome
note on EPIC-00-S2 in
[the flow file](../flows/EPIC-00-foundation-spikes-flows.md#epic-00-s2--type-stripping-is-refused-inside-node_modules-and-the-tsx-fallback-is-adopted).

**Acceptance criteria**

1. Package `b` declares `"exports": { ".": "./src/index.ts" }` and is consumed by `a` via
   `"@spike/b": "workspace:*"`, matching the real layout exactly — not a hand-made symlink.
2. After `pnpm install`, `node a/src/main.ts` prints a value produced by `b` on **both Node 24 and
   Node 26**.
3. The same holds for `vitest`, `vite` and `tsc -b` resolving across the boundary — a dev loop that
   works for `node` but breaks the test runner is not a dev loop.
4. `b`'s source contains only `erasableSyntaxOnly`-legal syntax; a second, deliberately illegal
   variant (`enum`) is run and its failure is recorded, confirming why D4 is permanent.
5. The `publishConfig` exports-override from
   [16-repo-layout.md §3](../../16-repo-layout.md) is present on `b` and `pnpm pack` on `b`
   produces a tarball whose `exports` point at `dist/`, not `src/` — the belt-and-braces half of
   the trick is verified, not assumed.
6. The decision note states, explicitly, "adopt `node --watch`" or "adopt `tsx@4.23.4` watch", and
   which of KAR-01.3's acceptance criteria change if it is the latter.

**Test plan (TDD)**

| #   | Level               | Test                                                                                       | Red when                                                                                                                                                                            |
| --- | ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration (spike) | `node a/src/main.ts` under Node 24 exits 0 and stdout matches the expected string          | Exit is non-zero with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` → realpath resolution does not save us; take the `tsx` fallback                                                 |
| 2   | integration (spike) | The same under Node 26                                                                     | Behaviour differs across majors → the dev loop is version-fragile and `.node-version` becomes load-bearing rather than convenient                                                   |
| 3   | integration (spike) | `vitest run` in `a` imports from `b` and passes; `tsc -b` typechecks the two-project graph | The runner or the compiler resolves differently from `node` → three tools, three resolution stories, and the "one source of truth" claim dies                                       |
| 4   | integration (spike) | Add `enum Status { Ok }` to `b/src/index.ts` and rerun                                     | It _succeeds_ → the runtime is more permissive than documented; still ban it, because `--experimental-transform-types` was removed in Node 26.0.0 and there is no escape hatch left |
| 5   | manual              | `pnpm pack` on `b`; inspect the tarball's `package.json` `exports`                         | It still points at `./src/index.ts` → `publishConfig` is not being applied and the published-package story is wrong                                                                 |

**Notes / risks** — Half a day, and it unblocks everything. If it is going to fail, failing on a
Tuesday morning in week one is the cheapest possible outcome.

---

### KAR-00.3 — Spike: Vite middleware mode carrying SSE and HMR on one port

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-00.2                              |
| **PRD**         | NF3, NF10, F10.1, F10.6, F4.4         |
| **Verified by** | EPIC-00-S11, EPIC-00-S12, EPIC-00-S13 |

**As** the author, **I want** one Node process on port 7777 that simultaneously holds a
ten-minute SSE stream open with events arriving individually and hot-reloads a `.vue` edit,
**so that** D10 — Vite in middleware mode inside `DeFlowd`, no proxy, no CORS, no second port — is
a demonstrated property rather than a type-declaration reading.

**Timebox: 1 day** (roadmap labels this M at 1 day; on this backlog's scale a one-day spike is S).
The question: _does `vite@8.2.0`'s `middlewareMode: { server }` actually attach HMR to the
daemon's own `node:http` server, and does an SSE route on that same server survive ten minutes
without buffering or dying?_ The `middlewareMode?: boolean | { server: HttpServer }` signature was
verified on 2026-08-02 from vite 8.2.0's bundled type declarations, where `server` is documented as
_"Parent server instance to attach to. This is needed to proxy WebSocket connections to the parent
server"_. That is a **type**, not a runtime observation. The whole UI is an SSE projection of the
ledger, so if this does not hold, the dev loop needs a proxy — and Vite's dev proxy is
documented-bad at SSE in exactly three ways ([03-local-development.md §4.3](../../03-local-development.md)):
events buffer and arrive in one burst at stream end, long streams hit socket timeouts, and close
events do not propagate back to the backend.

The second half of the same day settles the resume contract, which is a separate verified fact with
its own consequence: `EventSource` sends `Last-Event-ID` **only on automatic reconnect**, never on
a fresh `new EventSource()` after a page reload, and it cannot set custom headers at all
(**verified 2026-08-02**). So the endpoint must also accept `?since=<seq>`, and this spike proves
the reload path loses no events.

**Artefact left behind:** `spikes/s4-one-port/` with a `server.ts` (Hono + `@hono/node-server` +
Vite middleware), a `client.mjs` that records per-event client-side receipt timestamps to a CSV,
and `docs/spikes/S4-one-port.md` carrying the measured inter-arrival distribution.

**If it fails:** the fallback is two ports with a documented proxy configuration
(`timeout: 0`, `proxyTimeout: 0`, `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`,
no compression middleware on the stream route) — and the note must say plainly that the dev loop
now differs structurally from production routing, which is the class of bug D10 exists to delete.

**Acceptance criteria**

1. Exactly one `node` process listens on 127.0.0.1:7777 and serves the SSE route, the API and the
   UI. `lsof`/`ss` shows one listening socket, not two.
2. The SSE endpoint emits one event per second for **ten minutes**; the client-recorded receipt
   timestamps show 600 events with inter-arrival gaps clustered at ~1000 ms and **no gap greater
   than 3 s** — measured from the CSV, not by watching a terminal.
3. Editing a `.vue` file during that stream hot-reloads the module in the browser **without the SSE
   connection closing** — the event sequence has no gap and no reconnect.
4. `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` are present on the SSE
   response, and no compression middleware sits in front of that route.
5. Reloading the page mid-stream and re-hydrating via `?since=<seq>` loses no events and duplicates
   none, and the harness confirms the browser sent **no** `Last-Event-ID` header on that fresh
   connection.
6. The route mount order is proven to matter: the API route is registered before the SPA fallback,
   and a test request to `/api/stream` never reaches Vite's middleware.

**Test plan (TDD)**

| #   | Level               | Test                                                                                                                                  | Red when                                                                                                                                         |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | integration (spike) | Boot the harness; assert a single listening socket on 7777                                                                            | A second port appears → Vite opened its own HMR server; `middlewareMode: { server }` is not doing what the type says                             |
| 2   | e2e (spike)         | Run the 10-minute stream; assert `events.length === 600` and `max(gap) < 3000ms` from the client CSV                                  | Events arrive in one burst, or the stream dies at N minutes → buffering or a socket timeout; the fallback proxy config becomes mandatory reading |
| 3   | e2e (spike)         | Touch a `.vue` file at t=300 s; assert an HMR update reaches the browser **and** the SSE `EventSource.readyState` never leaves `OPEN` | The stream drops on reload → HMR and SSE cannot share the server and D10 is wrong                                                                |
| 4   | integration (spike) | Assert response headers on `/api/stream`                                                                                              | `Content-Encoding` present, or `no-transform` missing → something is compressing the stream                                                      |
| 5   | e2e (spike)         | Reload the page at t=120 s; capture the request headers of the new `EventSource`                                                      | `Last-Event-ID` is present → the verified browser behaviour has changed; re-check before dropping `?since=`                                      |
| 6   | integration (spike) | Register the SPA fallback first, on purpose, and assert `/api/stream` returns HTML                                                    | It returns the stream anyway → mount order does not matter here and the note says so                                                             |

**Notes / risks** — Ten minutes of wall clock per attempt makes this spike slower than its size
suggests; run the long stream once, in the background, while doing the header and mount-order
checks.

---

### KAR-00.4 — Spike: elkjs in a Vite 8 web worker

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-00.2                              |
| **PRD**         | F10.1, F10.2                          |
| **Verified by** | EPIC-00-S14, EPIC-00-S15, EPIC-00-S16 |

**As** the author, **I want** a `vite build` — not a `vite dev` — of a scratch app that lays out a
60-node graph off the main thread, **so that** the plan graph (F10.1) and the plan-evolution
scrubber (F10.2, the marquee feature) rest on a layout engine that is known to bundle rather than
one that is known to be awkward.

**Timebox: 1 day.** The question: _does `elkjs@0.12.0` load in a Vite 8 worker, in a production
build, served from `dist/` by the daemon?_ elkjs is GWT-transpiled Java; its own README
acknowledges bundler friction, and its documented `workerUrl` option assumes a publicly-served path
that does not survive Vite's asset hashing. The plan is Vite's `?worker` import plus ELK's
`workerFactory`, and it is **Unverified** — the research could not run a build (A3-4, graded
**High**).

While the harness is warm, settle the layout-pinning question too. The commonly-written
`layerChoiceConstraint` / `positionChoiceConstraint` recipe **will not work**: those options are
consumed only when `org.eclipse.elk.interactiveLayout=true`, `semiInteractive` reads
`org.eclipse.elk.position` rather than `positionChoiceConstraint`, and constraint enforcement is a
known elkjs weak spot (A3-5). The **union-graph-laid-out-once** approach is the primary mechanism
for the scrubber; the interactive constraints are an experiment. Prove the union-graph approach
here, on a synthetic 5-version plan.

**Artefact left behind:** `spikes/s3-elk-worker/` with the scratch app and a `check.mjs` that
asserts on the built `dist/` manifest, plus `docs/spikes/S3-elk-worker.md` recording the initial
chunk size with and without ELK, and the union-graph result on the 5-version synthetic plan.

**If it fails:** `@dagrejs/dagre@3.0.0` for the live graph, with ELK on the main thread only for
the scrubber's cached layouts, where a slower synchronous call is acceptable. Note for whoever
copies example code later: the Vue Flow docs' repl pins `@dagrejs/dagre@1.1.2`, two majors behind
3.0.0, so the API surface in copied snippets is older than the version you will install.

**Acceptance criteria**

1. `vite build` succeeds and emits a hashed worker chunk; the app then runs **from the built
   `dist/` served over HTTP**, not only from the dev server.
2. ELK (~1.6 MB) is **absent from the initial chunk** — proven by reading the built chunk's size and
   contents, with the before/after numbers written into the note.
3. A 60-node graph is laid out with the main thread demonstrably free: a main-thread heartbeat
   counter continues ticking across the layout call.
4. A synthetic 5-version plan is laid out **once as a union graph**, and stepping v1→v5 keeps every
   surviving node at a stable position — no re-layout jump between versions.
5. The `layerChoiceConstraint` / `positionChoiceConstraint` recipe is tried and its actual behaviour
   recorded, so nobody re-tries it in W11 on the strength of a blog post.
6. The note states which of `elkjs` or `@dagrejs/dagre` EPIC-16's `GraphCanvas` facade
   (KAR-16.6) is built against.

**Test plan (TDD)**

| #   | Level               | Test                                                                                                                                                           | Red when                                                                                               |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | integration (spike) | `vite build` then assert a `*.worker-*.js` asset exists in `dist/assets/`                                                                                      | No worker chunk emitted → `?worker` + `workerFactory` did not wire up; take the dagre fallback         |
| 2   | integration (spike) | Assert the entry chunk's byte size is within 100 KB of the same build with ELK removed                                                                         | ELK is in the initial chunk → 1.6 MB on first paint, against NF3's "UI interactive < 1 s"              |
| 3   | browser (spike)     | Serve `dist/` over plain HTTP; run the 60-node layout; assert coordinates are returned and a main-thread `setInterval` counter advanced by ≥ 5 during the call | Layout throws under the built asset paths → the `workerUrl` hashing problem is real                    |
| 4   | browser (spike)     | Lay out the union of five plan versions once; assert node positions are byte-identical across the five rendered versions                                       | Positions move → the scrubber jumps on every step and F10.2 needs a different mechanism                |
| 5   | browser (spike)     | Set `layerChoiceConstraint` without `interactiveLayout: true`; assert it is ignored                                                                            | It works → the research's finding is wrong for 0.12.0; record that and keep it as an experiment anyway |

**Notes / risks** — This spike answers "does it build", not "is it fast enough". The performance
question — Vue Flow's ceiling, currently an **estimate extrapolated from React Flow guidance and
Unverified** (A3-2) — is measured in week one of W10 against a 400-node fixture, and it is that
measurement, not this one, that decides whether the memory/data-flow view (F10.4) survives to M1.

---

### KAR-00.5 — Spike: native prebuilds load on the target machines

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-00.2                              |
| **PRD**         | NF4, NF5, NF6, F4.1, F4.2             |
| **Verified by** | EPIC-00-S17, EPIC-00-S18, EPIC-00-S19 |

**As** the author, **I want** both native dependencies proven to install and load with **zero
compilation** on the machines DeFlow will actually run on, and the ledger's fsync cost measured on
APFS, **so that** `npx deflowai up` (NF6) does not fail on a toolchain-less laptop and the
`synchronous=` setting is picked from a number measured on the machine that will run it.

**Timebox: 1 day** — roadmap S5 (2 hours) plus S6 (half a day), combined because they answer the
same question with the same harness. The questions: _do `better-sqlite3@13.0.2`'s darwin prebuilds
actually execute?_ and _does `@lydell/node-pty@1.2.0-beta.14` cover the platform matrix?_
better-sqlite3 v13 migrated to N-API and ships 8 prebuilt binaries in the npm tarball
(`prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`) with `gypfile: false` and no install
script; `npm i` completed in **1 second** with zero compilation — **verified 2026-08-02 on
linux-x64 only** (A1-2). The darwin binaries are demonstrably in the tarball but were never
executed. `@lydell/node-pty` installed in **514 ms** with zero compilation, but it is at
`1.2.0-beta.14`, a beta of a community fork, and it is the single remaining native-install risk for
`npx deflowai up` (A0-6).

Every fsync-sensitive number in [05-durable-execution.md](../../05-durable-execution.md) —
**979 ev/s at `synchronous=FULL` versus 22,982 ev/s at `NORMAL`** — was measured on Linux, likely
on overlayfs. macOS uses `F_FULLFSYNC` and is typically _slower_ for fsync (A1-1). The relative
shape should hold; the absolute numbers must be re-measured.

**Artefact left behind:** `spikes/s5-native/` with `probe.mjs` and `bench.mjs`, a results CSV per
machine, and `docs/spikes/S5-native-prebuilds.md` carrying the install matrix table and the chosen
`synchronous=` value with its justification.

**If it fails:** a `better-sqlite3` failure on darwin is serious — it forces either a build-from-
source prerequisite (which contradicts NF6) or an early move to the `Db` port's alternative
implementation, and the note says which. A `@lydell/node-pty` gap is survivable and the fallback is
already designed: **no agent process needs a TTY** — ACP and every headless mode are pure pipe
protocols, verified across five agents — so a pty is needed only for DeFlow's own ACP `terminal/*`
implementation. A missing matrix leg becomes either a documented prerequisite or a no-TTY fallback
path where `terminal/*` is simply not advertised as a client capability.

**Acceptance criteria**

1. On the author's own macOS laptop: `npm i better-sqlite3@13.0.2` completes with **no compilation
   step in the output**, no `node-gyp`, no `prebuild-install` network fetch.
2. `SELECT sqlite_version()` returns `3.53.4`; an FTS5 table creates successfully and `bm25()`
   ranks results; `db.loadExtension` is present on the instance.
3. The append benchmark is re-run on APFS at `synchronous=FULL` and `synchronous=NORMAL`, single-
   append and batched, and the four numbers are recorded next to the Linux baseline
   (979 / 22,982 ev/s) with the ratio computed.
4. The note names the `synchronous=` value DeFlow will ship with, and the reason, in one sentence.
5. `@lydell/node-pty@1.2.0-beta.14` installs with zero compilation and allocates a working
   `/dev/pts` on each cell of the matrix: macOS Apple Silicon × Node 24, macOS Apple Silicon ×
   Node 26, Linux glibc × Node 24, Linux glibc × Node 26, Linux musl × Node 24 — **on a box with no
   compiler installed**.
6. Any missing cell is written into the note as either a documented prerequisite or a no-TTY
   fallback, and never left as "probably fine".
7. Upstream `node-pty@1.1.0` is _not_ used anywhere and the note records why: its install script is
   `node scripts/prebuild.js || node-gyp rebuild`, it silently falls back to compiling, and it was
   verified to fail outright in a toolchain-less environment.

**Test plan (TDD)**

| #   | Level               | Test                                                                                                                                | Red when                                                                                                                                  |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration (spike) | Install into a clean tmpdir with `PATH` stripped of compilers; assert the install log contains no `gyp` line and completes in < 5 s | A compile is attempted → NF6 is broken on a fresh machine and the note must say so before EPIC-01 pins the dependency                     |
| 2   | unit (spike)        | `db.prepare('select sqlite_version() v').get()` returns `3.53.4`                                                                    | A different version → SQL behaviour drifts with the user's install, which is the exact reason `node:sqlite` was rejected                  |
| 3   | integration (spike) | Create an FTS5 table with `tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"`, insert, and `ORDER BY bm25(t)`             | FTS5 is absent → D15's retrieval design has no engine and the tokenizer decision (unchangeable after table creation) needs re-taking      |
| 4   | integration (spike) | Append 10,000 events at `synchronous=FULL` and at `NORMAL`, single and batched, on APFS; write ev/s to CSV                          | `FULL` on APFS is so slow that the durability setting becomes a product trade-off rather than a default — record it, do not paper over it |
| 5   | integration (spike) | Spawn a pty per matrix cell; assert a `/dev/pts/*` fd is allocated and echoes                                                       | Allocation fails on a cell → that platform gets the no-TTY fallback and `terminal/*` is not advertised there                              |
| 6   | manual              | `ls node_modules/better-sqlite3/prebuilds/` and record the filenames actually present                                               | The 8 prebuilds are not there → the tarball changed between 13.0.2 and whatever resolved                                                  |

**Notes / risks** — Linux musl needs a container to test, which is the one place this spike touches
Docker. That is acceptable: it is a test environment, not a runtime dependency, and NF6's "no
Docker requirement for the core" is about the user's machine.

---

### KAR-00.6 — Spike: Biome's Vue formatter on real SFCs

|                 |                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                         |
| **Priority**    | P0                                                                                                  |
| **Size**        | XS                                                                                                  |
| **Depends on**  | KAR-00.2                                                                                            |
| **PRD**         | NF6 (toolchain floor); roadmap risk A2-3. See the epic's Risks note on this story's weak PRD anchor |
| **Verified by** | EPIC-00-S20                                                                                         |

**As** the author, **I want** to see what `biome check --write` actually does to real Vue SFCs
before it is wired into a `stage_fixed: true` pre-commit hook, **so that** the hook cannot silently
auto-stage a bad rewrite, and cannot silently do nothing at all.

**Timebox: 3 hours.** The question: _is Biome 2.5.6's `.vue` formatting good enough to auto-apply,
and is the opt-in flag actually required?_ Biome's `.vue` support is not merely "experimental" — it
is **off by default**, gated behind
`"html": { "experimentalFullSupportEnabled": true, "formatter": { "enabled": true } }` in
`biome.json`. Without that flag, `biome check` **silently no-ops on `.vue` files**: a green run and
zero formatting. That silence is the hazard, because a pre-commit hook with `stage_fixed: true`
that quietly does nothing is worse than no hook — you pay the setup cost and get none of the
benefit, and you stop reading the diff.

While here, confirm the ownership split that keeps the two linters workable: **Biome formats,
`oxlint` lints**, enforced by `"linter": { "enabled": false }` in `biome.json`. Running both over
the same globs produces duplicate diagnostics and autofixes that fight each other across runs. Also
record two facts EPIC-01 depends on: type-aware linting went stable in **oxlint 1.75.0** (1.76.0 is
merely the current latest), and oxlint lints only the `<script>` block of a `.vue` file and will
never implement `eslint-plugin-vue`'s template rules.

**Artefact left behind:** a scratch branch `spike/s7-biome-vue` (not merged) with the before/after
diff, and `docs/spikes/S7-biome-vue.md` carrying the `git diff --stat` totals and a verdict on
whether `stage_fixed: true` is safe for `.vue`.

**If it fails:** the note records `stage_fixed: true` restricted to `*.{ts,json,jsonc,css,html}`
and `.vue` formatting left as a manual `pnpm format` step, or Prettier retained for `.vue` only —
and KAR-01.5's acceptance criteria change accordingly before the hook is written.

**Acceptance criteria**

1. With the `html` block **absent**, `biome check --write packages/web` reports success and
   `git status` shows **zero** changed `.vue` files. The silent no-op is demonstrated, not assumed.
2. With the `html` block present, the same command produces a diff, and `git diff --stat` is
   bounded and reviewed line by line.
3. The review specifically covers `<script setup>` blocks with complex generics and templates with
   long attribute lists — the two cases where SFC formatters break.
4. The note gives a one-word verdict on `stage_fixed: true` for `.vue`: safe, or not safe.
5. The Biome-formats / oxlint-lints split is confirmed by running both over one file and observing
   that no diagnostic appears twice and no autofix reverses another.

**Test plan (TDD)**

| #   | Level               | Test                                                                                              | Red when                                                                                                                               |
| --- | ------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration (spike) | Run `biome check --write` with no `html` block; assert `git diff --name-only -- '*.vue'` is empty | It formats anyway → the flag is no longer required in 2.5.6; record the version where behaviour changed                                |
| 2   | manual              | Read the whole diff produced with the flag on                                                     | Any rewrite changes semantics, mangles a generic, or reflows a template unreadably → `stage_fixed` is unsafe for `.vue`                |
| 3   | integration (spike) | Enable Biome's linter _and_ oxlint over the same file; count diagnostics                          | Duplicates appear → confirms `"linter": { "enabled": false }` is load-bearing, not stylistic                                           |
| 4   | integration (spike) | `oxlint` a `.vue` file with an unused component registration                                      | It reports nothing → confirms oxlint sees only `<script>`; template rules need ESLint, which is a separate decision deferred out of M1 |

**Notes / risks** — Three hours. The reason it is in M0 rather than EPIC-01 is ordering: the hook
is written in KAR-01.6, and a formatter that auto-stages a bad rewrite is the worst possible
combination to discover after fifty commits.

---

### KAR-00.7 — Record spike outcomes and take the go/no-go decision against the kill criterion

|                 |                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                  |
| **Priority**    | P0                                                                                                           |
| **Size**        | XS                                                                                                           |
| **Depends on**  | KAR-00.1, KAR-00.2, KAR-00.3, KAR-00.4, KAR-00.5, KAR-00.6                                                   |
| **PRD**         | F3.1, F3.2, AR-1; PRD §11 M0 kill criterion; PRD §13 risks "Provider ToS shifts again" and "Scope explosion" |
| **Verified by** | EPIC-00-S10, EPIC-00-S21, EPIC-00-S22, EPIC-00-S23                                                           |

**As** the author, **I want** the seven spike outcomes consolidated into one dated decision record
that either authorises EPIC-01 or stops the project, **so that** the largest decision in the whole
build is taken deliberately, once, against a pre-agreed criterion — rather than drifting past it
because eleven epics were already sketched.

**Timebox: half a day.** This story restates the kill criterion, applies it, and records the
answer.

> **Kill criterion (PRD §11, restated and sharpened in [roadmap §1](../../17-roadmap.md)).** If S1
> shows that ACP integration is impractical — the adapters cannot complete a prompt cycle reliably,
> permission mediation does not actually reach the client, or cancellation deadlocks — **and** CLI
> exec shims prove hopelessly unstable across two vendors, then the provider-neutrality thesis
> needs rethinking before anything else is built. That is the point at which to stop.

Two clarifications the research adds and this note must carry. First, the ACP adapters for Claude
Code and Codex are **community-maintained bridges, not first-party vendor implementations**, so
their fidelity to the underlying CLI is the main risk to the ACP-first thesis — which is why
KAR-00.1 tests the _adapters_, not only the natively-ACP agents (A0-2). Second, the PRD's separate
worry that ACP fragments because Microsoft ships a competitor has **largely retired**: Microsoft
shipped Intelligent Terminal 0.1 on 2 June 2026 with a native agent pane speaking ACP that
auto-detects Copilot, Claude Code, Codex CLI and Gemini CLI, and Microsoft's `agent-host-protocol`
is positioned as complementary — "AHP is a coordination layer. ACP is a communication layer. They
compose naturally". That risk drops Medium → Low in the register, and the remaining ACP risk is
adapter fidelity and v2 timing, not standards fragmentation.

**The decision is one of three**, and the note must pick exactly one:

| Decision            | Condition                                                                                                                            | Consequence                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GO**              | KAR-00.1's six steps completed on at least one agent, with permission mediation reaching the client and cancellation not deadlocking | EPIC-01 starts. Each of the other six spikes' fallbacks, where taken, is written into the affected epic's stories before that epic starts                 |
| **GO, re-weighted** | The ACP cycle works on the native agent but the community adapter is unreliable                                                      | EPIC-01 starts, and EPIC-05's KAR-05.8 (CLI exec shim fallback) is promoted from fallback to a first-class parallel path with its own conformance battery |
| **NO-GO**           | The ACP cycle is unreliable across both agents **and** a shim spike over two vendors is equally unstable                             | Stop. The note states what would have to change to revisit, and no EPIC-01 story is started                                                               |

Note that **none of the other six spikes is a kill criterion.** Each has a stated fallback; the
point of running them in M0 is that the fallback costs a day now and a fortnight later.

**Artefact left behind:** `docs/spikes/S0-go-no-go.md` — dated, listing all seven spikes with
outcome, decision, fallback-taken flag and closed-risk id; plus the board updated so every EPIC-01
story's blocker is cleared or not.

**If it fails:** "fails" here means the decision cannot be taken because a spike produced no
recorded outcome. That is not a reason to proceed on vibes — the spike is re-run, at its original
timebox, before the decision is taken.

**Acceptance criteria**

1. `docs/spikes/` contains exactly seven decision notes plus the go/no-go note, and every one has a
   filled-in _measurement_ section — not a prose impression.
2. The go/no-go note restates the kill criterion verbatim and states which of the three decisions
   was taken, with the specific evidence for it.
3. Every spike whose fallback was taken has the affected downstream story named by id (for example:
   "S2 failed → KAR-01.3 acceptance criteria 2 and 5 change; `dev` script becomes `tsx watch`").
4. Every open-risk id this epic was meant to close (A0-1, A0-3, A0-6, A1-1, A1-2, A2-1, A2-3, A3-4,
   A3-5, A4-2) is listed with either "closed" and a pointer to the measurement, or "still open" and
   the reason.
5. `fixtures/capabilities/` contains generated files, and a grep of the repo shows **no hardcoded
   capability matrix** — a hardcoded matrix is wrong within a month, and two of the five versions
   probed on 2026-08-02 were published the same day they were probed (A0-9).
6. The note carries a date and is committed. On a NO-GO, the board's EPIC-01 row is set to
   `Blocked` with this note as the blocker.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                   | Red when                                                                                                                                                                   |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration | A script asserts one `docs/spikes/S<n>-*.md` exists per spike and each contains a non-empty `## Measurement` and `## Decision` section | A note is missing a measurement → that spike "ended in seems fine" and must be re-run                                                                                      |
| 2   | integration | Grep `packages/` and `spikes/` for a literal capability object (`supportsResume`, `sessionCapabilities` as source constants)           | A constant is found → the fixture-not-constant rule (F3.5) is already being broken in week one                                                                             |
| 3   | unit        | Parse each note's `closes:` front-matter and assert the union covers the ten risk ids this epic owns                                   | A risk id is unclaimed → it silently survives into M1 as an unowned assumption                                                                                             |
| 4   | manual      | Read the go/no-go note against the kill criterion text side by side                                                                    | The decision does not follow from the recorded evidence → the criterion is being rationalised past, which is the exact failure PRD §13's "scope explosion" row warns about |

**Notes / risks** — This is the story most likely to be skipped under time pressure, and it is the
one that makes the other six worth having. Half a day of writing converts seven afternoons of
experimentation into a plan.

---

## Risks

| Risk                                                                                                                                          | Mitigation                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KAR-00.1 overruns its 4-day timebox.** It is the largest, the only one that spends quota, and the only one whose failure stops the project. | The timebox is itself a signal: an overrun means the integration is harder than the design assumes, which is A0-2 evidence. Record the overrun in the note rather than quietly extending.                                               |
| **A spike "passes" without a recorded measurement.** The single most likely way this epic produces no value.                                  | The epic DoD and KAR-00.7's test plan both assert on the presence of a non-empty `## Measurement` section. A spike with no recorded outcome is a spike you will repeat.                                                                 |
| **The author proceeds past a NO-GO** because the architecture documents are already written and the sunk cost feels large.                    | The three-way decision table exists so the outcome is chosen from a fixed menu, and the board is updated mechanically. PRD §13 already names scope explosion as a **High** risk.                                                        |
| **Spike code leaks into production.** Throwaway harnesses have a way of becoming `packages/`.                                                 | `spikes/` is deliberately outside `pnpm-workspace.yaml`'s `packages:` globs, so it never enters `pnpm -r`, `tsc -b` or the vitest projects. The only artefact that graduates is `fixtures/capabilities/`.                               |
| **KAR-00.6 has no clean PRD requirement id.** It is a toolchain decision, and the traceability rule wants an F- or NF-number.                 | Stated here rather than dropped silently, per the brief. It anchors to NF6 (the install/toolchain floor) and to roadmap risk A2-3; its real justification is that it de-risks KAR-01.5 and KAR-01.6, both of which do carry NF-numbers. |
| **Vendor versions move between spike and build.** Two of the five agent versions probed on 2026-08-02 were published the same day.            | The capability matrix is a generated fixture regenerated on every `deflow doctor` run, never a constant (A0-9). The spike's job is to prove the _probe_ works, not to freeze its output.                                                |

Total size (~7.5 days) sits inside the roadmap's 8–10 day M0 budget and well under this backlog's
15-day epic warning line. The dependency shape is a fan: KAR-00.2 first and alone, then
KAR-00.1/3/4/5/6 in any order (KAR-00.1 is the long pole and should start immediately after
KAR-00.2), then KAR-00.7.

---

**Related:** [Flows](../flows/EPIC-00-foundation-spikes-flows.md) · [Board](../board.md) ·
[17-roadmap.md](../../17-roadmap.md) · [02-tech-stack.md](../../02-tech-stack.md) ·
[03-local-development.md](../../03-local-development.md)

[← Back to the delivery plan](../README.md)
