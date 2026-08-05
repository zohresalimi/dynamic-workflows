# @DeFlow/ledger

The SQLite event store. The append-only `event` log, the `io_chunk` data plane, the `effect`
journal, the `plan` / `run` / `node_wake` tables, `PRAGMA user_version` migrations, the
content-addressed blob store and the SSE tail queries.

Architecture: [docs/05-durable-execution.md](../../docs/05-durable-execution.md). Delivery:
[EPIC-03](../../docs/delivery/epics/EPIC-03-event-ledger.md).

## The `Db` port

The interface lives in `@DeFlow/core` (which performs no I/O), the better-sqlite3@13.0.2
implementation lives here, and the fake lives in `@DeFlow/testkit`. It is five methods —
`prepare`, `exec`, `transaction`, `pragma`, `close` — and it is small on purpose: its job is
**substitutability, not abstraction**. Swapping the driver is a change to `src/sqlite-db.ts` and its
contract test. SQL is written out in full everywhere else, because the statements are the schema's
contract and are meant to be read.

One write connection, N read-only connections. **Verified 2026-08-02, and again across two real
processes on 2026-08-05:** SQLite permits exactly one writer, and a second connection's
`BEGIN IMMEDIATE` fails with `SQLITE_BUSY` after its `busy_timeout` rather than hanging. There is no
write pool, no queue and no `acquireWriter()`; a second `openWrite()` on a path this process already
holds throws `LedgerAlreadyOpen`.

## What `synchronous = NORMAL` buys, and what it does not

`NORMAL` **does not fsync the WAL on every commit.** So:

- **A process crash is survived.** SIGKILL the daemon mid-write, reopen, and every committed row is
  there with `PRAGMA integrity_check` returning `ok`. This is the guarantee DeFlow actually makes,
  and the crash-fuzz suite is what proves it.
- **A power cut is not.** A kernel panic or a pulled plug can lose the most recent commits. That is
  a real limitation and it is written here rather than left implied by the word "WAL".

The price of the alternative, measured rather than assumed. From the architecture's Linux benchmark
(2026-08-02): **979 ev/s at `FULL` against 22,982 ev/s at `NORMAL`** — roughly a **23x** penalty for
one transaction per event.

The shipping value comes from the machine that runs it, not from those figures (spike
[S5](../../docs/spikes/S5-native-prebuilds.md), MacBook `Mac15,4`, darwin/arm64, APFS, 2026-08-04,
10,000 events per configuration):

| `synchronous`         | one txn per event | batched (100) |
| --------------------- | ----------------- | ------------- |
| `FULL`, fullfsync=0   | 41,246 ev/s       | 788,076 ev/s  |
| `NORMAL`, fullfsync=0 | 137,549 ev/s      | 1,083,923 ev/s |
| `FULL`, fullfsync=1   | 335 ev/s          | 28,605 ev/s   |
| `NORMAL`, fullfsync=1 | 48,143 ev/s       | 661,412 ev/s  |

macOS's `fsync(2)` does not flush the drive's write cache; only `fcntl(F_FULLFSYNC)` does, and
SQLite issues it only under `PRAGMA fullfsync = 1`, which is **off by default on darwin**. So at the
platform default, `FULL` costs 3.3x and buys nothing extra against power loss, and buying the
guarantee it is supposed to buy costs **144x**.

**For a laptop daemon, `NORMAL` is the right trade** — the failure it exposes you to is one you were
already exposed to by the machine going to sleep on a train, and the failure it protects you from,
the daemon being killed, is the one that actually happens.

### The one case that switches to `FULL`

A transaction recording a **genuinely irreversible external effect** — a publish, a deploy, a push
to a remote. Wrap that transaction, and only that transaction, in `withFullSync(db, fn)`. It raises
`synchronous` to `FULL`, raises `fullfsync` on darwin (without which it would be decoration), runs
the transaction, and restores both afterwards including when the callback throws. It costs about
3 ms per commit.

## The `event` table is append-only

`appendEvents(db, drafts)` and `readRange(db, runId, afterSeq, limit)` are the whole write and read
surface over `event`, and there is deliberately no third function that writes: no `updateEvent`, no
`deleteEvent`, no `amendEvent`. `seq` is the identity of an event **outside** the database — an SSE
frame `id`, a checkpoint's `last_seq`, a browser tab's cursor — so a row that can change is a cursor
that can lie. A grep test (`test/append-only.test.ts`) fails the build when one appears.

A batch is **one** transaction and every envelope in it is validated before a single row is written,
so a batch lands whole or not at all. The seq comes back from `INSERT … RETURNING seq` rather than a
follow-up `SELECT last_insert_rowid()`, which would be a second statement in the hot path for the
same answer.

### Sequence numbers have gaps

**Resume from strictly greater than your cursor. Never `cursor + 1`.** Every read is
`WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`, and the two reasons gaps are ordinary rather
than a symptom are:

- **Pruning.** `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT` on both `event` and `io_chunk`, and
  `AUTOINCREMENT` keeps a high-water mark in `sqlite_sequence` that a `DELETE` does not lower — so a
  pruned number is never reissued and leaves a permanent hole. That is the point of the keyword: with
  a bare `INTEGER PRIMARY KEY`, deleting the row that held 3 hands 3 straight back to the next
  insert, and every persisted cursor silently starts pointing at a different event.
- **One global sequence.** There is one `ledger.db`, keyed by `run_id` throughout — not one database
  per run. Two active runs interleave in the same `event` table, so a run's cursor walks a strided
  subsequence and `cursor + 1` is wrong before anything has been deleted at all.

**A rollback does not burn sequence numbers, contrary to what
[docs/05-durable-execution.md §6](../../docs/05-durable-execution.md#6-autoincrement-is-mandatory)
originally claimed.** Verified 2026-08-05 on better-sqlite3@13.0.2 / SQLite 3.53.4: `sqlite_sequence`
is an ordinary table, its high-water update is part of the transaction, and `ROLLBACK` — full or to a
`SAVEPOINT` — restores it, so the next append reuses the numbers the rolled-back batch was given. The
consequence for callers is the same either way, and it is the reason `appendEvents` documents its
return value as provisional: **a `seq` means nothing until the transaction that produced it commits.**

## The control plane and the data plane are different tables

`event` is small and is what `reduce()` folds. `io_chunk` is huge, holds agent `stdout`, `stderr`
and raw `agent_json` frames, and **the reducer never opens it**. `appendIoChunk` /
`appendIoChunks` write it, `readIoChunks` / `drainIoChunks` read it, and a `node.progress` event
may carry an `ioChunkSeq` pointer into it but never the bytes.

That separation is *physical* rather than a `kind` predicate or a partial index, which is strictly
better: there is no index to misdeclare and nothing to keep in sync. It buys three things.

- **No snapshotting.** **Measured 2026-08-02:** 500,000 events in one combined table is 193 MB and a
  full scan is 416 ms; the 10,000-row control-plane subset reduces to state in **29 ms**. A 40-node
  multi-hour run is on the order of **2,000** control-plane events, so folding one from scratch is
  single-digit milliseconds. There is no snapshot table and none is planned.
- **A meaningful progress watermark, for free.** An agent producing megabytes while accomplishing
  nothing writes only to `io_chunk`, so it does not advance the F4.7 watermark; an agent thinking
  silently for eight minutes does not falsely trip the stall detector either.
- **A structural guarantee, not a convention.** `@DeFlow/core` declares no dependency on
  `@DeFlow/ledger` or on a driver, and no file under `packages/core/src` may name `io_chunk` —
  `packages/core/test/purity.test.ts` fails the build if one does.

`readRunStats(db, runId)` reports `controlEventCount` beside `ioChunkCount`, so the ~2,000 figure
above stays a measurement. Roadmap **A1-3** is that per-tool-call events would be 10-100x it;
`CONTROL_EVENT_BUDGET` (20,000) is the assertion that catches that, and real snapshots are worth
revisiting only past `SNAPSHOT_REVISIT_THRESHOLD` (100,000) control events in a single run. If file
*size* becomes the concern first, the cheaper move is putting `io_chunk` in a second SQLite file via
`ATTACH`. When KAR-03.6 writes the `run` projection row, it carries this count onto the run record;
until then it is computed on read, which cannot go stale.

Anything over `MAX_INLINE_PAYLOAD_BYTES` (256 KiB) is refused at the append boundary with
`PayloadTooLarge` rather than written into `event.payload`. KAR-03.9 turns that refusal into a spill
to the content-addressed blob store; until then, refusing is the honest failure, because `event` is
append-only and is re-read by every replay.

## The tail query is served by the index, and every read is bounded

The SSE tail — `WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 500` — is the hottest read in the
system. **Measured 2026-08-02:** 1,000 of them over 500,000 events took 196 ms total, ~0.2 ms each.
`EXPLAIN QUERY PLAN` is asserted rather than hoped for, so dropping or reordering `event_run_seq`
fails the build.

**Correction, verified 2026-08-05 (KAR-03.4).** The architecture records that plan as
`SEARCH event USING COVERING INDEX event_run_seq`. On better-sqlite3@13.0.2 / SQLite 3.53.4 that
string appears only when the query asks for nothing outside `(run_id, seq)` — the seq-only cursor
probe. The shipped tail selects the whole envelope, so it fetches the row and plans as
`SEARCH event USING INDEX event_run_seq (run_id=? AND seq>?)`. Both are asserted. The properties
that actually matter are the same either way and are asserted too: **no `SCAN event`** and **no
`USE TEMP B-TREE FOR ORDER BY`**.

**better-sqlite3 is fully synchronous**, so an unbounded or unindexed read on the write connection
does not make one endpoint slow — it stops the event loop, and every in-flight SSE stream and HTTP
request in the daemon **stalls** behind it. A guard (`test/bounded-reads.test.ts`) fails the build on
a `SELECT` over `event` or `io_chunk` in this package without a `LIMIT`; counting aggregates, which
return one row, are exempt.

### Never a lazy `iterate()` cursor across a stream

Read more rows than fit in one window with `drainEvents` / `drainIoChunks`: bounded `LIMIT` queries
in a loop, each batch preparing and discarding its statement, nothing held open between batches.

A lazy `stmt.iterate()` piped into an SSE response is the shape a reasonable engineer reaches for,
and it is a trap. An open read statement holds a read transaction open, and SQLite cannot checkpoint
WAL frames past the oldest live reader, so every row written while the stream is connected
accumulates in `ledger.db-wal` and **no checkpoint can reclaim it**.

**Verified on this machine 2026-08-05**, writing 20,000 4 KiB rows while one cursor was held open on
a reader connection: the `-wal` file reached **96 MB**, `PRAGMA wal_checkpoint(TRUNCATE)` came back
`{ busy: 1, log: 23318, checkpointed: 248 }` — 248 frames of 23,318, and not one byte returned to
the filesystem — and the space came back only after the cursor was closed. The same 20,000 rows
through the bounded drain held `-wal` at **5.8 MB** and truncated cleanly. (The architecture's note
records 82.6 MB and `{busy:0, log:0, checkpointed:0}` for this; the magnitude reproduces, the exact
`wal_checkpoint` row does not — `busy: 1` with a near-zero `checkpointed` is what a blocked TRUNCATE
actually returns here, and `{0,0,0}` is what it returns *after* the cursor closes.) Both halves are
asserted in
`test/integration/wal-held-cursor.test.ts`, the bad one on purpose, so nobody simplifies the drain
back into an iterator.

## Migrations: no `down`, roll forward or restore

Migrations are numbered `.ts` files under `src/migrations/`, append-only and never edited once
shipped, each exporting a `Migration` with an `up(db)`. **There is no `down` migration anywhere in
this package**, and none should ever be added: for a local single-user daemon, a down migration is a
second, less-tested code path that exists to be wrong. Recovery from a bad migration is **roll
forward** (ship a new migration that fixes the shape) **or restore the pre-migration backup**.

Before the first `up()` of a run touches anything, `migrate()` takes
`VACUUM INTO '<dataDir>/pre-migrate-<user_version>.db'` — measured 2026-08-02 at 1007 ms for a
193 MB database, faster than `db.backup()`'s 1633 ms, and it produces a compacted, independently
openable copy. That file is the recovery path, and it doubles as a one-command "attach my ledger to
this bug report".

**Downgrade safety is two mechanisms, not one, and they cover different layers:**

- **Event payloads** downgrade gracefully: the reducer's tolerance for an unknown `kind` (KAR-03.5)
  is what makes a run written by a newer daemon still readable by an older one, one event at a time.
- **The schema itself does not.** A ledger whose `PRAGMA user_version` is higher than this binary's
  highest shipped migration id throws `LedgerTooNew` — naming both versions and pointing at the
  `pre-migrate-*.db` files — rather than guessing. There is no equivalent tolerance here, because a
  write from the older binary could violate a constraint it does not know exists.

## Testing this package

**`:memory:` is for pure projection unit tests only** — files named `*.projection.test.ts`, and a
guard in `test/testing-hygiene.test.ts` fails the build on an in-memory DSN anywhere else under
`packages/*/test/integration/`. An in-memory database cannot exercise WAL, cannot be reopened after
a simulated crash, and hides fsync and ordering bugs, which is to say it cannot test F4.2 — resume
after crash — which is the entire durability thesis. Everything else opens a real file inside a real
tmpdir (`makeTempDir()` from `@DeFlow/testkit`, kept on failure with `DeFlow_KEEP_TMP=1`).
