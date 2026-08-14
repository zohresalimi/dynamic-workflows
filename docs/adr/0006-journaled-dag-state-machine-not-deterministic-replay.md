# ADR 0006: A journaled DAG state machine, not deterministic workflow replay

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

Durable execution has two established models:

- **Deterministic replay** (Temporal, Restate, and in part Inngest). The workflow is code. On
  recovery the engine re-executes that code from the top, feeding recorded results back at each
  step boundary, so the implicit control flow is reconstructed. This is powerful and it is how you
  get durability out of arbitrary imperative programs.
- **Checkpoint-and-memoize** (DBOS, Inngest's step model). Each step's _result_ is journaled. On
  recovery you do not re-execute orchestration logic; you look up what already happened.

Replay's one real benefit is reconstructing implicit control flow from code. DeFlow does not have
implicit control flow: [ADR 0005](./0005-plan-as-data-not-code.md) makes the plan an explicit,
persisted, content-addressed document. The control flow is already on disk.

Replay's costs, on the other hand, are real. It imposes determinism constraints on orchestration
code and creates the classic "cannot change workflow code while runs are in flight" problem — hence
Temporal's `patched()` and Inngest's machinery, where step IDs must be SHA-1 hashes of
human-readable names with a `:n` suffix appended per repeat occurrence, plus a `ctx.stack.stack`
array whose sole purpose is detecting that the code changed mid-run. All of that exists to solve a
problem DeFlow does not have.

DeFlow's runs last hours to days, on a laptop, developed by one person who will be restarting the
daemon constantly. "Cannot upgrade the engine while a run is in flight" would be a daily obstruction.

The performance argument for replay-style optimisation also does not hold here. **Verified
2026-08-02** by benchmark on better-sqlite3 13.0.2 with WAL and `synchronous=NORMAL`: control-plane
replay of 10,000 rows takes **29 ms**, and a full scan of 500,000 rows takes **416 ms**.

## Decision

**Build a journaled DAG state machine: an append-only event ledger, a pure reducer, a pure decision
function, and an effect journal with idempotency keys.**

```ts
export function reduce(s: RunState, e: Event): RunState; // pure, total, ignores unknown kinds
export function decide(s: RunState, now: number): Command[]; // pure: what should happen next
export interface EffectRunner {
  run(c: Command, ctx: EffectCtx): Promise<Event[]>;
} // impure shell
```

Nine primitives, all load-bearing, nothing else needed:

1. Append-only event log with a single global monotonic `seq`
   (`INTEGER PRIMARY KEY AUTOINCREMENT` — **mandatory**; plain rowid reuses sequence numbers after a
   delete, **verified 2026-08-02**, which silently corrupts every persisted SSE cursor the moment
   run pruning is added).
2. A deterministic reducer that is pure, total, and **ignores unknown `kind` values** — forward
   compatibility for a user who downgrades DeFlowd.
3. `decide()` separated from execution, so the whole scheduler is unit-testable with zero I/O (NF9).
4. Step boundary = one node attempt, journaled as `node.started` (written _before_ the side effect) →
   `node.progress*` → `node.completed | node.failed`. The pre-effect record is what makes
   at-least-once recovery possible at all.
5. Idempotency key `(run_id, node_id, attempt, effect_ordinal)` (F4.3).
6. At-least-once plus a per-effect-type `reconcile()` probe for the crash-mid-effect case.
7. **Effect journaling, not replay**: the result of every non-deterministic operation is persisted;
   restart short-circuits on a `done` record.
8. Two-layer versioning: an event envelope carrying `kind` + `v:int` with a read-time upcaster
   chain; plan versioning is free because plans are immutable documents referenced by hash.
9. Fencing: `flock` on `~/.DeFlow/DeFlow.lock` plus a `daemon_epoch` bumped on every start, with
   stale-epoch writes rejected — because running `npx deflow up` in two terminals is very common.

The schema splits the small control-plane `event` table from the high-volume `io_chunk` table. That
split is what makes snapshotting unnecessary: a 40-node multi-hour run produces on the order of 2k
control-plane events, and replaying that is single-digit milliseconds. Full detail, including the
measured numbers and the effect-type reconciliation table, is in
[05-durable-execution.md](../05-durable-execution.md).

## Consequences

### Positive

- **DeFlowd is upgradeable mid-run.** This is the headline consequence. There is no determinism
  constraint on engine code, so the only compatibility surface is the event schema, which is
  versioned explicitly with an upcaster chain. Every `node --watch` restart during development
  exercises F4.2 for free.
- The scheduler, the retry policy, the stall detectors and the whole ready-set calculation are pure
  functions testable with a `FakeClock` — a six-hour human gate is exercised in microseconds.
- No snapshotting subsystem, which would otherwise be the most bug-prone part of the system. The
  `run.state_json` checkpoint is a pure cache guarded by a `checkpoint_version` column: a mismatch
  means "full replay", so a checkpoint can never cause a correctness bug.
- Long suspension is durable by construction: `node_wake(run_id, node_id, wake_at, reason)` rows
  instead of `setTimeout`. **Verified 2026-08-02** that passing `2**31` to `setTimeout` fires the
  callback after **1 ms** with only a `TimeoutOverflowWarning` — a 30-day wait becoming instant.

### Negative

- We own the correctness. There is no vendor to blame for a durability bug, which raises the bar on
  the crash-fuzz test suite ([14-testing-strategy.md](../14-testing-strategy.md)).
- **The window between an effect landing in the world and its `done` row committing is irreducible.**
  There is no two-phase commit with git or a shell. It can be shrunk and reconciled, not closed. Any
  design claiming otherwise is lying.
- `reconcile()` can legitimately return `unknown`, and there is no correct automatic action. The
  human gate for that case must exist from day one rather than being bolted on.
- `attempt` in the idempotency key means a retry deliberately produces a _new_ key and _will_
  re-execute. Crash-resume (same attempt, memoise) and failure-retry (new attempt, re-execute) are
  genuinely different operations and the reducer must distinguish them.

### Neutral

- `synchronous=NORMAL` protects against process crash, not power loss. **Verified 2026-08-02**:
  SIGKILL mid-write at ~45k committed rows, reopen, all 45,339 rows present,
  `PRAGMA integrity_check` = `ok`. `FULL` costs ~23× throughput (979 vs 22,982 ev/s). For a laptop
  daemon `NORMAL` is the right trade, with `FULL` reserved for transactions recording genuinely
  irreversible external effects.

## Alternatives considered

- **Temporal / Restate.** Rejected: replay-safety constrains orchestration code, they are heavy for
  a single-user local tool, they need a server (violating NF6), and their UIs are operator
  dashboards rather than agent-work surfaces. Borrow the pattern, not the dependency (PRD §4.4).
- **DBOS Transact for TypeScript.** Rejected on verified source-level grounds — see
  [ADR 0008](./0008-build-the-durable-engine-rather-than-adopt-one.md).
- **LangGraph checkpointers.** Rejected on ADR 0003 grounds (raw model APIs) and because its
  persistence is thread/graph state rather than side-effect journaling.
- **Snapshot-per-N-events from the start.** Rejected on measurement: 29 ms control-plane replay
  means the complexity budget belongs in effect reconciliation, not in a snapshot subsystem. The
  hook exists and stays trivial.

## Revisit when

Either of these is measured, not anticipated:

1. **A single run exceeds ~100,000 control-plane events** (e.g. a 10,000-node DAG). Then add
   per-run snapshot rows keyed by `(run_id, seq)`, keeping the `checkpoint_version` guard. This does
   not change the model, only the cache.
2. **Users want to write imperative TypeScript workflows.** That is the one thing replay genuinely
   buys, and it would be added as a _second execution mode over the same ledger_ — not retrofitted.
   That needs a superseding ADR, and ADR 0005 would need superseding too.

Not a trigger: multi-machine orchestration. That would first require reopening AR-1
([ADR 0003](./0003-never-hold-provider-credentials.md)).

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
