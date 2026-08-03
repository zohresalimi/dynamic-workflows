# EPIC-03: Event ledger and durable state

> Part of the [Karvan delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-03-event-ledger-flows.md)

| | |
|---|---|
| **Epic ID** | EPIC-03 |
| **Status** | Not started |
| **Priority** | P0 |
| **Milestone** | M1 |
| **Workstream** | W1 (see [roadmap §2.2](../../17-roadmap.md)) |
| **Size** | ~16 days across 9 stories |
| **Depends on** | EPIC-02, EPIC-00 (spike S5) |
| **Blocks** | EPIC-05, EPIC-06, EPIC-07, EPIC-09, EPIC-11, EPIC-13, EPIC-14, EPIC-15, EPIC-18 |
| **PRD requirements** | F4.1, F4.2, F4.4, NF4, NF6, NF8, NF9, NF10 |
| **Architecture** | [05-durable-execution.md](../../05-durable-execution.md) |

## Goal

At the end of this epic `karvand` has a durable, append-only ledger it can be killed with `SIGKILL`
in the middle of and reopen without losing a committed event or reusing a sequence number. Six
`STRICT` SQLite tables exist behind a ~60-line `Db` port; the control plane (`event`) and the data
plane (`io_chunk`) are physically separate tables so replay stays in milliseconds while agent
transcripts grow to hundreds of megabytes; a pure `reduce()` folds the log into `RunState` and
ignores what it does not understand; a version-guarded checkpoint makes startup fast without ever
being able to make it wrong; and `flock` plus a `daemon_epoch` mean a user who runs `npx karvan up`
in two terminals gets a clear error rather than two schedulers spawning the same agent.

## Why this matters

This is the epic PRD §2.1's second broken thing — "the run doesn't survive" — is answered by, and
everything downstream is a projection of what is built here. If the ledger is wrong, the plan graph
is wrong, the blackboard is wrong, the SSE stream is wrong and the UI is wrong, all in ways that
look like unrelated bugs. Two failures are specifically being designed out and both are measured
rather than assumed. A plain `INTEGER PRIMARY KEY` **reuses sequence numbers after a delete**
(**Verified 2026-08-02**: 1, 2, 3 → delete 3 → insert → 3, versus 1, 2, 4 with `AUTOINCREMENT`), and
`seq` is the identity of an event *outside* the database — the SSE frame id a browser tab persisted,
the `last_seq` in a checkpoint, the cursor a frontend store holds across a reconnect. The moment run
pruning ships, every persisted cursor silently points at a different event, with no error anywhere.
And two `karvand` processes reducing the same ledger both derive the same ready set, both spawn the
same agent, both burn tokens and both commit to the same branch — SQLite protects the *database*,
not the *scheduler*.

## Scope

**In scope:**

- The `Db` port, the `better-sqlite3@13.0.2` adapter, PRAGMA setup in the specified order, and the
  one-writer / N-readers connection model.
- Migrations on `PRAGMA user_version` with a `VACUUM INTO` backup before each, append-only and with
  no `down` path.
- All six tables: `event`, `io_chunk`, `effect`, `plan`, `run`, `node_wake` — created here as
  migration 0001, even though the semantics of `effect` and `node_wake` are exercised in EPIC-06.
- Append with `RETURNING seq`, per-run tail queries, and the bounded-drain rule for streaming reads.
- `reduce(state, event): RunState` — pure, total, ignores unknown kinds, applies upcasters at read
  time.
- The checkpoint cache in `run.state_json` / `run.last_seq` guarded by `checkpoint_version`.
- `flock` on `<dataDir>/karvan.lock` and the `daemon_epoch` counter stamped on every write.
- Replay on daemon start, and the crash-fuzz harness that proves it.
- The content-addressed blob store for payloads over ~256 KiB.

**Out of scope:**

- `decide()`, the scheduler tick loop, the effect journal *protocol* (`durable()`, `reconcile()`),
  and the `node_wake` ticker — [EPIC-06](./EPIC-06-orchestrator.md). This epic ships the tables and
  the fold; EPIC-06 ships the policy that reads them.
- The SSE endpoint, `Last-Event-ID` and `?since=<seq>` handling — [EPIC-15](./EPIC-15-daemon-api.md).
  This epic ships the tail query and its performance guarantee, not the HTTP surface.
- FTS5 retrieval over run artifacts — [EPIC-09](./EPIC-09-context-memory.md), KAR-09.10. The
  tokenizer must be set at table creation and is unchangeable later, so that migration lands there,
  not here.
- Run pruning and retention. Not in M1 — but `AUTOINCREMENT` exists precisely so pruning is safe
  when it arrives, and KAR-03.3's regression test proves it.
- Orphaned-child reaping on boot — [EPIC-05](./EPIC-05-provider-adapters.md), KAR-05.9. This epic
  makes the `(pid, process_start_time)` journal *storable*; the reaper is elsewhere.

## Definition of Ready (epic level)

- [ ] EPIC-02 Done: the `Event` union, envelope, upcaster registry and `NodeFailure` exist in
      `@karvan/core`, and `pnpm schemas:check` is green.
- [ ] **M0-S5 has run on the author's actual laptop**: `better-sqlite3@13.0.2` installs with no
      compilation, `SELECT sqlite_version()` returns `3.53.4`, and the append benchmark has been
      re-run on APFS. Every fsync-sensitive number in
      [05-durable-execution.md](../../05-durable-execution.md) was measured on Linux, likely
      overlayfs (roadmap risk **A1-1**); the `synchronous=` setting is chosen from the laptop's own
      numbers, not from the doc's.
- [ ] `test/fixtures/` has the tmpdir fixture with `KARVAN_KEEP_TMP` support and the
      `pool: 'forks'` integration project configured.
- [ ] The rule "`:memory:` is for pure projection unit tests only" is agreed and written into
      `packages/ledger/README.md` before the first test is written.

## Definition of Done (epic level)

- [ ] All nine stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-03-event-ledger-flows.md) exists as an
      automated test at the level its `Automated at:` line names.
- [ ] The **crash-fuzz suite runs in CI on every push** (`pnpm vitest run --project crash-fuzz`)
      with `KARVAN_KEEP_TMP=1` and `actions/upload-artifact` on failure, on `ubuntu-26.04` and
      `macos-26`, Node 24 and Node 26. It asserts all three invariants: no effect executed twice,
      reduced state equals the pre-crash projection at the last durably-written seq, and
      `PRAGMA integrity_check` returns `ok`.
- [ ] No durability test in this epic uses `:memory:`, and a lint rule fails the build on
      `':memory:'` appearing outside `**/*.projection.test.ts`.
- [ ] The `Unverified` claims this epic touches are closed or explicitly recorded: **A1-1** and
      **A1-2** by M0-S5 on the real machine; **A1-3** (the ~2,000 control-events-per-run assumption)
      by the per-run control-event counter shipped in KAR-03.4; **A1-8** (`@types/better-sqlite3`
      lagging at 9.6.0) by a local `.d.ts` augmentation if `db.explain()` or `stmt.toString()` are
      needed.
- [ ] `packages/ledger/README.md` states plainly that `synchronous = NORMAL` protects against
      process crash and **not** against power loss, and names the one case that switches to `FULL`.

## User stories

### KAR-03.1 — The `Db` port and driver adapter

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | — |
| **PRD** | NF6, NF9 |
| **Verified by** | EPIC-03-S1, EPIC-03-S2, EPIC-03-S3, EPIC-03-S4, EPIC-03-S25 |

**As** the engine author, **I want** SQLite behind a thin port with its PRAGMAs applied in a fixed
order on every open, **so that** the durability settings cannot drift between connections and
swapping the driver is a one-file change.

Implements [05-durable-execution §7.1](../../05-durable-execution.md#71-pragmas-in-this-order-on-every-open)
and decision D6. The `Db` interface lives in `@karvan/core` (which cannot perform I/O); the
`better-sqlite3@13.0.2` implementation lives in `@karvan/ledger`; the fake lives in
`@karvan/testkit`. The port is deliberately tiny — `prepare`, `exec`, `transaction`, `close`,
`pragma` — around 60 lines, because its purpose is substitutability, not abstraction. The connection
model is **one write connection and N read-only connections**, with `busy_timeout` set on every one
of them including the readers: **Verified 2026-08-02** that SQLite permits exactly one writer and a
second connection's `BEGIN IMMEDIATE` fails with `SQLITE_BUSY`. Do not build a write pool.

**Acceptance criteria**

1. Every open applies, in this order: `journal_mode = WAL`, `synchronous = NORMAL`,
   `busy_timeout = 5000`, `foreign_keys = ON`, `wal_autocheckpoint = 1000`,
   `journal_size_limit = 67108864`, `cache_size = -32000`. Order is asserted, not just the end
   state — `journal_mode` is persistent, the rest are per-connection.
2. Reopening the same file reports `journal_mode = wal` without it being set again.
3. `openWrite()` called twice on the same path throws a typed `LedgerAlreadyOpen` error; the write
   connection is a singleton per process.
4. `openRead()` returns a connection that can query while a write transaction is open, and whose
   `busy_timeout` is 5000.
5. A second process's `BEGIN IMMEDIATE` against the same file fails with `SQLITE_BUSY` after the
   timeout rather than hanging indefinitely.
6. All tables are created `STRICT`; inserting a text value into an `INTEGER` column fails with
   `cannot store TEXT value in INTEGER column` (**Verified 2026-08-02**) rather than coercing.
7. `INSERT … RETURNING seq` returns the assigned sequence number without a second query.
8. The `synchronous` setting is a single named constant with a comment naming the measured cost —
   979 ev/s at `FULL` versus 22,982 ev/s at `NORMAL`, roughly 23× — and an exported
   `withFullSync(fn)` escape hatch for the transaction recording a genuinely irreversible external
   effect.

**Test plan (TDD)** — write these tests first, in this order, and watch each fail before writing
the implementation.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Open a file-backed db in a tmpdir; assert the pragma read-back table | PRAGMAs are set in the wrong order or omitted |
| 2 | integration | Close, reopen, assert `journal_mode` is still `wal` with no set call | WAL is treated as per-connection |
| 3 | integration | `openWrite()` twice throws `LedgerAlreadyOpen` | A pool was built |
| 4 | integration | Spawn a second node process holding `BEGIN IMMEDIATE`; assert `SQLITE_BUSY` on the first | Writer exclusivity is assumed rather than tested |
| 5 | integration | `INSERT INTO event(ts) VALUES ('not a number')` rejected with the exact message | Tables are not `STRICT` |
| 6 | integration | `RETURNING seq` on an append returns a positive integer equal to a follow-up `SELECT max(seq)` | The adapter does a second round trip |
| 7 | unit | The fake `Db` in testkit satisfies the same contract test suite as the real one | The port leaked driver types |

**Notes / risks** — Roadmap **A1-8**: `@types/better-sqlite3@9.6.0` lags the package at 13.0.2 and
coverage of `db.explain()` / `stmt.toString()` is unconfirmed. Worst case is a small local `.d.ts`
augmentation in `packages/ledger/src/types/`; do not let it become a reason to reach for an ORM.

---

### KAR-03.2 — Schema migrations on `PRAGMA user_version` with pre-migration backup

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | KAR-03.1 |
| **PRD** | NF6, NF8 |
| **Verified by** | EPIC-03-S1, EPIC-03-S5, EPIC-03-S6, EPIC-03-S7 |

**As** a solo maintainer, **I want** ~40 lines of migration runner over `PRAGMA user_version` that
takes a compacted backup before it touches anything, **so that** a bad migration is recoverable
without a `down` path that exists only to be wrong.

Implements [05-durable-execution §7.2](../../05-durable-execution.md#72-migrations-40-lines-on-pragma-user_version).
Migration 0001 creates all six tables from §5 with their indexes. Migrations are numbered `.ts`
files under `packages/ledger/src/migrations/NNNN-name.ts`, **append-only and never edited once
shipped**, each exporting `up(db)`. There are **no `down` migrations**: for a local single-user
daemon you roll forward or restore a backup. The backup is
`VACUUM INTO '<dbdir>/pre-migrate-<user_version>.db'` — **measured 2026-08-02 at 1007 ms for a
193 MB database**, versus 1633 ms for `db.backup()`, so `VACUUM INTO` is both faster and produces a
compacted copy. It has a second use: a one-command "attach my ledger to this bug report".

**Acceptance criteria**

1. Opening a fresh file at `user_version = 0` runs every migration in ascending id order and leaves
   `user_version` at the highest id.
2. Opening an already-current file runs nothing and takes no backup.
3. A `pre-migrate-<n>.db` file appears in the data directory before the first `up()` runs, and it
   opens and passes `PRAGMA integrity_check`.
4. A migration that throws leaves `user_version` at its prior value, leaves the schema unchanged
   (SQLite DDL is transactional), and raises
   `migration <id> (<name>) failed` with the original error as `cause`.
5. `PRAGMA foreign_keys` is `OFF` for the duration of the migration run and `ON` after it, including
   after a failure.
6. A ledger whose `user_version` is **higher** than the binary's highest migration id causes the
   daemon to refuse to open it, exiting with a typed error naming both versions and pointing at the
   `pre-migrate-*.db` files — it does not partially migrate and does not run backwards, because
   there is no `down`.
7. A test asserts that no already-shipped migration file's content hash has changed.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Fresh tmpdir → migrate → assert `user_version` and the six table names | Migration 0001 is incomplete |
| 2 | integration | Migrate twice; assert the second run performs no writes and creates no backup | Idempotence is by luck |
| 3 | integration | Insert 50k rows, migrate, assert the backup exists and passes `integrity_check` | Backup is taken after, or not at all |
| 4 | integration | A deliberately failing migration 0002; assert `user_version` unchanged and the table absent | The runner commits partially |
| 5 | integration | Assert `foreign_keys` is `ON` after a *failed* run | The restore is in the happy path only |
| 6 | integration | Set `user_version = 9999` by hand; assert `openLedger` throws `LedgerTooNew` | The daemon silently treats it as current |
| 7 | unit | Content-hash table over `src/migrations/*.ts` | A shipped migration was edited |

**Notes / risks** — `PRAGMA user_version = ${m.id}` cannot be parameterised, so the id must be a
number from the migration object and never anything derived from input. Keep the interpolation on
one line with a comment saying why.

---

### KAR-03.3 — Append-only event table with monotonic sequence

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-03.2 |
| **PRD** | F4.1, NF10 |
| **Verified by** | EPIC-03-S1, EPIC-03-S8, EPIC-03-S9, EPIC-03-S10 |

**As** every consumer of run state, **I want** one globally monotonic `seq` that is never reused,
**so that** an SSE frame id, a checkpoint offset and a frontend cursor all mean the same thing
forever.

Implements [05-durable-execution §3 primitive 1 and §6](../../05-durable-execution.md#6-autoincrement-is-mandatory).
Ships `append(events): EventSeq[]` over the `event` table — `seq INTEGER PRIMARY KEY AUTOINCREMENT`,
`run_id`, `ts`, `kind`, `v`, `node_id`, `attempt`, `ikey`, `payload` (JSON text) — plus
`readRange(runId, afterSeq, limit)` and the `event_run_seq` index. The ledger is a **single global
database** keyed by `run_id` throughout, not one file per run
([16-repo-layout §7.2](../../16-repo-layout.md)). The API is append-only: there is no `update` and
no `delete` on `event` exposed anywhere.

**Acceptance criteria**

1. `AUTOINCREMENT` is present on `event.seq` and on `io_chunk.seq`, and a regression test proves the
   difference: against a table declared with a bare `INTEGER PRIMARY KEY`, inserting 1/2/3, deleting
   3, and inserting again yields **3**; against the real schema it yields **4**.
2. Appending a batch of N events in one transaction returns N sequence numbers, strictly increasing,
   and `sqlite_sequence` reflects the high-water mark.
3. A transaction that is rolled back **burns** its sequence values, and the next successful append
   returns a number greater than the burned ones. Consumers are documented as "resume from strictly
   greater than my cursor" and never "expect `cursor + 1`".
4. `readRange(runId, afterSeq, limit)` returns only that run's events, ordered by `seq`, strictly
   greater than `afterSeq`, at most `limit` rows, and reports whether more remain.
5. Two runs appending concurrently interleave in the one `event` table without either run's
   `readRange` observing the other's rows.
6. Every appended row carries a non-null `epoch` (see KAR-03.7) and a `v`; the append API rejects an
   event whose envelope fails `EventEnvelopeSchema`.
7. There is no exported function that updates or deletes a row in `event`. A grep test enforces it.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | The rowid-reuse comparison against a scratch table without `AUTOINCREMENT` | `AUTOINCREMENT` was "optimised away" |
| 2 | integration | Batch append of 100 events returns 100 strictly-increasing seqs | The batch does one insert per statement outside a transaction |
| 3 | integration | Begin, append, rollback, append; assert a gap | Gaps are treated as impossible |
| 4 | integration | `readRange` with `afterSeq` equal to the last returned seq returns [] | The comparison is `>=` |
| 5 | integration | Two runs' appends interleaved; per-run reads isolated | The index is on `seq` alone |
| 6 | unit | `append` rejects an envelope missing `epoch` | Validation happens at read time only |
| 7 | unit | Grep for `UPDATE event` / `DELETE FROM event` outside migrations | An "amend" helper appeared |

**Notes / risks** — Test 1 is the most valuable single test in this epic and it costs ten lines.
`AUTOINCREMENT` looks like ceremony (one extra `sqlite_sequence` row update per insert) and will be
questioned by a future reader — including the author. The test is what answers them.

---

### KAR-03.4 — Control-plane / data-plane split and the `io_chunk` stream

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-03.3 |
| **PRD** | F4.1, F4.7, F10.6, NF3 |
| **Verified by** | EPIC-03-S11, EPIC-03-S12, EPIC-03-S13, EPIC-03-S14, EPIC-03-S30 |

**As** the daemon, **I want** agent stdout in a physically separate table the reducer never reads,
**so that** replay stays in milliseconds, the progress watermark is meaningful for free, and
snapshotting never becomes necessary.

Implements [05-durable-execution §5.1](../../05-durable-execution.md#51-why-the-control-plane--data-plane-split-removes-snapshotting).
Ships `appendIoChunk({runId, nodeId, attempt, stream, data})` over the `io_chunk` table
(`stream` is `stdout` | `stderr` | `agent_json`, `data` is a `BLOB`) and
`readIoChunks(runId, nodeId, attempt, afterSeq, limit)`. The measured case for the split:
500,000 events in one combined table is **193 MB**; a full scan is **416 ms**; the control-plane
subset of 10,000 rows reduces to state in **29 ms**; and 1,000 SSE tail queries
(`WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500`) take **196 ms total, ~0.2 ms each**, served by
`SEARCH event USING COVERING INDEX event_run_seq`. A 40-node multi-hour run produces on the order of
**2,000** control-plane events, so reducing it is single-digit milliseconds — which is why
snapshotting is not built. This story also ships the per-run control-event counter that turns that
assumption into a measurement.

**Acceptance criteria**

1. Agent stdout, stderr and raw ACP frames land in `io_chunk` and never in `event`. A node's
   `node.progress` event may carry an `ioChunkSeq` pointer but not the bytes.
2. `reduce()` has no read path to `io_chunk`: the reducer's input type is `Event`, the `Db` handle
   is not in scope inside `@karvan/core`, and an architecture test asserts `packages/core` does not
   import `@karvan/ledger`.
3. With 500,000 `io_chunk` rows and 10,000 `event` rows for the same run, folding the control plane
   to state completes in under 100 ms on CI hardware (budget set at ~3× the measured 29 ms).
4. `EXPLAIN QUERY PLAN` for the SSE tail query reports `SEARCH event USING COVERING INDEX
   event_run_seq`; a test asserts the plan string, so an index change that silently degrades it
   fails CI.
5. Streaming reads drain with bounded `LIMIT` queries and close the statement. A regression test
   proves why: holding one lazy `iterate()` cursor open while writing 20,000 rows produces an
   **82.6 MB** `-wal` file that no checkpoint can truncate — `wal_checkpoint(TRUNCATE)` returns
   `{busy:0, log:0, checkpointed:0}` and space is reclaimed only after the cursor closes
   (**Verified 2026-08-02**).
6. A per-run counter of control-plane events is exposed (`SELECT count(*) FROM event WHERE run_id=?`
   surfaced on the run record) so the "~2,000 per run" assumption is measured from M1 rather than
   assumed.
7. A payload over ~256 KiB never reaches `event.payload` — it spills (KAR-03.9).

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Write 1 MB of agent output; assert `event` row count unchanged and `io_chunk` grew | stdout is journalled as events |
| 2 | unit | Architecture test: `packages/core/package.json` dependencies contain no `@karvan/ledger` | The reducer gained a db handle |
| 3 | integration | Seed 500k `io_chunk` + 10k `event`; time the fold; assert < 100 ms | The reducer scans both tables |
| 4 | integration | Assert the `EXPLAIN QUERY PLAN` string for the tail query | An index was dropped or reordered |
| 5 | integration | The 20k-row write with an open `iterate()` cursor; assert `-wal` size and then assert the bounded-drain path stays under 8 MB | Someone "simplified" the drain to a lazy iterator |
| 6 | integration | Run a scripted 40-node fixture; assert the control-event counter is recorded | The counter is a TODO |

**Notes / risks** — Roadmap **A1-3**: the "no snapshotting needed" conclusion assumes ~2,000
control-plane events per 40-node run, and per-tool-call events could be 10–100× that. Criterion 6 is
how that gets found by measurement instead of by pain. Revisit real snapshots only past ~100k
control events in a single run; if file size becomes the concern first, the cheaper move is putting
`io_chunk` in a second SQLite file via `ATTACH`.

---

### KAR-03.5 — The pure reducer and state projection

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-02.7, KAR-03.3 |
| **PRD** | F4.1, NF9, NF10 |
| **Verified by** | EPIC-03-S7, EPIC-03-S11, EPIC-03-S15, EPIC-03-S16, EPIC-03-S17 |

**As** every view, gate and scheduler decision, **I want** one pure total function folding events
into `RunState`, **so that** state is never ambiguous, is testable with zero setup, and a version
downgrade degrades the projection instead of corrupting it.

Implements [05-durable-execution §3 primitive 2 and §4](../../05-durable-execution.md#4-the-functional-core).
Ships `RunState` and `reduce(state: RunState, event: Event): RunState` in `@karvan/core`: no I/O, no
clock, no randomness, a value returned for every input. `RunState` covers run status, per-node state
and attempt counts, the active `planHash`, held locks, the progress watermark, budget totals, and
the id registry. The rule that matters most is negative: **the reducer must ignore unknown `kind`
values.** Not throw, not `assertNever`, not log-and-throw — `return state` unchanged. Upcasting
happens on the way in, so `reduce` only ever sees current-version payloads.

**Acceptance criteria**

1. `reduce(state, e)` where `e.kind` is unrecognised returns the **identical** state object
   (reference equality is acceptable and preferred) and does not throw.
2. `reduce` is deterministic: folding the same event array twice from the same initial state
   produces deeply-equal results, and folding a 2,000-event fixture produces a stable file snapshot
   under the normalising serialiser.
3. `reduce` performs no I/O and reads no clock: an architecture test asserts `@karvan/core` has no
   dependency capable of I/O, and a runtime test stubs `Date.now` to throw for the duration of a
   fold.
4. Upcasters are applied before `reduce` sees a payload; a fixture ledger containing v1, v2 and v3
   `node.completed` payloads reduces to the same state as one containing only v3 equivalents.
5. `run.paused` / `run.resumed` change reduced state — pause is an event, never an in-memory flag —
   and survive a fold-from-scratch.
6. `node.progress` does **not** advance the progress watermark; `node.completed` does. The watermark
   is the `seq` of the last event that actually changed reduced state.
7. `node.lock.acquired` / `node.lock.released` are reflected in `state.locks`, so the repo write
   lock lives in the ledger and survives a restart rather than evaporating with a JavaScript `Map`.
8. Reducing an event whose `epoch` is older than the run's current epoch is a no-op with a counter
   incremented (see KAR-03.7).

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `reduce(s, {kind:'future.thing'}) === s` | The switch has an `assertNever` default |
| 2 | unit | Fold `test/fixtures/runs/happy-path.events.json` twice; deep-equal; `toMatchFileSnapshot` | The reducer mutates its input state |
| 3 | unit | `vi.spyOn(Date, 'now').mockImplementation(() => { throw … })` around a full fold | A timestamp leaked into the fold |
| 4 | unit | Fold a mixed-version fixture; compare to the all-v3 fixture's state | Upcasting happens inside `reduce` per kind |
| 5 | unit | Watermark after 50 `node.progress` events is unchanged; after one `node.completed` it advances | Progress events advance it, breaking stall detection |
| 6 | unit | Locks fixture: acquire, crash-fold-from-zero, assert the lock is still held | Locks are held in memory |
| 7 | unit | Fold with a stale-epoch event; assert no state change and the counter incremented | Epoch is checked only at write time |

**Notes / risks** — Criterion 6 is what makes F4.7's stall detector meaningful for free: because
agent stdout lives in `io_chunk` and never touches the reducer, an agent producing megabytes while
accomplishing nothing does not advance the watermark, and an agent thinking silently for eight
minutes before a real transition does not falsely trip it. That property is a consequence of
KAR-03.4's split; this story just has to not break it.

---

### KAR-03.6 — Checkpoint cache with version-guarded invalidation

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | KAR-03.5 |
| **PRD** | F4.2, NF3 |
| **Verified by** | EPIC-03-S18, EPIC-03-S19, EPIC-03-S20, EPIC-03-S27 |

**As** the daemon at startup, **I want** a checkpoint that is a pure optimisation and can never be
the cause of a correctness bug, **so that** a fast start never becomes a wrong start.

Implements [05-durable-execution §5.1](../../05-durable-execution.md#51-why-the-control-plane--data-plane-split-removes-snapshotting)'s
"ship the checkpoint hook, but keep it trivial and keep it honest". `run.state_json` +
`run.last_seq` are written opportunistically — every ~500 events or on quiesce — and **always in the
same transaction as the events they cover**. Startup is
`state = checkpointValid ? decode(run.state_json) : initial`, then `reduce()` over
`event WHERE run_id = ? AND seq > last_seq`. `checkpoint_version` is bumped whenever the reducer's
state shape changes; a mismatch means "ignore the cache, full replay". That column is the point: it
is what makes the checkpoint incapable of causing a correctness bug, "a property worth far more than
the milliseconds it saves".

**Acceptance criteria**

1. A checkpoint row is written in the same SQLite transaction as the batch of events it covers; a
   test that kills the process between the two cannot observe a checkpoint ahead of its events,
   because there is no window in which one exists without the other.
2. `run.last_seq` never exceeds the maximum `event.seq` for that run.
3. On startup with `run.checkpoint_version` equal to the binary's `CHECKPOINT_VERSION`, state is
   decoded and only events with `seq > last_seq` are folded.
4. On mismatch, the cache is ignored and a full replay runs; the resulting state is **deeply equal**
   to the state produced by the checkpointed path on the same ledger. This equality test is the
   story's core assertion.
5. A deliberately corrupted `state_json` (truncated, or valid JSON of the wrong shape) is detected,
   discarded, and replaced by a full replay — it never propagates into `RunState`.
6. Checkpointing is disable-able with an env flag (`KARVAN_NO_CHECKPOINT=1`) and the full suite
   passes with it set — proving the cache is genuinely optional.
7. `CHECKPOINT_VERSION` is a single exported constant adjacent to the `RunState` type, with a
   comment requiring a bump on any shape change.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Append 600 events; assert exactly one checkpoint row and that its `last_seq` matches a committed event | The checkpoint is written outside the transaction |
| 2 | integration | Load with a matching version; assert only the tail was folded (spy on the fold count) | The checkpoint is written but never read |
| 3 | integration | Bump `CHECKPOINT_VERSION`; reload; assert full replay and deep-equal state | The two paths diverge |
| 4 | integration | Overwrite `state_json` with `'{"garbage":`; reload; assert clean full replay | The decode throws and takes the daemon with it |
| 5 | integration | Overwrite `state_json` with a *valid* but wrong-shaped object; assert it is rejected | Only JSON parse errors are caught |
| 6 | integration | Full suite run with `KARVAN_NO_CHECKPOINT=1` | Something started depending on the cache |

**Notes / risks** — Criterion 5 is the subtle one. A truncated file throws and is easy to catch; a
structurally-valid object of an old shape decodes fine and silently produces wrong state. Validate
the decoded object against the `RunState` schema, not just `JSON.parse`.

---

### KAR-03.7 — Single-instance lease and daemon epoch fencing

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-03.3 |
| **PRD** | F4.1, NF4, NF6 |
| **Verified by** | EPIC-03-S21, EPIC-03-S22, EPIC-03-S23 |

**As** a user who runs `npx karvan up` in two terminals in their first week, **I want** the second
one to fail immediately with a clear message, **so that** two schedulers never spawn the same agent,
burn double tokens and commit to the same branch.

Implements [05-durable-execution §12](../../05-durable-execution.md#12-fencing-flock-plus-daemon-epoch).
Two mechanisms, together, because they cover different failures. **`flock` on
`<dataDir>/karvan.lock`**, taken at boot, makes the second instance fail fast with a message naming
the pid holding the lock — not a stack trace. **`daemon_epoch`**, a counter bumped on every
`karvand` start and stamped on every write, means that if a second daemon somehow does start, its
stale-epoch writes are rejected. `flock` prevents the second daemon; the epoch guarantees that if one
exists anyway — a stale lock file on a network mount, a debugger-suspended process, a container
restart that inherited the file — it cannot corrupt anything.

**Acceptance criteria**

1. The first `karvand` acquires an exclusive `flock` on `<dataDir>/karvan.lock` and holds it for its
   lifetime.
2. A second `karvand` process against the same data directory exits non-zero within 1 second with a
   message of the form `karvand is already running (pid <n>) — data dir <path>`. No stack trace, no
   `EWOULDBLOCK` leaking through.
3. The lock is released when the first process exits, including on `SIGKILL` (the kernel releases
   `flock` on fd close), and a subsequent start succeeds without manual cleanup.
4. `daemon_epoch` is read, incremented and persisted atomically at boot, and every appended `event`
   row carries the current epoch.
5. A write carrying an epoch lower than the persisted current epoch is **rejected** at the append
   boundary with a typed `StaleEpoch` error naming both epochs; the writer does not retry.
6. A test simulating the belt-and-braces case — two `Ledger` instances constructed over the same
   file with the `flock` deliberately bypassed — shows the older-epoch instance's appends all
   rejected while the newer instance's succeed, and the ledger's content is exactly the newer
   instance's writes.
7. `run.daemon_epoch` on the run projection row reflects the epoch that last advanced that run, so
   the UI can show "this run was resumed by a later daemon".

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Take the lock in-process, then `execa` a second process that tries; assert exit code and the exact message | The message is a raw errno |
| 2 | integration | `kill -9` the lock holder; assert a fresh start acquires it | The lock is a lockfile with a pid, not `flock` |
| 3 | integration | Boot twice sequentially; assert epoch 1 then 2 persisted | The epoch resets or is per-run |
| 4 | integration | Append with a hand-set stale epoch; assert `StaleEpoch` and zero rows written | Epoch is stored but never checked |
| 5 | integration | Two `Ledger` instances over one file, flock bypassed; interleave appends; assert only the newer epoch's rows exist | The epoch is advisory |
| 6 | e2e | Two real `karvand` processes on the same data dir; assert exactly one binds the port and one exits cleanly | The daemon partially initialises before locking |

**Notes / risks** — Take the `flock` **before** anything else in boot: before binding the port,
before opening the ledger for writing, before probing providers. A second daemon that spawns a
capability probe before failing has already changed the world. Note that `flock` semantics on
network mounts are unreliable, which is exactly why the epoch exists and why criterion 6 is tested
with the lock deliberately bypassed rather than assumed unreachable.

---

### KAR-03.8 — Ledger replay on daemon start

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-03.5, KAR-03.6, KAR-03.7 |
| **PRD** | F4.2, NF4, NF9 |
| **Verified by** | EPIC-03-S16, EPIC-03-S24, EPIC-03-S25, EPIC-03-S26, EPIC-03-S27 |

**As** an operator whose laptop crashed nine hours into a run, **I want** the daemon to rebuild
exact state from the ledger on start, **so that** the run continues from the last completed boundary
instead of from zero.

Implements [05-durable-execution §14](../../05-durable-execution.md#14-how-all-of-this-is-tested) and
F4.2. Ships `openAndReplay(dataDir): Map<RunId, RunState>` — migrate, validate the checkpoint,
decode or start from initial, fold the tail, and hand back state — plus the crash harness
`harness.crashAndRestart()` that reopens the database over the same file and rebuilds. **The test
mechanism is non-negotiable**: `db.close()` and a **fresh engine over the same file**, because that
is the real code path a daemon restart takes. `:memory:` cannot exercise WAL, cannot be reopened
after a simulated crash, and hides ordering bugs, so it cannot test the one property that matters
most. This story also owns the crash-fuzz suite that CI runs on every push.

**Acceptance criteria**

1. `openAndReplay` over a ledger written by a previous process reconstructs state deeply equal to
   that process's in-memory state at its last durably-written `seq`.
2. After `kill -9` mid-append, reopening finds every committed row present and
   `PRAGMA integrity_check` returns `ok`. The reference measurement is **45,339 rows recovered after
   SIGKILL, integrity ok** (**Verified 2026-08-02**).
3. Replay is tolerant of a sequence gap: a ledger whose `seq` jumps (as a real rollback or SIGKILL
   produces) replays without error and without inventing the missing rows.
4. An older binary replaying a ledger containing newer event kinds produces a **degraded but
   uncorrupted** projection: unknown kinds are skipped, known kinds still apply, and the daemon
   starts and serves.
5. The crash-fuzz suite runs N iterations of: start `karvand` with mock agents on `PATH` and a
   scripted multi-node run; sleep a seeded random interval; `kill -9` the daemon; restart over the
   same `.karvan/`; then assert (a) no effect executed twice, checked against the effect journal
   **plus the fake agents' own side-effect log** — each fake binary appends
   `{runId, nodeId, attempt, idempotencyKey}` to a file on every invocation, so "executed twice" is
   a duplicate-key check on a text file, not an inference; (b) reduced state equals the pre-crash
   projection at the last durably-written seq; (c) `PRAGMA integrity_check` is `ok`; (d) the run
   either completes or halts with a typed failure — never wedges.
6. The kill point is seeded from `$GITHUB_RUN_ID` so a CI failure is reproducible from the log, and
   the mock agents' `--seed` flag makes the pre-crash side deterministic so the only variable is
   where the knife lands.
7. `packages/ledger/README.md` states that `synchronous = NORMAL` protects against process crash and
   **not** power loss, and names the `withFullSync` case.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Write 5k events, snapshot state, `close()`, `openAndReplay`, deep-equal | Replay reads the checkpoint only |
| 2 | integration | `execa` a child that appends in a loop; `kill -9`; reopen; count rows; `integrity_check` | `synchronous` was set to `OFF` |
| 3 | integration | Hand-craft a ledger with a gap at seq 412; replay; assert no error and correct state | Replay asserts contiguity |
| 4 | integration | Ledger containing `future.thing` events; replay with the current binary; assert the run is served | The reducer's unknown-kind path is not reached from replay |
| 5 | crash-fuzz | The full N-iteration loop with all four assertions | Any of the four fails — this is the test that proves the thesis |
| 6 | integration | Assert the fake agents' side-effect log has no duplicate `idempotencyKey` after a crash-restart | Idempotency is inferred rather than observed |

**Notes / risks** — This is the load-bearing test of the entire project: "everything else in the
durability design is theory until this test is green." Assertion (b) requires the pre-crash
projection, so the harness must snapshot the projected state on **every** event before the kill —
build that into the harness from the first iteration rather than retrofitting it. Note also
[testing strategy §8](../../14-testing-strategy.md)'s hard rule: never use `vi.useFakeTimers()` while
a child process is alive. Advance the injected `Clock` instead.

---

### KAR-03.9 — Content-addressed blob spill for oversized payloads *(added)*

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | KAR-03.3 |
| **PRD** | F6.5, NF8, F4.1 |
| **Verified by** | EPIC-03-S28, EPIC-03-S29 |

**As** the ledger, **I want** anything over ~256 KiB written to a content-addressed blob store with
only a descriptor left in the event, **so that** replay time stays a function of control-plane size
rather than of how chatty a tool was.

Added because [04-domain-model §10](../../04-domain-model.md#10-pitfalls) mandates the spill —
"anything over ~256 KiB spills to the content-addressed blob store and the event keeps
`{ sha256, bytes, mime, head, tail }`. Replay time is a function of ledger size, and un-spilled tool
output is what makes it explode" — and [16-repo-layout §7.2](../../16-repo-layout.md) assigns the
blob store to `@karvan/ledger` at `$XDG_DATA_HOME/karvan/blobs/<ab>/<sha256>`. No skeleton story
owns it, and KAR-03.4's replay budget depends on it. Ships `putBlob(bytes, mime): Handle`,
`getBlob(handle)`, `spillIfLarge(payload)` and the two-character shard directory layout.

**Acceptance criteria**

1. A payload under the threshold is stored inline unchanged.
2. A payload over ~256 KiB is written to `blobs/<first two hex of sha256>/<sha256>` and the event's
   payload field is replaced by `{ sha256, bytes, mime, head, tail }` where `head` and `tail` are
   bounded excerpts sufficient for the inspector to render something without a fetch.
3. The `Handle` returned is `artifact://<64 hex sha256>` and resolves through `getBlob` to bytes
   whose sha256 matches.
4. Writing the identical bytes three times — the same failing test log across three retry attempts —
   produces **one** file on disk and three identical handles.
5. Blob writes are atomic: written to a sibling temp file carrying the ikey and `rename`d into
   place, never written into `/tmp`, because cross-filesystem rename is not atomic.
6. A blob whose content hash does not match its path is detected on read and raises
   `BlobCorrupt` naming the handle, rather than returning wrong bytes.
7. `getBlob` on a missing handle returns a typed `BlobMissing`, and the node inspector renders the
   `head`/`tail` excerpt with an explicit "full artifact unavailable" state rather than an empty box.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | 255 KiB payload inline; 257 KiB payload spilled; assert both event rows' shapes | The threshold is applied to the serialised row, not the payload |
| 2 | integration | Write the same 1 MB buffer 3×; assert one file and `du` unchanged after the 2nd and 3rd | Content addressing is by handle, not by content |
| 3 | integration | Assert the temp file is a sibling of the target and is gone after the write | The temp file is in `os.tmpdir()` |
| 4 | integration | Corrupt a blob file in place; assert `BlobCorrupt` on read | The hash is trusted, never verified |
| 5 | integration | Delete a blob file; assert `BlobMissing` and that the event still renders from `head`/`tail` | A missing blob throws through the projection |

**Notes / risks** — The spill threshold should be one exported constant, and the `head`/`tail`
excerpt sizes should be chosen so a spilled payload's descriptor stays comfortably under the
threshold itself. Blobs are global (not per-run) for the same reason content addressing exists: the
identical failing test log across three attempts or two runs deduplicates to one object.

---

## Sequencing

KAR-03.1 → KAR-03.2 → KAR-03.3 is a hard chain; nothing else can start until events can be appended.
KAR-03.4 and KAR-03.9 then unblock realistic fixtures. KAR-03.5 can be developed in parallel with
KAR-03.4 because the reducer is pure and needs only `@karvan/core` — this is the story to work on
when the SQLite work needs a break. KAR-03.6 needs KAR-03.5's `RunState` shape. KAR-03.7 is
independent of the reducer and can be slotted anywhere after KAR-03.3. KAR-03.8 is last and is the
epic's acceptance gate.

Per [roadmap §2.3](../../17-roadmap.md), **W1 and W2 can be worked in the same week** —
[EPIC-04](./EPIC-04-mock-agent.md) shares no code with this epic and is a pleasant break from
reducer work. It is also a prerequisite for KAR-03.8's crash-fuzz suite, which needs mock agents on
`PATH`, so overlapping them is not merely pleasant but necessary.

## Risks

| Risk | Mitigation |
|---|---|
| **This epic is ~16 days, over the ~15-day guidance.** It is the largest foundational epic and everything is blocked on it. | Stated rather than hidden. Two levers if it runs long: KAR-03.9 (blob spill, `S`) can slip to just before EPIC-09 needs artifact offloading, and KAR-03.6 (checkpoint, `S`) is by construction a pure optimisation that can ship after KAR-03.8 — the ledger is correct without it, only slower to open. Do **not** defer KAR-03.7 to save time; a double-launched daemon is a first-week failure. |
| **All ledger benchmarks ran on Linux, likely overlayfs; macOS APFS uses `F_FULLFSYNC` and is typically slower** (roadmap A1-1, A1-2). Every number quoted in this epic's acceptance criteria inherits that caveat. | M0-S5 is in the Definition of Ready. Re-run the append benchmark on the target laptop and pick `synchronous=` from those numbers. Set CI performance budgets at ~3× the measured figure so they catch regressions without flaking on a slow runner. |
| **The ~2,000 control-events-per-run assumption may be 10–100× off** if events are ever emitted per tool call (roadmap A1-3). That would make "do not build snapshotting" wrong. | KAR-03.4 criterion 6 instruments the count per run from M1. Revisit past ~100k in a single run. The `checkpoint_version` guard means adding real snapshots later is additive, not a rewrite. |
| **`synchronous = NORMAL` does not survive power loss.** A kernel panic or a power cut can lose the most recent commits. | Stated in the README, in the epic DoD, and in a flow scenario. `FULL` costs roughly 23× per commit (979 vs 22,982 ev/s), so it is applied only via `withFullSync` around a genuinely irreversible external effect — a publish, a deploy, a push to a remote. |
| **A future contributor "simplifies" the drain to a lazy `iterate()` cursor** and reintroduces the 82.6 MB unclosable WAL. | KAR-03.4 test 5 is a regression test that asserts both the bad behaviour and the good one, with the measured number in the test name. |

---

**Related:** [Flows](../flows/EPIC-03-event-ledger-flows.md) · [Board](../board.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md) ·
[16-repo-layout.md](../../16-repo-layout.md)

[← Back to the delivery plan](../README.md)
