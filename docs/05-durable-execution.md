# Durable execution

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This is the engine. Everything in [PRD §7.4](./prd.md#74-durable-execution) — the event-sourced
ledger (F4.1), resume after crash (F4.2), idempotency keys (F4.3), pause/resume/cancel (F4.4),
node-level retry (F4.5), budget ceilings (F4.6), no-progress detection (F4.7), long suspension
(F4.8) — lands here, plus NF4 ("run state survives daemon restart, OS restart and laptop sleep"),
NF9 (deterministic core) and NF10 (auditable).

It is also the document with the most measured evidence behind it. The design below was not chosen
from a blog post; the alternatives were benchmarked on 2026-08-02 against `better-sqlite3@13.0.2`,
and the numbers are quoted inline. Where a number appears, it was measured.

| Decision           | Verdict                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Execution model    | Checkpoint-and-memoize (Inngest/DBOS), **not** deterministic replay (Temporal/Restate) — D7 |
| Dependency         | Build it. ~800–1500 LOC. DBOS rejected on source evidence                                   |
| Store              | `better-sqlite3@13.0.2` behind a ~60-line `Db` port — D6                                    |
| Snapshotting       | **Do not build it yet.** The control-plane/data-plane table split removes the need          |
| Sequence numbers   | `INTEGER PRIMARY KEY AUTOINCREMENT`. Non-negotiable                                         |
| Timers             | Durable `node_wake` rows on a ~1 Hz tick. **Never** `setTimeout` for a wait                 |
| Durability setting | `synchronous = NORMAL`. Survives process crash, not power loss. Stated, not hidden          |

---

## 1. Why checkpoint-and-memoize and not deterministic replay

Durable execution engines split into two families.

**Deterministic replay** (Temporal, Restate, Cloudflare Workflows) treats your _workflow function_
as the source of truth. On recovery it re-executes the function from the top, feeding recorded
results back at each await point until it reaches the frontier. That works only if the function is
deterministic, which imposes a real tax: no `Date.now()`, no `Math.random()`, no unordered
iteration, no branching on anything not in the history — and, most painfully, **you cannot change
the workflow code while runs are in flight**. Temporal answers that with `patched()` / version
markers. Inngest answers it with step-hash machinery: step IDs are SHA-1 hashes of the
human-readable step name with a `:n` suffix appended per repeat occurrence, plus a `ctx.stack.stack`
array carried in every request purely so the SDK can detect that the code changed underneath a
running function.

**Checkpoint-and-memoize** (Inngest's and DBOS's actual persistence layer, underneath that
machinery) treats the _journal_ as the source of truth. Each step boundary writes an intent record
before the side effect and a result record after it. Recovery does not re-execute orchestration
code at all — it folds the log into state and short-circuits any step that already has a `done`
record.

DeFlow takes the second model, and the reason is structural rather than aesthetic: **DeFlow's
control flow is already persisted data.** The `PlanGraph` is an immutable, content-hashed JSON
document in SQLite ([domain model](./04-domain-model.md)), and node identity comes from `node_id`
in that document — never from code position, call order, or a hash of a function name. The one
thing replay buys you, reconstructing implicit control flow from imperative code, is something
DeFlow does not need, because there is no imperative workflow code to reconstruct it from.

Three consequences follow, and they are the whole argument:

1. **DeFlowd can be upgraded mid-run with zero determinism risk.** Stop the daemon, install a new
   version, start it, and in-flight runs continue. There is no "workflow versioning" problem
   because there is no workflow code whose shape must match the history.
2. **The entire problem class disappears.** No `patched()`, no version markers, no step-hash
   counters, no `ctx.stack` change detection, no "you added an `await` above line 40 and now every
   running instance is non-deterministic". None of that machinery exists in DeFlow because none of
   the problems it solves exist in DeFlow.
3. **The only compatibility surface left is the event payload schema**, and that is handled
   explicitly: every event carries `kind` plus an integer `v`, with an upcaster chain
   `upcast(kind, v, payload) -> latestPayload` applied at read time. That is one small, testable,
   well-understood surface instead of a diffuse property of all your code.

There is no performance argument on the other side either. **Verified 2026-08-02:** folding a
control-plane ledger of 10,000 rows into state takes **29 ms**; a full scan of 500,000 rows takes
**416 ms**. Replay-style optimisation would be solving a problem that does not exist at this scale.

**When the other model would be right.** If DeFlow ever lets users write imperative TypeScript
workflows, deterministic replay becomes necessary for _those_. Add it then, as a second execution
mode layered on the same ledger. Do not retrofit it into this one.

---

## 2. Build, don't buy — the DBOS verdict

The PRD's §9.2 sketch floated DBOS as an embedded option ("DBOS demonstrates the pattern"). That
was investigated from source rather than from documentation, and it does not hold.

**Verified 2026-08-02**, against `dbos-inc/dbos-transact-ts` cloned at commit
`dfd600cc48537a69f3d57d28108a781bfb82c988` (2026-07-30):

- `package.json` dependencies are exactly `commander`, `pg`, `serialize-error`, `superjson`, `ws`,
  `yaml`. No SQLite driver. No optional or peer dependency that could supply one.
- `src/system_database.ts` line 666: `export class SystemDatabase { readonly pool: Pool; … }` — a
  hard `pg.Pool`. The constructor takes a `systemDatabaseUrl: string` and an optional `pg.Pool`.
- `src/sysdb_migrations/migration_runner.ts` imports `type { ClientBase } from 'pg'` and queries
  `information_schema.tables`.
- That migration runner declares a `sqlite3?: ReadonlyArray<string>` field on its `DBMigration`
  type — and a repo-wide grep shows **the field is referenced nowhere else in `src/`**. It is a
  dead placeholder, probably copied from a polyglot spec.
- npm `@dbos-inc/dbos-sdk@4.25.14` (published 2026-07-30) ships the same pg-only dependency set.
- SQLite durability landed in DBOS **Go**, not TypeScript. (That Go claim rests on a search summary
  of the DBOS June 2026 release notes; `www.dbos.dev` returns 403 to automated fetch, so treat it
  as medium confidence. It does not change the recommendation either way.)

That `sqlite3?` field is exactly the kind of artefact that produces a false positive in a
docs-and-search investigation. Reading the source is why this is settled rather than hopeful.

And even if TypeScript SQLite support lands in 2027, it would still be the wrong shape: DBOS models
workflows as decorated imperative functions with `DBOS.runStep`, owns its own `dbos` schema, runs
its own recovery executor, and uses a Postgres `LISTEN`/`NOTIFY` loop for notifications. All of
that fights the data-driven DAG above, and a Postgres requirement contradicts NF6 outright — the
promise is `npx DeFlow up` with no database server.

The rest of the field is no better. `reflow-ts@0.5.0` (2026-06-10, four published versions total)
is the only SQLite-backed TypeScript durable-execution package found, and four releases is not a
durability guarantee. `@aws/durable-execution-sdk-js@2.2.0` is Lambda-only.

**What you would be reimplementing is small, and you have to own it anyway**: the ledger, the
reducer, the effect journal, the scheduler. Budget **~800–1500 LOC** of core, excluding effect
adapters. Revisit DBOS-on-Postgres or Restate only if DeFlow ever needs multi-machine orchestration
— which [PRD §5](./prd.md#5-the-provider-neutrality-constraint-read-this-before-anything-else)
argues against.

---

## 3. The nine load-bearing primitives

All nine are load-bearing. Nothing else is needed, and adding a tenth should require an argument.

**1. Append-only event log with a single global monotonic `seq`.** One `event` table, one
`INTEGER PRIMARY KEY AUTOINCREMENT` column. `seq` is the total order of the system: it is the SSE
frame id, the checkpoint cursor, the progress watermark, and the tiebreaker for anything the wall
clock cannot order. Timestamps are informational; `seq` is authoritative (F4.1, NF10).

**2. A deterministic reducer `(state, event) -> state`.** Pure, total, and — this is the part
people skip — it **must ignore unknown `kind` values** rather than throwing. A user who downgrades
DeFlowd after a run has recorded a newer event kind must get a degraded projection, never a
corrupted one or a crash loop.

**3. `decide()` separated from execution.** The scheduler's entire policy — ready-set derivation,
admission, backoff, stall detection, budget ceilings — is a pure function of state and the current
instant. It returns `Command[]`; it never performs anything. This is what makes the scheduler
unit-testable with zero I/O and is how NF9 is satisfied by construction rather than by convention.

**4. A step boundary is one node attempt**, journaled as a three-record lifecycle: `node.started`
written **before** the side effect, then `node.progress*`, then `node.completed | node.failed`. The
pre-effect record is the thing that makes at-least-once recovery possible at all. Without it, a
crash between "started work" and "finished work" is indistinguishable from "never started".

**5. Idempotency key** `(run_id, node_id, attempt, ordinal)` on every side-effecting operation
(F4.3). §7 works through this in detail.

**6. At-least-once plus dedup.** Every effect type ships a `reconcile()` probe answering "did this
already happen out there in the world?" for the crash-mid-effect case. There is no exactly-once;
there is at-least-once plus a good enough probe plus an honest escalation path when the probe
cannot tell.

**7. Effect journaling, not replay.** The _result_ of every non-deterministic operation is
persisted. Restart short-circuits on a `done` record. You never re-execute orchestration code to
reconstruct state — you `reduce()` the log.

**8. Versioning in two layers.** (a) The event envelope carries `kind` + `v:int`, with an upcaster
chain applied at read time. (b) Plan versioning is _free_: plans are immutable documents referenced
by content hash, so a replan writes a **new** `plan` row plus a `plan.patched` event rather than
mutating anything. That property is also exactly what makes the plan-evolution scrubber (F10.2)
possible — see [planning and replanning](./06-planning-and-replanning.md).

**9. Fencing and lease**, even in a single-user daemon. `flock` plus a `daemon_epoch`. §10 covers
why this is not paranoia.

---

## 4. The functional core

Three declarations carry the engine. They live in `@DeFlow/core`, which has no dependency capable
of performing I/O.

```ts
// Pure, total, forward-compatible. Ignores unknown event kinds.
export function reduce(state: RunState, event: Event): RunState;

// Pure. "Given this state, at this instant, what should happen next?"
export function decide(state: RunState, now: number): Command[];

// The imperative shell (@DeFlow/daemon) — the only place effects happen.
export interface EffectRunner {
  run(command: Command, ctx: EffectCtx): Promise<Event[]>;
}
```

The loop is: `reduce` the log into `RunState` → call `decide` → hand the resulting `Command[]` to
the `EffectRunner` → append the `Event[]` it returns → `reduce` those → repeat. Nothing else
mutates run state, ever.

The discipline buys four concrete things:

- **The whole scheduler is testable with no SQLite, no spawn, no clock.** Ready-set derivation,
  jitter, semaphore admission, churn detection and budget ceilings are pure functions over a plain
  object.
- **Six hours costs microseconds.** With a `Clock` port injected, `clock.advance(hours(6))`
  exercises a six-hour human gate instantly.
- **Crash tests are cheap.** `harness.crashAndRestart()` reopens the database, rebuilds state and
  asserts invariants — see [testing strategy](./14-testing-strategy.md).
- **NF9 is enforced by a package boundary**, not by code review.

The corollary is a hard rule: **anything nondeterministic goes through a port.** Time via `Clock`.
Randomness via a seeded generator. Ids via an injected factory. An import of `node:fs` inside
`@DeFlow/core` means the design has already broken.

---

## 5. The schema

Six tables. The most important decision in the whole file is the first two being _two_ tables and
not one.

```sql
-- ── CONTROL PLANE ────────────────────────────────────────────────────────
-- Small. This is what replay() reads. Every row can change reduced state.
CREATE TABLE event (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- MANDATORY. See §6.
  run_id     TEXT    NOT NULL,
  ts         INTEGER NOT NULL,          -- ms epoch, informational only; ORDER IS seq
  kind       TEXT    NOT NULL,          -- 'node.started' | 'node.completed' | …
  v          INTEGER NOT NULL DEFAULT 1,-- payload schema version, for upcasting
  node_id    TEXT,
  attempt    INTEGER,
  ikey       TEXT,                      -- effect idempotency key, when applicable
  payload    TEXT    NOT NULL           -- JSON
) STRICT;
CREATE INDEX event_run_seq ON event(run_id, seq);

-- ── DATA PLANE ───────────────────────────────────────────────────────────
-- Huge. NEVER read by the reducer. Agent stdout/stderr and raw protocol frames.
CREATE TABLE io_chunk (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL,
  node_id  TEXT NOT NULL,
  attempt  INTEGER NOT NULL,
  stream   TEXT NOT NULL,               -- 'stdout' | 'stderr' | 'agent_json'
  ts       INTEGER NOT NULL,
  data     BLOB NOT NULL
) STRICT;
CREATE INDEX io_run_seq ON io_chunk(run_id, seq);

-- ── THE IDEMPOTENCY JOURNAL ──────────────────────────────────────────────
CREATE TABLE effect (
  ikey         TEXT PRIMARY KEY,        -- run_id/node_id/attempt/ordinal
  run_id       TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  ordinal      INTEGER NOT NULL,
  kind         TEXT NOT NULL,           -- 'agent' | 'shell' | 'git' | 'file'
  request_hash TEXT NOT NULL,           -- guards against a plan edit under a live effect
  state        TEXT NOT NULL,           -- 'pending' | 'done' | 'failed'
  result_json  TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
) STRICT;
CREATE INDEX effect_run_state ON effect(run_id, state);

-- ── IMMUTABLE PLAN DOCUMENTS ─────────────────────────────────────────────
CREATE TABLE plan (
  hash       TEXT PRIMARY KEY,          -- content hash of doc
  run_id     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  doc        TEXT NOT NULL
) STRICT;

-- ── PROJECTION CACHE — always rebuildable from `event` ────────────────────
CREATE TABLE run (
  run_id            TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  plan_hash         TEXT NOT NULL,
  last_seq          INTEGER NOT NULL,
  state_json        TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL,  -- bump when the reducer changes shape
  daemon_epoch      INTEGER NOT NULL
) STRICT;

-- ── DURABLE TIMERS — replaces setTimeout entirely ────────────────────────
CREATE TABLE node_wake (
  run_id  TEXT NOT NULL,
  node_id TEXT NOT NULL,
  wake_at INTEGER NOT NULL,
  reason  TEXT NOT NULL,                -- 'backoff' | 'human_gate' | 'poll' | …
  PRIMARY KEY (run_id, node_id)
) STRICT;
CREATE INDEX node_wake_due ON node_wake(wake_at);
```

All tables are `STRICT`. **Verified 2026-08-02:** `STRICT` genuinely enforces column types —
inserting text into an `INTEGER` column fails with `cannot store TEXT value in INTEGER column`
rather than silently coercing. Also verified: `RETURNING seq` works, so an append gets its assigned
sequence number without a second query; and generated columns over JSON work
(`kind TEXT GENERATED ALWAYS AS (payload->>'kind') VIRTUAL`) if you ever want to index into a
payload without denormalising it.

### 5.1 Why the control-plane / data-plane split removes snapshotting

The usual event-sourcing folklore says "replay gets slow, therefore build snapshots". That folklore
is measuring the wrong thing. Replay gets slow when you mix a megabyte-per-minute agent transcript
into the same table as your state transitions. Separate them and the problem evaporates.

**Measured 2026-08-02** (this machine, `better-sqlite3@13.0.2`, WAL + `synchronous = NORMAL`):

| Measurement                                                                | Result                         |
| -------------------------------------------------------------------------- | ------------------------------ |
| 500,000 events in one combined table                                       | **193 MB**, inserted in 4.8 s  |
| Full replay scan of all 500,000 rows                                       | **416 ms**                     |
| Control-plane subset (10,000 rows) reduced to state                        | **29 ms**                      |
| 1,000 SSE tail queries (`WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500`) | **196 ms total, ~0.2 ms each** |

The control-plane figure was obtained on the combined table via a partial index — `EXPLAIN QUERY
PLAN` confirmed `SEARCH event USING INDEX event_run_ctl`. In the shipped schema the same isolation
is achieved _physically_, by the table split, which is strictly better: there is no index to get
wrong and no `kind` predicate to keep in sync. The SSE tail query is served by
`SEARCH event USING COVERING INDEX event_run_seq`.

**Clarification, verified 2026-08-05 (KAR-03.4).** That plan string is what the *seq-only* cursor
probe produces. `event_run_seq` covers `(run_id, seq)`, so the shipped tail — which selects the
whole envelope, payload included — fetches the row and plans as
`SEARCH event USING INDEX event_run_seq (run_id=? AND seq>?)`. Both are asserted in
`packages/ledger/test/integration/control-plane-split.test.ts`, along with the two properties that
carry the performance either way: **no `SCAN event`** and **no `USE TEMP B-TREE FOR ORDER BY`**.

A 40-node multi-hour run produces on the order of **2,000** control-plane events. Reducing that is
single-digit milliseconds.

> **Conclusion, stated plainly: do not build snapshotting yet.**

Ship the checkpoint hook, but keep it trivial and keep it honest:

- `run.state_json` + `run.last_seq` is a **cache**, written opportunistically — every ~500 events,
  or on quiesce — and **always in the same transaction as the events it covers**.
- Startup is:
  `state = checkpointValid ? decode(run.state_json) : initial`, then
  `reduce()` over `event WHERE run_id = ? AND seq > last_seq`.
- `checkpoint_version` is bumped whenever the reducer's state shape changes. A mismatch means
  "ignore the cache, full replay".

That last column is the point. It makes the checkpoint a **pure optimisation that can never cause a
correctness bug** — a property worth far more than the milliseconds it saves. A checkpoint that can
be wrong is a checkpoint that will eventually be wrong at 3am on a nine-hour run.

Revisit real snapshots only if a single run exceeds ~100k control-plane events, which would mean
you started emitting control events per tool call rather than per step. Instrument the count per
run from M1 so you find out by measurement instead of by pain. If ledger _file size_ becomes an
operational concern before that, the cheaper move is putting `io_chunk` in a second SQLite file
via `ATTACH`.

---

## 6. AUTOINCREMENT is mandatory

Not a style preference. A verified landmine.

**Verified 2026-08-02.** With a plain `INTEGER PRIMARY KEY`, insert rows 1, 2, 3; delete row 3;
insert again — the new row gets **seq 3**. The sequence number is reused, because a bare rowid is
`max(rowid) + 1` and `max` just moved. With `AUTOINCREMENT` the same sequence yields **1, 2, 4**,
because SQLite keeps the high-water mark in a `sqlite_sequence` row that deletion does not lower.

Why this is catastrophic rather than untidy: `seq` is the identity of an event _outside_ the
database. It is the SSE frame `id` a browser tab persisted before a reload. It is the `last_seq` in
a checkpoint row. It is the cursor a frontend store holds across a reconnect. The moment run
pruning or retention is added — and it will be added, because a 193 MB ledger is real — every one
of those persisted cursors starts pointing at a _different event than the one it was written for_,
silently, with no error anywhere. The UI shows the wrong history; the checkpoint skips events that
were never applied.

The cost of `AUTOINCREMENT` is one extra `sqlite_sequence` row update per insert. Pay it, on both
`event` and `io_chunk`.

One contract that follows: **sequence numbers have gaps.** Every consumer must resume from "strictly
greater than my cursor" and must never assume the next event is `cursor + 1`. This is spelled out in
the SSE contract in [API and realtime](./11-api-and-realtime.md). The two things that produce the
gaps are:

- **Pruning**, per the paragraph above: `AUTOINCREMENT` never reissues a deleted number, so a pruned
  event leaves a permanent hole in what any reader observes.
- **One global `event` table.** Two active runs interleave in it, so a run's cursor walks a strided
  subsequence and `cursor + 1` is wrong before anything has been deleted at all.

**Correction, verified 2026-08-05 (KAR-03.3).** This section previously said "a rolled-back
transaction burns `AUTOINCREMENT` values". It does not. `sqlite_sequence` is an ordinary table, its
high-water update is part of the transaction, and `ROLLBACK` — full or to a `SAVEPOINT` — restores
it, so the next append is handed the same numbers the rolled-back batch was given. Probed on
better-sqlite3@13.0.2 / SQLite 3.53.4 under this project's own pragmas, in both WAL and rollback-journal
mode. The contract above is unchanged — it rests on the two mechanisms just listed — but one corollary
is worth stating explicitly, because the append API returns seqs from inside a transaction: **a `seq`
means nothing until the transaction that produced it commits.**

---

## 7. Connection setup and migrations

### 7.1 PRAGMAs, in this order, on every open

```sql
PRAGMA journal_mode = WAL;             -- persistent; survives reopen
PRAGMA synchronous = NORMAL;           -- see §9.7 for exactly what this does and does not buy
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA wal_autocheckpoint = 1000;      -- pages
PRAGMA journal_size_limit = 67108864;  -- 64 MB cap after checkpoint
PRAGMA cache_size = -32000;            -- 32 MB
```

Order matters: `journal_mode` first because it is persistent and the rest are per-connection;
`busy_timeout` before anything that might contend.

**One write connection, N read-only connections.** **Verified 2026-08-02:** SQLite permits exactly
one writer — a second connection's `BEGIN IMMEDIATE` fails with `SQLITE_BUSY`. Do not build a write
pool. Set `busy_timeout` on every connection including the readers.

### 7.2 Migrations: ~40 lines on `PRAGMA user_version`

No library is worth it here. What was rejected, and why: `umzug@3.8.3` is DB-agnostic and
heavyweight for six tables; `@blackglory/better-sqlite3-migrations@0.2.2` is a 0.x single-maintainer
package; `drizzle-kit@0.31.10` drags in a whole ORM, and `drizzle-orm` is mid-major-transition
(`latest` is 0.45.2 while the 1.0 line has sat in `rc.4` since 2026-06-27) so adopting it during
this window is a bad trade; `sqlite@5.1.1` has not shipped since 2023. `dbmate@2.34.1` is a decent
standalone binary that does support SQLite, but it adds a non-npm install step, which conflicts
with `npx DeFlow up` (NF6).

```ts
type Migration = { id: number; name: string; up: (db: Db) => void };

export function migrate(db: Db, migrations: readonly Migration[]) {
  db.exec("PRAGMA foreign_keys = OFF");
  const cur = db.prepare<{ user_version: number }>("PRAGMA user_version").get()!
    .user_version;
  for (const m of migrations
    .filter((m) => m.id > cur)
    .sort((a, b) => a.id - b.id)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.id}`); // cannot be parameterised
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.id} (${m.name}) failed`, { cause: e });
    }
  }
  db.exec("PRAGMA foreign_keys = ON");
}
```

Rules:

- Migrations are **append-only** and never edited once shipped. Each is a numbered `.ts` file
  exporting `up`.
- **No `down` migrations.** For a local single-user daemon you roll forward or restore a backup.
  A down migration is a second, less-tested code path that exists to be wrong.
- **Back up before migrating**: `VACUUM INTO '<dbdir>/pre-migrate-<user_version>.db'`. **Measured
  2026-08-02: 1007 ms for a 193 MB database.** That is a completely acceptable safety net.
  (`db.backup()` measured 1633 ms for the same file, so `VACUUM INTO` is both faster and produces a
  compacted copy.)
- SQLite DDL is transactional, unlike MySQL, so a failed migration rolls back cleanly.

`VACUUM INTO` has a second use: it is a one-command "attach my ledger to this bug report", which
matters a lot when you are the only engineer on the project.

---

## 8. Idempotency

### 8.1 The key

```
ikey = `${run_id}/${node_id}/${attempt}/${ordinal}`
```

Hash it to short hex when it has to be embedded in a filename.

`ordinal` is a monotonic counter of effects within one node attempt, and the critical detail is
**where it comes from**: it is assigned from the _reducer's view_ of how many effect intents this
`(run_id, node_id, attempt)` has already recorded — not from a runtime counter in the effect
runner. A runtime counter resets to zero when the process restarts, so the second effect of an
interrupted attempt would come back as ordinal 0 and collide with the first. Derived from reduced
state, the same effect gets the same ordinal on every restart, which is the entire point.

### 8.2 The write-ahead effect journal

Intent first, then act, then record. This is the protocol:

```ts
async function durable<T>(eff: Effect<T>): Promise<T> {
  const row = db.transaction(() => {
    db.prepare(
      `INSERT INTO effect(ikey,run_id,node_id,attempt,ordinal,kind,request_hash,state,started_at)
                VALUES (@ikey,@run_id,@node_id,@attempt,@ordinal,@kind,@request_hash,'pending',@now)
                ON CONFLICT(ikey) DO NOTHING`,
    ).run(eff.meta);
    return db.prepare(`SELECT * FROM effect WHERE ikey=?`).get(eff.ikey)!;
  })();

  if (row.state === "done") return JSON.parse(row.result_json) as T; // memoised
  if (row.state === "failed") throw new EffectFailed(row);

  if (row.started_at < daemonStartedAt) {
    // 'pending' from a PREVIOUS daemon life => we crashed mid-effect. Ambiguous.
    const probe = await eff.reconcile(row); // 'done' | 'not-started' | 'unknown'
    if (probe.status === "done") {
      markDone(eff.ikey, probe.result);
      return probe.result;
    }
    if (probe.status === "unknown") throw new NeedsHumanReview(eff.ikey);
  }

  const result = await eff.perform(); // ikey embedded in the world where possible
  markDone(eff.ikey, result);
  return result;
}
```

Read the branches carefully, because each one is a different real situation:

- `done` → the effect completed in a previous life. **Memoise.** This is F4.2's "completed nodes are
  never re-executed", at effect granularity.
- `failed` → a recorded, classified failure. Rethrow it; the scheduler decides whether that means
  retry (new attempt, new ikey) or fail the node.
- `pending` **from this daemon's life** → normal concurrent execution; fall through and perform.
- `pending` **from a previous daemon's life** → we died mid-effect. This is the only genuinely hard
  case, and it is what `reconcile()` exists for.

`request_hash` is the guard against a subtler failure: someone edits the plan (or a `PlanPatch`
lands) so that a node now does something _different_, while an `effect` row for that ikey already
exists. Without the hash you would happily return the memoised result of the old operation as if it
were the new one. A mismatch is a **hard error**, not a warning and not a silent stale result.

### 8.3 The four effect types

A generic "use an idempotency key" recommendation would be useless, because each of the four things
DeFlow actually does has a different reconciliation story.

**Agent invocation — the good case.** Journal the `session_id` from the **first** frame the instant
it arrives, as its own `event` row, never buffered — a buffered session id is a session id you lose
in exactly the crash where you needed it. On reconcile: if a session id is journaled _and the
adapter advertises resume_, resume the session; if none is journaled, the agent produced no durable
state and a clean restart is safe. Raw stdout streams into `io_chunk` throughout, so a partial
transcript survives the crash and the UI can replay it.

Resume semantics differ per vendor, so this is a **per-adapter `supportsResume` capability flag,
never an assumption**. Claude Code's headless mode has `--resume <session_id>` with
`--output-format stream-json` for NDJSON and `--output-format json` returning a session id. At the
ACP layer, `session.resume` is advertised by Claude, Codex and OpenCode but **not** by Copilot or
Gemini ([provider adapter layer](./07-provider-adapter-layer.md)). An adapter without resume means a
crashed agent node restarts from scratch — a cost model difference, not a correctness difference,
because DeFlow's own ledger is always sufficient to reconstruct the prompt.

**Shell command — not idempotent in general, and no cleverness fixes that.** Classify it at
**plan time**, not at run time:

- `pure` — test, lint, build, typecheck. Just re-run it; the cost is time.
- `mutating` — migrations, package publishes, network POSTs.

For `mutating`, run inside a dedicated worktree and journal a hash of `git status --porcelain`
**before** and **after**. Reconcile by re-hashing: matches the _before_ hash ⇒ not started; matches
the _after_ hash ⇒ done; anything else ⇒ `unknown`. **Never auto-retry a `mutating` command whose
`reconcile()` returns `unknown`.** Escalate to the human gate. A migration that half-ran is not a
thing to guess about.

**Git — make it structurally idempotent instead of journaling around it.** Branch names are flat,
`DeFlow/<runId>__<nodeId>` (D13 — the PRD's slashed form is a verified bug, since git cannot have
`refs/heads/DeFlow/r1` be both a file and a directory, which blocks any run-level integration
branch). Worktree path `.DeFlow/wt/<runId>__<nodeId>`. `git worktree add` failing with "already
exists" is a **success**, not an error.

Commits are the one genuinely non-idempotent git operation, and a single trailer fixes them:

```bash
git commit -m "<subject>" -m "DeFlow-Effect-Id: <ikey>"
# reconcile:
git log --grep="DeFlow-Effect-Id: <ikey>" --format=%H -1
```

Absolute rule inside a retriable node: **no `push --force`, no `reset --hard`, no `clean -fdx`.**
Full detail in [workspace and safety](./09-workspace-and-safety.md).

**File write — atomic rename, with the ikey in the temp filename.**

```ts
const tmp = `${path}.DeFlow-${ikey}.tmp`; // sibling of the target, NEVER /tmp
const fd = openSync(tmp, "w");
writeSync(fd, data);
fsyncSync(fd);
closeSync(fd);
renameSync(tmp, path);
fsyncSync(dirFd); // then fsync the DIRECTORY
```

Reconcile is pleasingly simple: an orphaned tmp file bearing this ikey means the crash happened
before the rename, so unlink it and redo. No tmp file and a target whose content hash matches means
done.

---

## 9. The known holes

Every design that claims exactly-once side effects against git and a shell is lying. Here is what
DeFlow cannot do, stated up front so nobody is surprised by it later.

**9.1 The window between the effect landing in the world and the `done` row committing is
irreducible.** There is no two-phase commit with git, with a shell command, or with an HTTP POST.
It can only be _shrunk_ — write `done` immediately, keep `synchronous = NORMAL` so the commit is
fast — and then reconciled. This is the honest floor of the whole design.

**9.2 A retry deliberately produces a new ikey and re-executes.** `attempt` is part of the key, so a
retry mints a new key by construction. That is intentional, but it means **crash-resume** (same
attempt → memoise) and **failure-retry** (new attempt → re-execute) are genuinely different
operations. The reducer must distinguish them, and every effect adapter must be _told which one it
is in_, because "re-run this" and "check whether this already ran" call for different behaviour.

**9.3 `reconcile()` can return `unknown`, and there is no correct automatic action.** Retrying might
double-apply. Skipping might drop the work. Both are wrong in some cases and neither is detectable.
**Design the human gate for this case on day one** rather than bolting it on: the run transitions to
`needs_human`, the effect row and both reconciliation hashes are surfaced in the UI, and a human
chooses "it ran" or "it didn't". If `unknown` turns out to be common in practice, the escalation is
a content-addressed overlay (run every mutating node copy-on-write, diff, apply) — large complexity,
and it still does not help with network effects, so do not pre-build it.

**9.4 Orphaned children after SIGKILL.** Agents are spawned `{ detached: true }`, so when DeFlowd
dies they are reparented to init and **keep running and keep burning tokens**. Journal
`(pid, process_start_time)` — `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart= -p <pid>` on
macOS. On restart, kill only when **both** the pid and the start time match.

> **Never kill by bare pid after a restart.** Pids are recycled. You will eventually kill the
> user's editor.

Kill the _group_, not the process: `process.kill(-child.pid, 'SIGTERM')`, a configurable grace
period (default 5 s), then `SIGKILL`. **Verified 2026-08-02** that process-group kill works this
way. Agent CLIs spawn their own subprocess trees (git, node, ripgrep) that `child.kill()` would
leave running. The full escalation ladder is in
[workspace and safety §11.1](./09-workspace-and-safety.md).

**9.5 Filesystem caveats.** `rename` is atomic only **within one filesystem**, which is why the temp
file must be a sibling of the target and never in `/tmp`. Directory `fsync` is a **no-op on
Windows**. Both guarantees break on network mounts. DeFlow targets macOS and Linux at M1 (NF5); the
Windows caveat is a known M3 gap.

**9.6 The wall clock is not monotonic.** Laptop sleep and NTP correction both move `Date.now()`
backwards. Journal timestamps for **display**; order strictly by `seq`. Any logic that compares two
timestamps to decide what happened first is a bug waiting for a daylight-saving transition.

**9.7 `synchronous = NORMAL` protects against process crash, not power loss.** **Verified
2026-08-02:** SIGKILL mid-write-loop at ~45k committed rows, then reopen — all **45,339** rows
present, `PRAGMA integrity_check` = `ok`. But `NORMAL` does not fsync the WAL on every commit, so a
kernel panic or a power cut can lose the most recent commits. The alternative is priced: `FULL`
measured **979 ev/s versus 22,982 ev/s** for one-transaction-per-event — roughly a **23×** penalty.

For a laptop daemon, `NORMAL` is the right trade and this document says so rather than pretending
WAL means invulnerable. If you want a middle ground, run `NORMAL` globally and switch to
`synchronous = FULL` **only for the transaction that records a genuinely irreversible external
effect** — a publish, a deploy, a push to a remote.

**Unverified caveat.** All benchmarks ran in a Linux container, likely over overlayfs. The absolute
fsync-sensitive numbers will differ on macOS APFS, which uses `F_FULLFSYNC` and is typically slower.
Re-run the benchmark on the target laptop before fixing the setting. The _relative_ shape (FULL is
20–25× more expensive per commit; batching gives ~7×) should hold.

---

## 10. The scheduler

A single-threaded tick loop in DeFlowd, running at roughly **1 Hz**, driving `decide(state, now)`.

### 10.1 Durable wake times, never `setTimeout`

Do not use `setTimeout` for a wait. Two independent reasons, one of them verified and genuinely
alarming:

**Verified 2026-08-02:** Node's maximum timer delay is `2^31 - 1 ms` = 24.9 days. Passing `2**31`
does not throw and does not clamp to the maximum — it fires the callback after **1 ms**, with only a
`TimeoutOverflowWarning` on stderr. A 30-day human gate implemented with `setTimeout` fires
instantly and nothing in your logs says "durability failure".

And even below that ceiling: timers do not fire during laptop sleep, and they do not survive a
restart at all.

Instead, write a row:

```sql
INSERT INTO node_wake(run_id, node_id, wake_at, reason) VALUES (?,?,?,?)
  ON CONFLICT(run_id,node_id) DO UPDATE SET wake_at=excluded.wake_at, reason=excluded.reason;
-- the ticker:
SELECT * FROM node_wake WHERE wake_at <= ?;
```

`setTimeout(min(nextWakeAt - now, 1000))` is used **only** as a sleep hint for the ticker itself,
never as the wait.

The elegance is the payoff. A suspended node costs exactly **one row and zero CPU** (F4.8), and
four problems that look unrelated collapse into one mechanism:

| Problem                             | Mechanism         |
| ----------------------------------- | ----------------- |
| A six-hour human gate (F8.1)        | a `node_wake` row |
| Laptop sleep across that gate (NF4) | a `node_wake` row |
| Crash and restart mid-wait (F4.2)   | a `node_wake` row |
| Retry backoff (F4.5)                | a `node_wake` row |

One code path, exercised constantly, instead of four rarely-exercised ones.

### 10.2 Ready set and admission

The ready set is derived purely from state — no ambient knowledge, no in-memory bookkeeping:

```ts
ready = nodes.filter(
  (n) =>
    n.state === "pending" &&
    n.deps.every((d) => state.nodes[d].state === "completed") &&
    n.attempt < n.maxAttempts &&
    (n.wakeAt ?? 0) <= now,
);

admit = min(
  globalAgentSlots - running.length,
  classSlots(n) - runningInClass(n),
);
```

**Use per-resource-class semaphores, not one global number.** A single "max concurrency: 3" is the
wrong abstraction because the constraints are not fungible:

| Class                       | Default | What actually limits it                              |
| --------------------------- | ------- | ---------------------------------------------------- |
| Global agent slots          | 3       | Laptop RAM and vendor rate limits                    |
| Per-repository write lock   | 1       | Git index contention; F5.2's serialise-writes policy |
| Per-worktree exclusive lock | 1       | One agent per worktree, always                       |

**The repo write lock is enforced in the ledger** (`node.lock.acquired` / `node.lock.released`
events), not in a JavaScript `Map`. An in-memory lock evaporates on restart, and the first thing
that happens after a crash is that you resume several nodes at once — precisely when you need the
lock most.

### 10.3 Retry, backoff, and error classification

Full jitter:

```ts
delay = Math.random() * Math.min(cap, base * 2 ** (attempt - 1)); // base 2_000ms, cap 300_000ms
```

Full jitter rather than equal jitter or none, because the common failure here is _correlated_:
several nodes hit the same vendor rate limit at the same moment, and you do not want them retrying
in lockstep and re-tripping it.

**Persist the computed `wake_at` into `node_wake` in the SAME transaction as the `node.failed`
event.** Split them and a restart inside the backoff window either loses the delay (immediate
retry storm) or double-counts the attempt.

Classify the error before deciding what the failure even means:

| Class       | Examples                                                           | Action                                                        |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `transient` | Rate limit, `ETIMEDOUT`, known-flaky exit code                     | Retry with backoff (F4.5), optionally on a different provider |
| `permanent` | Plan references a nonexistent file, auth failure, schema violation | Fail the node; propagate to dependents                        |
| `gate`      | `reconcile()` returned `unknown`; the agent asked a question       | Suspend, notify a human (F8.1, F8.3)                          |

Hitting a budget ceiling (F4.6) is deliberately a `gate`, not a `permanent` failure: the run
**pauses for a human decision** rather than dying with hours of work half-done.

### 10.4 Pause, resume and cancel are events

Never in-memory flags (F4.4). `run.pause.requested` is an event; `decide()` reads reduced state and
stops admitting new nodes. In-flight nodes run to completion by default, or are suspended in
aggressive mode. `run.cancel.requested` is cooperative first, then forceful.

Because they are events, pause survives a restart, appears in the timeline, and is auditable — a
flag on an object satisfies none of those. The three-stage cancel path (protocol-level
`session/cancel`, then `SIGTERM` to the process group, then `SIGKILL` after grace) is the kill
switch of F5.7 and is specified in [workspace and safety](./09-workspace-and-safety.md).

---

## 11. No-progress detection (F4.7)

[PRD §7.4](./prd.md#74-durable-execution) calls this "the single most expensive failure mode in
autonomous loops", and it is right. Two detectors, both cheap, plus hard caps as a backstop.

### 11.1 The progress watermark

Maintain a `progress_watermark`: the `seq` of the last event that **actually changed reduced
state**.

Here is the elegant part, and it falls out of the schema for free. Agent stdout lives in `io_chunk`
and **never touches the reducer**. So an agent that is producing megabytes of output while
accomplishing nothing does not advance the watermark, and an agent thinking silently for eight
minutes before a real state transition does not falsely trip it either. The metric is meaningful
without a single line of code written specifically to make it meaningful — the control-plane /
data-plane split of §5 already did the work.

### 11.2 The stall detector

```
now - watermarkTs > stallThreshold   (default 10 min)   while ≥1 node is `running`
  → emit run.stalled
```

Surface it in the UI, optionally notify (F8.4). **Do not auto-kill.** A legitimately long build, a
large test suite and a wedged agent look identical from here, and killing a 40-minute integration
run because it was quiet for 10 minutes is a worse failure than the one being prevented.

### 11.3 The churn circuit-breaker

Keep a sliding window of the last **M = 20** completed node attempts. Trip when either:

- the same `(node_id, request_hash)` appears more than **N = 5** times — the same work being redone
  with the same inputs, which is the literal definition of a livelock; or
- the count of `completed` nodes has **not increased across 3 consecutive planner replans** — the
  planner is rearranging deck chairs.

On trip, transition the run to `needs_human`. **Never silently continue.** This mirrors what the
agent-runtime ecosystem converged on during 2026: sliding-window tool-call dedup with small
consecutive-no-progress thresholds, so a livelock breaks fast rather than expensively.

### 11.4 Hard caps as a backstop

`maxAttemptsPerNode` (default 3, matching the surgical repair loop's cap in F7.5),
`maxRunWallClock`, `maxTotalNodeExecutions`. These exist to bound the blast radius of a detector
bug, not as the primary mechanism.

---

## 12. Fencing: flock plus daemon epoch

"It's a single-user local daemon, so locking is unnecessary" is wrong, and the failure is common
rather than exotic: **a user runs `npx DeFlow up` in two terminals.** It happens the first week.

SQLite protects the _database_ — verified, a second connection's `BEGIN IMMEDIATE` returns
`SQLITE_BUSY` — but it does absolutely nothing to stop two schedulers from interleaving _effect
execution_. Both daemons reduce the same ledger, both derive the same ready set, both spawn the
same agent, both burn tokens, and both commit to the same branch.

Two mechanisms, together:

1. **`flock` on `<dataDir>/DeFlow.lock`**, taken at boot. Second instance fails fast with a clear
   message naming the pid holding the lock — not a stack trace.
2. **`daemon_epoch`**, a counter bumped on every DeFlowd start and stamped on every write. Writes
   carrying a stale epoch are **rejected**. This is the belt to `flock`'s braces, and it is what
   covers the cases `flock` does not: a stale lock file on a network mount, a debugger-suspended
   process, a container restart that inherited the file.

`flock` prevents the second daemon from starting; the epoch guarantees that if one somehow does, it
cannot corrupt anything.

---

## 13. What not to do

A concentrated list of the verified footguns in this area.

- **Never use a plain `INTEGER PRIMARY KEY` for `seq`.** Rowid reuse (§6) corrupts every persisted
  cursor the moment pruning ships.
- **Never hold a read transaction or a lazy `iterate()` cursor open across an SSE stream.**
  **Verified 2026-08-02:** holding one open cursor while writing 20k rows produced an **82.6 MB**
  `-wal` file that no checkpoint could truncate — `wal_checkpoint(TRUNCATE)` returned
  `{busy:0, log:0, checkpointed:0}` and space was only reclaimed after the cursor closed. Drain with
  bounded `LIMIT` queries and close.
  **Re-measured 2026-08-05 (KAR-03.4)** on darwin/arm64 with the shipped pragmas, 20,000 4 KiB rows:
  the `-wal` file reached **96 MB** against the bounded drain's **5.8 MB**, and the blocked
  `wal_checkpoint(TRUNCATE)` returned **`{busy:1, log:23318, checkpointed:248}`** — 248 frames of
  23,318, with nothing returned to the filesystem. `{busy:0, log:0, checkpointed:0}` is what it
  returns *after* the cursor closes. The magnitude and the conclusion stand; the exact row does not.
  Both halves are asserted in `packages/ledger/test/integration/wal-held-cursor.test.ts`.
- **Never run an unbounded scan on the write connection.** `better-sqlite3` is fully synchronous and
  blocks the event loop; a large unindexed query stalls every in-flight SSE stream and HTTP request.
  Headroom is large (0.2 ms per tail query) but it is not infinite.
- **Never build a write pool.** One writer. Readers as separate read-only connections, all with
  `busy_timeout` set.
- **Never use `setTimeout` for a wait longer than a tick.** `2**31` ms fires after 1 ms.
- **Never kill by bare pid after a restart.** Match pid _and_ process start time. And when verifying
  a group kill worked, exclude `Z`-state processes — a successfully killed subtree shows up as
  zombies awaiting reaping, which reads as a false negative.
- **Never put the atomic-write temp file in `/tmp`.** Cross-filesystem rename is not atomic.
- **Never auto-retry a `mutating` shell command whose `reconcile()` returned `unknown`.**
- **Never let the reducer read `io_chunk`.** It is the one rule that keeps replay fast, keeps the
  progress watermark meaningful, and keeps snapshotting unnecessary.
- **Never let the reducer throw on an unknown event kind.** Ignore it.
- **Do not adopt `drizzle-orm` for the ledger during its 1.0 transition window.**
- **Do not treat `synchronous = NORMAL` as "durable".** It is durable against process crash. Say so.

---

## 14. How all of this is tested

Full detail lives in [testing strategy](./14-testing-strategy.md); the durability-specific shape is:

Because `reduce` and `decide` are pure, the scheduler is exercised entirely without I/O, and the
harness is a first-class API rather than a test helper:

```ts
const h = new Harness({
  db: ":memory:",
  clock: new FakeClock(),
  effects: new FakeEffectRunner(),
});
h.clock.advance(hours(6)); // exercise a 6-hour human gate in microseconds
h.crashAndRestart(); // reopen the DB, rebuild state, assert invariants
```

The load-bearing test is **crash-fuzz in CI**: spawn DeFlowd as a child process, `kill -9` at a
random point in a scripted run, restart, and assert three invariants —

1. no effect executed twice without its ikey being reused,
2. reduced state matches the pre-crash projection,
3. `PRAGMA integrity_check` returns `ok`.

That exact shape was run against SQLite during the research pass and passed (45,339 rows recovered
after SIGKILL, integrity ok), so the harness is cheap to build and known to be worth building.

One hard rule for tests that touch this layer: **never use `vi.useFakeTimers()` while a child
process is alive.** The process's real I/O never arrives and the test deadlocks. Advance the
injected `Clock` instead — which is precisely why `Clock` is a port.

---

**Related:** [Architecture overview](./01-architecture-overview.md) ·
[Domain model](./04-domain-model.md) · [Planning and replanning](./06-planning-and-replanning.md) ·
[API and realtime](./11-api-and-realtime.md) · [Testing strategy](./14-testing-strategy.md) ·
[Workspace and safety](./09-workspace-and-safety.md)

[← Back to index](./README.md)
