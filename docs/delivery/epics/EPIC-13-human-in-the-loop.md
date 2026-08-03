# EPIC-13: Human-in-the-loop and approvals

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-13-human-in-the-loop-flows.md)

|                      |                                                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-13                                                                                                                                                                                                                                                                                              |
| **Status**           | Not started                                                                                                                                                                                                                                                                                          |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                   |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                                   |
| **Workstream**       | W8b (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                                                        |
| **Size**             | ~11 days across 4 stories                                                                                                                                                                                                                                                                            |
| **Depends on**       | EPIC-06 (durable wake times, pause/resume as events, the 1 Hz ticker), EPIC-03 (the ledger and the reducer), EPIC-08 (the permission policy function whose escalations arrive here)                                                                                                                  |
| **Blocks**           | EPIC-15 (the human endpoints mount this epic's service functions), EPIC-17 (the approval surfaces) · EPIC-12 consumes the queue — a `needs-human` verdict is only useful if something answers it — but is not gated on this epic starting, which is why EPIC-12 does not list it in `Depends on`     |
| **PRD requirements** | F8.1, F8.2, F8.3, F4.4, F4.8, F5.4, F5.6, NF4, NF10                                                                                                                                                                                                                                                  |
| **Architecture**     | [10-verification-gates.md §1, §9.1](../../10-verification-gates.md), [11-api-and-realtime.md §2, §6, §7.5, §11](../../11-api-and-realtime.md), [05-durable-execution.md §10.1, §10.4, §9.3](../../05-durable-execution.md), [09-workspace-and-safety.md §8.2, §10](../../09-workspace-and-safety.md) |

## Goal

At the end of this epic the Operator is a first-class participant in a run rather than an observer
of one. A `human` node blocks a branch of the plan for six hours at the cost of a single SQLite row
and zero CPU, survives a daemon restart and a laptop sleep, and resumes exactly where it was. One
screen lists everything waiting on the Operator across every concurrent run. A running node can be
given a correction without the run being discarded, and the API says honestly whether that
correction was actually delivered. And when an agent asks for something the permission policy will
not auto-answer, the request reaches the Operator carrying the command, the resolved path, the rule
that matched and the node's declared scope — enough to decide in seconds rather than enough to
guess.

## Why this matters

PRD §3.2 lists _"no human-in-the-loop"_ (G11) as a **Medium** gap in ODW, and that rating
understates it for DeFlow specifically, because three P0 mechanisms elsewhere in the system
terminate here and nowhere else:

- **`reconcile()` can return `'unknown'` and there is no correct automatic action.** Retrying might
  double-apply a migration; skipping might drop the work. Both are wrong in some cases and neither
  is detectable. [05 §9.3](../../05-durable-execution.md) says to _design the human gate for this
  case on day one rather than bolting it on_, and A1-5 rates it **High**. That gate is this epic.
- **There is no override flag in the verification data model.** The only path past a failing gate is
  a `human` node whose response is a ledger event with an identity and a timestamp
  ([10 §9.1](../../10-verification-gates.md)). If the human path does not work, the _only_ thing
  EPIC-12 can do with a red gate is stop the run.
- **Budget ceilings pause rather than fail** (F4.6), and the churn breaker transitions the run to
  `needs_human` rather than continuing (F4.7). Both produce a run that is alive, cheap and waiting —
  and entirely useless until something surfaces it.

The suspension mechanism itself is the reason this is cheap rather than hard. Four problems that
look unrelated — a six-hour human gate, laptop sleep across that gate, crash and restart mid-wait,
and retry backoff — collapse into **one** `node_wake` row on a 1 Hz ticker
([05 §10.1](../../05-durable-execution.md)). One code path, exercised constantly, instead of four
rarely-exercised ones. The failure mode if it is done the obvious way is spectacular and silent:
Node's maximum timer delay is `2^31 - 1` ms, and passing `2**31` does not throw and does not clamp —
it fires the callback after **1 ms** with only a `TimeoutOverflowWarning` on stderr. A 30-day human
gate implemented with `setTimeout` fires instantly and nothing in the logs says "durability
failure". **Verified 2026-08-02.**

## Scope

**In scope:**

- `HumanNode` execution: `prompt`, `options[{ id, label, effect }]` with effects
  `approve | reject | edit | inject`, and `deadline { wakeAt, onTimeout: 'fail' | 'escalate' |
'default', default? }`.
- `human.requested` / `human.responded` events, and the `node.suspended { until: { kind: 'human' } }`
  lifecycle around them.
- Durable suspension via a `node_wake` row with `reason: 'human_gate'`, resumed by the 1 Hz ticker,
  with a lint that fails the build on `setTimeout` used as a wait in engine code.
- Blocking semantics: a suspended `human` node blocks its dependents and nothing else; sibling
  branches keep being admitted.
- The cross-run approval queue as a **projection**, not a table: aggregating pending human nodes,
  queued `PlanPatch`es, `needs-human` verdicts, `effect.reconcile-unknown` escalations,
  `budget.exceeded` pauses, churn-breaker trips, `stale-input` tainted nodes and outstanding
  permission escalations, across every run.
- The `runs=*` global topic on the SSE stream carrying `human.requested` without dragging every
  `node.progress` frame from every run into an idle tab.
- `POST /api/runs/:id/nodes/:nodeId/respond`, `GET /api/approvals`,
  `POST /api/runs/:id/interject` and `POST /api/runs/:id/patches/:patchId/decide` as _handlers on
  the daemon's core service_, with their `ifLastSeq` optimistic-concurrency behaviour and their
  `409` codes (`stale_cursor`, `patch_already_decided`, `run_not_pausable`).
- Interjection: `mode: 'next-turn' | 'pause-and-inject'`, the `delivery: 'queued' | 'delivered' |
'unsupported'` response, the `202` (never an error) for `unsupported`, and the guidance's entry
  into the next context packet as an attributed segment.
- Permission escalation: which `session/request_permission` calls are auto-answered from the policy
  table and which reach the Operator; the context payload an escalation carries; the four
  `PermissionOptionKind` values and their effect on subsequent calls; and `{outcome: 'cancelled'}`
  as a first-class outcome rather than an error.
- Restart and sleep behaviour for every one of the above.

**Out of scope:**

- The HTTP server, routing, bearer auth, `Origin` validation and the SSE serving loop —
  [EPIC-15](./EPIC-15-daemon-api.md) KAR-15.1–15.3. This epic writes the handlers and their
  semantics; EPIC-15 mounts them and owns the transport. Until it lands, every handler in this epic
  is exercised through its service function, which is the same code path.
- The permission policy function itself, the command allowlist, path scoping and environment
  scrubbing — [EPIC-08](./EPIC-08-safety-model.md). This epic owns only what happens when that
  function returns _"ask the human"_.
- Verdicts, gates and the repair loop — [EPIC-12](./EPIC-12-verification-gates.md). A `needs-human`
  verdict is an input to the queue here.
- The patch policy engine's rule table — [EPIC-11](./EPIC-11-dynamic-planning.md) KAR-11.4. This
  epic surfaces and decides queued patches; it does not decide _which_ patches queue.
- Budget ceilings and the churn breaker — [EPIC-14](./EPIC-14-cost-governance.md) and
  [EPIC-06](./EPIC-06-orchestrator.md). Both feed the queue.
- The approval queue **UI**, the notification badge and the inspector deep links —
  [EPIC-17](./EPIC-17-p0-views.md). This epic defines the projection they render.
- Desktop, Slack and email notifications (F8.4) — P1, M2.
- Steering without stopping (F8.5) as a _guaranteed_ capability — P1 and adapter-dependent. The
  `delivery: 'unsupported'` branch is in scope precisely so M1 is honest about not having it.
- The interactive PTY WebSocket at `/api/pty/:runId/:nodeId` — [EPIC-15](./EPIC-15-daemon-api.md).
  Typing into a live `node-pty` is the one thing that genuinely needs keystroke latency; textual
  interjection does not.

## Definition of Ready (epic level)

- [ ] **EPIC-06 Done through KAR-06.6 and KAR-06.7.** `node_wake` rows, the 1 Hz ticker and
      pause/resume-as-events exist, because every story here is built on them rather than beside
      them.
- [ ] **EPIC-03 Done.** File-backed SQLite with WAL, `daemon_epoch` fencing and ledger replay on
      start — a human gate that does not survive a restart is not a human gate.
- [ ] The `HumanNode` type from [04 §3.2](../../04-domain-model.md) and the `human.requested` /
      `human.responded` envelopes from [04 §9](../../04-domain-model.md) are landed in
      `@DeFlow/core`.
- [ ] A decision is recorded on the `human.interjected` event kind (see KAR-13.3 notes): the API
      contract returns a `seq` from `POST /interject`, so an event must exist, and the Event union
      in EPIC-02 KAR-02.7 needs the slot before this epic writes to it.
- [ ] The mock agent's scenario 3 — `session/request_permission` behaving differently per chosen
      option, **including the `cancelled` outcome** — is implemented
      ([EPIC-04](./EPIC-04-mock-agent.md) KAR-04.2), because KAR-13.4 is untestable without it.
- [ ] `TestClock` with `advance()` is wired into the scheduler, so a six-hour gate costs microseconds
      and no test in this epic ever needs `vi.useFakeTimers()`.

## Definition of Done (epic level)

- [ ] All four stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-13-human-in-the-loop-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes on `ubuntu-26.04` and
      `macos-26`.
- [ ] A run suspended on a `human` node for six simulated hours consumes **zero** CPU samples and
      **one** `node_wake` row, and resumes to the same reduced state — asserted against a file-backed
      ledger reopened by a fresh engine, not against an in-process object.
- [ ] `kill -9` on the daemon while a `human` node is pending, followed by a restart over the same
      `.DeFlow/` directory, leaves the node still pending, still in the approval queue, and still
      answerable — with no duplicate `human.requested` event.
- [ ] A grep for `setTimeout` in `packages/core` and `packages/daemon/src/scheduler` returns hits
      only for the ticker's own sleep hint, and CI fails otherwise.
- [ ] The approval queue returns items from at least two concurrently-running runs in one call, with
      no per-run polling and no second SSE connection.
- [ ] `POST /interject` against an adapter that cannot steer returns `202` with
      `delivery: "unsupported"`, and the projection carries that state so the UI cannot render a
      delivered guidance bubble that never arrived.
- [ ] Every state this epic introduces is traceable to a ledger event (NF10). There is no in-memory
      "pending approvals" map anywhere in the daemon.

## User stories

### KAR-13.1 — Blocking human nodes with cheap suspension

|                 |                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                |
| **Priority**    | P0                                                                                                         |
| **Size**        | M                                                                                                          |
| **Depends on**  | EPIC-06 KAR-06.6, EPIC-06 KAR-06.7, EPIC-03 KAR-03.8                                                       |
| **PRD**         | F8.1, F4.8, F4.4, NF4                                                                                      |
| **Verified by** | EPIC-13-S1, EPIC-13-S2, EPIC-13-S3, EPIC-13-S4, EPIC-13-S5, EPIC-13-S6, EPIC-13-S7, EPIC-13-S8, EPIC-13-S9 |

**As** the Operator, **I want** a `human` node to block its branch indefinitely at effectively zero
cost and to be exactly where I left it after a restart or an overnight suspend, **so that** I can
walk away from a run without deciding in advance how long I will be gone.

The mechanism is [05 §10.1](../../05-durable-execution.md) applied directly. When `decide()` admits
a `human` node it appends `human.requested { node, prompt, options, deadline? }`, appends
`node.suspended { until: { kind: 'human' } }`, and writes one `node_wake` row with
`reason: 'human_gate'` — inside the **same transaction**, because splitting them means a restart
inside the window either loses the wait or double-counts it. The 1 Hz ticker's only job is
`SELECT * FROM node_wake WHERE wake_at <= ?`. A suspended node costs one row and zero CPU.

Nothing about the wait is held in process memory. That is what makes the restart case fall out for
free rather than needing its own recovery path: on boot the daemon replays the ledger, reduces to a
state in which the node is suspended, finds the `node_wake` row, and continues waiting. It is the
same code path a running daemon takes on every tick.

The response is an event too. `human.responded { node, optionId, text?, at }` is what advances the
node, so the decision appears in the timeline, survives a restart, and is attributable — which a
boolean on an object satisfies none of.

**Acceptance criteria**

1. Admitting a `human` node appends `human.requested`, `node.suspended` and the `node_wake` row in
   one SQLite transaction. A crash between them is impossible to observe: a fuzz test that kills the
   daemon at a random point never finds a `human.requested` without its wake row, or vice versa.
2. A six-hour suspension advanced with `clock.advance(hours(6))` completes with the node still
   suspended, exactly one `node_wake` row for it, no additional events appended in the interval, and
   zero agent processes alive.
3. `POST /runs/:id/nodes/:nodeId/respond { optionId }` appends `human.responded` and the node
   resumes on the **same attempt** — no new idempotency key is minted, because a human gate is not a
   retry.
4. Killing the daemon with `SIGKILL` while the node is pending and restarting over the same
   `.DeFlow/` directory leaves the node pending, its `node_wake` row intact, exactly one
   `human.requested` event in the ledger, and the node answerable. `PRAGMA integrity_check` returns
   `ok`.
5. Wall-clock movement does not affect the gate. A test that moves the injected clock backwards
   (the laptop-sleep and NTP case) does not fire the wake early and does not skip it; ordering is by
   `seq`, never by `ts`.
6. `setTimeout` is not used as a wait anywhere in engine code. The regression test asserts directly
   that `setTimeout(fn, 2**31)` fires after ~1 ms — so the reason for the rule is in the suite, not
   only in a comment.
7. `deadline.onTimeout` behaves per its value: `fail` fails the node with a typed reason; `escalate`
   appends a second, higher-visibility `human.requested`; `default` appends
   `human.responded { optionId: deadline.default, by: 'policy' }`. A `default` value naming an
   option id that does not exist is a plan validation error, not a runtime surprise.
8. Each option `effect` does what it says: `approve` completes the node, `reject` fails the branch
   with a typed reason, `edit` accepts a replacement payload validated against the node's
   `returns.schemaId`, `inject` completes the node and carries the operator's text into the
   dependents' packets.
9. Responding twice returns `409` with the original response echoed; the ledger contains exactly one
   `human.responded` for the node.
10. A suspended `human` node blocks only its dependents. Sibling branches with satisfied deps
    continue to be admitted, and the run's status is `running`, not `paused` — a pending approval is
    not a paused run.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                 | Red when                                               |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | unit        | `setTimeout(fn, 2**31)` fires in under 10 ms — the footgun, asserted                                                                 | Nobody believes the comment                            |
| 2   | unit        | `decide()` over a state with an admitted `human` node returns a suspend command carrying a `node_wake` write, not a timer            | The wait is a timer                                    |
| 3   | unit        | `decide()` still admits a sibling node whose deps are satisfied while a `human` node is suspended                                    | Suspension is treated as a run-level pause             |
| 4   | unit        | `deadline.onTimeout` table over `fail`/`escalate`/`default`, plus `default` naming an unknown option → validation error              | The timeout paths are one branch                       |
| 5   | integration | File-backed ledger, `TestClock` advanced six hours: one `node_wake` row, no events in the interval, node still suspended             | The wait is in memory                                  |
| 6   | integration | `human.requested` + `node.suspended` + `node_wake` written in one transaction, asserted by a rollback injection                      | They are three statements                              |
| 7   | integration | `SIGKILL` mid-suspension → reopen with a fresh engine over the same file → node pending, one `human.requested`, `integrity_check` ok | `:memory:` was used, or state lived in the process     |
| 8   | integration | Clock moved backwards by two hours mid-wait → wake still fires at the recorded `wake_at`, ordering asserted on `seq`                 | Logic compares timestamps                              |
| 9   | integration | Second `respond` returns 409 with the original body; one `human.responded` in the ledger                                             | The handler is not idempotent                          |
| 10  | integration | Option effect matrix over `approve`/`reject`/`edit`/`inject`, with `edit` payload validated against `returns.schemaId`               | `edit` accepts anything                                |
| 11  | e2e         | Real daemon on an ephemeral port: a `human` node blocks, an approval is submitted over HTTP, the run advances                        | The engine and the API disagree about the node's state |

**Notes / risks** — the six-hour scenario must run against a **file-backed** database. `:memory:`
cannot be reopened after a simulated crash, which is the one property that matters most here
([testing strategy §7](../../14-testing-strategy.md)). And no test in this story may use
`vi.useFakeTimers()` while a child process is alive: the child's real I/O never arrives and the test
deadlocks for the full 30 s timeout in CI. Advance the injected `Clock`.

---

### KAR-13.2 — The cross-run approval queue

|                 |                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                               |
| **Priority**    | P0                                                                                        |
| **Size**        | M                                                                                         |
| **Depends on**  | KAR-13.1, EPIC-03 KAR-03.5, EPIC-11 KAR-11.4, EPIC-12 KAR-12.3                            |
| **PRD**         | F8.3, NF10                                                                                |
| **Verified by** | EPIC-13-S10, EPIC-13-S11, EPIC-13-S12, EPIC-13-S13, EPIC-13-S14, EPIC-13-S15, EPIC-13-S16 |

**As** the Operator, **I want** one surface listing everything waiting on me across every run,
**so that** I never discover a nine-hour run that has been blocked since hour two because I was
looking at a different tab.

`GET /api/approvals` is the endpoint ([11 §6](../../11-api-and-realtime.md)) and the queue is a
**projection over the ledger**, not a table. That is not purity; it is the only way it can be
correct. An in-memory pending map evaporates on restart, and the first thing that happens after a
restart is that several runs resume at once — precisely when the queue matters most. It is also
NF10: every row in the queue must be traceable to the event that created it, and clicking a row must
deep-link to that event's node.

Eight things can wait on a human, and the queue is not useful unless it carries all of them:

| Kind                | Source event                                         | What the Operator decides                                |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `human-node`        | `human.requested`                                    | Choose an option (F8.1)                                  |
| `patch`             | `plan.patch.proposed` with a `queued` decision       | Approve or reject (F2.5)                                 |
| `gate-needs-human`  | `gate.evaluated` with `outcome: 'needs-human'`       | Judge, or accept a red gate explicitly                   |
| `reconcile-unknown` | `node.failed` with `effect.reconcile-unknown`        | _"It ran"_ or _"it didn't"_ — no automatic answer exists |
| `budget`            | `budget.exceeded`                                    | Raise the ceiling or stop (F4.6 pauses, never fails)     |
| `churn`             | `run.needs_human { reason: 'churn' }`                | Change the approach, or stop                             |
| `tainted`           | `fact.invalidated` with a non-empty `taints` list    | Re-run, abandon or accept the stale input                |
| `permission`        | an escalated `session/request_permission` (KAR-13.4) | Allow or reject, once or always                          |

The transport detail that makes this cheap is the `runs=*` topic. One SSE connection per tab is an
architecture constraint, not a tuning knob — HTTP/1.1 caps concurrent connections per origin at
about six, and an SSE connection never closes, so one stream per run panel across three tabs
exhausts the budget and every subsequent `fetch` silently queues forever. `runs=*` subscribes to the
low-volume global lifecycle topic only — `run.created`, `run.completed`, `run.aborted`,
`human.requested` — which is exactly what the queue needs and does not drag a single `node.progress`
frame into an idle tab.

**Acceptance criteria**

1. `GET /api/approvals` returns items from every run with something pending, in one call, ordered
   oldest-first by the `seq` of the event that created them, with the run id, node id, kind, prompt
   or summary, the creating `seq`, and an age.
2. All eight kinds in the table above appear in the queue, and each carries enough to decide without
   a second request: a patch item carries `estimate { costUsdDelta, blastRadiusFiles, maxPermission,
replanDepth }` and the `reason`; a `reconcile-unknown` item carries the effect row and both
   reconciliation hashes; a `gate-needs-human` item carries the verdict's findings and the reason.
3. The queue is computed from reduced state with no auxiliary table. Deleting the projection cache
   and replaying the ledger produces an identical queue — asserted by a snapshot comparison.
4. The queue survives a daemon restart with no re-notification and no duplication: an item pending
   before `SIGKILL` is present exactly once afterwards, with the same creating `seq`.
5. A client subscribed with `runs=*` receives `human.requested` from any run within one tick, and
   receives **no** `node.progress` frames — asserted by counting frames by `kind`, not by eyeballing
   a log.
6. Answering an item accepts `ifLastSeq`. If the run's head has advanced in a way that changes the
   decision surface — the patch was auto-applied on the policy timer while the Operator was reading
   — the response is `409 stale_cursor` carrying the current head, and nothing is applied.
7. Deciding an already-decided patch returns `409 patch_already_decided` with the **original**
   decision in the body, so the UI can show what actually happened rather than double-applying.
8. Resolving an item removes it from the queue on the next projection, and the removal reaches a
   subscribed client over the existing connection without a reconnect.
9. Per-run counts are exposed alongside the queue so the run list can show a badge without a second
   query.
10. Adding a run panel does not open a second SSE connection: the client mutates the filter with
    `POST /api/stream/:streamId/subscribe` and the daemon backfills that run from the client's
    cursor before resuming live delivery.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                      | Red when                                                       |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | unit        | `approvalsProjection(state)` over a hand-built multi-run state returns all eight kinds, ordered by creating `seq`         | The projection knows about human nodes only                    |
| 2   | unit        | Each kind's item carries its decision payload — table-driven over the eight                                               | Items are `{ runId, nodeId }` stubs and the UI has to re-fetch |
| 3   | unit        | Replaying the ledger from `seq` 0 produces a queue identical to the cached projection                                     | The queue is accumulated rather than derived                   |
| 4   | integration | Two concurrent runs on one file-backed ledger, one pending item each: one `GET /approvals` returns both                   | The endpoint is per-run                                        |
| 5   | integration | `SIGKILL` with three items pending → restart → the same three items, same creating `seq`s, no duplicates                  | Pending state lived in memory                                  |
| 6   | integration | A stream opened with `runs=*` receives `human.requested` and zero `node.progress` frames while a noisy run streams output | The topic filter is not applied server-side                    |
| 7   | integration | Approve a patch with a stale `ifLastSeq` after the policy timer auto-applied it → `409 stale_cursor`, nothing applied     | Optimistic concurrency is missing                              |
| 8   | integration | Decide an already-decided patch → `409 patch_already_decided` with the original decision                                  | The second decision overwrites the first                       |
| 9   | integration | Resolving an item removes it and the removal arrives on the same connection                                               | The client has to poll                                         |
| 10  | e2e         | Two runs on a real daemon; the queue drives both to completion from one connection                                        | Per-panel connections were reintroduced                        |

**Notes / risks** — the `ifLastSeq` requirement is not theoretical. Patches are auto-applied on a
policy timer (F2.5), so _"the panel went stale while the Operator read it"_ is the normal case, not
an exotic one ([11 §11](../../11-api-and-realtime.md)). The `409` is a feature: it is how the UI
learns to re-render rather than silently applying a decision to a world that moved.

---

### KAR-13.3 — Interjection into a running node

|                 |                                                                 |
| --------------- | --------------------------------------------------------------- |
| **Status**      | Not started                                                     |
| **Priority**    | P0                                                              |
| **Size**        | M                                                               |
| **Depends on**  | KAR-13.1, EPIC-05 KAR-05.1, EPIC-05 KAR-05.2, EPIC-09 KAR-09.2  |
| **PRD**         | F8.2, F8.5 (P1, honestly degraded), F4.4                        |
| **Verified by** | EPIC-13-S17, EPIC-13-S18, EPIC-13-S19, EPIC-13-S20, EPIC-13-S21 |

**As** the Operator watching a node go the wrong way, **I want** to hand it a correction without
throwing the run away, **so that** watching a run is useful rather than merely painful.

`POST /api/runs/:id/interject { nodeId, text, mode, ifLastSeq }` with `mode: 'next-turn' |
'pause-and-inject'`, answering `202` with `{ seq, delivery }` where `delivery` is `queued`,
`delivered` or `unsupported` ([11 §7.5](../../11-api-and-realtime.md)). The design decision that
carries the story is that **`unsupported` is a `202`, not an error**: F8.5 is P1 and
adapter-dependent, the capability matrix is genuinely uneven, and the UI must render that honestly
rather than showing a delivered guidance bubble that never arrived. An error would be worse in both
directions — it implies the Operator did something wrong, and it invites a retry that will also not
work.

`next-turn` queues the text so it enters the node's next turn where the adapter supports mid-turn
steering. `pause-and-inject` is the mode that always works: the node is suspended at the next safe
boundary, the guidance becomes part of the packet, and the node resumes **on the same attempt** with
the same idempotency key. The run is never discarded, and no completed effect is re-executed.

The guidance enters the next context packet as an attributed segment — provenance `human`, the
Operator's text verbatim — so it appears in the node inspector (F10.3) alongside everything else the
node received. It is not silently prepended to a prompt where nobody can find it later.

**Acceptance criteria**

1. `POST /interject` appends a `human.interjected` event carrying `{ node, text, mode }` and returns
   `202 { seq, delivery }`. The returned `seq` is the appended event's, so the client can immediately
   position its cursor.
2. `delivery: 'delivered'` is returned only when the adapter's capability row says it can steer
   mid-turn **and** the text was handed to the live session. `queued` means accepted and not yet
   delivered. `unsupported` means the adapter cannot, and is returned with `202`, never `4xx`.
3. `mode: 'pause-and-inject'` suspends the node at the next safe boundary, includes the guidance in
   the re-assembled packet, and resumes on the **same attempt** and the same idempotency key. No
   completed effect is re-executed and no `node.retry.scheduled` event is appended.
4. The run is not discarded, cancelled or reset by any interjection path. The run status before and
   after an interjection differs only if the mode was `pause-and-inject`, and then only for the
   duration of the pause.
5. The guidance appears in the next `context.built` packet manifest as a segment with provenance
   `human` and the text byte-identical to what was posted.
6. Interjecting into a node that completed between the Operator's read and the post returns
   `409 stale_cursor` when `ifLastSeq` was supplied, and `404 node_not_found`-shaped `409` semantics
   with a typed code when it was not. Nothing is appended in either case.
7. Interjecting into a suspended `human` node is rejected with a typed error naming
   `POST /nodes/:nodeId/respond` as the correct call — two mechanisms for "tell the run something"
   is confusing enough without them silently overlapping.
8. Multiple interjections before the next turn are delivered in `seq` order and all appear in the
   packet; none is dropped or coalesced silently.
9. The `delivery` value is carried on the projection the UI reads, so an `unsupported` interjection
   renders as undelivered rather than as a delivered message.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                         | Red when                                 |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | unit        | The interject service returns `unsupported` for a capability row without steering, `queued` for one with it, both with a `202`-shaped result | `unsupported` throws                     |
| 2   | unit        | Interjecting a suspended `human` node returns the typed "use respond" error                                                                  | The two paths overlap                    |
| 3   | unit        | Two interjections before the next turn both appear in the assembled packet, in `seq` order                                                   | The second overwrites the first          |
| 4   | integration | Mock agent scripted to accept mid-turn steering: `delivered`, and the text appears in the next `session/prompt` frame                        | Delivery is assumed rather than observed |
| 5   | integration | Mock agent with steering disabled via `--capabilities`: `202 unsupported`, no frame sent, projection shows undelivered                       | The daemon pretends                      |
| 6   | integration | `pause-and-inject` on a live node: `node.suspended`, packet rebuilt with the segment, resume with the same `ikey`, no re-executed effect     | Resume mints a new attempt               |
| 7   | integration | Golden packet snapshot containing the `human`-provenance segment                                                                             | Guidance is spliced into a prompt string |
| 8   | integration | Node completes between read and post with a stale `ifLastSeq` → `409 stale_cursor`, nothing appended                                         | The write lands on a finished node       |
| 9   | e2e         | Real daemon: a run is interjected mid-node and completes; the ledger shows one `human.interjected` and no cancellation                       | The run is discarded and restarted       |

**Notes / risks** — the API contract returns a `seq` from `POST /interject`, so an event must exist;
this story names it `human.interjected` (v1) and contributes the payload and its upcaster slot to
the union owned by [EPIC-02](./EPIC-02-domain-model.md) KAR-02.7. Adding an event kind is explicitly
**not** a breaking change by construction — the reducer ignores unknown kinds and the envelope
carries `v` ([11 §12](../../11-api-and-realtime.md)) — but the slot needs to exist before this epic
writes to it, which is why it is a Definition-of-Ready item rather than a task.

---

### KAR-13.4 — Permission escalation requests reaching the operator

|                 |                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                               |
| **Priority**    | P0                                                                                        |
| **Size**        | M                                                                                         |
| **Depends on**  | KAR-13.1, KAR-13.2, EPIC-08 KAR-08.1, EPIC-08 KAR-08.3, EPIC-05 KAR-05.1                  |
| **PRD**         | F5.4, F5.6, F8.1, F8.3                                                                    |
| **Verified by** | EPIC-13-S22, EPIC-13-S23, EPIC-13-S24, EPIC-13-S25, EPIC-13-S26, EPIC-13-S27, EPIC-13-S28 |

**As** the Operator, **I want** the small number of permission requests that actually need me to
arrive with the command, the resolved path, the rule that matched and the node's declared scope,
**so that** I can decide in five seconds and am not trained to click _allow_ by a stream of requests
I did not need to see.

DeFlow is the ACP **client**, so it implements `session/request_permission` and sits in the path of
every file access and every command execution
([09 §8](../../09-workspace-and-safety.md)). **DeFlow auto-responds to routine requests from the
policy table — no human in the loop — and escalates to the Operator only for the gated categories.**
That split is the story: a system that asks about everything is a system whose _allow_ button gets
pressed reflexively, which is exactly the ambient-authority failure the Kiro incident turned on.
[09 §10.5](../../09-workspace-and-safety.md) is explicit that **human gates belong at the
network-egress and identity boundary, not at the command boundary**.

An escalation is a `human` node like any other — same suspension, same queue, same
`human.responded` — with a payload built for a five-second decision: the `command`, `args`, `cwd`
and the _resolved_ path (post-`realpath`, so a symlink pointing outside the worktree is visible as
what it is), the `ToolCallLocation.path` the agent supplied, which policy rule matched and why, the
node's `permission` level and declared `pathScopes`, and the node's brief.

The four `PermissionOptionKind` values — `allow_once`, `allow_always`, `reject_once`,
`reject_always` (**verified 2026-08-02** from `@agentclientprotocol/sdk@1.3.0`) — are the options
DeFlow offers back, and `{outcome: 'cancelled'}` is a first-class `RequestPermissionOutcome`, not an
error. The `_always` variants scope to the run, never to the machine: a decision made about one
agent's session must not silently authorise a different run tomorrow.

**Acceptance criteria**

1. A request the policy table answers is auto-responded within one tick with no `human.requested`
   event and no queue item — asserted by counting `human.requested` events across a run in which the
   agent makes twenty routine `fs/read_text_file` calls inside its scope.
2. A request in a gated category — network egress, an identity/credential boundary, a command
   outside the allowlist, a write resolving outside the worktree — appends `human.requested` with
   the full context payload above, and the queue item carries it without a second request.
3. The resolved path is shown, not only the requested one. A request for `./tmp/x` where `tmp` is a
   symlink to `/etc` shows the post-`realpath` target, because that is the fact the decision turns
   on.
4. Each of the four `PermissionOptionKind` values behaves as named for the remainder of the run:
   `allow_once` / `reject_once` apply to that call only; `allow_always` / `reject_always` are
   recorded as run-scoped policy and applied to subsequent matching requests without a second
   prompt. Neither `_always` variant persists past the run.
5. `{outcome: 'cancelled'}` is handled as a first-class outcome: the node is not failed with a
   protocol error, the cancellation is recorded, and the agent's turn ends per the adapter's
   contract.
6. An escalation inherits the `HumanNode.deadline` semantics. On expiry with
   `onTimeout: 'default'`, DeFlow answers with the declared default option — which for an escalation
   is `reject_once` — and records `human.responded { by: 'policy' }`. Leaving an agent session open
   indefinitely is not free, and a silent hang is a worse answer than a recorded refusal.
7. An adapter whose capability row reports `mediatedExecution: false` is **refused scheduling** for
   any node above `read`, rather than being silently escalated to the Operator or silently granted
   (F5.4). The refusal names the adapter and the level.
8. A permission escalation outstanding when the daemon is `SIGKILL`ed cannot be answered after
   restart — the agent process and its session are gone. The node fails with a typed reason naming
   the lost session, the escalation is removed from the queue, and the node is re-scheduled as a new
   attempt. It does not sit in the queue forever attached to a dead process.
9. Every auto-response and every escalation is a ledger event, so a run's complete permission history
   is reconstructable after the fact (NF10) — including the ones no human ever saw.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                  | Red when                                        |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | unit        | The policy function's escalate/auto decision, table-driven over the four ladder levels × the gated categories                         | Everything escalates, or nothing does           |
| 2   | unit        | The escalation payload builder produces command, args, cwd, resolved path, matched rule, node permission and pathScopes               | The payload is a message string                 |
| 3   | unit        | `_always` decisions are stored run-scoped and are absent from a second run's state                                                    | The decision persists to config                 |
| 4   | integration | Mock agent scenario 3: twenty in-scope `fs/read_text_file` calls → zero `human.requested` events                                      | Routine calls reach the Operator                |
| 5   | integration | Mock agent requests `terminal/create` for `curl https://example.com` at `worktree` level → escalation with the matched rule named     | Egress is auto-denied silently, or auto-allowed |
| 6   | integration | A symlinked path resolving outside the worktree → the payload shows the `realpath` target                                             | Only the requested path is shown                |
| 7   | integration | Option-kind matrix: a second matching request after `allow_always` is auto-answered; after `allow_once` it prompts again              | `_always` is not implemented                    |
| 8   | integration | Mock agent scripted to produce `{outcome: 'cancelled'}` → recorded, node not failed with a protocol error                             | Cancellation is an exception                    |
| 9   | integration | Deadline expiry with `onTimeout: 'default'` → `reject_once` recorded with `by: 'policy'`                                              | The escalation waits forever                    |
| 10  | integration | `mediatedExecution: false` capability row → node refused scheduling with a typed error                                                | The adapter is silently escalated               |
| 11  | integration | `SIGKILL` with an escalation outstanding → restart → node failed with the lost-session reason, queue item gone, new attempt scheduled | The queue holds a request nothing can answer    |

**Notes / risks** — A5-1 sits underneath this story: Claude Code's sandbox settings are version-gated
at fine granularity (`credentials` ≥ 2.1.187, `mask` ≥ 2.1.199, `filesystem.disabled` ≥ 2.1.216,
`strictAllowlist` ≥ 2.1.219), and without `sandbox.failIfUnavailable: true` the sandbox **silently**
runs unsandboxed when bubblewrap or socat are missing. That is EPIC-08's control to implement, but
it changes what this epic escalates: if the ladder is decorative on a platform, the categories that
must reach the Operator widen. Assert the version-sniff result in the escalation payload so the
Operator can see which enforcement was actually in effect when they decide.

---

## Risks

| Risk                                                                                                                                                    | Severity | Mitigation                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The HTTP surface belongs to EPIC-15, which depends on EPIC-11.** If EPIC-15 slips, this epic's handlers have no transport.                            | Medium   | Every handler is written as a service function first and exercised through it, which is the same code path EPIC-15 mounts. The `DeFlow` CLI (EPIC-18) can also drive them. Only the e2e rows in the test plans block on EPIC-15.                                                                                       |
| **A1-5 — `reconcile()` returning `'unknown'` has no correct automatic action**, and this epic is where the product answer lives.                        | High     | The `reconcile-unknown` queue kind is a first-class item in KAR-13.2 with the effect row and both reconciliation hashes attached. If it turns out to be common in practice, the escalation is a content-addressed overlay — large complexity, and explicitly not pre-built ([05 §9.3](../../05-durable-execution.md)). |
| **Alert fatigue: escalate too much and the _allow_ button becomes reflexive**, which is precisely the ambient-authority failure F5.6 exists to prevent. | High     | KAR-13.4 AC-1 makes it measurable rather than a matter of taste: twenty routine in-scope reads must produce zero `human.requested` events. Track escalations per run as a metric from the first real run and treat a rise as a policy-table bug.                                                                       |
| **F8.5 steering is adapter-dependent and may be unsupported on every installed adapter at M1.**                                                         | Medium   | `delivery: 'unsupported'` with a `202` is the designed-in honest degradation, and `pause-and-inject` always works. The risk is only that the nicer mode is unavailable, not that interjection is.                                                                                                                      |
| **A permission escalation ties up a live agent session** for as long as the Operator is away, and vendor sessions may time out on their own.            | Medium   | KAR-13.4 AC-6 gives escalations a deadline defaulting to `reject_once`, and AC-8 defines the restart path. Both are worse than an infinitely patient agent and better than a run that silently wedges.                                                                                                                 |
| **Two mechanisms for "tell the run something"** — `respond` and `interject` — could overlap confusingly.                                                | Low      | KAR-13.3 AC-7 makes interjecting a suspended `human` node a typed error naming the correct call.                                                                                                                                                                                                                       |

---

**Related:** [Flows](../flows/EPIC-13-human-in-the-loop-flows.md) · [Board](../board.md) ·
[Verification gates](../../10-verification-gates.md) ·
[API and realtime](../../11-api-and-realtime.md) ·
[Durable execution](../../05-durable-execution.md) ·
[Verification gates epic](./EPIC-12-verification-gates.md)

[← Back to the delivery plan](../README.md)
