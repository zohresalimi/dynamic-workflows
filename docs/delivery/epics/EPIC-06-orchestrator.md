# EPIC-06: Orchestrator: scheduling and durable effects

> Part of the [Karvan delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-06-orchestrator-flows.md)

| | |
|---|---|
| **Epic ID** | EPIC-06 |
| **Status** | Not started |
| **Priority** | P0 |
| **Milestone** | M1 |
| **Workstream** | W4 (see [roadmap §2.2](../../17-roadmap.md)) |
| **Size** | ~22 days across 9 stories — **over the ~15-day guidance, see Risks** |
| **Depends on** | EPIC-02 (the `Event` union, `PlanGraph` and the effect vocabulary `decide()` returns), EPIC-03, EPIC-05 (EPIC-04 for the mock agent on `PATH`) |
| **Blocks** | EPIC-07, EPIC-09, EPIC-10, EPIC-11, EPIC-12, EPIC-13, EPIC-14, EPIC-15 |
| **PRD requirements** | F4.2, F4.3, F4.4, F4.5, F4.7, F4.8, F5.2, F5.7 (scheduling half), F9.2 (classification half), NF4, NF9 |
| **Architecture** | [05-durable-execution.md](../../05-durable-execution.md) |

## Goal

At the end of this epic Karvan has an engine that decides what to do next as a **pure function** and
performs it through a **write-ahead effect journal**, so that a `kill -9` at any instant of a
multi-hour run is followed by a restart that resumes from the last completed boundary without
re-executing a single side effect it can prove already landed — and escalates to a human, loudly,
in the one case where it cannot prove anything. Concurrency is bounded per resource class with the
repository write lock held in the ledger rather than in memory; every wait in the system, from a
2-second retry backoff to a 30-day human gate, is one `node_wake` row and zero CPU; and pause,
resume and cancel are events on the same log as everything else.

## Why this matters

This is the epic that makes PRD §2.1's second broken thing — *"the run doesn't survive"* — actually
false rather than aspirationally false. EPIC-03 gave Karvan a ledger it can be killed on top of;
this epic gives it a scheduler that knows what to do with one. G2 in the PRD's ODW analysis is
rated **Critical** precisely here: "a crash at step 38 of 40 means re-running all 40 — and
re-paying". The success metric is explicit and measurable — **successful resume rate after
interruption > 95%** — and there is no way to reach it by care and good intentions. It is reached by
a journal, a probe per effect type, and an honest escalation path.

The second reason is testability, and it is why this epic is worth its size. `decide()` is pure and
the whole scheduler runs against a `TestClock` with zero I/O: ready-set derivation, jitter,
semaphore admission, churn detection and budget ceilings are functions over a plain object. A
six-hour human gate is `clock.advance(hours(6))` and costs microseconds. **NF9 is satisfied by a
package boundary rather than by code review** — `@karvan/core` has no dependency capable of
performing I/O, and an `import 'node:fs'` inside it means the design has already broken. TDD is not
a process tax here; it is the cheapest way to build this at all.

## Scope

**In scope:**

- `decide(state: RunState, now: number): Command[]` — the entire scheduling policy as a pure
  function in `@karvan/core`, and the `EffectRunner` interface it hands `Command[]` to.
- Ready-set derivation from reduced state only: dependency satisfaction, attempt budget, wake time,
  pause state, lifecycle.
- Per-resource-class semaphores — global agent slots (default 3), the per-repository write lock (1),
  the per-worktree exclusive lock (1) — with lock ownership recorded as `node.lock.acquired` /
  `node.lock.released` events so it survives a restart.
- The `durable()` protocol over the `effect` table: intent row before the side effect, `done` or
  `failed` row after, `ON CONFLICT(ikey) DO NOTHING`, memoisation on `done`, and the
  `started_at < daemonStartedAt` branch that detects a crash mid-effect.
- `ikey = ${run_id}/${node_id}/${attempt}/${ordinal}` with `ordinal` assigned from the **reducer's**
  view of prior intents for that `(run_id, node_id, attempt)`.
- `request_hash` as the guard against a plan patch landing under a journaled effect.
- `reconcile()` per effect kind — `agent`, `shell` (pure and mutating are different), `git`, `file`
  — returning `'done' | 'not-started' | 'unknown'`, and the `needs_human` gate for `unknown`.
- Error classification into `transient | permanent | gate` at construction time, full-jitter backoff,
  and `node.retry.scheduled` + the `node_wake` row written in the **same transaction** as
  `node.failed`.
- The `node_wake` table's ticker at ~1 Hz, replacing `setTimeout` for every wait in the system.
- `run.pause.requested` / `run.paused` / `run.resumed` / `run.cancel.requested` as events, and the
  cooperative-then-forceful cancel ladder's scheduling side.
- The progress watermark, the stall detector (`run.stalled`) and the churn circuit breaker
  (`run.needs_human`), plus the hard caps that backstop them.
- Crash recovery: rebuild `RunState`, reconcile every `pending` effect from a prior daemon epoch,
  re-derive the ready set, and reap or adopt orphaned children by `(pid, process_start_time)`.
- The `Harness` API — `new Harness({ db, clock, effects })`, `clock.advance()`, `crashAndRestart()`
  — as a first-class exported testing surface, not a test helper.

**Out of scope:**

- The `event`, `effect`, `run` and `node_wake` **tables** themselves, the `Db` port, migrations,
  `reduce()`, the checkpoint cache, `flock` and `daemon_epoch` — all
  [EPIC-03](./EPIC-03-event-ledger.md). This epic writes rows into tables that already exist and
  reads state a reducer already produces.
- Spawning agents, ACP session lifecycle, `supportsResume` capability probing, `ResumeNative` versus
  `ResumeByReplay`, frame-size guards and the detached-spawn mechanics —
  [EPIC-05](./EPIC-05-provider-adapters.md), especially KAR-05.5 and KAR-05.9. This epic *calls*
  those and journals their results.
- Worktree creation, branch naming, `merge-tree` conflict detection and dirty-worktree salvage —
  [EPIC-07](./EPIC-07-workspace-isolation.md). The git effect's *idempotency contract* (the
  `Karvan-Effect-Id` trailer, "already exists" is a success) is specified here because it is a
  reconciliation concern; the git wrapper that implements it is there.
- The permission ladder, command allowlist, environment scrubbing and the kill switch's process-tree
  mechanics — [EPIC-08](./EPIC-08-safety-model.md). This epic owns cancellation as *scheduling
  state*; EPIC-08 owns `killTree()`.
- Cost accounting, pre-flight estimates and budget ceiling *values* —
  [EPIC-14](./EPIC-14-cost-governance.md). This epic owns only the decision that
  `budget.cost-exceeded` classifies as `gate` and therefore pauses rather than fails.
- The human approval queue UI and `human.requested` / `human.responded` round trip —
  [EPIC-13](./EPIC-13-human-in-the-loop.md). This epic emits `run.needs_human` and suspends; EPIC-13
  surfaces it.
- Deterministic replay of a completed run (F4.9) — M2, and the same recorder mechanism as the
  adapter goldens.
- Snapshotting. [05-durable-execution §5.1](../../05-durable-execution.md) says plainly not to build
  it yet; the control-plane / data-plane split already removed the need.

## Definition of Ready (epic level)

- [ ] **EPIC-03 Done.** `reduce()` produces a `RunState` whose shape this epic's `decide()` reads;
      the `effect` and `node_wake` tables exist from migration 0001; `daemon_epoch` is stamped on
      every write; the crash-fuzz harness boots.
- [ ] **EPIC-05 Done at least through KAR-05.1, KAR-05.5 and KAR-05.9.** `decide()` can be built
      against a `FakeEffectRunner`, but KAR-06.4's agent reconciliation needs the real
      `supportsResume` manifest and the real detached-spawn path, and KAR-06.9's orphan reaping
      needs `(pid, process_start_time)` to actually be journaled.
- [ ] **EPIC-04 Done.** `karvan-mock-agent` is on a temp `PATH`, honours `--seed`, and can
      `process.exit(1)` mid-turn and hang forever on demand. Assertion (a) of the crash-fuzz test —
      "no effect executed twice" — is a duplicate-key check over the fake binaries' own side-effect
      log, so the fakes must append `{runId, nodeId, attempt, idempotencyKey}` on every invocation.
- [ ] The `Clock` port (`now()`, `sleep(ms, signal)`, `setTimer(ms, fn)`) and a `TestClock`
      implementation exist in `@karvan/core`, and a lint rule fails the build on `Date.now()`,
      `setTimeout` or `setInterval` appearing anywhere in `packages/core/src`.
- [ ] **The product answer to "what does a human do when `reconcile()` returns `unknown`?" is
      written down** before KAR-06.4 starts. Roadmap risk **A1-5** and open question 2 of
      [§7](../../17-roadmap.md) both say this is a product decision, not an engineering one. The
      decision is a paragraph in `packages/orchestrator/README.md`; the UI for it is EPIC-13.
- [ ] `packages/orchestrator` exists with `@karvan/core` as its only intra-repo dependency for the
      pure half, and the `pool: 'forks'` integration project is configured.

## Definition of Done (epic level)

- [ ] All nine stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-06-orchestrator-flows.md) exists as an
      automated test at the level its `Automated at:` line names.
- [ ] **The crash-fuzz suite is green in CI on every push** across `ubuntu-26.04` and `macos-26`,
      Node 24 and Node 26, with the kill point seeded from `$GITHUB_RUN_ID` so a failure is
      reproducible from the log. It asserts all three invariants: no effect executed twice, reduced
      state equals the pre-crash projection at the last durably-written seq, and
      `PRAGMA integrity_check` returns `ok` — plus a fourth this epic adds: the run either completes
      or halts with a typed `NodeFailure`, and never wedges.
- [ ] `decide()` and every function it calls are proven I/O-free by the package boundary: a test
      asserts `@karvan/core`'s transitive dependency set contains nothing capable of I/O, and the
      whole scheduler test file runs with no tmpdir, no database and no spawn.
- [ ] **No `setTimeout` is used as a wait anywhere in `packages/orchestrator`.** A lint rule permits
      it in exactly one place — the ticker's own `setTimeout(min(nextWakeAt - now, 1000))` sleep
      hint — and that call site is named in the rule's allowlist.
- [ ] The four known holes from [05-durable-execution §9](../../05-durable-execution.md) each have a
      passing scenario **and** a paragraph in `packages/orchestrator/README.md`: the irreducible
      landed-but-unrecorded window (§9.1), retry-versus-resume being different operations (§9.2),
      `reconcile()` returning `unknown` (§9.3), and the pid-reuse hazard (§9.4). A plan that hides
      these is worse than no plan; the README says so.
- [ ] The core is within the stated budget: `packages/core/src/{reduce,decide}.ts` plus
      `packages/orchestrator/src/{durable,reconcile,ticker}.ts` total **under ~1,500 LOC**, measured
      in CI. If it is materially over, something has been reimplemented that the ledger already did.
- [ ] Roadmap risk **A1-4** is closed per adapter: for every provider in the capability matrix,
      `supportsResume` is read from the fixture and the agent reconciler's behaviour on that profile
      has a test — including Copilot's and Gemini's, which cannot resume at all.

## User stories

### KAR-06.1 — The `decide` function and ready-set derivation

| | |
|---|---|
| **Status** | Ready |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | EPIC-03 (KAR-03.5 for `RunState`) |
| **PRD** | F4.2, NF9 |
| **Verified by** | EPIC-06-S1, EPIC-06-S2, EPIC-06-S3, EPIC-06-S4 |

**As** the engine author, **I want** the scheduler's entire policy expressed as
`decide(state, now) -> Command[]` with no ability to perform anything, **so that** every scheduling
decision in the system is a unit test over a plain object and NF9's deterministic core is enforced
by a package boundary rather than by discipline.

Implements [05-durable-execution §4](../../05-durable-execution.md#4-the-functional-core) and
primitive 3 of §3. The loop is `reduce` the log into `RunState` → call `decide` → hand the resulting
`Command[]` to the `EffectRunner` → append the `Event[]` it returns → `reduce` those → repeat.
Nothing else mutates run state, ever. The ready set is derived **purely from state** — no ambient
knowledge, no in-memory bookkeeping:

```ts
ready = nodes.filter(n =>
  n.state === 'pending' &&
  n.deps.every(d => state.nodes[d].state === 'completed') &&
  n.attempt < n.maxAttempts &&
  (n.wakeAt ?? 0) <= now);
```

`now` is a parameter, not a call. `Command` is a closed union — `StartNode`, `CancelNode`,
`AcquireLock`, `ReleaseLock`, `ScheduleWake`, `EmitEvent` — and each carries everything the runner
needs, because the runner is not allowed to consult state. This is the story that sets the shape of
the whole epic, so it is worth being fussy about: a `Command` that says "start node X" and lets the
runner look up X's provider has already leaked policy into the shell.

**Acceptance criteria**

1. `decide(state, now)` returns the same `Command[]` for the same `(state, now)` on every call, and
   calling it never mutates `state` — asserted with a deep-frozen input.
2. `@karvan/core` imports nothing capable of I/O. A test walks the resolved dependency graph and
   fails on `node:fs`, `node:child_process`, `node:net`, `better-sqlite3` or any transitive arrival
   of them.
3. A node enters the ready set only when it is `pending`, every entry in `deps` is `completed`,
   `attempt < retry.maxAttempts`, and `wakeAt` is absent or `<= now`.
4. A node whose `lifecycle` is `superseded` or `abandoned` is never ready, regardless of its state.
5. A dependency that failed `permanent` propagates `dependency.failed` to its dependents as a
   `Command`, and those dependents never enter the ready set.
6. `decide()` returns commands in a deterministic order derived from `seq` and `node_id`, never from
   object key iteration order, so a snapshot of the command list is stable across runs.
7. When the run is `paused`, `decide()` returns no `StartNode` commands but still returns
   `ScheduleWake` and `ReleaseLock` commands for work already in flight.
8. Reducing an empty ledger and calling `decide` yields `[]` rather than throwing.

**Test plan (TDD)** — write these tests first, in this order, and watch each fail before writing the
implementation.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `decide(initialState, 0)` returns `[]` | The function assumes at least one node |
| 2 | unit | A two-node chain: only the root is ready; after `node.completed` for the root, only the leaf is | Dependency satisfaction reads anything other than reduced state |
| 3 | unit | `Object.freeze` the state deeply; assert `decide` does not throw | The function mutates its input for bookkeeping |
| 4 | unit | Same state, same `now`, 100 calls → 100 identical arrays (deep equal) | Randomness or `Date.now()` leaked in |
| 5 | unit | `wakeAt = now + 1` → not ready; `wakeAt = now` → ready | The comparison is `<` instead of `<=` |
| 6 | unit | `attempt === maxAttempts` → not ready even with deps satisfied | The attempt budget is checked in the runner instead |
| 7 | unit | A `superseded` node with satisfied deps → not ready | Lifecycle is ignored |
| 8 | unit | Dependency-graph guard: importing `@karvan/core` in a bare Node process with `fs` monkey-patched to throw does not throw | An I/O import crept in |
| 9 | unit | Shuffle the `nodes` object's key order; assert an identical command array | Iteration order leaks into output |

**Notes / risks** — The temptation to give `decide()` "just one" lookup — the capability manifest,
the current git head, the wall clock — will arrive within a week. Every one of them is passed in
through `RunState` or `now` instead. The manifest is already a ledger fact by EPIC-05, so it costs
nothing to fold it into state.

---

### KAR-06.2 — Bounded concurrency with per-resource-class semaphores

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-06.1 |
| **PRD** | F5.2, F4.2 |
| **Verified by** | EPIC-06-S4, EPIC-06-S5, EPIC-06-S6, EPIC-06-S7 |

**As** an operator running several agents at once, **I want** admission bounded per resource class
rather than by one global number, **so that** analysis nodes parallelise freely while two write
nodes never touch the same git index — and so that the lock which stops them still exists after a
crash.

Implements [05-durable-execution §10.2](../../05-durable-execution.md#102-ready-set-and-admission).
A single "max concurrency: 3" is the wrong abstraction because the constraints are not fungible:

| Class | Default | What actually limits it |
|---|---|---|
| Global agent slots | 3 | Laptop RAM and vendor rate limits |
| Per-repository write lock | 1 | Git index contention; F5.2's serialise-writes policy |
| Per-worktree exclusive lock | 1 | One agent per worktree, always |

```ts
admit = min(globalAgentSlots - running.length, classSlots(n) - runningInClass(n));
```

The load-bearing decision is that **the repo write lock is enforced in the ledger**, as
`node.lock.acquired` / `node.lock.released` events, not in a JavaScript `Map`. An in-memory lock
evaporates on restart, and the first thing that happens after a crash is that several nodes resume
at once — precisely the moment the lock matters most. Lock acquisition is therefore a `Command` that
produces an event, and `decide()` reads held locks out of reduced state like everything else. Lock
release is emitted on `node.completed`, `node.failed` and `node.cancelled` alike, and a lock held by
a node that is no longer running is reclaimed at startup with a `node.lock.released` carrying
`reason: 'reclaimed'`.

**Acceptance criteria**

1. With `globalAgentSlots: 3` and five ready agent nodes, `decide()` returns exactly three
   `StartNode` commands; the remaining two stay `pending` and are returned on the next tick as slots
   free.
2. Two ready nodes that both declare a write to the same repository produce exactly one
   `AcquireLock{ lock: 'repo' }` command; the second is withheld until a `node.lock.released` for
   that key is reduced.
3. `node.lock.acquired` and `node.lock.released` events carry `{ node, lock: 'repo' | 'worktree',
   key }` and are the **only** record of lock ownership — a grep asserts no `Map`, `Set` or module
   scoped variable in `packages/orchestrator/src` holds lock state.
4. After `crashAndRestart()` with a `node.lock.acquired` and no matching release in the ledger, the
   lock is still held, and a competing node is still withheld.
5. A lock held by a node whose state reduces to `failed`, `cancelled` or `completed` is released at
   startup with `reason: 'reclaimed'`, and the event names the node that held it.
6. Read-only nodes (`permission: 'read'`) never request the repo write lock, so an arbitrary number
   of analysis nodes run in parallel up to the global slot count.
7. Two nodes assigned the same worktree path produce one `AcquireLock{ lock: 'worktree' }`; a node
   with its own worktree is unaffected.
8. Slot counts come from `RunState` (seeded from `.karvan/config.yaml`), never from a constant in
   the scheduler, and changing `globalAgentSlots` between daemon lives takes effect on the next
   tick without touching in-flight nodes.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | 5 ready nodes, 3 slots → 3 `StartNode`; complete one → 1 more | Admission counts ready instead of running |
| 2 | unit | Two repo-writing nodes → one `AcquireLock`, one withheld | The lock is advisory |
| 3 | unit | Feed `node.lock.acquired` with no release; assert the competing node stays `pending` for 100 ticks | Locks are held outside the reducer |
| 4 | integration | `crashAndRestart()` with an unreleased repo lock; assert it survives | The lock lives in a `Map` |
| 5 | unit | A held lock whose owner reduced to `failed` → `ReleaseLock{ reason: 'reclaimed' }` on the first post-restart tick | Reclaim is manual |
| 6 | unit | 8 read-only nodes, 3 slots → 3 started, none requests the repo lock | `permission` is not consulted |
| 7 | integration | Two mock agents scripted to `git add` in the same repo, admitted through the real runner; assert their `node.started` seqs never interleave | The lock is checked but not enforced at the boundary |

**Notes / risks** — The repo lock is where F5.2 ("serialize writes, parallelize reads") physically
lives, and PRD §13 rates *parallel write agents produce incompatible work* as **High**. Worth
resisting: a "just this once" bypass flag for the lock. If it exists it will be set, and the failure
it produces (two agents' conflicting decisions committed to the same branch) surfaces hours later as
a merge problem rather than immediately as a scheduling problem.

---

### KAR-06.3 — Write-ahead effect journal and idempotency keys

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-06.1, EPIC-03 (KAR-03.3) |
| **PRD** | F4.3, F4.2 |
| **Verified by** | EPIC-06-S8, EPIC-06-S9, EPIC-06-S10, EPIC-06-S11, EPIC-06-S17 |

**As** the engine, **I want** every side-effecting operation preceded by a durable intent row keyed
by `(run_id, node_id, attempt, ordinal)`, **so that** a restart can tell "already happened",
"definitely did not happen" and "cannot tell" apart instead of guessing.

Implements [05-durable-execution §8.1 and §8.2](../../05-durable-execution.md#8-idempotency). The
protocol is intent first, then act, then record:

```ts
const row = db.transaction(() => {
  db.prepare(`INSERT INTO effect(ikey,…,state,started_at) VALUES (…,'pending',@now)
              ON CONFLICT(ikey) DO NOTHING`).run(eff.meta);
  return db.prepare(`SELECT * FROM effect WHERE ikey=?`).get(eff.ikey)!;
})();

if (row.state === 'done')   return JSON.parse(row.result_json) as T;   // memoised
if (row.state === 'failed') throw new EffectFailed(row);
if (row.started_at < daemonStartedAt) { /* crashed mid-effect — KAR-06.4 */ }
const result = await eff.perform();
markDone(eff.ikey, result);
```

Two details carry the whole story. First, **`ordinal` is assigned from the reducer's view** of how
many effect intents this `(run_id, node_id, attempt)` has already recorded — never from a runtime
counter in the effect runner. A runtime counter resets to zero when the process restarts, so the
second effect of an interrupted attempt comes back as ordinal 0 and collides with the first;
derived from reduced state, the same effect gets the same ordinal on every restart, which is the
entire point. Second, **`request_hash`** guards against a `PlanPatch` landing so that a node now does
something *different* while an `effect` row for that ikey already exists — without it you would
happily return the memoised result of the old operation as if it were the new one. A mismatch is
`effect.request-hash-mismatch`, class `permanent`, a hard error and not a warning.

**Acceptance criteria**

1. `ikey` is exactly `${run_id}/${node_id}/${attempt}/${ordinal}`, and the short-hex hash used when
   it must be embedded in a filename is a stable sha256 prefix with a documented length.
2. An `effect.started` event and the `effect` row are written in one transaction, **before**
   `eff.perform()` is called. A test that crashes between them is impossible by construction; a test
   that crashes immediately after observes `state = 'pending'`.
3. `ON CONFLICT(ikey) DO NOTHING` followed by a `SELECT` returns the pre-existing row, so two
   concurrent attempts to journal the same ikey both read the same row and exactly one performs.
4. A `done` row short-circuits: `eff.perform()` is not called and the memoised `result_json` is
   returned, with `effect.completed { reconciled: false }` not re-emitted.
5. A `failed` row throws `EffectFailed` carrying the original `NodeFailure`, and the scheduler — not
   the runner — decides whether that is a retry or a node failure.
6. `ordinal` for the Nth effect of an attempt is N-1 after a restart just as it was before it. A
   test interrupts an attempt after its first effect, restarts, and asserts the second effect gets
   ordinal 1 and not 0.
7. `request_hash` covers the node's brief, provider, model, permission level, path scopes and
   declared reads/writes. Changing any of them and re-entering `durable()` for the same ikey raises
   `effect.request-hash-mismatch` naming both hashes; the memoised result is not returned.
8. Effect rows are never deleted or updated in place except to move `pending → done | failed`; a
   trigger or a test asserts no other transition occurs.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `ikeyFor({runId,nodeId,attempt,ordinal})` golden strings, including ids containing `-` and `_` | The separator collides with an id character |
| 2 | integration | Journal an effect against a file-backed db; assert the row is `pending` and `effect.started` exists **before** the fake effect's side-effect log has a line | `perform()` runs first |
| 3 | integration | Call `durable()` twice with the same ikey; assert one side-effect line and two identical return values | Memoisation is by in-process cache |
| 4 | integration | Pre-seed a `failed` row; assert `EffectFailed` with the stored `NodeFailure` and no `perform()` | Failures are re-executed |
| 5 | integration | Two effects in one attempt, kill after the first, restart, run the second; assert ordinals `0` then `1` | The ordinal comes from a runtime counter |
| 6 | integration | Mutate the node's `permission` between two `durable()` calls for the same ikey; assert `effect.request-hash-mismatch` | The hash covers too little |
| 7 | unit | `requestHash` is stable across key reordering and unaffected by `undefined` fields | The canonical encoder was skipped |
| 8 | integration | Attempt to `UPDATE effect SET state='pending' WHERE state='done'`; assert it is rejected | The journal is mutable |

**Notes / risks** — `request_hash` and `planHash` must both use the project's own canonical JSON
encoder, not `ohash` — `ohash` promises only "best efforts" at stable serialisation, which is fine
for "did this change since last render" and not fine for a value that gates whether a side effect
re-runs.

---

### KAR-06.4 — Effect reconciliation per effect type

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-06.3, EPIC-05 (KAR-05.5), EPIC-07 (KAR-07.1 for the git wrapper) |
| **PRD** | F4.3, F4.2 |
| **Verified by** | EPIC-06-S12, EPIC-06-S13, EPIC-06-S14, EPIC-06-S15, EPIC-06-S16 |

**As** the engine restarting after a crash, **I want** each of the four effect kinds to answer "did
this already happen out there in the world?" in the way that is actually true for that kind, **so
that** at-least-once execution plus a good probe gets as close to exactly-once as physics allows —
and says so out loud when it cannot.

Implements [05-durable-execution §8.3](../../05-durable-execution.md#83-the-four-effect-types) and
primitive 6 of §3. `reconcile(row) -> 'done' | 'not-started' | 'unknown'` is called only for a
`pending` row whose `started_at < daemonStartedAt` — a `pending` row from *this* daemon's life is
ordinary concurrency and falls through to `perform()`.

- **`agent`** — the good case. Journal the ACP `session_id` from the **first** frame the instant it
  arrives, as its own `event` row, never buffered: a buffered session id is a session id you lose in
  exactly the crash where you needed it. On reconcile, a journaled session id plus an adapter whose
  manifest says `session.resume` means resume; no journaled session id means the agent produced no
  durable state and a clean restart is safe. Two of five adapters — `copilot --acp` 1.0.77 and
  `gemini --acp` 0.53.1 — cannot resume at all, so a crashed agent node on those profiles restarts
  from scratch. That is a **cost-model difference, not a correctness difference**, because Karvan's
  ledger is always sufficient to reconstruct the prompt.
- **`shell`** — not idempotent in general, and no cleverness fixes that. Classified at **plan time**:
  `pure` (test, lint, build, typecheck) is simply re-run; `mutating` (migrations, publishes, network
  POSTs) runs inside a dedicated worktree with a hash of `git status --porcelain` journaled before
  and after, and reconciles by re-hashing — matches *before* ⇒ `not-started`, matches *after* ⇒
  `done`, anything else ⇒ `unknown`.
- **`git`** — made structurally idempotent rather than journaled around. `git worktree add` failing
  with "already exists" is a **success**. Commits are the one genuinely non-idempotent operation and
  a trailer fixes them: `git commit -m "<subject>" -m "Karvan-Effect-Id: <ikey>"`, reconciled with
  `git log --grep="Karvan-Effect-Id: <ikey>" --format=%H -1`.
- **`file`** — atomic rename with the ikey in the temp filename:
  `${path}.karvan-${ikey}.tmp`, a **sibling of the target, never `/tmp`**, written, `fsync`ed,
  `rename`d, then the *directory* `fsync`ed. An orphaned tmp bearing this ikey means the crash
  happened before the rename — unlink and redo. No tmp file and a target whose content hash matches
  means done.

And the hole: **`unknown` has no correct automatic action.** Retrying might double-apply; skipping
might drop the work; both are wrong in some cases and neither is detectable. The run transitions to
`needs_human` with `run.needs_human { reason: 'reconcile-unknown' }`, the node fails with
`effect.reconcile-unknown` class `gate`, and the effect row plus **both** reconciliation hashes are
surfaced for a human to choose "it ran" or "it didn't".

**Acceptance criteria**

1. `reconcile()` is invoked **only** when `row.state === 'pending' && row.started_at <
   daemonStartedAt`. A `pending` row from the current epoch falls straight through to `perform()`.
2. Agent: the `session_id` is written as its own event within the same tick it arrives, unbuffered.
   Killing the daemon one frame after the session id arrives and restarting finds it in the ledger.
3. Agent, resume-capable profile: reconcile returns `done` for a completed turn and resumes an
   incomplete one via `ResumeNative`. Agent, non-resume profile (Copilot/Gemini shape from the
   mock agent's `--agent-capabilities` flag): reconcile returns `not-started`, the node restarts
   clean, and a `node.progress` event records `resumeStrategy: 'replay'` so the cost is visible.
4. Shell `pure`: reconcile always returns `not-started`; the command re-runs; the cost is time.
5. Shell `mutating`: the before/after `git status --porcelain` hashes are journaled in the effect's
   `result_json` scaffold before `perform()`. Reconcile matching *before* ⇒ `not-started`, matching
   *after* ⇒ `done`, neither ⇒ `unknown`.
6. **A `mutating` command whose reconcile returns `unknown` is never auto-retried.** A test asserts
   the scheduler emits `run.needs_human { reason: 'reconcile-unknown' }` and no `StartNode` for that
   node on any subsequent tick until a human event arrives.
7. Git: `git worktree add` exiting non-zero with a message containing `already exists` is mapped to
   success. A commit whose trailer is already findable by `git log --grep` reconciles `done` and is
   not re-committed; the resolved sha is the memoised result.
8. File: a `<target>.karvan-<ikeyHash>.tmp` sibling present ⇒ unlink and `not-started`; absent with
   a matching content hash ⇒ `done`; absent with a differing hash ⇒ `unknown`. The temp path is
   asserted to share a directory with the target and to never be under `os.tmpdir()`.
9. Every reconcile outcome is recorded as `effect.completed { reconciled: true }` or as the
   `needs_human` escalation — a reconcile that silently mutates the row without an event does not
   exist.
10. The `unknown` escalation payload carries the ikey, the effect kind, the request hash and both
    reconciliation hashes, so the human decision in EPIC-13 is made against evidence rather than a
    prose message.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | The dispatch table: a `pending` row from the current epoch never calls `reconcile` | The epoch comparison is missing |
| 2 | integration | Mock agent emits a session id then `process.exit(1)`; restart; assert the id is in `event` | The session id was buffered |
| 3 | integration | Scenario Outline over the five capability profiles from the 2026-08-02 matrix; assert `ResumeNative` for claude/codex/opencode and `ResumeByReplay` for copilot/gemini | `supportsResume` was assumed uniform |
| 4 | integration | Real `git` in a tmpdir with `GIT_CONFIG_GLOBAL=/dev/null`: commit with the trailer, crash, reconcile finds it by `--grep`, no second commit | The trailer is cosmetic |
| 5 | integration | `git worktree add` twice; assert the second is treated as success | The error string is not matched |
| 6 | integration | Mutating shell: dirty the worktree between before-hash and reconcile so neither hash matches; assert `unknown` and `run.needs_human` | `unknown` falls through to retry |
| 7 | integration | File effect: create an orphan `.karvan-<hash>.tmp`, reconcile, assert it is unlinked and the effect re-performs | Orphan detection is by mtime |
| 8 | integration | Assert the tmp path's `dirname` equals the target's and does not start with `os.tmpdir()` | Someone "tidied up" into `/tmp` |
| 9 | integration | After a `done` reconcile, assert `effect.completed { reconciled: true }` is in the ledger | Reconciliation is invisible in the timeline |

**Notes / risks** — This is the epic's biggest story and the one where the plan is most likely to be
optimistic. Roadmap risk **A1-4** is live: vendor resume support is verified only for Claude Code,
and Copilot advertises just `sessionCapabilities: {list}` while Gemini advertises none. Treat
`session/resume` as a token-cost optimisation and never as the durability mechanism — the ledger is
the durability mechanism. Also live is **A1-5**, which is not a bug to be fixed later: the
`unknown` gate is a product decision, and the Definition of Ready requires it written down before
this story starts. If `unknown` turns out to be common in practice the escalation is a
content-addressed overlay (run every mutating node copy-on-write, diff, apply) — large complexity,
still no help for network effects, so **do not pre-build it**.

---

### KAR-06.5 — Node retry with classified errors and jittered backoff

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-06.1, KAR-06.3, KAR-06.6 |
| **PRD** | F4.5, F4.6, F9.2 |
| **Verified by** | EPIC-06-S17, EPIC-06-S18, EPIC-06-S19, EPIC-06-S20, EPIC-06-S31 |

**As** an operator whose run just hit a vendor rate limit, **I want** the failure classified before
anything decides what it means, and the retry delayed by full jitter with the delay itself durable,
**so that** five nodes hitting the same limit do not retry in lockstep and re-trip it, and a restart
inside the backoff window neither storms nor double-counts the attempt.

Implements [05-durable-execution §10.3](../../05-durable-execution.md#103-retry-backoff-and-error-classification).
The classifier assigns `class` when the `NodeFailure` is *constructed*, never derived from `reason`
at render time, because the same reason is transient or permanent depending on context —
`provider.unavailable` is transient for a rate-limited vendor and permanent for a binary the user
uninstalled mid-run. **The scheduler reads `class` and nothing else.**

| Class | Examples | Action |
|---|---|---|
| `transient` | `provider.rate-limited`, `ETIMEDOUT`, a known-flaky exit code | Retry with backoff, optionally rerouted to another provider |
| `permanent` | `adapter.spawn-failed`, `contract.schema-invalid`, `safety.pathscope-violation` | Fail the node; propagate `dependency.failed` |
| `gate` | `effect.reconcile-unknown`, `budget.cost-exceeded`, the agent asked a question | Suspend, notify a human |

```ts
delay = Math.random() * Math.min(cap, base * 2 ** (attempt - 1));   // base 2_000ms, cap 300_000ms
```

Full jitter rather than equal jitter or none, because the common failure here is *correlated*. And
the transactional rule: **persist the computed `wake_at` into `node_wake` in the same transaction as
the `node.failed` event**, together with `node.retry.scheduled { node, nextAttempt, wakeAt }`. Split
them and a restart inside the backoff window either loses the delay (immediate retry storm) or
double-counts the attempt. Hitting a budget ceiling is deliberately `gate` and not `permanent`: the
run **pauses for a human decision** rather than dying with hours of work half-done.

**Acceptance criteria**

1. `class` is a field on `NodeFailure` set by the classifier at construction. A test asserts the
   scheduler never branches on `reason` — a grep over `packages/orchestrator/src` finds no
   `NodeFailureReason` literal outside the classifier module.
2. `transient` schedules attempt `n+1` when `n < retry.maxAttempts` (default 3) and otherwise fails
   the node with the last failure preserved.
3. `permanent` fails the node immediately with no `node_wake` row, and emits `dependency.failed` for
   every dependent, transitively.
4. `gate` suspends the node with `node.suspended` and emits `run.needs_human` with the reason;
   `decide()` returns no `StartNode` for it until a `human.responded` event is reduced.
5. The computed delay satisfies `0 <= delay < min(300_000, 2_000 * 2 ** (attempt - 1))` with the
   randomness drawn from an **injected seeded generator**, so a seeded test asserts exact values.
6. `node.failed`, `node.retry.scheduled` and the `node_wake` upsert are one transaction. A test that
   forces a rollback between them asserts none of the three landed.
7. Restarting inside a backoff window re-derives the same `wakeAt` from the `node_wake` row rather
   than recomputing it, and does not increment `attempt`.
8. `retry.onFailure` entries (`{ when: NodeFailureReason; action: 'retry' | 'reroute' | 'escalate' }`)
   override the class default for that reason; `reroute` emits a `PlanPatch` proposal so the
   provider change is visible in the scrubber (F3.9) rather than happening silently.
9. `budget.cost-exceeded` and `budget.wallclock-exceeded` classify as `gate`, produce
   `budget.exceeded` and `run.paused`, and never produce `node.failed` with class `permanent`.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Scenario-outline table over `(reason, context) -> class`, including `provider.unavailable` in both contexts | `class` is derived from `reason` |
| 2 | unit | Seeded RNG: attempts 1..6 produce the documented delay sequence, capped at 300 s | The cap is applied before the exponent |
| 3 | unit | 20 nodes failing `provider.rate-limited` at the same `now`; assert the wake times span more than 80% of the window | Equal jitter or no jitter |
| 4 | integration | Force a `ROLLBACK` between `node.failed` and the wake upsert; assert neither row exists | They are two transactions |
| 5 | integration | `crashAndRestart()` mid-backoff; assert `attempt` unchanged and the node not ready until `wakeAt` | Backoff lives in memory |
| 6 | unit | `permanent` on a node with two dependents → two `dependency.failed` commands, and their dependents too | Propagation is one level deep |
| 7 | unit | `gate` → `node.suspended` + `run.needs_human`, and 1,000 subsequent ticks produce no `StartNode` | The gate is advisory |
| 8 | integration | A `budget.cost-exceeded` failure pauses the run and leaves every completed node's work intact | The ceiling fails the run |
| 9 | unit | `onFailure: [{ when: 'provider.rate-limited', action: 'reroute' }]` emits a patch proposal | Rerouting is silent |

**Notes / risks** — `Math.random()` in the delay formula as written in the architecture doc is
shorthand; in `@karvan/core` it must come through the seeded generator port, or NF9 is violated and
the jitter test cannot assert exact values. This is exactly the kind of line that gets copied
literally.

---

### KAR-06.6 — Durable wake times and long suspension

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | KAR-06.1, EPIC-03 (KAR-03.3) |
| **PRD** | F4.8, NF4 |
| **Verified by** | EPIC-06-S20, EPIC-06-S21, EPIC-06-S22 |

**As** a run waiting six hours for a human, **I want** to wait as a row in a table rather than as a
timer in a process, **so that** the wait survives a restart and a closed laptop lid, and costs one
row and zero CPU.

Implements [05-durable-execution §10.1](../../05-durable-execution.md#101-durable-wake-times-never-settimeout).
There are two independent reasons and one of them is alarming. **Verified 2026-08-02:** Node's
maximum timer delay is `2**31 - 1` ms = 24.9 days; passing `2**31` does not throw and does not clamp
— it fires the callback after **1 ms**, with only a `TimeoutOverflowWarning` on stderr. A 30-day
human gate implemented with `setTimeout` fires instantly and nothing in the logs says "durability
failure". And even below that ceiling, timers do not fire during laptop sleep and do not survive a
restart at all.

```sql
INSERT INTO node_wake(run_id, node_id, wake_at, reason) VALUES (?,?,?,?)
  ON CONFLICT(run_id,node_id) DO UPDATE SET wake_at=excluded.wake_at, reason=excluded.reason;
SELECT * FROM node_wake WHERE wake_at <= ?;   -- the ticker, ~1 Hz
```

`setTimeout(min(nextWakeAt - now, 1000))` is used **only** as a sleep hint for the ticker itself,
never as the wait. The payoff is that four problems that look unrelated collapse into one mechanism:
a six-hour human gate, laptop sleep across that gate, crash-and-restart mid-wait, and retry backoff
are all *a `node_wake` row*. One code path exercised constantly instead of four exercised rarely.

**Acceptance criteria**

1. No code path in `packages/orchestrator` calls `setTimeout` or `setInterval` as a wait. The lint
   allowlist contains exactly one call site — the ticker's sleep hint — named in the rule config.
2. The ticker wakes at most once per second and, when the next `wake_at` is nearer than 1,000 ms,
   sleeps only until then. Its sleep is `clock.setTimer`, so a `TestClock` drives it.
3. A due row produces a `decide()` input where that node's `wakeAt <= now`; the row is deleted in the
   same transaction as the event that consumes it, so a crash cannot both fire and lose it.
4. `reason` is one of `'backoff' | 'human_gate' | 'poll'` and is rendered in the timeline, so "why
   is this node asleep" is answerable without reading code.
5. A wake 30 days out is stored as a plain integer ms epoch and honoured exactly; a regression test
   asserts that the equivalent `setTimeout(2**31)` fires after ~1 ms, so the reason for the design
   is encoded in the suite rather than in a comment.
6. `clock.advance(hours(6))` in the `Harness` fires a six-hour gate with no wall-clock time passing,
   and the intervening ticks perform no database writes beyond the due-row query.
7. A suspended node holds no slot, no lock and no child process; `runningInClass` excludes it.
8. Wall-clock non-monotonicity is tolerated: after simulating `now` moving *backwards* by an hour
   (laptop sleep, NTP correction), no wake is skipped and no node is double-fired — ordering
   decisions read `seq`, never two timestamps compared to each other.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Regression: `setTimeout(2**31, fn)` fires in under 10 ms — documenting the footgun | Someone "simplifies" the ticker |
| 2 | unit | `TestClock.advance(6h)` → the gate's node becomes ready on the next tick | The wait is a real timer |
| 3 | integration | Insert a wake 30 days out, `crashAndRestart()`, advance to it, assert it fires once | Wakes live in memory |
| 4 | integration | Crash between "row due" and "event appended"; restart; assert the row is still there and fires | Delete and consume are separate transactions |
| 5 | unit | Move `now` back 1 hour then forward 2; assert each wake fires exactly once | Logic compares two timestamps |
| 6 | unit | A suspended node is absent from `running` and holds no lock | Suspension is a flag on a running node |
| 7 | unit | With the next wake 200 ms away, the ticker's sleep hint is 200 ms, not 1,000 | The hint is a constant |

**Notes / risks** — The 1 Hz tick is a *ceiling on latency*, not a polling loop that must be
optimised: a run with no due wakes and no ready nodes executes one indexed `SELECT` against
`node_wake_due` per second, and the measured tail-query cost in this schema is ~0.2 ms. If that ever
shows up in a profile, the problem is elsewhere.

---

### KAR-06.7 — Pause, resume and cancel as events

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-06.1, KAR-06.2, EPIC-05 (KAR-05.9) |
| **PRD** | F4.4, F5.7 |
| **Verified by** | EPIC-06-S23, EPIC-06-S24, EPIC-06-S25 |

**As** an operator who needs to stop a run right now, **I want** pause, resume and cancel recorded
as events rather than set as flags, **so that** a pause survives a restart, appears in the timeline,
and is auditable — and so that cancel kills the whole process tree rather than one process while its
children keep burning tokens.

Implements [05-durable-execution §10.4](../../05-durable-execution.md#104-pause-resume-and-cancel-are-events)
and the scheduling half of the kill switch. `run.pause.requested` is an event; `decide()` reads
reduced state and stops admitting new nodes. In-flight nodes run to completion by default, or are
suspended in aggressive mode. `run.cancel.requested { mode: 'cooperative' | 'forceful' }` drives a
three-stage ladder whose mechanics live in [EPIC-08](./EPIC-08-safety-model.md) and whose *state* is
owned here:

1. Protocol-level `session/cancel` (or ACP `terminal/kill`) so the agent flushes its final
   `session/update`s and answers with `stopReason: 'cancelled'`.
2. `process.kill(-pid, 'SIGTERM')` — **the negative pid**, signalling the whole group — then a
   configurable grace period, default 5 s.
3. `process.kill(-pid, 'SIGKILL')`, then 2 s.
4. Report failure to the ledger. **A kill that did not take is an event, not a silent condition.**

Two verified traps ride along. `process.kill(child.pid, ...)` with a **positive** pid killed only the
direct child and left both grandchildren alive, reparented to PID 1. And after a *successful* group
SIGKILL, `ps` still lists the grandchildren — in state **`Z` (zombie)** with `ppid = 1`, already
dead and awaiting reaping. **Any "did the kill work?" assertion must exclude `Z`-state processes**,
or a working kill reads as a failure.

**Acceptance criteria**

1. `run.pause.requested` from either the CLI or the API appends an event; `decide()` on the next
   tick returns zero `StartNode` commands and the run's projected status is `paused`.
2. Pausing does not touch in-flight nodes in the default mode; their `node.completed` events are
   accepted normally and their locks released.
3. `crashAndRestart()` on a paused run comes back paused. A test asserts no `StartNode` is issued
   after the restart until `run.resumed` is appended.
4. `run.resumed` re-admits work on the next tick, respecting the same semaphores as before —
   including a repo lock that was held across the pause.
5. `run.cancel.requested { mode: 'cooperative' }` sends `session/cancel` first and waits for
   `stopReason: 'cancelled'`; the client keeps accepting `session/update` notifications that arrive
   *after* the cancel without deadlocking.
6. `mode: 'forceful'` escalates SIGTERM → 5 s → SIGKILL → 2 s, and each stage is an event with the
   pid and pgid in its payload.
7. Kill verification excludes `Z`-state processes:
   `ps -eo pid,pgid,stat | awk -v g=$PGID '$2==g && $3 !~ /Z/'` returns empty. A regression test
   asserts that the *positive*-pid form leaves grandchildren alive, so nobody "simplifies" the kill
   path.
8. A kill that does not take after stage 3 appends a typed failure event naming the surviving pids;
   the run does not silently continue and does not wedge.
9. Cancelled nodes release every lock they held and their in-flight effect rows are moved to
   `failed` with `NodeResult.status = 'cancelled'`, so a later restart does not reconcile them as
   ambiguous.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Reduce `run.pause.requested`; assert `decide()` returns no `StartNode` but still returns `ReleaseLock` | Pause is checked in the runner |
| 2 | integration | Pause, `crashAndRestart()`, 100 ticks; assert nothing started | Pause is an in-memory flag |
| 3 | integration | Pause while a repo lock is held, resume, assert the same node keeps the lock | Resume reclaims held locks |
| 4 | integration | Mock agent scripted to flush updates after cancel; assert no deadlock and `stopReason: 'cancelled'` | The reader is torn down on cancel |
| 5 | integration | `bash -c 'sleep 300 & sleep 300 & sleep 300; wait'` detached; group SIGKILL; assert the `stat !~ /Z/` filter returns empty | Zombies are counted as survivors |
| 6 | integration | Positive-pid kill; assert two grandchildren remain with `ppid=1` — the regression guard | The negative pid was "cleaned up" |
| 7 | integration | Mock agent that ignores SIGTERM; assert the SIGKILL stage fires after the grace period and both stages are events | The escalation timer is missing |
| 8 | integration | Cancel a node holding a worktree lock; assert `node.lock.released` and a `cancelled` effect row | Cancellation leaks locks |

**Notes / risks** — The grace period must be a config value, not a constant: long-running CLIs need
time to flush transcripts, and 5 s is a default rather than a law. And `execa`'s
`forceKillAfterDelay` is **not** an escalation for this case — it does not work when the subprocess
is terminated with an explicit signal, which Karvan always passes, so the timer is implemented by
hand.

---

### KAR-06.8 — No-progress detection: stall detector and churn circuit breaker

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-06.1, KAR-06.5 |
| **PRD** | F4.7 |
| **Verified by** | EPIC-06-S26, EPIC-06-S27, EPIC-06-S28 |

**As** an operator asleep while a run continues, **I want** a livelock to break fast rather than
expensively, **so that** the failure mode PRD §7.4 calls "the single most expensive in autonomous
loops" costs minutes instead of a monthly allowance.

Implements [05-durable-execution §11](../../05-durable-execution.md#11-no-progress-detection-f47).
Two detectors, both cheap, plus hard caps as a backstop.

The **progress watermark** is the `seq` of the last event that *actually changed reduced state*, and
the elegant part falls out of the schema for free: agent stdout lives in `io_chunk` and never
touches the reducer, so an agent producing megabytes while accomplishing nothing does not advance
the watermark, and an agent thinking silently for eight minutes before a real state transition does
not falsely trip it. The metric is meaningful without a line of code written to make it so.

The **stall detector**: `now - watermarkTs > 10 min` while at least one node is `running` emits
`run.stalled { watermarkSeq, idleMs, runningNodes }`. **It does not auto-kill.** A legitimately long
build, a large test suite and a wedged agent look identical from here, and killing a 40-minute
integration run because it was quiet for ten minutes is a worse failure than the one prevented.

The **churn circuit breaker** keeps a sliding window of the last **M = 20** completed node attempts
and trips when either the same `(node_id, request_hash)` appears more than **N = 5** times — the
same work redone with the same inputs, the literal definition of a livelock — or the count of
`completed` nodes has not increased across **3 consecutive planner replans**. On trip the run
transitions to `needs_human`. **Never silently continue.**

**Acceptance criteria**

1. The watermark advances only on events that change reduced state. A test appends 10,000 `io_chunk`
   rows and 50 `node.progress` events and asserts the watermark is unmoved.
2. `run.stalled` is emitted once per stall episode, not once per tick, and carries `watermarkSeq`,
   `idleMs` and the list of running node ids.
3. No code path kills, fails or reschedules a node in response to `run.stalled`. A test asserts the
   commands returned on a stalled tick are identical to those on the tick before.
4. The stall threshold is configurable and defaults to 10 minutes; a run that goes quiet for 9
   minutes 59 seconds emits nothing.
5. The churn window is the last 20 **completed attempts** (not events, not seconds); the sixth
   occurrence of the same `(node_id, request_hash)` within it trips the breaker.
6. Three consecutive `plan.patched` events with no increase in the completed-node count trip the
   breaker with `reason: 'churn'` and a detail naming the plan versions involved.
7. On trip, `run.needs_human { reason: 'churn', detail }` is appended, `decide()` issues no further
   `StartNode`, and in-flight nodes are allowed to finish.
8. Hard caps back the detectors, not the other way round: `maxAttemptsPerNode` (default 3, matching
   F7.5's surgical repair cap), `maxRunWallClock` and `maxTotalNodeExecutions` each produce a typed
   failure naming which cap fired.
9. Both detectors run inside `decide()` — they are pure functions of state and `now`, and a test
   exercises a 40-minute stall in microseconds via `clock.advance`.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | 10k io chunks + 50 `node.progress` → watermark unchanged | The reducer reads the data plane |
| 2 | unit | `clock.advance(11 min)` with one running node → exactly one `run.stalled` | It fires per tick |
| 3 | unit | Commands on the stalled tick deep-equal the prior tick's | The detector acts |
| 4 | unit | 5 occurrences of the same `(node_id, request_hash)` → no trip; the 6th → trip | Off-by-one on N |
| 5 | unit | 21 completed attempts where the repeated pair falls out of the window → no trip | The window is unbounded |
| 6 | unit | 3 replans with the completed count flat → trip; 3 replans with it rising → no trip | The replan detector counts patches, not progress |
| 7 | unit | Trip → `run.needs_human` and no `StartNode` for 1,000 ticks | The breaker is advisory |
| 8 | integration | A mock-agent loop scripted to redo identical work; assert the run halts within 6 attempts rather than exhausting a budget | The detectors are not wired into the real loop |

**Notes / risks** — The success metric is **runs abandoned due to runaway loop < 5%**, and the two
tuning constants (M = 20, N = 5) are practitioner defaults rather than measured values. Emit the
window contents in the `run.needs_human` detail so the first few real trips are diagnosable, and
expect to tune. The stall threshold in particular will look wrong the first time a 30-minute test
suite runs under it.

---

### KAR-06.9 — Crash recovery and resume from the last completed boundary

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-06.2, KAR-06.3, KAR-06.4, KAR-06.6, KAR-06.7 |
| **PRD** | F4.2, NF4 |
| **Verified by** | EPIC-06-S6, EPIC-06-S11, EPIC-06-S16, EPIC-06-S25, EPIC-06-S29, EPIC-06-S30 |

**As** an operator whose laptop rebooted at hour four of a six-hour run, **I want** `karvan up` to
pick the run back up from the last completed boundary, **so that** the durability thesis is a
property the suite proves rather than a claim the README makes.

Implements [05-durable-execution §14](../../05-durable-execution.md#14-how-all-of-this-is-tested)
and closes the epic. Startup is a fixed sequence: take `flock`, bump `daemon_epoch`, rebuild
`RunState` (checkpoint if `checkpoint_version` matches, else full replay), **reconcile every
`effect` row still `pending` from a prior epoch**, reclaim locks whose owners are no longer running,
reap orphaned children, load due `node_wake` rows, then start the ticker. Only after all of that
does the first `decide()` run.

Orphan reaping is where the pid-reuse hazard lives. Agents are spawned `{ detached: true }`, so when
karvand dies they are reparented to init and **keep running and keep burning tokens**. The journal
records `(pid, process_start_time)` — `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart= -p <pid>`
on macOS — and on restart a process is killed only when **both** the pid and the start time match.

> **Never kill by bare pid after a restart. Pids are recycled. You will eventually kill the user's
> editor.**

**Acceptance criteria**

1. Startup performs the sequence above in that order, and a test asserts no `StartNode` command is
   issued before reconciliation of prior-epoch `pending` effects has completed.
2. Every `effect` row `pending` with `started_at < daemonStartedAt` is reconciled exactly once at
   startup, and each outcome is an event.
3. Completed nodes are never re-executed: after a restart, `decide()` issues no command for any node
   whose reduced state is `completed`, and the fake agents' side-effect log contains no duplicate
   `idempotencyKey`.
4. Orphan reaping kills a child only when the journaled `(pid, process_start_time)` pair matches the
   live process. A test journals a pid, lets the process exit, spawns a *different* process that is
   assigned the same pid, and asserts the reaper leaves it alone and logs a `pid-reused` skip.
5. `git worktree unlock` is issued for any worktree whose owning process is provably gone (EPIC-07
   owns the git call; this story owns the liveness decision).
6. The run either completes or halts with a typed `NodeFailure` after any number of crashes — it
   never wedges. The crash-fuzz suite asserts this as its fourth invariant.
7. The crash-fuzz test runs in CI on every push with `kill -9` (not SIGTERM — SIGTERM tests the
   shutdown handler, SIGKILL tests durability), a kill point randomised and seeded from
   `$GITHUB_RUN_ID`, and mock agents pinned by `--seed` so the only variable is where the knife
   lands.
8. The pre-crash SSE-projected state is snapshotted on every event by the harness, and the
   post-restart projection equals it at the last durably-written `seq` — accounting for the fact
   that `AUTOINCREMENT` **leaves gaps**, so consumers resume from "strictly greater than my cursor"
   and never assume `cursor + 1`.
9. `PRAGMA integrity_check` returns `ok` after every crash iteration.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Seed a prior-epoch `pending` effect; assert reconciliation runs before the first tick | Startup ordering is incidental |
| 2 | integration | `crashAndRestart()` after 3 of 5 nodes complete; assert 2 `StartNode`s and 0 re-executions | Memoisation is not consulted at startup |
| 3 | integration | Journal a pid, let it die, spawn a same-pid process, run the reaper; assert survival and a `pid-reused` log line | The reaper kills by bare pid |
| 4 | integration | Orphan a detached mock agent by SIGKILLing the daemon; assert it is still running before the reaper and gone after | Orphans are assumed to die with the parent |
| 5 | e2e | Crash-fuzz, 20 iterations, random kill points; assert all four invariants | Any of the durability work is theory |
| 6 | e2e | Crash inside the irreducible window (after the effect's side-effect log line, before `markDone`); assert reconciliation resolves it or escalates, never silently duplicates | The window is unhandled |
| 7 | integration | A ledger with a seq gap from a rolled-back transaction; assert the projection resumes from `> cursor` | A consumer assumes `cursor + 1` |
| 8 | integration | `PRAGMA integrity_check` after each iteration | WAL handling is wrong |

**Notes / risks** — This story is the epic's acceptance gate and it is where schedule risk
concentrates: a crash-fuzz failure is rarely a small fix. Budget the last two days of it for
diagnosis rather than construction, and keep `KARVAN_KEEP_TMP=1` plus `actions/upload-artifact` on
failure wired from the first CI run — a CI-only durability failure with no artefacts is close to
undiagnosable.

---

## Sequencing

KAR-06.1 is first and is genuinely `Ready` today: `RunState` comes from EPIC-03 and nothing else in
this epic can be shaped until `decide()` and `Command` exist. KAR-06.2 and KAR-06.6 follow and are
both small, pure and satisfying — they are the stories to pick up when the effect journal is being
difficult. KAR-06.3 is the first story that touches SQLite in anger; KAR-06.4 depends on it and is
the largest single piece of work in the epic, so start it on a clear week rather than in the gaps.
KAR-06.5 needs KAR-06.6 already in place, because its whole transactional guarantee is about the
`node_wake` row. KAR-06.7 can be slotted anywhere after KAR-06.2. KAR-06.9 is last by construction:
it is the story that proves the other eight.

Two cross-epic realities to plan around. **KAR-06.4 cannot finish without EPIC-07's git wrapper** —
the `Karvan-Effect-Id` trailer and the "already exists is success" mapping need a real `Git` class
with its forbidden-argument assertions, and EPIC-07 depends on this epic in the other direction.
Break the cycle by landing KAR-07.1 (the wrapper alone, no worktree lifecycle) early and treating it
as a KAR-06.4 prerequisite; that is the smaller of the two inversions. And **KAR-06.4's agent
reconciliation needs EPIC-04's `--agent-capabilities` flag**, which turns "does `ResumeByReplay` work
on a Gemini-shaped profile?" from an integration test requiring an installed, authenticated Gemini
CLI into a unit test that runs in 40 ms. That flag is the single highest-leverage item in the mock
agent, and this epic is why.

## Risks

| Risk | Mitigation |
|---|---|
| **This epic is ~22 days, well over the ~15-day guidance, and it is on the critical path with EPIC-07, EPIC-09, EPIC-11, EPIC-13 and EPIC-14 all behind it.** | Stated rather than hidden. It is the hardest epic in the plan and the one the PRD's second Critical gap lands on; shortening it means shipping a run that cannot resume. Three honest levers, in the order they should be pulled: KAR-06.8's churn breaker can ship with the `(node_id, request_hash)` detector only, deferring the replan-based one; KAR-06.4's `file` effect reconciliation can be deferred until EPIC-09 actually writes artifacts through it; and KAR-06.2's per-worktree lock can initially be subsumed by the repo lock at a real parallelism cost. Do **not** defer KAR-06.9 — an unproven durability layer is worse than an absent one, because it will be trusted. |
| **`reconcile()` returning `unknown` has no correct automatic action** (roadmap **A1-5**, rated High; roadmap §7 open question 2 says it needs a *product* answer). If the gate is bolted on late, the first real occurrence lands at 3 a.m. on a nine-hour run with no UI to resolve it. | The Definition of Ready requires the product answer written down before KAR-06.4 starts. EPIC-06-S15 is the scenario; `run.needs_human { reason: 'reconcile-unknown' }` with both hashes in the payload is the contract EPIC-13 builds against. The escalation beyond that — a content-addressed copy-on-write overlay — is explicitly **not** pre-built. |
| **The window between an effect landing in the world and its `done` row committing is irreducible.** There is no two-phase commit with git, a shell command or an HTTP POST. | It can only be shrunk (write `done` immediately; `synchronous = NORMAL` keeps the commit fast) and then reconciled. EPIC-06-S16 crashes *inside* the window deliberately, and the README states the floor plainly. `withFullSync` from EPIC-03 is applied only around a genuinely irreversible external effect. |
| **Vendor resume support is verified only for Claude Code** (roadmap **A1-4**). Copilot advertises `sessionCapabilities: {list}` and Gemini advertises none, so two of five adapters cannot resume at all. | `supportsResume` is read from the generated capability fixture, never assumed. An adapter without resume means a crashed agent node restarts from scratch — a cost-model difference surfaced honestly in the UI, not a correctness difference, because the ledger reconstructs the prompt. The epic DoD requires a test per profile. |
| **Retry and crash-resume are different operations and will be conflated.** `attempt` is part of the ikey, so a retry mints a new key and re-executes by construction — while a crash-resume of the same attempt memoises. An adapter told the wrong one either duplicates work or drops it. | EPIC-06-S17 asserts both directions explicitly, and `EffectCtx` carries a `mode: 'fresh' \| 'resume'` discriminator so an adapter cannot be ambiguous about which situation it is in. |
| **The pid-reuse hazard is a foot-gun with a very long fuse.** Killing by bare pid after a restart works every time in testing and eventually kills the operator's editor. | `(pid, process_start_time)` is journaled from day one and KAR-06.9 criterion 4 tests the reuse case directly by forcing a pid collision. The reaper logs a `pid-reused` skip rather than being silent, so the guard is observable. |
| **`decide()` will accrete I/O.** The first "just one lookup" arrives within a week and NF9 dies quietly. | The package boundary is the enforcement, backed by a dependency-graph test in the epic DoD and a LOC budget measured in CI. Everything `decide()` needs arrives through `RunState` or `now`. |
| **All the durability benchmarks behind this epic ran on Linux, likely overlayfs** (roadmap **A1-1**). Timing-sensitive assertions inherit that caveat. | M0-S5 re-runs them on the author's laptop as part of EPIC-03's Definition of Ready. Set CI performance budgets at ~3× the measured figure so they catch regressions without flaking, and keep timing out of correctness assertions entirely — the `TestClock` means almost none of this epic needs a real duration. |

---

**Related:** [Flows](../flows/EPIC-06-orchestrator-flows.md) · [Board](../board.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[07-provider-adapter-layer.md](../../07-provider-adapter-layer.md) ·
[09-workspace-and-safety.md](../../09-workspace-and-safety.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
