# EPIC-03 flows — Event ledger and durable state

> Behavioural specification for [EPIC-03](../epics/EPIC-03-event-ledger.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor              | Description                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Operator**       | The engineer driving DeFlow — runs `npx DeFlow up`, and occasionally runs it twice                       |
| **DeFlowd**        | The local daemon. In several scenarios there are two of them, or an older and a newer build              |
| **Ledger**         | `@DeFlow/ledger` — the write connection, the read connections, the migration runner, the blob store      |
| **Reducer**        | `reduce(state, event)` in `@DeFlow/core` — pure, total, no I/O                                           |
| **Provider agent** | A `@DeFlow/mock-agent` subprocess on a temp `PATH`, writing to `io_chunk` and to its own side-effect log |
| **SSE consumer**   | A browser tab or the CLI, holding a `seq` cursor across a reconnect                                      |
| **CI**             | The `test` matrix and the `crash-fuzz` project, on `ubuntu-26.04` and `macos-26`, Node 24 and 26         |

## Preconditions common to all flows

```gherkin
Background:
  Given a data directory created with fs.mkdtemp under os.tmpdir() with the prefix "DeFlow-"
  And DeFlow_KEEP_TMP is honoured so a failed run's ledger survives for post-mortem
  And the ledger is a FILE-BACKED SQLite database at <dataDir>/ledger.db — never ":memory:"
  And it is opened with journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000,
      foreign_keys=ON, wal_autocheckpoint=1000, journal_size_limit=67108864, cache_size=-32000
  And all six tables — event, io_chunk, effect, plan, run, node_wake — are declared STRICT
  And time enters the engine through an injected Clock port, never Date.now() or setTimeout
  And no test in this file calls vi.useFakeTimers() while a child process is alive
```

> `:memory:` is permitted **only** in scenarios explicitly marked `Automated at: unit (projection)`.
> It cannot exercise WAL, cannot be reopened after a simulated crash, and hides fsync and ordering
> bugs — so it cannot test F4.2, which is the entire durability thesis.

## Flow index

| Scenario    | Title                                                                  | Verifies                     | Type        |
| ----------- | ---------------------------------------------------------------------- | ---------------------------- | ----------- |
| EPIC-03-S1  | Open, migrate, append, reopen                                          | KAR-03.1, KAR-03.2, KAR-03.3 | Happy path  |
| EPIC-03-S2  | PRAGMAs are applied in order and WAL persists                          | KAR-03.1                     | Happy path  |
| EPIC-03-S3  | A second writer gets `SQLITE_BUSY`, readers do not                     | KAR-03.1                     | Edge case   |
| EPIC-03-S4  | `STRICT` refuses a TEXT value in an INTEGER column                     | KAR-03.1                     | Failure     |
| EPIC-03-S5  | A migration takes a compacted backup before it runs                    | KAR-03.2                     | Happy path  |
| EPIC-03-S6  | A failing migration rolls back completely                              | KAR-03.2                     | Failure     |
| EPIC-03-S7  | A ledger newer than the binary refuses to open                         | KAR-03.2, KAR-03.5           | Failure     |
| EPIC-03-S8  | Pruning reuses a sequence number without `AUTOINCREMENT`               | KAR-03.3                     | Failure     |
| EPIC-03-S9  | Sequence gaps are legal and the cursor is strictly greater than        | KAR-03.3                     | Edge case   |
| EPIC-03-S10 | Two runs interleave in one global event table                          | KAR-03.3                     | Concurrency |
| EPIC-03-S11 | Agent output reaches `io_chunk` and never the reducer                  | KAR-03.4, KAR-03.5           | Happy path  |
| EPIC-03-S12 | Control-plane replay stays fast beside a huge data plane               | KAR-03.4                     | Performance |
| EPIC-03-S13 | The SSE tail query is served by the covering index                     | KAR-03.4                     | Performance |
| EPIC-03-S14 | An open cursor held across a stream blows the WAL to 82.6 MB           | KAR-03.4                     | Failure     |
| EPIC-03-S15 | The reducer is pure, total and clock-free                              | KAR-03.5                     | Happy path  |
| EPIC-03-S16 | An older DeFlowd replays a ledger written by a newer one               | KAR-03.5, KAR-03.8           | Recovery    |
| EPIC-03-S17 | Upcasters run on the way into the reducer                              | KAR-03.5                     | Happy path  |
| EPIC-03-S18 | The checkpoint is committed with the events it covers                  | KAR-03.6                     | Happy path  |
| EPIC-03-S19 | A `checkpoint_version` bump forces a full replay to the same state     | KAR-03.6                     | Recovery    |
| EPIC-03-S20 | A corrupted checkpoint cannot corrupt state                            | KAR-03.6                     | Failure     |
| EPIC-03-S21 | The operator runs `DeFlow up` in two terminals                         | KAR-03.7                     | Failure     |
| EPIC-03-S22 | A daemon that bypassed the flock is fenced by `daemon_epoch`           | KAR-03.7                     | Concurrency |
| EPIC-03-S23 | The epoch is bumped on start and stamped on every write                | KAR-03.7                     | Happy path  |
| EPIC-03-S24 | `kill -9` mid-append, reopen, integrity intact                         | KAR-03.8                     | Recovery    |
| EPIC-03-S25 | `synchronous = NORMAL` survives a crash and is honest about power loss | KAR-03.1, KAR-03.8           | Edge case   |
| EPIC-03-S26 | Crash-fuzz: no effect executed twice, state matches, integrity ok      | KAR-03.8                     | Recovery    |
| EPIC-03-S27 | Checkpointed start and cold start agree exactly                        | KAR-03.6, KAR-03.8           | Recovery    |
| EPIC-03-S28 | A payload over 256 KiB spills to the blob store                        | KAR-03.9                     | Happy path  |
| EPIC-03-S29 | The same evidence across three attempts is one blob                    | KAR-03.9                     | Edge case   |
| EPIC-03-S30 | Control-plane event volume is measured, not assumed                    | KAR-03.4                     | Happy path  |

---

## EPIC-03-S1 — Open, migrate, append, reopen

**Verifies:** KAR-03.1, KAR-03.2, KAR-03.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The ledger round trip

  Scenario: a fresh data directory becomes a working ledger
    Given an empty data directory
    When openLedger(dataDir) is called
    Then PRAGMA user_version rises from 0 to the highest shipped migration id
    And the tables event, io_chunk, effect, plan, run, node_wake all exist and are STRICT
    And the indexes event_run_seq, io_run_seq, effect_run_state and node_wake_due all exist

  Scenario: appending returns assigned sequence numbers
    Given an open ledger
    When 3 events for run "run_20260802T141133Z_9f2a1c" are appended in one transaction
    Then append returns [1, 2, 3]
    And each was obtained from "INSERT … RETURNING seq" rather than a follow-up SELECT
    And readRange(runId, 0, 100) returns them in seq order

  Scenario: reopening finds them
    When the ledger is closed and openLedger is called again on the same directory
    Then no migration runs
    And readRange(runId, 0, 100) still returns the same 3 events with the same seqs
```

**Notes:** The `RETURNING seq` clause is **Verified 2026-08-02** to work on
`better-sqlite3@13.0.2` / SQLite 3.53.4. It matters because the alternative — insert then
`SELECT last_insert_rowid()` — is a second statement in the hot path of the append loop.

---

## EPIC-03-S2 — PRAGMAs are applied in order and WAL persists

**Verifies:** KAR-03.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Connection setup

  Scenario: the documented order is followed
    When a connection is opened
    Then the executed pragma statements are, in order:
      | journal_mode = WAL            |
      | synchronous = NORMAL          |
      | busy_timeout = 5000           |
      | foreign_keys = ON             |
      | wal_autocheckpoint = 1000     |
      | journal_size_limit = 67108864 |
      | cache_size = -32000           |

  Scenario: journal_mode is persistent, the rest are per-connection
    Given the ledger has been opened once and closed
    When it is opened again
    Then "PRAGMA journal_mode" reads back "wal" before any pragma is set on this connection
    And "PRAGMA synchronous" reads back the default until it is set

  Scenario: readers also get a busy timeout
    When openRead() is called
    Then that connection's busy_timeout is 5000
    And it can SELECT while the write connection holds an open transaction

  Scenario: -wal and -shm files exist alongside the database
    Then <dataDir>/ledger.db-wal and <dataDir>/ledger.db-shm are present while the ledger is open
```

**Notes:** Order is asserted rather than only the end state because `journal_mode` is persistent and
the rest are per-connection, and because `busy_timeout` must be in place before anything that might
contend. A reader opened without `busy_timeout` fails immediately under write pressure instead of
waiting, which surfaces as a flaky SSE hydrate.

---

## EPIC-03-S3 — A second writer gets `SQLITE_BUSY`, readers do not

**Verifies:** KAR-03.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: One writer, N readers

  Scenario: a second write connection cannot begin
    Given process A holds an open "BEGIN IMMEDIATE" on the ledger
    When process B issues "BEGIN IMMEDIATE" on the same file
    Then B fails with SQLITE_BUSY after its 5000 ms busy_timeout
    And it does not hang indefinitely

  Scenario: readers are unaffected
    Given process A is inside a write transaction having inserted 100 rows
    When a read-only connection queries readRange for a different run
    Then it returns promptly with the pre-transaction snapshot
    And it does not block

  Scenario: no write pool exists
    When openWrite() is called a second time in the same process
    Then it throws LedgerAlreadyOpen
    And packages/ledger exposes no pool, queue or "acquireWriter" API
```

**Notes:** **Verified 2026-08-02** that SQLite permits exactly one writer and a second connection's
`BEGIN IMMEDIATE` fails with `SQLITE_BUSY`. The temptation to build a write pool is real and
building one produces a queue of connections all failing the same way, plus a much harder concurrency
story. One writer is the design, and the third scenario is the guard.

---

## EPIC-03-S4 — `STRICT` refuses a TEXT value in an INTEGER column

**Verifies:** KAR-03.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: STRICT tables enforce column types

  Scenario: a text timestamp is rejected, not coerced
    When "INSERT INTO event(run_id, ts, kind, v, payload) VALUES ('run_x', 'not-a-number', 'run.created', 1, '{}')" is executed
    Then it fails with the message "cannot store TEXT value in INTEGER column event.ts"
    And no row is written

  Scenario: every table is STRICT
    When "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" is queried
    Then every returned sql string ends with "STRICT"
```

**Notes:** **Verified 2026-08-02**: `STRICT` genuinely enforces types rather than applying SQLite's
usual affinity coercion. Without it, a `ts` that arrived as an ISO string instead of a ms epoch
would be stored silently and would sort lexicographically — a bug that only appears when a run
crosses a digit boundary.

---

## EPIC-03-S5 — A migration takes a compacted backup before it runs

**Verifies:** KAR-03.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Pre-migration backup

  Scenario: the backup exists before the first up() executes
    Given a ledger at user_version 1 containing 50,000 events
    And migration 0002 is pending
    When migrate() is called
    Then <dataDir>/pre-migrate-1.db exists before migration 0002's up() is entered
    And that file opens independently and returns "ok" from PRAGMA integrity_check
    And it was produced by "VACUUM INTO", so it is smaller than or equal to the source

  Scenario: an already-current ledger takes no backup
    Given user_version already equals the highest migration id
    When migrate() is called
    Then no pre-migrate file is created
    And no transaction is opened
```

**Notes:** **Measured 2026-08-02: `VACUUM INTO` took 1007 ms for a 193 MB database**, versus 1633 ms
for `db.backup()` — faster _and_ it produces a compacted copy. That is a completely acceptable safety
net for a local daemon, and it doubles as the one-command "attach my ledger to this bug report",
which matters a lot when you are the only engineer on the project.

---

## EPIC-03-S6 — A failing migration rolls back completely

**Verifies:** KAR-03.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Migrations are all-or-nothing

  Scenario: a throwing migration leaves nothing behind
    Given a ledger at user_version 1
    And a test migration 0002 named "add-broken-table" whose up() creates a table and then throws
    When migrate() is called
    Then it throws an Error with the message "migration 2 (add-broken-table) failed"
    And that Error's cause is the original error
    And PRAGMA user_version is still 1
    And the table created by the first half of up() does not exist, because SQLite DDL is transactional

  Scenario: foreign_keys is restored even on failure
    Then PRAGMA foreign_keys reads 1 after the failed run

  Scenario: there is no down path
    When packages/ledger/src/migrations is searched for an exported "down"
    Then there are zero matches
    And packages/ledger/README.md states that recovery is roll-forward or restore from pre-migrate-<n>.db
```

**Notes:** No `down` migrations is a deliberate choice for a local single-user daemon: a down
migration is a second, less-tested code path that exists to be wrong. The backup from EPIC-03-S5 is
the recovery mechanism, and it is cheap enough to take unconditionally.

---

## EPIC-03-S7 — A ledger newer than the binary refuses to open

**Verifies:** KAR-03.2, KAR-03.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Downgrade safety at the schema layer

  Scenario: a schema from the future is not guessed at
    Given a ledger whose PRAGMA user_version is 9
    And a DeFlowd binary whose highest shipped migration id is 7
    When openLedger is called
    Then it throws LedgerTooNew
    And the message names both 9 and 7 and points at the pre-migrate-*.db files
    And no migration runs forward or backward
    And no table is altered

  Scenario: the event layer downgrades gracefully, the schema layer does not
    Then the reducer's unknown-kind tolerance (EPIC-03-S16) covers a downgrade across event kinds
    And LedgerTooNew covers a downgrade across a schema change
    And packages/ledger/README.md states both rules together, so the difference is not surprising
```

**Notes:** These two mechanisms have to be understood as a pair. The reducer ignoring unknown `kind`
values is what makes a _payload_-level downgrade safe; there is no equivalent for a table that has
gained a column, because a write from the older binary would violate a constraint it does not know
about. Failing loudly with a message naming the backup is the honest behaviour, and it is the
scenario a user hits after trying a nightly build.

---

## EPIC-03-S8 — Pruning reuses a sequence number without `AUTOINCREMENT`

**Verifies:** KAR-03.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: AUTOINCREMENT is mandatory

  Scenario: a bare INTEGER PRIMARY KEY reuses the number
    Given a scratch table "naive(seq INTEGER PRIMARY KEY, v TEXT)"
    When rows are inserted producing seqs 1, 2, 3
    And the row with seq 3 is deleted
    And another row is inserted
    Then the new row's seq is 3
    And the sequence number has been reused

  Scenario: the real schema does not
    Given the real event table declared "seq INTEGER PRIMARY KEY AUTOINCREMENT"
    When the same insert/delete/insert sequence is performed
    Then the new row's seq is 4
    And sqlite_sequence still records the high-water mark 3 before the insert and 4 after

  Scenario: what reuse would break
    Given an SSE consumer that persisted the cursor "3" before a reload
    And run pruning has deleted the event that was seq 3
    When a new event is appended under the naive schema
    Then the consumer resuming from "strictly greater than 3" silently skips a real event
    And the checkpoint whose last_seq is 3 covers an event it never applied
    And nothing raises an error anywhere
```

**Notes:** **Verified 2026-08-02.** This is the single most important regression test in the epic and
it costs ten lines. `seq` is the identity of an event _outside_ the database — the SSE frame `id` a
browser tab persisted before a reload, the `last_seq` in a checkpoint row, the cursor a frontend
store holds across a reconnect. Run pruning is not in M1, but it will be added because a 193 MB
ledger is real, and the third scenario is why this must be right before then rather than after. The
cost of `AUTOINCREMENT` is one extra `sqlite_sequence` row update per insert.

---

## EPIC-03-S9 — Sequence gaps are legal and the cursor is strictly greater than

**Verifies:** KAR-03.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Sequence gaps are legal

  Scenario: a rollback leaves no rows, and does not burn the numbers either
    Given the last committed event has seq 100
    When a transaction appends 3 events and is rolled back
    Then none of those 3 events is in the ledger
    And sqlite_sequence still reads 100, because ROLLBACK restores it
    And a subsequent append is handed 101 — a seq means nothing until its transaction commits

  Scenario: pruning is what leaves a hole
    Given events with seqs 1, 2 and 3
    When the row holding seq 2 is deleted and another event is appended
    Then the new event's seq is 4, because AUTOINCREMENT never reissues 2
    And readRange(runId, 1, 10) returns seqs 3 and 4, skipping the hole

  Scenario: two runs in one table leave a hole in each run's view
    Given runs "run_A" and "run_B" appending alternately
    Then run_A's seqs are 1, 3, 5, 7
    And readRange("run_A", 1, 10) returns 3 next, never 2

  Scenario: the cursor contract is "strictly greater than"
    Given a consumer holding cursor 100
    When it resumes
    Then it issues "WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?"
    And it never computes "cursor + 1"
    And a test asserts no source file in packages/ledger or packages/daemon contains "seq + 1" as a cursor expression
```

**Notes:** **Amended 2026-08-05 (KAR-03.3).** This scenario used to be titled "A rolled-back
transaction burns a sequence value" and asserted that the append after a rollback skips the burned
numbers. It does not: `sqlite_sequence` is an ordinary table, a `ROLLBACK` — full or to a
`SAVEPOINT` — restores its high-water mark, and the next append is handed 101. Verified on
better-sqlite3@13.0.2 / SQLite 3.53.4 before the scenario was rewritten, and
[05-durable-execution §6](../../05-durable-execution.md#6-autoincrement-is-mandatory) was corrected
at the same time. The contract is unchanged and now rests on the two mechanisms that genuinely
produce gaps — pruning, and one global `event` table shared by concurrent runs — which is a stronger
footing, because both are permanent rather than incidental.

This contract propagates all the way to the SSE endpoint in
[EPIC-15](../epics/EPIC-15-daemon-api.md): resume is always "strictly greater than `n`", never
"expect `n+1`". A UI that assumed contiguity would show a permanent phantom gap the first time two
runs are active at once.

---

## EPIC-03-S10 — Two runs interleave in one global event table

**Verifies:** KAR-03.3 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: One global ledger keyed by run_id

  Scenario: interleaved appends stay isolated on read
    Given runs "run_A" and "run_B" are both active
    When 50 events are appended alternating between them
    Then the global seq sequence is strictly increasing across both
    And readRange("run_A", 0, 100) returns only run_A's 25 events
    And their relative order matches the append order

  Scenario: there is exactly one database file
    Then <dataDir> contains ledger.db and no per-run *.db file
    And the run directory .DeFlow/runs/<runId>/ contains exports only — plan/, nodes/, report.html —
        and is never read back to reconstruct state
```

**Notes:** [16-repo-layout §7.2](../../16-repo-layout.md) records this as a deliberate deviation from
the PRD §9.4 sketch, which put `ledger.db` under `.DeFlow/runs/<runId>/`. The schema is keyed by
`run_id` throughout, cross-run features (project memory, plan templates, the cross-run dashboard,
FTS5 retrieval over prior runs) need one queryable store, and a per-run database would put a binary
WAL-journalled file inside a git repository.

---

## EPIC-03-S11 — Agent output reaches `io_chunk` and never the reducer

**Verifies:** KAR-03.4, KAR-03.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The control-plane / data-plane split

  Scenario: a chatty agent does not grow the control plane
    Given a mock agent scripted to emit 1 MB of agent_message_chunk output over 200 frames
    And the event table currently holds 40 rows for this run
    When the node runs to completion
    Then io_chunk has grown by roughly 200 rows carrying the bytes
    And the event table has grown by fewer than 10 rows — node.started, node.progress*, node.completed
    And no event payload contains more than a bounded excerpt of the output

  Scenario: node.progress points at the chunk stream rather than carrying it
    Then a node.progress payload may carry ioChunkSeq
    And it never carries the chunk bytes

  Scenario: the reducer structurally cannot read io_chunk
    Then reduce()'s parameter type is (RunState, Event)
    And packages/core has no dependency on @DeFlow/ledger or better-sqlite3
    And an architecture test asserts both
```

**Notes:** This split is what makes the F4.7 progress watermark meaningful **for free**: an agent
producing megabytes of output while accomplishing nothing does not advance the watermark, and an
agent thinking silently for eight minutes before a real state transition does not falsely trip the
stall detector. Neither property needed a line of code written specifically to produce it.

---

## EPIC-03-S12 — Control-plane replay stays fast beside a huge data plane

**Verifies:** KAR-03.4 · **Type:** Performance · **Automated at:** integration

```gherkin
Feature: Replay performance without snapshotting

  Scenario: 500k data-plane rows do not slow the fold
    Given a ledger seeded with 10,000 event rows and 500,000 io_chunk rows for one run
    When openAndReplay folds that run's control plane into RunState
    Then it completes in under 100 ms on CI hardware
    And the io_chunk table is never queried during the fold

  Scenario: a realistic run is single-digit milliseconds
    Given a 40-node multi-hour run fixture with roughly 2,000 control-plane events
    When it is folded
    Then it completes in under 30 ms on the developer machine
    And no snapshot table is consulted, because none exists
```

**Notes:** **Measured 2026-08-02** on `better-sqlite3@13.0.2` with WAL + `synchronous = NORMAL`:
500,000 events in one combined table is **193 MB**, a full scan is **416 ms**, and the control-plane
subset of 10,000 rows reduces to state in **29 ms**. In the shipped schema the isolation is achieved
_physically_ by the table split rather than by a partial index, which is strictly better — there is
no index to get wrong and no `kind` predicate to keep in sync. The CI budget is set at ~3× the
measured figure so it catches a regression without flaking on a slow shared runner; roadmap **A1-1**
notes those numbers came from Linux, likely overlayfs, so the macOS budget is set from M0-S5's
re-measurement.

---

## EPIC-03-S13 — The SSE tail query is served by the covering index

**Verifies:** KAR-03.4 · **Type:** Performance · **Automated at:** integration

```gherkin
Feature: The tail query is the hottest read in the system

  Scenario: the query plan is asserted, not hoped for
    When "EXPLAIN QUERY PLAN SELECT … FROM event WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500" is run
    Then the plan contains "SEARCH event USING COVERING INDEX event_run_seq"
    And it contains no "SCAN event" and no "USE TEMP B-TREE FOR ORDER BY"

  Scenario: a thousand tail queries stay cheap
    Given a ledger with 500,000 events
    When 1,000 tail queries are executed with advancing cursors
    Then the total elapsed time is under 600 ms on CI hardware
    And no single query exceeds 5 ms

  Scenario: unbounded scans are refused on the write connection
    Then a lint or review rule forbids a query without a LIMIT on the write connection
    And packages/ledger/README.md records that better-sqlite3 is fully synchronous, so a large
        unindexed query on the write connection stalls every in-flight SSE stream and HTTP request
```

**Notes:** **Measured 2026-08-02**: 1,000 tail queries took **196 ms total, ~0.2 ms each**, served by
`SEARCH event USING COVERING INDEX event_run_seq`. Headroom is large but not infinite, and the
synchronous driver means a single bad query is a whole-daemon stall rather than a slow endpoint.

---

## EPIC-03-S14 — An open cursor held across a stream blows the WAL to 82.6 MB

**Verifies:** KAR-03.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Bounded drains, never a lazy cursor across a stream

  Scenario: the failure this rule exists to prevent
    Given a read cursor opened with stmt.iterate() and deliberately held open
    When 20,000 rows are written on the write connection
    Then the ledger.db-wal file grows to roughly 82.6 MB
    And "PRAGMA wal_checkpoint(TRUNCATE)" returns { busy: 0, log: 0, checkpointed: 0 }
    And the space is reclaimed only after the cursor is closed

  Scenario: the shipped drain does not do that
    Given the shipped readRange path draining the same 20,000 rows with bounded LIMIT queries
    And each prepared statement finalised between batches
    When the same 20,000 rows are written
    Then the -wal file stays under 8 MB
    And wal_checkpoint(TRUNCATE) reports a non-zero checkpointed page count
```

**Notes:** **Verified 2026-08-02.** The first scenario deliberately asserts the bad behaviour so
nobody "simplifies" the drain back into a lazy iterator — which is exactly the shape a reasonable
engineer reaches for when streaming a large result to SSE. Put the number in the test name so the
diff reads as a warning.

---

## EPIC-03-S15 — The reducer is pure, total and clock-free

**Verifies:** KAR-03.5 · **Type:** Happy path · **Automated at:** unit (projection)

```gherkin
Feature: The functional core

  Scenario: determinism
    Given the fixture test/fixtures/runs/happy-path.events.json with 2,000 events
    When reduce is folded over it twice from the same initial state
    Then the two results are deeply equal
    And the result matches the file snapshot __snapshots__/state-happy-path.json under the normalising serialiser

  Scenario: the input state is never mutated
    Given a deeply frozen initial state
    When the fold runs
    Then no TypeError is thrown
    And the frozen object is unchanged

  Scenario: no clock is read
    Given Date.now is stubbed to throw for the duration of the fold
    When the fold runs
    Then it completes normally

  Scenario: totality
    Given a generated corpus containing one event of every registered kind, plus three unknown kinds,
          plus one event with every optional envelope field absent
    When each is reduced against every one of five representative states
    Then reduce returns a RunState for all of them and throws for none

  Scenario: pause is state, not a flag
    Given a ledger containing run.paused at seq 50 and no run.resumed
    When state is folded from scratch
    Then state.status is 'paused'
    And nothing outside the ledger was consulted to determine that
```

**Notes:** This is the one scenario in the epic permitted to use `:memory:` or no database at all —
it is a pure projection test. Its speed is the point: because `reduce` and `decide` are pure, the
whole scheduler is exercised without I/O, and `clock.advance(hours(6))` exercises a six-hour human
gate in microseconds.

---

## EPIC-03-S16 — An older DeFlowd replays a ledger written by a newer one

**Verifies:** KAR-03.5, KAR-03.8 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Downgrade tolerance — the single forward-compatibility mechanism

  Background:
    Given a ledger written by a newer DeFlowd for run "run_20260802T141133Z_9f2a1c"
    And it contains 1,800 events of known kinds
    And it also contains 40 events of kind "node.sandbox.escalated", which this binary has never heard of
    And PRAGMA user_version is unchanged, so the schema is compatible

  Scenario: the daemon starts and serves
    When the older DeFlowd starts over that data directory
    Then it does not throw
    And it does not enter a crash loop
    And it binds its port and serves the run

  Scenario: unknown kinds are skipped, known kinds still apply
    When the run's state is folded
    Then every known event has been applied
    And each of the 40 unknown events left state unchanged
    And a single aggregate log line reports "skipped 40 events of 1 unknown kind" at info level
    And there is NOT one error-level log line per skipped event

  Scenario: the projection is degraded, not corrupted
    Then state.nodes reflects every node.started / node.completed present in the ledger
    And no node is left in an impossible state such as completed-without-started
    And the UI's run view renders, with the unknown transitions simply absent from the timeline

  Scenario: appending after a downgrade is safe
    When the older daemon appends new events
    Then their seqs are strictly greater than every existing seq
    And no existing row is rewritten
    And a subsequent start of the NEWER binary folds the whole ledger, unknown-to-the-old events included,
        and produces the state the newer reducer expects
```

**Notes:** This is the mandated downgrade scenario and it is the entire reason
[04-domain-model §9.2](../../04-domain-model.md) rule 2 says "not throw, not log-and-throw, not
`assertNever`". A user who installs a newer `DeFlowd`, starts a run, then downgrades must get a
daemon that skips what it does not understand rather than one that refuses to open the ledger. The
aggregate-log clause is deliberate: an error line per skipped event during a 40-node replay is its
own denial of service. Note the pairing with [EPIC-03-S7](#epic-03-s7--a-ledger-newer-than-the-binary-refuses-to-open):
payload-level downgrade degrades, schema-level downgrade refuses.

---

## EPIC-03-S17 — Upcasters run on the way into the reducer

**Verifies:** KAR-03.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Read-time payload upcasting

  Scenario: a mixed-version ledger reduces correctly
    Given a ledger containing node.completed payloads at v1, v2 and v3
    When the run is folded
    Then each payload is upcast to v3 before reduce sees it
    And the resulting state is deeply equal to the state folded from an all-v3 ledger of equivalent events

  Scenario: the ledger is not rewritten
    When the fold completes
    Then the stored payload text for the v1 rows is byte-identical to what it was before the fold
    And event.v for those rows is still 1

  Scenario: the reducer never branches on v
    When packages/core/src/reduce.ts is inspected
    Then it branches on event.kind only
    And it contains no comparison against event.v
```

**Notes:** Events are never rewritten on disk — the ledger is append-only and immutable, so a v1
payload written in March is still a v1 payload in December. Keeping `v` out of the reducer's
branching is what stops upcasting logic leaking into state transitions, where it would be
untestable.

---

## EPIC-03-S18 — The checkpoint is committed with the events it covers

**Verifies:** KAR-03.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The checkpoint cache

  Scenario: written in the same transaction
    Given 600 events are appended in batches
    When the checkpoint threshold of ~500 events is crossed
    Then exactly one run row update occurs
    And run.last_seq equals a seq that is committed in the same transaction
    And run.checkpoint_version equals the binary's CHECKPOINT_VERSION

  Scenario: last_seq never runs ahead
    Given 50 randomised append-and-checkpoint cycles with interleaved rollbacks
    Then at every observation point run.last_seq <= (SELECT max(seq) FROM event WHERE run_id = ?)

  Scenario: startup uses the cache
    Given a valid checkpoint at last_seq 500 and 30 further events
    When openAndReplay runs
    Then state is decoded from state_json
    And exactly 30 events are folded
    And the fold count is observable through a counter so this is asserted, not assumed

  Scenario: it is also written on quiesce
    Given a run goes idle with 40 uncheckpointed events
    When the scheduler observes quiesce
    Then a checkpoint is written covering them
```

**Notes:** "Always in the same transaction as the events it covers" removes the entire class of bug
where a crash lands between the event commit and the checkpoint commit. There is no window in which
a checkpoint exists without its events, so the second scenario's invariant holds by construction
rather than by care.

---

## EPIC-03-S19 — A `checkpoint_version` bump forces a full replay to the same state

**Verifies:** KAR-03.6 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: The checkpoint is a pure optimisation

  Scenario: a reducer shape change invalidates the cache
    Given a ledger with a valid checkpoint written at CHECKPOINT_VERSION 4
    And a binary whose CHECKPOINT_VERSION is 5
    When openAndReplay runs
    Then state_json is ignored
    And every event for the run is folded from seq 0
    And the resulting state is deeply equal to the state the checkpointed path produced on version 4's shape,
        modulo the intended shape change

  Scenario: the two paths agree on an unchanged version
    Given the same ledger and a matching CHECKPOINT_VERSION
    When state is computed once via the checkpoint path and once with DeFlow_NO_CHECKPOINT=1
    Then the two states are deeply equal
    And this assertion runs for every fixture in test/fixtures/runs/

  Scenario: the whole suite passes with the cache disabled
    When the integration and crash-fuzz projects run with DeFlow_NO_CHECKPOINT=1
    Then every test passes
```

**Notes:** The `checkpoint_version` column is the entire point of the design: it makes the checkpoint
**a pure optimisation that can never cause a correctness bug** — a property worth far more than the
milliseconds it saves. A checkpoint that can be wrong is a checkpoint that will eventually be wrong
at 3am on a nine-hour run. The third scenario is what keeps that claim true over time.

---

## EPIC-03-S20 — A corrupted checkpoint cannot corrupt state

**Verifies:** KAR-03.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Checkpoint validation

  Scenario Outline: a bad cache is discarded, never propagated
    Given a ledger with a checkpoint whose state_json is <corruption>
    When openAndReplay runs
    Then the cache is discarded
    And a full replay produces the correct state
    And a warning names the run id and the reason "<reason>"
    And the daemon starts normally

    Examples:
      | corruption                                        | reason              |
      | truncated mid-object                              | decode-failed       |
      | valid JSON but an array instead of an object      | shape-invalid       |
      | valid JSON of an older RunState shape             | shape-invalid       |
      | valid RunState with last_seq greater than max(seq)| last-seq-impossible |

  Scenario: the cache is validated, not merely parsed
    Then decoding runs the candidate through RunStateSchema
    And a JSON.parse success alone is not sufficient to accept it
```

**Notes:** The third example is the subtle one and the reason criterion 5 of KAR-03.6 exists. A
truncated file throws and is trivially caught; a structurally-valid object of a previous shape parses
cleanly and silently produces wrong state — the exact failure mode `checkpoint_version` is meant to
prevent, but belt and braces are cheap here.

---

## EPIC-03-S21 — The operator runs `DeFlow up` in two terminals

**Verifies:** KAR-03.7 · **Type:** Failure · **Automated at:** e2e

```gherkin
Feature: Single-instance lease

  Scenario: the second daemon fails fast and says why
    Given DeFlowd is running with pid 4711 against data directory <dataDir>
    And it holds an exclusive flock on <dataDir>/DeFlow.lock
    When the operator runs "npx DeFlow up" in a second terminal against the same data directory
    Then the second process exits non-zero within 1 second
    And stderr reads "DeFlowd is already running (pid 4711) — data dir <dataDir>"
    And there is no stack trace and no raw EWOULDBLOCK
    And the second process did NOT bind a port
    And the second process did NOT open the ledger for writing
    And the second process did NOT spawn a provider capability probe

  Scenario: the lock is taken before anything else in boot
    Then the boot sequence is: resolve data dir → flock → migrate → probe providers → bind port
    And a test asserts the ordering by instrumenting each step

  Scenario: a SIGKILLed daemon releases the lock
    Given DeFlowd is killed with SIGKILL
    When a new DeFlowd starts against the same data directory
    Then it acquires the lock without manual cleanup
    And no stale-pid file has to be removed by hand
```

**Notes:** This is the mandated two-daemons scenario. "It's a single-user local daemon, so locking is
unnecessary" is wrong, and the failure is common rather than exotic — **a user runs `npx DeFlow up`
in two terminals, and it happens the first week.** SQLite protects the _database_ (a second
connection's `BEGIN IMMEDIATE` returns `SQLITE_BUSY`, verified) but does absolutely nothing to stop
two schedulers interleaving _effect execution_: both reduce the same ledger, both derive the same
ready set, both spawn the same agent, both burn tokens, and both commit to the same branch. The
"did not spawn a probe" clause matters — a second daemon that gets far enough to probe providers has
already changed the world before failing. The third scenario relies on the kernel releasing `flock`
on fd close, which is why `flock` is used rather than a pid file.

---

## EPIC-03-S22 — A daemon that bypassed the flock is fenced by `daemon_epoch`

**Verifies:** KAR-03.7 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: Epoch fencing — the belt to flock's braces

  Background:
    Given two Ledger instances A and B are constructed over the same ledger.db
    And the flock is deliberately bypassed, simulating a stale lock file on a network mount,
        a debugger-suspended process, or a container restart that inherited the file
    And A booted at daemon_epoch 7
    And B booted afterwards and advanced the persisted epoch to 8

  Scenario: the older daemon's writes are rejected
    When A appends an event stamped with epoch 7
    Then the append fails with StaleEpoch naming 7 and 8
    And zero rows are written
    And A does not retry

  Scenario: the newer daemon's writes succeed
    When B appends an event stamped with epoch 8
    Then it succeeds and returns a seq

  Scenario: the ledger contains only the newer daemon's work
    Given 100 interleaved append attempts from A and B
    Then every row in the event table carries epoch 8
    And the reduced state is exactly what B alone would have produced

  Scenario: a stale-epoch event already on disk is a reducer no-op
    Given a hand-crafted ledger containing one event at epoch 6 after the run advanced to epoch 8
    When the run is folded
    Then that event leaves state unchanged
    And a stale-epoch counter is incremented and surfaced on the run projection
```

**Notes:** `flock` prevents the second daemon from starting; the epoch guarantees that if one somehow
does, it cannot corrupt anything. The two mechanisms cover different failures, which is why both
ship — and why this scenario deliberately bypasses the lock rather than assuming it is
unbreachable. `flock` semantics on network mounts are the documented case where it is.

---

## EPIC-03-S23 — The epoch is bumped on start and stamped on every write

**Verifies:** KAR-03.7 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: daemon_epoch bookkeeping

  Scenario: monotonic across boots
    Given a fresh data directory
    When DeFlowd boots three times in sequence
    Then the persisted epoch reads 1, then 2, then 3
    And the read-increment-persist is atomic — a crash between read and persist cannot produce a duplicate epoch

  Scenario: every event carries it
    Given 500 events appended across two daemon lives
    Then no event row has a null epoch
    And the epochs partition cleanly into the two lives

  Scenario: the run projection records who advanced it
    Given a run started under epoch 2 and resumed under epoch 3
    Then run.daemon_epoch is 3
    And the UI can render "resumed by a later daemon" from that field alone
```

**Notes:** The atomicity clause in the first scenario matters more than it looks: a crash between
reading the epoch and persisting the increment would let two consecutive daemon lives share an
epoch, which silently defeats the fencing in EPIC-03-S22. Read and write it in one transaction.

---

## EPIC-03-S24 — `kill -9` mid-append, reopen, integrity intact

**Verifies:** KAR-03.8 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Crash and reopen

  Scenario: SIGKILL during a write loop loses nothing committed
    Given a child process appending events in a tight loop to a file-backed ledger
    And it has committed roughly 45,000 rows
    When the parent sends SIGKILL — not SIGTERM, so no handler, no flush, no cleanup
    And the ledger file is reopened by a fresh process
    Then every committed row is present
    And PRAGMA integrity_check returns "ok"
    And the -wal file is recovered automatically on open with no manual checkpoint

  Scenario: resume is tested the way a restart actually happens
    Then the test closes the database and constructs a FRESH engine over the SAME FILE
    And it does not reuse the in-process handle
    And it does not use ":memory:", which cannot be reopened at all

  Scenario: a sequence gap from the crash is tolerated
    Given the crash interrupted an uncommitted transaction that had burned seqs
    When the ledger is replayed
    Then no error is raised
    And no missing seq is invented
    And the last_seq recorded by the surviving checkpoint is <= max(seq)
```

**Notes:** This is the mandated crash-and-reopen scenario. **Verified 2026-08-02**: SIGKILL mid-write
loop at ~45k committed rows, then reopen — all **45,339** rows present, `PRAGMA integrity_check` =
`ok`. `kill -9` rather than SIGTERM is the whole point: SIGTERM tests your shutdown handler, SIGKILL
tests your durability. The second scenario encodes
[testing strategy §7](../../14-testing-strategy.md)'s rule — `:memory:` cannot exercise WAL, cannot
be reopened after a simulated crash, and hides fsync and ordering bugs, so it cannot test the one
property that matters most.

---

## EPIC-03-S25 — `synchronous = NORMAL` survives a crash and is honest about power loss

**Verifies:** KAR-03.1, KAR-03.8 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Stating what the durability setting does and does not buy

  Scenario: process crash is survived
    Given synchronous = NORMAL
    When the process is SIGKILLed mid-write and the ledger reopened
    Then all committed rows are present and integrity_check is "ok"

  Scenario: power loss is not claimed
    Then packages/ledger/README.md states that NORMAL does not fsync the WAL on every commit,
        so a kernel panic or a power cut can lose the most recent commits
    And it records the measured price of the alternative: 979 ev/s at FULL versus 22,982 ev/s at NORMAL,
        roughly a 23x penalty for one transaction per event
    And it states that for a laptop daemon NORMAL is the right trade

  Scenario: irreversible effects opt into FULL
    Given a transaction recording a genuinely irreversible external effect — a publish, a deploy, a push to a remote
    When it is wrapped in withFullSync(...)
    Then synchronous is FULL for that transaction only
    And it is restored to NORMAL afterwards, including if the transaction throws

  Scenario: the setting comes from a measurement on the target machine
    Then the constant carries a comment naming the machine and date of the benchmark it was chosen from
    And roadmap risk A1-1 is closed by M0-S5's re-run on APFS, not by the Linux figures
```

**Notes:** The architecture is explicit that this document "says so rather than pretending WAL means
invulnerable". Roadmap **A1-1** records that all benchmarks ran in a Linux container, likely over
overlayfs; macOS APFS uses `F_FULLFSYNC` and is typically slower. The _relative_ shape (FULL is
20–25× more expensive per commit; batching gives ~7×) should hold, but the absolute setting is picked
from numbers measured on the machine that will run it.

---

## EPIC-03-S26 — Crash-fuzz: no effect executed twice, state matches, integrity ok

**Verifies:** KAR-03.8 · **Type:** Recovery · **Automated at:** crash-fuzz (CI, every push)

```gherkin
Feature: The test that proves the thesis

  Background:
    Given DeFlow-mock-agent and the fake exec-shim agent are symlinked onto a temp PATH
    And each fake binary appends {runId, nodeId, attempt, idempotencyKey} to a side-effect log file on every invocation
    And the mock agents run with --seed so the pre-crash side is deterministic
    And the kill point is seeded from $GITHUB_RUN_ID so a CI failure reproduces from the log
    And the harness snapshots the SSE-projected state on EVERY event before the kill

  Scenario Outline: kill, restart, assert four invariants
    Given DeFlowd is started over a fresh .DeFlow/ with a scripted multi-node run
    When the harness sleeps <interval> and sends SIGKILL to the daemon
    And DeFlowd is restarted over the same .DeFlow/ directory
    Then the fake agents' side-effect log contains no duplicate idempotencyKey
    And the effect journal contains no ikey in state 'done' twice
    And the reduced state equals the pre-crash projection at the last durably-written seq
    And PRAGMA integrity_check returns "ok"
    And the run either completes or halts with a typed NodeFailure — it never wedges

    Examples:
      | interval                          |
      | a random point in the first node   |
      | a random point mid-run             |
      | a random point during a gate       |
      | a random point during a retry backoff |

  Scenario: a wedge is a failure, not a timeout
    Given the restarted run neither completes nor fails within the scripted budget
    Then the test fails with the run's last 20 events and the reduced state attached
    And DeFlow_KEEP_TMP=1 plus actions/upload-artifact preserve the ledger for post-mortem
```

**Notes:** "Everything else in the durability design is theory until this test is green." Two details
make it actually work. Assertion one is checked against the fakes' **own** side-effect log, so
"executed twice" is a duplicate-key check on a text file rather than an inference from the journal
that is supposed to be preventing it. Assertion two needs the pre-crash projection, so the harness
must snapshot on every event from the first iteration — retrofitting that later is painful. Note
also that `vi.useFakeTimers()` is forbidden here: child processes are alive throughout, their real
I/O would never arrive, and the test would deadlock for the full timeout.

---

## EPIC-03-S27 — Checkpointed start and cold start agree exactly

**Verifies:** KAR-03.6, KAR-03.8 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Two paths, one answer

  Scenario Outline: every recorded fixture agrees on both paths
    Given the ledger fixture "<fixture>"
    When state is computed with the checkpoint cache enabled
    And state is computed again with DeFlow_NO_CHECKPOINT=1
    Then the two RunStates are deeply equal
    And both match the committed file snapshot for that fixture

    Examples:
      | fixture                |
      | happy-path             |
      | three-patches          |
      | gate-failure-repair    |
      | compaction             |
      | crash-resume-seq-gap   |
      | stress-400             |

  Scenario: the crash-resume fixture really has a gap
    Given the fixture crash-resume-seq-gap
    Then its event seqs are non-contiguous, as a real SIGKILL produces
    And both computation paths handle the gap without special-casing it
```

**Notes:** These six fixtures are the same corpus the UI's entire test and dev story runs on
([testing strategy §12](../../14-testing-strategy.md)) — a recorded ledger is simultaneously a test
fixture, a dev-mode data source and a demo, and `DeFlow replay <fixture>` serves one over the same
HTTP + SSE contract as a live run. Asserting both computation paths against them here means the UI's
fixtures are validated by the ledger's own suite before a single view is built.

---

## EPIC-03-S28 — A payload over 256 KiB spills to the blob store

**Verifies:** KAR-03.9 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Content-addressed spill

  Scenario: under the threshold, stored inline
    Given an event payload of 255 KiB
    When it is appended
    Then event.payload contains the full payload
    And no file is written under <dataDir>/blobs/

  Scenario: over the threshold, spilled
    Given an event payload of 2 MiB of test output
    When it is appended
    Then event.payload is replaced by { sha256, bytes: 2097152, mime, head, tail }
    And a file exists at <dataDir>/blobs/<first two hex>/<full sha256>
    And that file's sha256 matches its path
    And the descriptor left in the event is itself well under the threshold

  Scenario: the handle resolves
    When getBlob("artifact://<sha256>") is called
    Then it returns bytes whose sha256 matches the handle

  Scenario: the write is atomic and stays on one filesystem
    Then the temp file used during the write is a SIBLING of the target inside <dataDir>/blobs/<ab>/
    And it is never created in os.tmpdir()
    And it does not exist after the write completes

  Scenario Outline: failure modes are typed
    Given <situation>
    When getBlob is called
    Then it returns <error>
    And the node inspector renders the event's head/tail excerpt with an explicit "<ui>" state

    Examples:
      | situation                                   | error       | ui                          |
      | the blob file has been deleted              | BlobMissing | full artifact unavailable   |
      | the blob file's content no longer hashes    | BlobCorrupt | artifact failed integrity   |
```

**Notes:** "Replay time is a function of ledger size, and un-spilled tool output is what makes it
explode" — this is what keeps EPIC-03-S12's budget achievable. The sibling-temp-file rule is not
style: `rename` is atomic only **within one filesystem**, so a temp file in `/tmp` breaks the
guarantee entirely on any machine where `/tmp` is a separate mount.

---

## EPIC-03-S29 — The same evidence across three attempts is one blob

**Verifies:** KAR-03.9 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Deduplication falls out of content addressing

  Scenario: three retries producing identical output
    Given a node fails three times producing byte-identical 1 MiB test output each time
    When each attempt's evidence is stored
    Then <dataDir>/blobs/ contains exactly one file for that content
    And the three NodeFailure records carry the same artifact:// Handle
    And disk usage after the second and third writes is unchanged

  Scenario: blobs are global, not per-run
    Given two different runs produce the same failing build log
    Then both resolve to the same blob path
    And neither run's directory contains a copy
```

**Notes:** Blobs are global for the same reason content addressing exists — the identical failing
test log across three retry attempts, or across two runs of the same task, deduplicates to one
object. This also means blob deletion can never be per-run; retention has to be reference-counted or
mark-and-sweep, which is a note for whoever ships pruning, not work for M1.

---

## EPIC-03-S30 — Control-plane event volume is measured, not assumed

**Verifies:** KAR-03.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Instrumenting the assumption that removed snapshotting

  Scenario: the counter exists from M1
    Given a scripted 40-node run completes
    When the run projection is read
    Then it exposes a control-plane event count for that run
    And the count is in the low thousands, consistent with the ~2,000 figure the design assumes

  Scenario: a regression is visible
    Given a change that emits a control-plane event per tool call
    When the same 40-node run completes
    Then the count rises by an order of magnitude
    And a test asserting an upper bound of 20,000 control events for the standard fixture fails,
        naming the assumption and pointing at the "revisit past ~100k" threshold
```

**Notes:** Roadmap risk **A1-3**: the "no snapshotting needed" conclusion rests on ~2,000
control-plane events per 40-node run, and per-tool-call events could be 10–100× that. Instrumenting
from M1 is how that gets discovered by measurement rather than by a nine-hour run getting slow to
open. Because the `checkpoint_version` guard already exists, adding real snapshots later would be
additive rather than a rewrite — and if file _size_ becomes the concern first, the cheaper move is
putting `io_chunk` in a second SQLite file via `ATTACH`.

---

**Related:** [EPIC-03](../epics/EPIC-03-event-ledger.md) · [Board](../board.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md) ·
[16-repo-layout.md](../../16-repo-layout.md)

[← Back to the delivery plan](../README.md)
