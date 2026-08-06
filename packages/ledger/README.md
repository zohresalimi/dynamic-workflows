# @DeFlow/ledger

The SQLite event store. The append-only `event` log, the `io_chunk` data plane, the `effect`
journal, the `plan` / `run` / `node_wake` tables, the `provider_capabilities` manifest, the
`process` rows an orphan reaper reads, `PRAGMA user_version` migrations, the content-addressed
blob store and the SSE tail queries.

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

## `provider_capabilities` is a history, not a lookup table

Migration 0004's table holds what each installed agent said it could do, keyed on
`(provider, version, binary_sha256)` — three parts on purpose. A version bump or a rebuilt binary
writes a **new row**, so what an agent could do *at the time a run started* is still readable after
it is upgraded, which is exactly what the resume poisoning guard
([provider adapter layer §6.1](../../docs/07-provider-adapter-layer.md)) compares against.

`recordProviderCapabilities` upserts, and the only column a repeat probe moves is `probed_at`:
"when did we last see this binary" is worth recording, "what did it say" is not worth overwriting
with a second opinion from the same bytes. It reports `{ inserted }` so a caller can tell a new
binary from a familiar one without counting rows.

`caps_json` is the **entire `initialize` response, unmodified** — not a set of extracted columns.
Persisting it verbatim is what lets a later DeFlow answer a question nobody has thought to ask yet,
and it is what stops this table from becoming a hardcoded capability matrix in a different costume.
Two checks are applied and both refuse rather than repair: `binary_path` must be absolute, and
`caps_json` must parse. There is no `run_id` column — what a binary can do is a fact about the
machine, and it outlives every run that read it.

## `process` outlives the daemon that wrote it

Migration 0005's table exists because agents are spawned `detached: true`, which is what makes a
wedged agent and everything it started reachable with one signal — and which means **the agent
survives DeFlowd's death**. A daemon that crashed mid-run left real processes editing a real
worktree, and these rows are the only handle the next daemon has on them
([provider adapter layer §9.5](../../docs/07-provider-adapter-layer.md)).

`appendEventsWithProcess` writes the row **inside the same transaction as `node.started`**. Two
separate writes would leave a window, and that window is the moment a daemon is most likely to die,
because it has just started a child process.

`started_at` is stored verbatim as the OS printed it — `ps -o lstart=` on darwin, `/proc/<pid>/stat`
field 22 on linux — and is never parsed. It is compared for equality against the same source on the
same machine and nothing else: normalising it would invent precision the source does not have, and
the reaper uses it to decide whether a pid still belongs to the agent that was recorded. Trusting a
bare pid instead is how an orphan reaper kills an unrelated user process.

## The `effect` journal is written before the side effect, and never rewritten

A row in `effect` records that a side effect was *intended*, keyed by
`ikey = ${run_id}/${node_id}/${attempt}/${ordinal}`. `journalEffect` writes it together with the
`effect.started` event in **one** transaction, before anything is performed, so a crash between the
two is impossible by construction and a crash immediately after leaves a `pending` row — which is
the point. `pending` from a previous daemon life means "we died mid-effect and cannot tell"; from
this one it means "another caller is mid-flight". Those are different situations and the runner
treats them differently ([durable execution §8.2](../../docs/05-durable-execution.md#82-the-write-ahead-effect-journal)).

The insert is `ON CONFLICT (ikey) DO NOTHING` followed by a `SELECT`, never an upsert: the row
already there is the truth about that ikey — it may be `done`, with a result somebody is about to
memoise — and overwriting it with a fresh intent is exactly the failure the journal exists to
prevent.

`nextOrdinal` counts the rows of a `(run_id, node_id, attempt)` triple. It is deliberately a query
rather than a counter: a counter resets to zero when the process restarts, so the second effect of
an interrupted attempt would come back as ordinal 0, collide with the first, and memoise the wrong
result with no error anywhere. `packages/daemon/test/no-ordinal-counter.test.ts` is what keeps that
honest.

Migration 0006 adds four triggers, because the rule is about *transitions* and a `CHECK` cannot see
the row's previous values: a row is born `pending`, moves once to `done` or `failed`, never changes
its identity columns (`ikey`, the four key components, `kind`, `request_hash`, `started_at`) and is
never deleted. Re-opening a terminal row would turn "this already happened" into "this never
happened", and a deleted row is indistinguishable from an effect that never started.

Migration 0007 permits exactly one more edit, and only to a `pending` row: `scaffoldEffect` writes
`result_json` while the state stays `pending` and `ended_at` stays `NULL`. That is the note a
`mutating` shell effect leaves for the next daemon's probe — the hash of `git status --porcelain`
taken before the command is spawned, completed with the after-hash the instant it returns
([§8.3](../../docs/05-durable-execution.md#83-the-four-effect-types)). Both halves have to be
durable *while the row is still pending*, because the crash they exist to survive is the one that
happens before it goes terminal. Nothing else is relaxed: combined with the identity trigger, the
only column such an update can touch is `result_json`, a terminal row is still frozen, `ended_at`
still cannot be set on a `pending` row, and no scaffold appends an event — it is a note to a probe,
not something that happened to the run.

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

## The checkpoint is a cache, and it is allowed to be thrown away

`run.state_json` + `run.last_seq` are a **pure optimisation**. There is no snapshot table here and
there should not be one: a 40-node multi-hour run is on the order of 2,000 control-plane events and
folding those is single-digit milliseconds, so the cache buys a fast start and nothing else.

Two rules keep it from ever buying a *wrong* start:

- **It is written in the same transaction as the events it covers.** `RunCheckpointer.append` does
  the inserts and the `run` upsert inside one `BEGIN IMMEDIATE`, so there is no window — none
  reachable by `SIGKILL` — in which a checkpoint exists without its events. That is what makes
  `run.last_seq <= max(event.seq)` true by construction rather than by care.
- **It is discarded at the slightest doubt.** `run.checkpoint_version` not matching the binary's
  `CHECKPOINT_VERSION`, `state_json` that will not parse, a decoded object the `RunStateSchema`
  refuses, or a `last_seq` past the end of the run all produce the same behaviour: one warning line
  naming the run and the reason, and a full replay from seq 0. A replay is the correct answer, not a
  degraded one.

`CHECKPOINT_VERSION` lives in `@DeFlow/core`'s `run-state.ts`, three lines under the type it stamps.
**Bump it whenever the shape of `RunState` changes**, at any depth. Forgetting to is the only way
this cache can be wrong, and bumping it unnecessarily costs milliseconds of replay.

Set **`DeFlow_NO_CHECKPOINT=1`** to turn the whole thing off. The suite is run with it set, because
a cache that anything has come to *depend on* is no longer a cache.

## Coming back from a crash

`openAndReplay(dataDir)` is the whole of a daemon start: open, migrate, find every run the
directory holds, validate each one's checkpoint, fold what came after it, and hand back
`Map<RunId, RunState>` alongside the connection. `replayAll(db)` is the same thing for a ledger the
caller has already opened, which is what `boot.ts` uses — it has taken the lease and bumped the
epoch by then, and a second connection would contend for the write lock the lease exists to make
unnecessary.

Two rules govern it, and both look like omissions until you know why they are there:

- **A restart is a fresh engine over the same file.** Never the handle you already had, and never
  `:memory:` — which cannot be reopened at all, cannot exercise WAL recovery, and hides the ordering
  bugs a restart exists to expose. Every durability test here closes the database and constructs a
  new one over the same bytes, because that is the code path a daemon restart really takes.
- **A gap in `seq` is ordinary, not damage.** `AUTOINCREMENT` never reissues a pruned number and one
  sequence is shared by every run in the directory, so replay walks what is there, raises nothing,
  and does not invent the missing rows. Nothing asserts contiguity, and nothing may start to.

### The suite that proves it

`pnpm test:fuzz` runs the crash-fuzz slice: a real scripted multi-node run over a real `.DeFlow/`
with fake agent binaries on `PATH`, `SIGKILL`ed — process group and all — at a seeded random point,
then restarted over the same directory. It asserts four things: no effect executed twice, the
reduced state equals the pre-crash projection at every seq the dead process recorded one for,
`PRAGMA integrity_check` is `ok`, and the run either completes or halts with a typed failure rather
than wedging.

The first of those is checked against the fake agents' **own side-effect log** — every invocation
appends `{runId, nodeId, attempt, idempotencyKey}` to a text file — so "executed twice" is a
duplicate-key check on something the effect journal did not write. Asking the journal whether it
prevented a second execution only proves the journal agrees with itself.

The seed comes from `$GITHUB_RUN_ID` when CI sets one, so a failure reproduces from the log;
`DeFlow_CRASH_SEED=<n>` re-runs a specific kill point and `DeFlow_KEEP_TMP=1` leaves the ledger on
disk to open afterwards.

## Big payloads spill to the content-addressed blob store

Any event payload whose canonical encoding exceeds **256 KiB** (`MAX_INLINE_PAYLOAD_BYTES`, one
exported constant) is written to `<dataDir>/blobs/<first two hex of sha256>/<sha256>` and the event
keeps only `{ sha256, bytes, mime, head, tail }` plus `truncated: true`. `appendEvents` does this
when it is given a `spillTo` data directory; without one it refuses the batch with `PayloadTooLarge`
rather than writing a permanent oversized row into an append-only table.

The reason is the one sentence the whole control-plane / data-plane split rests on: **replay time is
a function of ledger size**, and un-spilled tool output is what makes it explode. `event` is read in
full by every replay for the life of the run, so a 4 MB tool transcript in it is permanent *and*
recurring cost. `head` and `tail` are ~2 KiB each, which is what lets the UI preview a 40 MB build
log in a list of two hundred nodes without touching the disk once.

**The temp file is a sibling of its target**, `<sha256>.DeFlow-<ikey>.tmp` in the same shard
directory, and never in a system temp directory. This is not style: `rename(2)` is atomic only
**within one filesystem**, so a temp file on a different mount silently turns the atomic publish into
a copy, and the store then has torn files in it. `test/blob-paths.test.ts` asserts the sibling
property and scans `src/blobs.ts` for any reference to a system temp directory, because it is a
property of the *absence* of code. The write is the full recipe from
[durable execution §9.4](../../docs/05-durable-execution.md): write, `fsync` the file, close, rename,
then `fsync` the **directory** — the bytes being durable does not help if the directory entry
pointing at them is not.

**Blobs are global, not per-run, and nothing in this package deletes one.** That is the same fact
twice: content addressing means the identical failing test log from attempts 1, 2 and 3 — or from
two different runs of the same task — is one object with one handle, and therefore that no single
run owns it. Writing the same bytes again is a no-op: the target already exists at the name its
content determines, so there is no temp file, no rename and no I/O. Retention, when someone ships
it, has to be reference-counted or mark-and-sweep; a per-run `rm -rf` never can be.

**The hash is verified on every read.** A path is a claim about content, and returning bytes just
because they were found at the right filename is how a corrupted build log reaches an agent as
evidence. `getBlob` raises `BlobCorrupt` naming the handle when the bytes disagree with their own
name, and `BlobMissing` when the file is gone. Neither is fatal to the UI: `inspectArtifact` turns
them into an `ArtifactView` carrying the event's own head/tail excerpt plus an explicit
`full artifact unavailable` or `artifact failed integrity` notice, so a lost artifact renders as a
preview and a sentence rather than an empty box.

## Two daemons: the lease and the epoch

The failure is common rather than exotic — **a user runs `npx DeFlow up` in two terminals**, and it
happens the first week. SQLite protects the *database* (a second connection's `BEGIN IMMEDIATE`
returns `SQLITE_BUSY`) but nothing about it stops two schedulers interleaving *effect execution*:
both reduce the same ledger, both derive the same ready set, both spawn the same agent, both burn
tokens, and both commit to the same branch. Two mechanisms ship together, because they cover
different failures.

**`acquireLease(dataDir)`** takes an exclusive lock on `<dataDir>/DeFlow.lock` and holds it for the
life of the process. A second daemon fails immediately with one sentence —
`DeFlowd is already running (pid 4711) — data dir …` — and no stack trace. It is called **first** in
boot, before the ledger is opened for writing, before providers are probed, before the port is
bound: a second daemon that gets as far as spawning a capability probe has already changed the world
before failing.

The lock is a *file lock the kernel holds*, not a pid file, because the property that matters is
that it is released when the holder dies — `SIGKILL` included, with no handler and no cleanup. Node
exposes no `flock(2)` and the npm package that does needs `node-gyp` at install time, which NF6
forbids. What is already here, already compiled, is SQLite, whose unix VFS takes ordinary `fcntl`
advisory locks: an open `BEGIN IMMEDIATE` on `DeFlow.lock` holds one for exactly as long as the
process lives.

Acquiring it is **one statement**, and nothing is ever written into `DeFlow.lock` — it stays zero
bytes forever. That is not minimalism, it is the correctness condition: **a commit is exactly the
moment SQLite lets go of the file lock**. An acquisition that commits the holder's pid into the lock
file has to take the lock, commit, and take it again to hold, and between the commit and the retake
it holds nothing. Two daemons started microseconds apart — a supervisor, a container restart, a
script, a test harness; anything that is not a human typing in two terminals — walk into that
window, and `test/integration/lease-race.test.ts` measures what comes out: the daemon that acquired
*first* locked out by the one that arrived second, rounds where **both** fail and the user gets no
daemon at all, and a raw `SqliteError: database is locked` escaping to the terminal when the losing
daemon's pid read collides with the winner's commit. So there is one `BEGIN IMMEDIATE`, it is never
committed and never rolled back, and it *is* the lease. A `SIGKILL`ed holder leaves no rollback
journal, because no transaction ever wrote a page.

The pid the message names lives in `DeFlow.lock.pid` beside the lock. That is not the pid file this
section rejects: nothing consults it to decide whether a daemon is running, and it is never trusted
for liveness. It is read in exactly one place — by a daemon that has *already* been refused the lock
and therefore already knows a live holder exists — purely to put a number in the sentence. A pid
left behind by a `SIGKILL`ed holder is unreachable, because the next daemon takes the lock instead
of reading the file.

The lease is also anchored in a module-level set inside `lease.ts`, and that too is load-bearing.
The kernel lock lives on a file descriptor owned by a better-sqlite3 `Database` with a finalizer
that closes it, so if the only reference were the returned `Lease`, a caller who keeps `lease.pid`
for a log line and drops the object would have handed the lease to the garbage collector to release
whenever it felt like it — measured at milliseconds under a normal boot's allocation rate, after
which a second daemon acquires the lease of a daemon that is still running.

**`bumpEpoch(db)`** is the belt to that lock's braces. It advances `daemon.epoch` once per daemon
life in a single `UPDATE … RETURNING` (never a read followed by a write — that hands two racing
daemons the same number), and every appended event carries the result. `appendEvents` compares each
draft against the persisted epoch *inside* the append transaction and refuses the whole batch with
`StaleEpoch` if any of them is lower. The epoch is what covers the cases the lock cannot: `flock`
semantics on network mounts, a debugger-suspended process, a container restart that inherited the
file. A daemon that somehow starts anyway cannot put a row in this ledger — and the reducer skips
any stale-epoch row already on disk and counts it in `RunState.staleEpochSkipped`.

## Testing this package

**`:memory:` is for pure projection unit tests only** — files named `*.projection.test.ts`, and a
guard in `test/testing-hygiene.test.ts` fails the build on an in-memory DSN anywhere else under
`packages/*/test/integration/`. An in-memory database cannot exercise WAL, cannot be reopened after
a simulated crash, and hides fsync and ordering bugs, which is to say it cannot test F4.2 — resume
after crash — which is the entire durability thesis. Everything else opens a real file inside a real
tmpdir (`makeTempDir()` from `@DeFlow/testkit`, kept on failure with `DeFlow_KEEP_TMP=1`).
