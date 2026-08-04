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
