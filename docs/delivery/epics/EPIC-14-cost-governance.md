# EPIC-14: Cost, budget and quota governance

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-14-cost-governance-flows.md)

|                      |                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-14                                                                                                                                                                                                                                                                                                                                                           |
| **Status**           | Not started                                                                                                                                                                                                                                                                                                                                                       |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                                                                                |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                                                                                                |
| **Workstream**       | cross-cutting — the accounting half lands inside W6, the ceiling and scheduling half inside W4 (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                          |
| **Size**             | ~11 days across 4 stories                                                                                                                                                                                                                                                                                                                                         |
| **Depends on**       | EPIC-09 KAR-09.7 (the three measurement tiers and the calibration factor), EPIC-06 KAR-06.2/06.5/06.6/06.7 (semaphores, classified retry, `node_wake`, pause-as-an-event), EPIC-05 KAR-05.2 (the capability manifest that carries `tokenAccounting`), EPIC-03 (the ledger and the reducer)                                                                        |
| **Blocks**           | — (EPIC-17 KAR-17.8's cost overlay and EPIC-11 KAR-11.4's cost dimension both consume this epic's projections, but neither is gated on it starting)                                                                                                                                                                                                               |
| **PRD requirements** | F9.1, F9.2, F9.3, F4.6, F3.9, F2.5 (the cost and elapsed-budget dimensions), F4.5, F4.8, NF7, NF10                                                                                                                                                                                                                                                                |
| **Architecture**     | [08-context-and-memory.md §7](../../08-context-and-memory.md), [05-durable-execution.md §10.3, §10.4, §10.1](../../05-durable-execution.md), [04-domain-model.md §8, §9](../../04-domain-model.md), [06-planning-and-replanning.md §4.3, §4.4](../../06-planning-and-replanning.md), [07-provider-adapter-layer.md §8.1, §12](../../07-provider-adapter-layer.md) |

## Goal

At the end of this epic a run knows, live, what it has spent — per node, per provider and per run —
and every figure it reports says how it was obtained. A ceiling in currency or wall-clock **pauses**
the run for a decision instead of killing it, and a paused run resumes from exactly where it stopped
once the operator raises the ceiling, with no completed node re-executed. Before anything expensive
happens — a run start, a plan patch — there is a pre-flight estimate the patch policy engine can act
on. And when a vendor says "not until 09:41", DeFlow writes that time into a `node_wake` row and
schedules around it rather than retrying blindly into the same wall for the next two hours.

## Why this matters

PRD §3.2 rates **G8 — no cost or quota awareness** as a **High** gap in Open Dynamic Workflow, with
the plain sentence _"nothing stops a `loop()` from burning a monthly allowance."_ PRD §13 lists
**runaway cost** as a High risk. For a tool whose entire premise is runs measured in hours or days,
against a subscription with a hard monthly ceiling, this is not a reporting feature — it is the
control that decides whether the tool is usable on a Tuesday afternoon and unusable by Thursday.

Three specific things break if this epic is skipped:

- **The patch policy engine loses two of its five dimensions.** `costUsdDelta` and
  `elapsedBudgetFraction` are inputs to the rule table in
  [06 §4.3](../../06-planning-and-replanning.md); the `expensive`, `budget-exhausted` and
  `read-only-analysis` rules cannot be evaluated without them. Without the estimator every patch
  falls to the `default` arm and every replan becomes a human interrupt — which converts the marquee
  dynamic-planning feature into a nagging dialogue box.
- **`budget.exceeded` is the one failure class that is not a failure.** [05 §10.3](../../05-durable-execution.md)
  makes it a `gate`, not a `permanent` error, _"the run **pauses for a human decision** rather than
  dying with hours of work half-done."_ If the pause path is not built, the only honest alternative
  is no ceiling at all, and PRD §12's _cost per completed task ≤ 1.5× manual_ metric becomes
  unmeasurable and unenforced.
- **A days-long orchestrator that cannot read a rate-limit frame is a retry storm.**
  [07 §8.1](../../07-provider-adapter-layer.md) records, **verified 2026-08-02**, that Claude Code's
  `stream-json` emits `{"type":"rate_limit_event","rate_limit_info":{ … resetsAt … }}`, and notes it
  is _"directly useful for a days-long orchestrator: parse `resetsAt` and schedule around it rather
  than retrying blindly."_ That frame is the difference between a run that sleeps four hours for the
  price of one SQLite row and a run that burns its retry budget in ninety seconds and dies.

The single non-negotiable property across all four stories comes from
[08 §7](../../08-context-and-memory.md): you do not own the model call, so there are three
measurement tiers, and **they must never be silently mixed**. Every count carries its `method`,
every `TokenUsage` carries its `source`, and — from [07 §12](../../07-provider-adapter-layer.md) —
API-key-path spend is _"real currency rather than subscription quota, and the two must not be summed
into one number."_ A ceiling computed from a silently-mixed figure fires at the wrong time, which is
worse than no ceiling, because it is a ceiling the operator trusts.

## Scope

**In scope:**

- The `budget.consumed { node?, provider, usage: TokenUsage, costUsd }` event as the single
  accounting record, and the per-node / per-provider / per-run rollup as a **reducer projection**
  over it — never a second mutable table.
- Provenance carried end to end: `TokenUsage.source: 'vendor-reported' | 'estimated'`, the capability
  manifest's `tokenAccounting: 'exact' | 'estimated' | 'none'`, and the run manifest's
  `provider.auth_mode` so subscription-quota spend and real-currency spend are reported as two
  figures, never one.
- Attempt-level attribution: a failed attempt's spend counts, and a crash-resumed attempt's spend is
  not double-counted when the ledger is replayed.
- Ceilings in both dimensions (`cost`, `wallclock`) at both scopes (`node`, `run`), sourced from
  `POST /api/runs`'s `budget: { costUsd, wallclockMs }` and `.DeFlow/config.yaml` defaults.
- `budget.exceeded { scope, dimension, limit, actual }` classified as failure class `gate`, the
  resulting `run.paused` / `run.needs_human { reason: 'budget' }`, and the full **resume-after-raise**
  path.
- Pre-flight estimation for a whole plan (before `run.started`) and for a `PlanPatch`
  (`estimate.costUsdDelta`, `estimate.estimatedWallClockDeltaMs`), built on EPIC-09's Tier-2
  tokenizer and the per-(provider, model) `tokenEstimateFactor`.
- Estimate-versus-actual reconciliation after each node, feeding EPIC-09's calibration EWMA and
  giving the operator a visible accuracy record.
- Parsing vendor rate-limit signals into `provider.rate_limited { provider, resetsAt?, raw }`;
  suspension via `node_wake(run_id, node_id, wake_at = resetsAt, reason = 'quota')`; full-jitter
  backoff where no `resetsAt` is available; and the `{ op: 'reroute', cause: 'quota' }` patch that
  makes a provider swap visible in the plan scrubber.
- Recognising the vendors' _own_ ceilings — Claude Code's `--max-budget-usd` and its
  `error_max_budget_usd` result subtype, Copilot's `--max-ai-credits` — as budget events rather than
  as transient failures to retry.
- `DeFlow doctor` reporting the current ceiling configuration, per-provider accounting fidelity and
  any provider for which a cost ceiling is unenforceable.

**Out of scope:**

- The tokenizer, the Tier-1 envelope parser, the Tier-3 API-key path and the calibration EWMA itself
  — [EPIC-09](./EPIC-09-context-memory.md) KAR-09.7. This epic consumes those tiers; it does not
  implement them. Until KAR-09.7 lands, every story here is exercised against committed
  `result`-envelope and `turn.completed` fixtures.
- The patch policy rule table and the `plan.patched` lifecycle — [EPIC-11](./EPIC-11-dynamic-planning.md)
  KAR-11.4 and KAR-11.6. This epic produces the `estimate` block the rules read and proposes the
  `reroute` op; it does not decide the outcome.
- The approval queue that surfaces a budget pause — [EPIC-13](./EPIC-13-human-in-the-loop.md)
  KAR-13.2. This epic produces the `run.needs_human { reason: 'budget' }` the queue projects.
- The scheduler's semaphores, `node_wake` table, 1 Hz ticker, error classifier and pause/resume
  events — [EPIC-06](./EPIC-06-orchestrator.md). This epic adds one wake `reason` and one failure
  class mapping.
- Run timeline with cost overlay and the context-budget chart — [EPIC-17](./EPIC-17-p0-views.md)
  KAR-17.8 and KAR-17.4. This epic defines the projection they render.
- **F9.4 subscription quota headroom tracking feeding planner routing** — P1. KAR-14.4 delivers the
  _reactive_ half (a limit that has already been hit is parsed, recorded and scheduled around).
  Predictive headroom per provider requires a quota API no vendor exposes on the subscription path;
  it is M2 work and is named again in Risks rather than dropped.
- **F9.5 cost-per-completed-task reporting across runs** — P1/M3, and it needs a cross-run dashboard
  ([EPIC-17](./EPIC-17-p0-views.md) is single-run). The per-run totals this epic produces are its
  input.
- Container-level or OS-level resource limits. DeFlow's ceilings are in currency and wall-clock, not
  CPU or memory.

## Definition of Ready (epic level)

- [ ] **EPIC-09 KAR-09.7 Done.** `countTokens` from `gpt-tokenizer/encoding/o200k_base`, the
      `modelUsage` parser, the Codex `turn.completed` parser and the persisted `tokenEstimateFactor`
      all exist. Building ceilings on an uncalibrated estimator is the failure this epic exists to
      prevent.
- [ ] **EPIC-06 KAR-06.5, 06.6 and 06.7 Done.** The classified-error retry path, the `node_wake`
      table with the 1 Hz ticker, and pause/resume/cancel as ledger events.
- [ ] **EPIC-05 KAR-05.2 Done.** The persisted capability manifest, so `tokenAccounting` is a data
      field rather than a hardcoded provider table.
- [ ] A committed fixture corpus under `test/fixtures/streams/` containing: at least one Claude Code
      `result` envelope with populated `modelUsage`, one `rate_limit_event` frame carrying
      `resetsAt`, one `result` with `subtype: 'error_max_budget_usd'`, and one Codex
      `turn.completed` with `usage`. Recorded once with `pnpm test:record`, never in CI.
- [ ] A decision recorded for the price table: where per-model USD rates come from for providers
      that report tokens but not cost, and what the estimator does when there is no rate at all.

## Definition of Done (epic level)

- [ ] All four stories `Done`.
- [ ] Every scenario in [the flow file](../flows/EPIC-14-cost-governance-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes.
- [ ] **No reported figure anywhere in the system lacks provenance.** A type-level check makes a
      cost or token figure without a `source` / `method` unconstructible, and a projection test
      proves subscription-quota spend and API-key currency spend are never summed.
- [ ] A run that hits its cost ceiling, is raised and resumed completes, and the crash-fuzz harness
      shows zero effects executed twice across the pause.
- [ ] `DeFlow doctor` reports, per installed provider: `tokenAccounting`, the current
      `tokenEstimateFactor` and sample count, and whether a cost ceiling is enforceable.
- [ ] The two `Unverified` claims this area depends on are resolved or explicitly re-flagged with a
      degradation path: **whether ACP surfaces token usage at all** (roadmap A0-3, High — if it does
      not, ACP-first silently costs F9.1) and **whether Copilot, Gemini/Antigravity, Cursor and
      OpenCode report machine-readable usage** (roadmap A4-3). Neither may remain an assumption in
      code; both are manifest fields with an honest `'none'` branch.

## User stories

### KAR-14.1 — Live per-node, per-provider, per-run accounting

|                 |                                                                                    |
| --------------- | ---------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                        |
| **Priority**    | P0                                                                                 |
| **Size**        | M                                                                                  |
| **Depends on**  | EPIC-09 KAR-09.7, EPIC-05 KAR-05.2, EPIC-03 KAR-03.5 (the pure reducer)            |
| **PRD**         | F9.1, F10.9, NF10                                                                  |
| **Verified by** | EPIC-14-S1, EPIC-14-S2, EPIC-14-S3, EPIC-14-S4, EPIC-14-S5, EPIC-14-S6, EPIC-14-S7 |

**As** the Operator, **I want** to see what a run has spent broken down by node and by provider while
it is still running, with every figure labelled by how it was measured, **so that** I can tell the
difference between a number DeFlow was told and a number DeFlow guessed before I decide whether to
let the run continue.

This story turns the three measurement tiers of [08 §7](../../08-context-and-memory.md) into a
ledger record and a projection. The record is `budget.consumed { node?, provider, usage: TokenUsage,
costUsd }` from [04 §9](../../04-domain-model.md); the projection is a rollup keyed by node, by
provider and by run, derived by the same pure reducer as everything else. Two constraints do all the
work. First, `TokenUsage.source` is **mandatory** and _"must never be silently mixed"_ — vendor
figures come from Claude Code's `modelUsage[model]` and Codex's `turn.completed.usage` and are
billing truth; estimated figures carry a known **15–20% undercount on Claude prose and worse on
code**. Second, from [07 §12](../../07-provider-adapter-layer.md), a node running on the explicit
API-key path spends _"real currency rather than subscription quota, and the two must not be summed
into one number"_ — so the rollup is a pair of figures with a shared shape, not a scalar.

The honest-degradation rule is the third constraint and the easiest to get wrong: a provider whose
manifest says `tokenAccounting: 'none'` produces **a blank cost, not a zero**. Zero is a claim; blank
is the truth. The rollup therefore carries an `unaccounted: ProviderId[]` list so a total can say
"$4.10 plus two providers that do not report".

**Acceptance criteria**

1. Every completed `agent` node attempt appends exactly one `budget.consumed` event carrying
   `usage.source`, and the event is appended in the same transaction as `node.completed` so a crash
   between the two is impossible.
2. `usage` is populated from `modelUsage[model]` on the Claude Code path and from
   `turn.completed.usage` on the Codex path, normalised to `TokenUsage`. The result envelope's
   `usage` field — typed `z.unknown()` in the CLI's own schema — is never read; a CI grep over
   `packages/` proves it.
3. The run rollup exposes at least four figures that are never collapsed into one:
   subscription-path cost, API-key-path cost, vendor-reported token totals and estimated token
   totals. A test constructs a run with all four present and asserts the projection contains no
   field that is their sum.
4. A provider whose capability manifest carries `tokenAccounting: 'none'` contributes `null` to the
   cost rollup and its `ProviderId` to `unaccounted`. The projection type makes `0` unrepresentable
   as "unknown".
5. A node that fails and retries contributes a `budget.consumed` event per attempt, and the node
   rollup reports both per-attempt and cumulative figures. Spend on a failed attempt is never
   discounted.
6. Replaying the ledger after a `kill -9` and restart reproduces byte-identical rollups, and no
   `budget.consumed` event is appended twice for the same `(runId, nodeId, attempt)` — enforced by
   the effect journal's idempotency key, not by a uniqueness check on the projection.
7. `node.progress` and `io_chunk` never contribute to any accounting figure; the control-plane /
   data-plane split of [05 §5](../../05-durable-execution.md) means an agent producing megabytes of
   stdout moves no cost number.
8. The rollup is available at `GET /api/runs/:id` as part of the run summary and updates live over
   the SSE stream because `budget.consumed` is an ordinary ledger event — no separate polling
   endpoint exists.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                            | Red when                         |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | unit        | `reduce()` over a hand-built event list containing three `budget.consumed` events produces per-node, per-provider and per-run rollups                                                           | The projection does not exist    |
| 2   | unit        | A `budget.consumed` whose `usage.source` is absent fails to typecheck, and a runtime constructor throws                                                                                         | `source` is optional             |
| 3   | unit        | Rollup over one `vendor-reported` and one `estimated` contribution exposes both and no summed field                                                                                             | The two are added                |
| 4   | unit        | Rollup over a subscription-path node and an API-key-path node keeps the currencies apart                                                                                                        | `auth_mode` is ignored           |
| 5   | unit        | `tokenAccounting: 'none'` contributes `null`; a test asserts the projection type rejects `0`                                                                                                    | Zero is used as unknown          |
| 6   | unit        | Parse the committed `result`-envelope fixture: `modelUsage` read, `usage` untouched                                                                                                             | The parser reads `usage`         |
| 7   | unit        | Parse the committed Codex `turn.completed` fixture into the same `TokenUsage` shape                                                                                                             | The Codex path is unimplemented  |
| 8   | integration | Real file-backed SQLite, mock agent on a temp `PATH`, two-node run: `budget.consumed` and `node.completed` share a transaction (assert by inspecting `seq` adjacency after a mid-write SIGKILL) | They are appended separately     |
| 9   | integration | `kill -9` mid-run, reopen the same `ledger.db` with a fresh engine, assert identical rollups and no duplicated `budget.consumed`                                                                | Replay double-counts             |
| 10  | integration | A node that fails once then succeeds: two `budget.consumed` events, cumulative rollup is their sum                                                                                              | Failed-attempt spend is dropped  |
| 11  | integration | A 5 MB stdout burst through `io_chunk` moves no accounting figure                                                                                                                               | The reducer reads the data plane |

**Notes / risks** — the accounting fidelity of four of the five probed adapters is **Unverified**
(roadmap A4-3): only Claude Code and Codex were checked on 2026-08-02. That is a manifest field and
an honest `'none'` branch, not a code fork. The larger risk is A0-3, rated **High**: whether ACP
surfaces token usage _at all_. If it does not, the ACP-first path silently costs F9.1 and the
fallback is the exec-shim adapter for cost-critical nodes — which is a routing decision, not a
rewrite, precisely because `tokenAccounting` lives in the manifest.

---

### KAR-14.2 — Budget ceilings that pause rather than fail

|                 |                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                  |
| **Priority**    | P0                                                                                           |
| **Size**        | M                                                                                            |
| **Depends on**  | KAR-14.1, EPIC-06 KAR-06.5 (the error classifier), EPIC-06 KAR-06.7 (pause/resume as events) |
| **PRD**         | F4.6, F9.2, F4.4, NF4, NF10                                                                  |
| **Verified by** | EPIC-14-S8, EPIC-14-S9, EPIC-14-S10, EPIC-14-S11, EPIC-14-S12, EPIC-14-S13, EPIC-14-S14      |

**As** the Operator, **I want** a run that reaches its cost or wall-clock ceiling to stop and wait
for me with everything it has done intact, **so that** a ceiling is a decision point rather than a
way to lose four hours of work.

[05 §10.3](../../05-durable-execution.md) is explicit and the wording is the design: _"Hitting a
budget ceiling (F4.6) is deliberately a `gate`, not a `permanent` failure: the run **pauses for a
human decision** rather than dying with hours of work half-done."_ Mechanically that means the
ceiling check runs inside `decide()`, the trip appends `budget.exceeded { scope, dimension, limit,
actual }` followed by `run.paused` and `run.needs_human { reason: 'budget' }`, and — because
pause is an event and never an in-memory flag ([05 §10.4](../../05-durable-execution.md)) — the
pause survives a restart, appears in the timeline and is auditable.

The resume path is the half that is easy to under-build. Raising the ceiling appends `run.resumed`;
the scheduler re-derives its ready set from reduced state; completed nodes are **never**
re-executed because the effect journal memoises them by `(runId, nodeId, attempt)`; and an in-flight
node that had already been admitted before the trip finishes rather than being torn down. There is
no separate "checkpoint" to write, because the ledger already is one.

Two ceilings that are not DeFlow's also matter here. Claude Code accepts `--max-budget-usd <amt>` and
returns `{ type: 'result', subtype: 'error_max_budget_usd' }`; Copilot CLI has `--max-ai-credits`.
Those are defence in depth below DeFlow's own ceiling — and they must be classified as budget events,
not as `transient` failures worth retrying, or the retry loop spends the remaining allowance
discovering the same wall three more times.

**Acceptance criteria**

1. A ceiling exists per run and per node, in both `cost` (USD) and `wallclock` (ms), sourced from
   `POST /api/runs`'s `budget: { costUsd, wallclockMs }` and defaulted from `.DeFlow/config.yaml`;
   the effective values are hashed into the run manifest so a mid-run config edit does not silently
   change them.
2. Crossing a ceiling appends, in one transaction, `budget.exceeded { scope, dimension, limit,
actual }` and `run.paused { by: 'policy', reason: 'budget' }`, plus
   `run.needs_human { reason: 'budget' }`. The failure class recorded is `gate`; a test asserts it is
   not `permanent` and not `transient`.
3. After the trip, `decide()` admits **no** new node — observable as zero further `node.scheduled`
   events — while nodes already `running` reach `node.completed` or `node.failed` normally.
4. **A paused run retains full state and resumes.** After raising the ceiling and appending
   `run.resumed`, the run continues from the ready set implied by reduced state: every previously
   `completed` node stays completed, no `node.started` event is emitted for any of them, the effect
   journal returns memoised results for their `ikey`s, worktrees and branches are untouched, and the
   blackboard's facts are unchanged.
5. A ceiling trip followed by a daemon `kill -9` and restart leaves the run paused — the pause is
   reconstructed from the ledger, not from memory — and the same resume path works after the
   restart.
6. `scope: 'node'` and `scope: 'run'` differ observably: a node ceiling suspends that node and
   escalates it, leaving sibling branches admissible; a run ceiling stops admission everywhere.
7. The `actual` figure in `budget.exceeded` is accompanied by the KAR-14.1 rollup breakdown, so an
   operator can see whether the trip was driven by vendor-reported figures or by estimates. A trip
   driven wholly by estimates is labelled as such wherever it is displayed.
8. If a run sets a `costUsd` ceiling while any scheduled node's provider reports
   `tokenAccounting: 'none'`, the run summary carries a `budgetEnforceable: false` marker naming
   those providers, and the spec-approval surface shows it before execution begins. DeFlow does not
   pretend to enforce a ceiling it cannot measure. The `wallclockMs` ceiling stays enforceable
   regardless.
9. A `result` envelope with `subtype: 'error_max_budget_usd'` is classified as a budget `gate`, is
   **not** retried, and produces the same pause path as a DeFlow-side trip, with the event recording
   that the vendor's own ceiling fired.
10. Wall-clock ceilings are measured through the injected `Clock` port; no engine code reads
    `Date.now()`, and a six-hour ceiling is exercised by `clock.advance(hours(6))` in microseconds.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                          | Red when                                                 |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | unit        | `decide()` over a state whose run rollup exceeds `budget.costUsd` returns a pause command and no admit commands                                                                               | The ceiling is checked at the adapter boundary           |
| 2   | unit        | The classifier maps a ceiling trip to class `gate`; table-driven against `transient` and `permanent` inputs                                                                                   | Budget is treated as a failure                           |
| 3   | unit        | `Scenario Outline` equivalent: `{cost, wallclock} × {node, run}` produces the right `budget.exceeded` payload                                                                                 | One dimension is hardcoded                               |
| 4   | unit        | `TestClock.advance(hours(6))` trips a wall-clock ceiling with no timers involved                                                                                                              | Wall-clock reads `Date.now()`                            |
| 5   | unit        | A rollup containing only `estimated` contributions produces a trip labelled estimate-driven                                                                                                   | Provenance is lost at the ceiling                        |
| 6   | integration | File-backed SQLite, mock agent, three-node run with a $0.01 ceiling: `budget.exceeded` + `run.paused` + `run.needs_human` in one transaction, then zero further `node.scheduled`              | The three are appended separately or admission continues |
| 7   | integration | **Resume:** raise the ceiling, append `run.resumed`, assert no `node.started` for any completed node, memoised effect results returned for their `ikey`s, and the run reaches `run.completed` | Resume re-executes work                                  |
| 8   | integration | Trip, then `kill -9`, then restart over the same `.DeFlow/`: run is still paused; then resume as in 7                                                                                         | Pause was an in-memory flag                              |
| 9   | integration | Node-scope trip: the tripping node suspends and escalates, a sibling branch continues to `node.completed`                                                                                     | Node scope stops the world                               |
| 10  | integration | Fake exec-shim agent returning `subtype: 'error_max_budget_usd'`: no retry attempt is scheduled, the pause path fires                                                                         | The vendor ceiling is retried                            |
| 11  | integration | A run with a `costUsd` ceiling and a `tokenAccounting: 'none'` provider reports `budgetEnforceable: false` before `run.started`                                                               | DeFlow claims an unenforceable ceiling                   |
| 12  | e2e         | Crash-fuzz variant: random `kill -9` during a run that trips a ceiling; assert no effect executed twice and `PRAGMA integrity_check` = `ok`                                                   | Durability across the pause is untested                  |

**Notes / risks** — do not implement the pause by cancelling in-flight children. Tearing down a node
that is 90% through a build to save a few cents converts a pause into a partial failure and breaks
criterion 4's promise that the run resumes intact. Admission is the lever; termination is the kill
switch (F5.7) and it lives in [EPIC-08](./EPIC-08-safety-model.md).

---

### KAR-14.3 — Pre-flight cost estimation

|                 |                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                             |
| **Priority**    | P0                                                                                                      |
| **Size**        | M                                                                                                       |
| **Depends on**  | KAR-14.1, EPIC-09 KAR-09.7 (Tier-2 and `tokenEstimateFactor`), EPIC-11 KAR-11.3 (the `PlanPatch` shape) |
| **PRD**         | F9.3, F2.5, F1.3                                                                                        |
| **Verified by** | EPIC-14-S15, EPIC-14-S16, EPIC-14-S17, EPIC-14-S18, EPIC-14-S19, EPIC-14-S20                            |

**As** the Operator and the patch policy engine, **I want** a labelled cost estimate before a run
starts and before an expensive patch is applied, **so that** the decision to spend is made before the
money is gone rather than reported afterwards.

The estimator produces the `estimate` block that [06 §4.1](../../06-planning-and-replanning.md)
defines on every `PlanPatch`: `{ costUsdDelta, nodesAdded, blastRadiusFiles, maxPermission,
replanDepth }`, plus `estimatedWallClockDeltaMs` from [04 §…](../../04-domain-model.md)'s patch
policy fields. It is built from EPIC-09's Tier-2 tokenizer with the per-(provider, model)
`tokenEstimateFactor` applied — which is why the calibration story is a hard dependency rather than a
nice-to-have: an uncalibrated `o200k_base` count systematically **undercounts Claude tokens by
15–20% on prose and more on code**, and an under-estimate is the dangerous direction for a spend
gate.

The estimate feeds three consumers with different tolerances. The spec-approval surface (F1.3) shows
a whole-plan figure so the operator can decline before `run.started`. The patch policy engine reads
`costUsdDelta` for its `expensive` (`> 5.00`) and `read-only-analysis` (`<= 5.00`) rules and
`elapsedBudgetFraction` for `budget-exhausted` (`>= 1.0` → reject). And KAR-14.2's `budgetEnforceable`
marker uses the same machinery to say up front which providers cannot be metered.

The subtle failure is what happens when there is no answer. An unknown cost must **never** be
coerced to `0`: a zero `costUsdDelta` matches `read-only-analysis` and auto-applies every expensive
patch on a provider DeFlow cannot price. Unknown is `null`, `null` matches no numeric rule, and the
rule table's `default` arm is `approve` — a human. That behaviour is a direct consequence of
[06 §4.3](../../06-planning-and-replanning.md)'s _"the default arm is `approve`, not `auto`. Anything
the rules do not recognise goes to a human."_

**Acceptance criteria**

1. `estimate(plan | patch, manifests, calibration)` is a pure function of its inputs — no clock, no
   network, no filesystem — and is golden-file snapshot-testable per node archetype.
2. Every estimated figure carries `method: 'gpt-tokenizer/o200k_base'` and the
   `tokenEstimateFactor` and sample count `n` that were applied. Where `n < 5` the seed factor
   (`anthropic: 1.2`, `openai: 1.0`, `default: 1.05`) is used and the estimate is marked as
   seed-based.
3. A whole-plan estimate is computed at plan validation and is present in the `GET /api/runs/:id`
   payload before `run.started`, so `POST /runs/:id/spec/approve` is an informed decision.
4. Every `PlanPatch` carries a populated `estimate` block before it reaches the policy engine; a
   patch without one is rejected at the tool boundary rather than defaulted.
5. The three worked examples in [06 §4.3](../../06-planning-and-replanning.md) reproduce exactly:
   `costUsdDelta 0.40` + `maxPermission read` + depth 1 → `auto` via `read-only-analysis`;
   `costUsdDelta 6.20` + permission escalation → `approve`; `replanDepth 4` → `reject` via
   `replan-depth-exceeded`.
6. `elapsedBudgetFraction` is computed from the KAR-14.1 rollup against the KAR-14.2 ceiling, in both
   dimensions, and the larger fraction wins. At `>= 1.0` the `budget-exhausted` rule fires and the
   ledger records `plan.patched { decision: 'rejected', ruleId: 'budget-exhausted' }`.
7. An unpriceable node — no rate for the model, or `tokenAccounting: 'none'` — yields
   `costUsdDelta: null`, never `0`. A `null` matches no numeric rule and the patch falls to the
   `default` arm. A test proves an expensive patch on an unpriceable provider is **not** auto-applied.
8. After each node completes, the estimate is reconciled against the Tier-1 actual and the delta is
   recorded, feeding EPIC-09's calibration update and exposing a per-run estimate-accuracy figure.
9. An estimate is never rendered in the same visual channel as billing truth: wherever an estimate
   and an actual appear together, the projection carries both and they are separately labelled.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                 | Red when                                    |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| 1   | unit        | `estimate()` over a 4-node fixture plan → golden file, with `method` and factor on every figure                                      | The estimator does not exist                |
| 2   | unit        | Purity: the same inputs twice produce identical output; a lint proves no `Date.now()`/`fetch` in `packages/cost/src/estimate.ts`     | The estimator reads ambient state           |
| 3   | unit        | Seed-versus-learned: `n = 3` uses the seed and marks it; `n = 5` uses the learned factor                                             | The threshold is off by one                 |
| 4   | unit        | Table-driven over the three worked examples from 06 §4.3 → `auto` / `approve` / `reject` with the right `ruleId`                     | The estimate does not drive the rules       |
| 5   | unit        | `elapsedBudgetFraction` across `{cost 0.9, wallclock 0.4}` → `0.9`; at `1.0` the reject rule fires                                   | The two dimensions are averaged             |
| 6   | unit        | Unpriceable node → `costUsdDelta: null`; the policy engine's numeric matcher returns false for `null`                                | `null` is coerced to `0`                    |
| 7   | unit        | A patch with no `estimate` block is rejected at the MCP tool boundary with a schema error                                            | The block is defaulted                      |
| 8   | integration | Full mock-agent node: estimate recorded pre-flight, Tier-1 actual recorded post-hoc, delta appended and the calibration factor moves | Reconciliation is not wired                 |
| 9   | integration | `GET /api/runs/:id` before `run.started` contains the whole-plan estimate                                                            | The estimate is computed too late to matter |
| 10  | integration | An expensive patch on a `tokenAccounting: 'none'` provider lands in the approval queue rather than auto-applying                     | Unknown cost reads as cheap                 |

**Notes / risks** — the price table is the soft spot. DeFlow does not hold a model credential, so it
cannot ask a vendor what a model costs; per-model USD rates are static data that goes stale. Where a
vendor reports `costUSD` directly (Claude Code's `modelUsage[m].costUSD`, and `total_cost_usd` on the
result envelope) prefer it and use the table only for _estimates_. Record the table's version in the
run manifest so an estimate can be re-derived later. If the table has no entry, the answer is `null`
— see criterion 7, which is the whole reason that criterion exists.

---

### KAR-14.4 — Rate-limit awareness and backoff scheduling

|                 |                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                                              |
| **Priority**    | P0                                                                                                                                                                                                       |
| **Size**        | M                                                                                                                                                                                                        |
| **Depends on**  | EPIC-06 KAR-06.5 (classified retry), EPIC-06 KAR-06.6 (durable wake times), EPIC-05 KAR-05.2 (capability manifests for `capabilitySuperset`), EPIC-11 KAR-11.6 (provider re-routing recorded as a patch) |
| **PRD**         | F3.9, F4.5, F4.8, F9.4 (reactive half), NF7                                                                                                                                                              |
| **Verified by** | EPIC-14-S21, EPIC-14-S22, EPIC-14-S23, EPIC-14-S24, EPIC-14-S25, EPIC-14-S26, EPIC-14-S27, EPIC-14-S28                                                                                                   |

**As** a run that will be alive for two days, **I want** to read the provider's own statement of when
its limit resets and sleep until then, **so that** a rate limit costs one SQLite row instead of the
rest of my retry budget.

This is the story the days-long horizon actually depends on.
[07 §8.1](../../07-provider-adapter-layer.md) records, **verified 2026-08-02**, that Claude Code's
`stream-json` emits `{"type":"rate_limit_event","rate_limit_info":{ … }}` including `resetsAt`, and
calls it out as _"directly useful for a days-long orchestrator — parse `resetsAt` and schedule around
it rather than retrying blindly."_ DeFlow normalises that frame into
`provider.rate_limited { provider, resetsAt?, raw }` ([04 §9](../../04-domain-model.md)) and then
does one of three things, in this order of preference:

1. **Suspend until the reset.** Write `node_wake(run_id, node_id, wake_at = resetsAt, reason =
'quota')` and let the 1 Hz ticker pick it up
   ([06 §4.4](../../06-planning-and-replanning.md)). Never `setTimeout` — **verified 2026-08-02**,
   Node's maximum timer delay is `2^31 - 1` ms and passing `2**31` does not throw and does not clamp,
   it fires the callback after **1 ms** with only a `TimeoutOverflowWarning` on stderr. A reset four
   days out is inside that ceiling; a monthly quota reset is not.
2. **Re-route**, if a healthy provider covers the node's requirements. The scheduler proposes
   `{ op: 'reroute', node, provider, cause: 'quota' }` through the same policy engine as any other
   patch, so _the swap appears in the plan scrubber_ — which is the entire point of F3.9's wording.
   The `quota-reroute-equivalent` rule auto-applies it only when `capabilitySuperset` and
   `permissionUnchanged` both hold; a reroute onto a weaker adapter is not equivalent and is not
   auto.
3. **Back off with full jitter**, where no `resetsAt` is available:
   `delay = Math.random() * Math.min(cap, base * 2 ** (attempt - 1))` with base 2,000 ms and cap
   300,000 ms. Full jitter rather than equal or none because _the common failure here is correlated_
   — several nodes hit the same vendor limit in the same tick, and lockstep retries re-trip it.

The one thing DeFlow must not do is fail the run. NF7: _one provider unavailable degrades the plan;
it does not kill the run._ If no healthy provider satisfies the node, **suspend — do not reroute**.

**Acceptance criteria**

1. A `rate_limit_event` frame on the shim path, and the equivalent rate-limit signal on the ACP path,
   both normalise to `provider.rate_limited { provider, resetsAt?, raw }` with `raw` carrying the
   vendor payload verbatim for later re-parsing. **The ACP half is a declared signal, not a probed
   one:** ACP assigns no rate-limit code, so the signal is a JSON-RPC error code the adapter's caller
   declared — the same shape as the shim's `rateLimitExitCodes`, and DeFlow ships none of either. An
   undeclared error degrades to criterion 6's blind backoff rather than to a quota DeFlow inferred,
   and a code ACP has already assigned (`authRequired` above all) cannot be declared at all, because
   reading one as a quota is exactly the conflation criterion 9 forbids.
2. When `resetsAt` is present, the node is suspended with a `node_wake` row whose `wake_at` equals
   `resetsAt` and whose `reason` is `'quota'`, and `node.suspended { until }` is appended. The
   suspended node consumes **one row and zero CPU** — a test asserts no timer handle and no running
   child process exist for it.
3. `node_wake` is written in the **same transaction** as the failure event, so a restart inside the
   window neither loses the delay nor double-counts the attempt.
4. A wake time beyond `2^31 - 1` ms from now is honoured exactly. A regression test demonstrates that
   `setTimeout(2**31, …)` fires after ~1 ms with a `TimeoutOverflowWarning`, and a lint rule fails
   the build on `setTimeout` used as a wait anywhere in engine code.
5. The suspension survives a daemon `kill -9` and restart and a simulated laptop sleep: the node
   wakes at `resetsAt` measured on the injected `Clock`, not at restart time.
6. Where no `resetsAt` is available, retry delay follows the full-jitter formula with base 2,000 ms
   and cap 300,000 ms. Three nodes tripping the same limit within one tick receive three distinct
   `wake_at` values — asserted statistically over a seeded RNG, not by eyeball.
7. Re-routing is proposed as a `PlanPatch` with `cause: 'quota'` and appears as a `plan.patched`
   event with its `reason` rendered verbatim. It auto-applies only when the target adapter's probed
   capability set covers everything the node requires **and** the permission level is unchanged.
8. With no capable healthy provider, the node suspends rather than rerouting; the run stays alive and
   other branches continue to be admitted (NF7).
9. A rate limit is classified `transient` — retryable, optionally on a different provider — and is
   never conflated with a budget `gate` or a `permanent` auth failure. A table-driven classifier test
   covers all three.
10. `DeFlow doctor` reports, per provider, the most recent `provider.rate_limited` event and its
    `resetsAt`, so an operator can see why a provider is currently unusable without opening a run.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                                                 | Red when                                                               |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | unit        | Parse the committed `rate_limit_event` fixture → `provider.rate_limited` with `resetsAt` and verbatim `raw`                                                                                                          | The frame is dropped as unknown                                        |
| 2   | unit        | Classifier table: rate limit → `transient`; `error_max_budget_usd` → `gate`; auth failure → `permanent`                                                                                                              | The classes are collapsed                                              |
| 3   | unit        | Full-jitter formula over a seeded RNG: bounds respected at attempts 1–8, cap honoured at 300,000 ms                                                                                                                  | Backoff is fixed or unbounded                                          |
| 4   | unit        | Three simultaneous trips produce three distinct delays over 1,000 seeded draws                                                                                                                                       | Jitter is equal-jitter or absent                                       |
| 5   | unit        | **The 2^31 demonstration**: `setTimeout(2**31, cb)` fires within ~5 ms and emits `TimeoutOverflowWarning`; the `node_wake` path with the same delay does not fire early                                              | Someone "simplifies" the wait back to a timer                          |
| 6   | unit        | `capabilitySuperset` over the probed capability matrix rows (claude-agent-acp 0.64.1, codex-acp 1.1.9, opencode 1.18.11, copilot 1.0.77, gemini 0.53.1) — a node needing `session.resume` rejects copilot and gemini | Capability comparison is hardcoded                                     |
| 7   | integration | Mock agent scripted to emit a rate-limit signal with `resetsAt` 4 hours out: `node_wake` row written in the same transaction as the failure event, `TestClock.advance(hours(4))` resumes it                          | The wake is a timer or a separate write                                |
| 8   | integration | `kill -9` during the suspension, restart, advance the clock: the node still wakes at `resetsAt`                                                                                                                      | The wake lived in memory                                               |
| 9   | integration | Reroute path: a capable alternate provider on `PATH` → `plan.patched` with `cause: 'quota'`, `decision: 'auto'`, and the node runs on the new provider                                                               | Rerouting bypasses the policy engine and never appears in the scrubber |
| 10  | integration | No capable alternate: the node suspends, a sibling branch still reaches `node.completed`                                                                                                                             | One provider outage kills the run                                      |
| 11  | e2e         | A run whose only provider is rate-limited for 6 hours: `DeFlow doctor` reports the `resetsAt`, the daemon idles, and after `clock.advance(hours(6))` the run completes                                               | Long suspension is not exercised end to end                            |
| 12  | integration | **The ACP half of criterion 1** (added): a real ACP child answers `session/prompt` with a declared rate-limit code → the same `provider.rate_limited` payload, the same `transient` class, the same `quota` wake row; an undeclared code stays what it was; an ACP-assigned code is refused before the spawn | Only the shim path normalises, and the ACP path fails as a bare error |

**Notes / risks** — only Claude Code's rate-limit frame is verified. Whether the ACP path surfaces
rate-limit state at all is **Unverified** and is one of the two questions the M0 S1 spike is told to
answer explicitly (roadmap §1). If ACP does not surface it, the reactive path degrades to "classify
a non-zero exit as `transient` and back off with full jitter", which is correct but blind — and that
degradation is exactly what criterion 6 specifies, so it is a data path rather than a missing
feature. **What is shipped for the ACP path is the data path itself, not a stub:** the normaliser,
the `provider.rate_limited` append, the `quota` wake row and the pre-spawn refusal of an
ACP-assigned code all exist and are tested (test 12, EPIC-14-S28); what the spike would add is the
one thing DeFlow must not invent — which code, if any, a given adapter actually answers with. Until
it does, `rateLimitErrorCodes` is empty everywhere, which is the honest state and is visible in the
code rather than implied by its absence. Predictive quota headroom (F9.4) is P1 and stays out: no vendor exposes remaining
subscription quota on the paths AR-1 permits, so any headroom figure DeFlow invented would be a
guess presented as a fact.

---

## Risks

- **Total size is ~11 days, which fits, but it is 11 days of work with no visible screen at the end.**
  Every story here produces events and projections that only become legible in
  [EPIC-17](./EPIC-17-p0-views.md) KAR-17.8. Mitigation: `DeFlow doctor` and the `GET /api/runs/:id`
  payload are the deliverable surfaces named in each story's criteria, so the epic is observable from
  the terminal without waiting for the UI.
- **The estimator's accuracy is bounded by someone else's tokenizer.** There is no public exact
  tokenizer for Claude 3+. The calibration loop (EPIC-09) converges within a few percent after ~20
  nodes, but the first ~5 nodes of a fresh (provider, model) pair are seed-based. Ceilings must
  therefore never be tuned so tightly that a 20% estimate error is the difference between finishing
  and pausing — and criterion 7 of KAR-14.2 exists so the operator can see when a trip was
  estimate-driven.
- **A0-3 (High): whether ACP surfaces token usage at all.** If it does not, F9.1 and F10.5 are
  silently degraded on the ACP-first path. This is a spike question, not a design question, and it
  must be answered in M0 rather than discovered in KAR-14.1.
- **The price table is static data in a moving market.** Prefer vendor-reported `costUSD`; version
  the table in the run manifest; return `null` rather than `0` when there is no entry.
- **F9.4 and F9.5 are deliberately not covered.** Predictive quota headroom feeding planner routing
  and cross-run cost-per-task reporting are both P1 and both belong to M2/M3. They are named here
  rather than dropped silently, per the backlog's traceability rule.

---

**Related:** [Flows](../flows/EPIC-14-cost-governance-flows.md) · [Board](../board.md) ·
[08-context-and-memory.md](../../08-context-and-memory.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[06-planning-and-replanning.md](../../06-planning-and-replanning.md) ·
[07-provider-adapter-layer.md](../../07-provider-adapter-layer.md)

[← Back to the delivery plan](../README.md)
