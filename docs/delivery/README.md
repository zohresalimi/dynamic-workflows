# DeFlow delivery plan

> How the architecture in [`../README.md`](../README.md) becomes working software, one story at a
> time, built by one person alongside a job and a degree.

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026 · **Board:** [board.md](./board.md)

---

## 1. What this is

Three documents already exist and none of them is a plan.

| Document                                     | What it settles                                                                                 | What it does not                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| [PRD](../prd.md)                             | _What_ DeFlow is, the `F`/`NF`/`AR-1` requirement ids, the priorities, the success metrics      | Any build order                    |
| [Architecture set](../README.md) (`01`–`17`) | _How_ it works — mechanisms, verified numbers, exact flags, locked decisions                    | What to do on Tuesday              |
| [Roadmap](../17-roadmap.md)                  | The M0 spikes, the twelve M1 workstreams W0–W12 and their dependencies, the open-risks register | Anything smaller than a workstream |

This directory is the missing layer: **workstreams broken into epics, epics into stories, stories
into scenarios, scenarios into tests.** It exists so that at any moment there is exactly one obvious
next thing to work on, and so that "is this done?" has an answer that is not a feeling.

It is a tool, not a contract. Nobody is holding you to it. See §8.

## 2. How to read the backlog

### Identifiers

- **Epics** — `EPIC-00` … `EPIC-22`, one file each in [`epics/`](./epics), mapped onto a roadmap
  workstream. `EPIC-21` was the one exception until 2026-08-16 — planned in Linear (`MET-795`) with
  no file, and deliberately absent from the board's totals rather than silently counted. It is now
  authored under §9, ahead of its first story, and counted like every other epic.
- **Stories** — `KAR-<epic>.<n>`, e.g. `KAR-03.4` is the fourth story of EPIC-03. They live inside
  the epic file.
- **Scenarios** — `EPIC-NN-S<m>`, e.g. `EPIC-03-S7`, in the matching file in [`flows/`](./flows).
  Every scenario declares which story it verifies.

Numbers are stable. A story is never renumbered and never deleted; it is descoped, deferred or
split, and the record of that is the point.

### The traceability chain

```
PRD requirement  →  story  →  scenario  →  automated test
     F4.2            KAR-03.8      EPIC-03-S14        packages/ledger/test/integration/…
```

It reads in both directions, which is the whole reason it is worth maintaining:

- **Forward:** every P0 requirement in the M1 scope is covered by at least one story. The
  [board](./board.md) reconciles this, and a requirement with no story is a visible hole rather than
  a surprise in month four.
- **Backward:** every story cites at least one requirement. A story that cannot cite one is either
  mis-scoped or is ceremony, and ceremony does not survive a solo build.

Each story's **Verified by** list names its scenarios; each scenario's **Verifies** line names its
stories. If those two disagree, one of them is wrong — that check is mechanical and belongs on the
board.

### The flow files _are_ the acceptance specifications

This is the part that is easy to get wrong. The epic file is a product manager's document: goal,
scope, sizing, sequencing, acceptance criteria at the level of _outcomes_. The flow file is a
business analyst's document, and it is the **behavioural specification the tests are written from**.

- Every scenario's Then clauses are observable: a real event kind, a real table, a real error string,
  a real exit code. _"Then the ledger contains a `node.failed` event with `reason: 'timeout'`"_ — not
  _"then the system handles the error"_.
- Every scenario names the level it is automated at: unit / integration / contract / e2e / browser /
  manual.
- The behaviour space is covered, not just the happy path — roughly two to four non-happy scenarios
  per happy one, including the verified footguns.

You should be able to open a flow file and write the test suite from it without asking a question.
If you find yourself inventing behaviour while writing a test, the specification was incomplete:
fix the flow file first, then write the test. That order matters, because the flow file is what the
next person — including future you — will read.

## 3. The TDD working agreement

DeFlow's testing strategy is specific and non-obvious. Read
[14-testing-strategy.md](../14-testing-strategy.md) once in full; this section is the working
agreement distilled from it, not a replacement.

### The loop

**Red → green → refactor, and the red must be observed.** Not inferred, not assumed from a compile
error — run the test, watch it fail for the reason you expect, then make it pass. A test written
after the implementation asserts what the code does, which is a tautology dressed as a specification.
**A story is not Done if its tests were written after the implementation.** Nobody will catch you.
That is exactly why it is written down.

### Which level to reach for

| Level         | Reach for it when                                                                                                                                                                    | Cost                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `unit`        | Pure logic: `reduce()`, `decide()`, projections, patch policy, packet rendering, the permission ladder, path scoping. **Should be ~80% of the test count** and run in about a second | free                   |
| `integration` | Anything touching a real subprocess, real `git`, or a real SQLite file. 30 s timeout, `pool: 'forks'`                                                                                | seconds                |
| `e2e`         | Cross-process behaviour only: a real `DeFlowd` on an ephemeral port. `singleFork`, no file parallelism, 180 s                                                                        | slow, flaky, budget ~5 |
| `web`         | Anything with geometry — Vue Flow, d3, xterm. Real Chromium                                                                                                                          | slow                   |

The default answer is `unit`. Reach up a level only when the behaviour genuinely lives at the
boundary — and when it does, do not fake the boundary (below).

### The six DeFlow-specific constraints

These are not style preferences. Each one exists because the alternative removes exactly the surface
where the bugs live.

1. **Fake binaries, not mocked modules.** `@DeFlow/mock-agent` and the testkit's fake exec-shim agent
   are real executables on a temp `PATH`. **Never mock `child_process` / `spawn`** — it tests your
   mock, and the parser, framing, backpressure, timeout and kill paths all go untested.
   ([§3](../14-testing-strategy.md))
2. **Real git, real tmpdirs.** `git init` into an `fs.mkdtemp` directory with
   `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null` and forced author/committer identity
   — without it your own `~/.gitconfig` silently changes test outcomes, which is the classic "passes
   locally, fails in CI" and its confusing inverse. Never `isomorphic-git` (no worktree support at
   all), never `memfs` downstream of a spawn (a real process cannot see a virtual filesystem).
   ([§5, §6](../14-testing-strategy.md))
3. **File-backed SQLite for anything durability-related.** `:memory:` cannot exercise WAL, cannot be
   reopened after a simulated crash, and hides fsync and ordering bugs — it cannot test F4.2, which
   is the entire durability thesis. Test resume by `db.close()` and constructing a fresh engine over
   the same file. `:memory:` is for pure projection unit tests and nothing else.
   ([§7](../14-testing-strategy.md))
4. **Time enters through the injected `Clock` port** — `now()`, `sleep()`, `setTimer()` — never
   `Date.now()` or `setTimeout` in engine code (NF9). Advance a `TestClock` manually, and a six-hour
   human gate runs in microseconds. ([§8](../14-testing-strategy.md))
5. **Never use fake timers while a child process is alive.** `vi.useFakeTimers()` freezes the event
   loop's timers, the child's real I/O never arrives, and you deadlock — usually as a test that
   passes locally and hangs for the full 30 s timeout in CI. Retry backoff, budget ceilings,
   no-progress detection and long suspension are all _about time around child processes_, so this is
   not a corner case. ([§8](../14-testing-strategy.md))
6. **Register the normalising snapshot serializer before writing the first snapshot.** Normalise
   timestamps, run/node/event ids, durations, absolute paths, ports and worktree directory names —
   or every snapshot changes on every run and you learn to `-u` past them, which is worse than having
   no snapshots. ([§9](../14-testing-strategy.md))

One more, inherited from the process-tree work: **any kill-verification assertion must exclude
`Z`-state processes.** After a _successful_ group SIGKILL, `ps` still lists the grandchildren as
zombies with `ppid=1`. A naive assertion concludes the kill failed when it did not.
([§10](../14-testing-strategy.md))

### What a story's test plan must look like

Every story carries a **Test plan (TDD)** table naming real levels and real mechanisms, with a
`Red when` column stating what makes each test fail before the implementation exists. A row that
says "write unit tests" is a failure of the story, not of the tester.

## 4. Definition of Ready

### Story level

- [ ] It cites at least one PRD requirement id.
- [ ] Its `Depends on` stories are `Done` — or the dependency is genuinely soft and that is stated.
- [ ] The architecture section it implements is identified, and it actually specifies the mechanism
      (not "to be decided").
- [ ] Its scenarios exist in the epic's flow file and their Then clauses are observable.
- [ ] Its Test plan names test levels and mechanisms that exist in
      [14-testing-strategy.md](../14-testing-strategy.md).
- [ ] It is `M` or smaller, or it is honestly `L` and the reason is stated. `XL` is never Ready —
      split it.

### Epic level

- [ ] Every dependency epic is `Done`, or the specific stories it needs are.
- [ ] The M0 spike that de-risks it (if any) has produced a working command or a written reason the
      plan changes.
- [ ] Its own **Definition of Ready** checklist in the epic file is satisfied.

## 5. Definition of Done

### Story level

- [ ] The acceptance criteria are all demonstrably met.
- [ ] **Every scenario in the epic's flow file that names this story is automated and passing** at
      the level it declares.
- [ ] **The red was observed** before the green, for each test in the plan.
- [ ] `pnpm typecheck`, `pnpm lint` and the affected test projects pass locally and in CI on
      `ubuntu-26.04` and `macos-26`, Node 24 and 26.
- [ ] **No new `Unverified` claim was introduced without an entry in the open-risks register**
      ([roadmap §6](../17-roadmap.md)) naming what would close it. Discovering an unknown is fine;
      leaving it undeclared is not — AR-6 applies to the delivery plan as much as to the
      architecture.
- [ ] Anything learned that contradicts an architecture doc is written back into that doc in the
      same session. A stale architecture doc is worse than none, because it is trusted.

### Epic level

- [ ] All its stories are `Done`.
- [ ] Its whole flow file passes as automated tests.
- [ ] No `Unverified` claim from the architecture docs in this area remains unverified — or each
      surviving one has an explicit, recorded reason.
- [ ] Its own **Definition of Done** checklist in the epic file is satisfied.
- [ ] Every PRD requirement listed in the epic header is covered by a story, or the gap is written
      into the epic's Risks or Out-of-scope section. Silently dropping one is the failure mode this
      check exists for.

## 6. Vocabularies

Use exactly these. The board parses them.

**Status** — `Not started` · `Ready` · `In progress` · `Blocked` · `In review` · `Done`

Everything starts at `Not started`. A story moves to `Ready` only when its Definition of Ready is
satisfied — which, for most stories, means an earlier story finished first. Be honest: an optimistic
`Ready` column is how a plan stops being usable.

**Sizing** — `XS` (< ½ day) · `S` (½–1 day) · `M` (2–3 days) · `L` (4–5 days) · `XL` (> 1 week —
**split it**)

Days are _working days for one person alongside a job and a degree_, not ideal engineering days. An
epic totalling more than ~15 days says so in its Risks section rather than pretending.

**Priority** — `P0` required for M1 personal use · `P1` required before showing colleagues (M2) ·
`P2` team scale (M3+)

Inherited from the PRD's own F-number priorities. Do not invent new ones, and do not promote a P1 to
P0 because it is interesting.

## 7. The epics

| Epic    | Title                                                                               | W             | Docs                                                  |
| ------- | ----------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------- |
| EPIC-00 | [Foundation spikes](./epics/EPIC-00-foundation-spikes.md)                           | M0            | [flows](./flows/EPIC-00-foundation-spikes-flows.md)   |
| EPIC-01 | [Development environment and toolchain](./epics/EPIC-01-dev-environment.md)         | pre-W0        | [flows](./flows/EPIC-01-dev-environment-flows.md)     |
| EPIC-02 | [Domain model and schemas](./epics/EPIC-02-domain-model.md)                         | W0            | [flows](./flows/EPIC-02-domain-model-flows.md)        |
| EPIC-03 | [Event ledger and durable state](./epics/EPIC-03-event-ledger.md)                   | W1            | [flows](./flows/EPIC-03-event-ledger-flows.md)        |
| EPIC-04 | [Deterministic mock agent](./epics/EPIC-04-mock-agent.md)                           | W2            | [flows](./flows/EPIC-04-mock-agent-flows.md)          |
| EPIC-05 | [Provider adapter layer](./epics/EPIC-05-provider-adapters.md)                      | W3            | [flows](./flows/EPIC-05-provider-adapters-flows.md)   |
| EPIC-06 | [Orchestrator: scheduling and durable effects](./epics/EPIC-06-orchestrator.md)     | W4            | [flows](./flows/EPIC-06-orchestrator-flows.md)        |
| EPIC-07 | [Workspace isolation and git orchestration](./epics/EPIC-07-workspace-isolation.md) | W5a           | [flows](./flows/EPIC-07-workspace-isolation-flows.md) |
| EPIC-08 | [Permission ladder and execution boundary](./epics/EPIC-08-safety-model.md)         | W5b           | [flows](./flows/EPIC-08-safety-model-flows.md)        |
| EPIC-09 | [Context assembly and memory](./epics/EPIC-09-context-memory.md)                    | W6            | [flows](./flows/EPIC-09-context-memory-flows.md)      |
| EPIC-10 | [Task intake and framing](./epics/EPIC-10-task-intake.md)                           | W7a           | [flows](./flows/EPIC-10-task-intake-flows.md)         |
| EPIC-11 | [Dynamic planning and patch policy](./epics/EPIC-11-dynamic-planning.md)            | W7b           | [flows](./flows/EPIC-11-dynamic-planning-flows.md)    |
| EPIC-12 | [Verification gates and the repair loop](./epics/EPIC-12-verification-gates.md)     | W8a           | [flows](./flows/EPIC-12-verification-gates-flows.md)  |
| EPIC-13 | [Human-in-the-loop and approvals](./epics/EPIC-13-human-in-the-loop.md)             | W8b           | [flows](./flows/EPIC-13-human-in-the-loop-flows.md)   |
| EPIC-14 | [Cost, budget and quota governance](./epics/EPIC-14-cost-governance.md)             | cross-cutting | [flows](./flows/EPIC-14-cost-governance-flows.md)     |
| EPIC-15 | [Daemon API and event stream](./epics/EPIC-15-daemon-api.md)                        | W9            | [flows](./flows/EPIC-15-daemon-api-flows.md)          |
| EPIC-16 | [Web UI foundation and projection store](./epics/EPIC-16-ui-foundation.md)          | W10           | [flows](./flows/EPIC-16-ui-foundation-flows.md)       |
| EPIC-17 | [P0 visualisation views](./epics/EPIC-17-p0-views.md)                               | W11           | [flows](./flows/EPIC-17-p0-views-flows.md)            |
| EPIC-18 | [CLI, doctor and packaging](./epics/EPIC-18-cli-packaging.md)                       | W12           | [flows](./flows/EPIC-18-cli-packaging-flows.md)       |
| EPIC-19 | [The live run pipeline, end to end](./epics/EPIC-19-live-run-pipeline.md)           | W13           | [flows](./flows/EPIC-19-live-run-pipeline-flows.md)   |
| EPIC-20 | [One-command install and a lowercase command](./epics/EPIC-20-install-and-naming.md) | W14           | [flows](./flows/EPIC-20-install-and-naming-flows.md)  |
| EPIC-21 | [Interactive CLI: a real terminal app, not a background command](./epics/EPIC-21-interactive-cli.md) | W16           | [flows](./flows/EPIC-21-interactive-cli-flows.md)     |
| EPIC-22 | [Web control center: projects, chat-driven runs, live boards](./epics/EPIC-22-web-control-center.md) | W15           | [flows](./flows/EPIC-22-web-control-center-flows.md)  |

Live status, sizing rollups and requirement coverage are on the [board](./board.md). This table is
the index; the board is the state.

## 8. Working cadence for one person

**Picking the next story.** In order, take the first that applies:

1. A `Blocked` story you can now unblock. Blocked work rots.
2. The next `Ready` story on the [critical path](../17-roadmap.md#21-the-critical-path) — the chain
   `W0 → W1 → W4 → W6 → W7 → W9 → W10 → W11`. Everything else is slack.
3. A `Ready` story in the epic you were already in, because context-switch cost is real and you have
   very little of the day to spend on it.
4. Anything `Ready` and `S` or `XS`, if the available time is under an hour.

Do not pick by interest. The interesting work is the visualisation and it is at the _end_ of the
chain for a reason: a view built against a hand-rolled fixture gets rebuilt against the real stream.

**The critical path is what protects you.** Two orderings in it are non-negotiable and both are
counter-intuitive: **W1 before everything** (everything is a projection of the ledger) and **W2
before W3** (the mock binary is what makes the ACP client testable without spending credits). W1 and
W2 can share a week — they touch no common code, and the mock agent is a pleasant break from reducer
work.

**When you are blocked.** Say which kind:

- _Blocked on knowledge_ → it is a spike. Timebox it, write down the answer, and record it in
  [research-findings.md](../research-findings.md) or the relevant architecture doc. A spike that ends
  in "seems fine" has not run.
- _Blocked on an earlier story_ → set `Blocked`, name the blocker in the story, and drop down the
  picking list. Do not start the blocked work anyway with a stub; the stub will ship.
- _Blocked on the outside world_ (a vendor CLI, an upstream bug) → it belongs in the
  [open-risks register](../17-roadmap.md#6-consolidated-open-risks-register) with what would close
  it, and the story gets a fallback path or is deferred. Waiting is not a plan.

**Cadence.** Aim to finish something every session, even if it is `XS`. A `Done` story on a Tuesday
evening is worth more than three half-built `M`s, because half-built work has to be re-loaded into
your head every time and this project is measured in months.

**And the honest part.** This plan will be wrong. Estimates on a solo build alongside a job and a
degree are guesses, several epics depend on things that are still `Unverified`, and the vendor
surface underneath moves monthly. The plan's job is to make the _next_ decision cheap, not to predict
March. When it stops doing that, change it — the next section says how.

## 9. Changing the plan

**Adding a story.** Append it with the next free number in its epic, mark it `(added)` in the epic's
story list so the board reconciler notices, cite its PRD requirement, and add its scenarios to the
flow file. A story with no scenarios cannot be Done, so this is not optional bookkeeping.

**Splitting an `XL`.** `XL` is not a size, it is a signal that the story was never understood. Split
on a _behavioural_ seam, never a layer seam — "the happy path" and "the failure paths" is a good
split; "the types" and "the implementation" is not, because neither half is demonstrable alone. The
original number keeps the first half; subsequent halves get new numbers and cite the original.

**Deprioritising.** Change the priority field and write one line saying why, in the story. A P0 that
becomes P1 has moved out of M1's definition of done and that is a product decision — check it against
[PRD §11](../prd.md) before making it, and if it is a P0 requirement rather than a convenience, it
needs a replacement story or an explicit gap note in the epic's Risks.

**Cutting scope.** The rule: **a scope cut is recorded, never silently absorbed.** Set the story's
status honestly, keep its number, and note in the epic's Risks or Out-of-scope section what is gone
and where it now lives (an epic id or a milestone). The existing model is
[roadmap §3](../17-roadmap.md#3-recommendation-cut-the-p0-view-surface-from-nine-to-six), which
argues nine P0 views down to seven-with-two-reduced _in writing, with reasoning_, and marks
`KAR-17.9` as a scope-cut candidate rather than deleting it. Do the same. The version of this project
that fails is the one where three quiet cuts accumulate into a tool that does not do the thing it
was for.

**Changing a mechanism.** That is an architecture change, not a plan change. Update the architecture
doc and the ADR first; the stories follow. The plan never becomes the source of truth for how the
system works.

## 10. What "done" means for M1

Restated verbatim from [PRD §11](../prd.md), because it is the only definition that matters:

> **You complete a real multi-hour task at work with it, from spec to merged PR, and the
> visualisation tells you why every step happened.**

Everything in this plan serves that sentence. Anything that does not is M2.

The metrics that judge it ([PRD §12](../prd.md)):

| Metric                                                             | M1 target               |
| ------------------------------------------------------------------ | ----------------------- |
| Task completion rate without human rescue, on the anchor use cases | > 50%                   |
| Gate first-pass rate                                               | > 40%                   |
| Median time-to-diagnose a failed run                               | < 5 min                 |
| Successful resume rate after interruption                          | > 95%                   |
| Cost per completed task vs manual agent driving                    | ≤ 1.5×                  |
| Replans per run                                                    | 1–4                     |
| Runs abandoned due to runaway loop                                 | < 5%                    |
| **Personal weekly active use**                                     | **≥ 3 real tasks/week** |

Two of these deserve a note. **Median time-to-diagnose** is the metric that judges the visualisation
— if it does not drop, the views are wrong, and no amount of polish fixes that. **Personal weekly
active use** is the only M1 metric that really matters: a tool you built and do not use is a
finished project and a failed one.

---

**Related:** [Board](./board.md) · [Epics](./epics) · [Flows](./flows) ·
[PRD](../prd.md) · [Architecture set](../README.md) · [Roadmap](../17-roadmap.md) ·
[Testing strategy](../14-testing-strategy.md)

[← Back to the architecture index](../README.md)
