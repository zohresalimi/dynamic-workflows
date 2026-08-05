/**
 * KAR-03.7 — the single-instance lease on `<dataDir>/DeFlow.lock`
 * (docs/05-durable-execution.md §12, docs/16-repo-layout.md §7.2).
 *
 * "It's a single-user local daemon, so locking is unnecessary" is wrong, and
 * the failure is common rather than exotic: **a user runs `npx DeFlow up` in
 * two terminals**, and it happens the first week. SQLite protects the
 * *database* — a second connection's `BEGIN IMMEDIATE` returns `SQLITE_BUSY` —
 * but it does nothing to stop two schedulers interleaving *effect execution*:
 * both reduce the same ledger, both derive the same ready set, both spawn the
 * same agent, both burn tokens, and both commit to the same branch.
 *
 * So the lease is taken **first**, before the ledger is opened for writing,
 * before providers are probed, before the port is bound. A second daemon that
 * gets far enough to probe providers has already changed the world.
 *
 * ## Why the lock is a database rather than a pid file
 *
 * The property that matters is that the **kernel** releases it when the holder
 * dies — `SIGKILL` included, with no handler, no flush and no cleanup. A pid
 * file cannot do that: it survives its writer, and the "is that pid still
 * alive?" check it forces is racy (pids are reused) and is wrong exactly when
 * it matters. Node exposes no `flock(2)`, and the one npm package that does
 * needs `node-gyp` at install time, which NF6 forbids outright. What Node does
 * ship, already compiled and already a dependency of this package, is SQLite —
 * whose unix VFS takes ordinary `fcntl` advisory locks on the database file.
 * An open `BEGIN IMMEDIATE` holds a `RESERVED` lock for as long as the process
 * lives and not one instant longer, which is precisely `flock`'s semantics for
 * this purpose, and the second daemon's `BEGIN IMMEDIATE` fails with
 * `SQLITE_BUSY` immediately because `busy_timeout` on this connection is 0.
 *
 * ## Why acquiring is one statement, and why the pid lives beside the lock
 *
 * There is an obvious-looking design in which the holder's pid is a row in the
 * lock database, so that the daemon which loses can name the one that won. It
 * does not work, and the reason is worth writing down because it will be
 * proposed again. Publishing that row means committing it, **and a commit is
 * exactly the moment SQLite lets go of the file lock**. The acquisition then
 * has to take the lock, commit, and take it a second time to hold — and
 * between the commit and the retake it holds nothing at all. Two daemons
 * started microseconds apart (a supervisor, a container restart, a script, a
 * test harness — anything that is not a human typing in two terminals) walk
 * into that window and the results are measurable, not theoretical: the daemon
 * that acquired *first* gets locked out by the one that arrived second; both
 * fail and the user is left with no daemon at all; and the losing daemon's
 * concurrent pid read holds a `SHARED` lock that makes the winner's commit
 * fail with a raw `SqliteError: database is locked`, which is precisely the
 * leaked errno AC2 forbids. `test/integration/lease-race.test.ts` is that
 * measurement.
 *
 * So nothing is ever written into the lock file. `DeFlow.lock` stays zero
 * bytes forever; its whole job is the `fcntl` lock the kernel takes on it.
 * There is exactly **one** `BEGIN IMMEDIATE`, it is never committed and never
 * rolled back, and it *is* the lease — which also means a `SIGKILL`ed holder
 * leaves no rollback journal, because no transaction ever wrote a page.
 *
 * The pid moves to `DeFlow.lock.pid` beside it. That is not a pid file in the
 * sense the section above rejects: nothing consults it to decide whether a
 * daemon is running, and it is never trusted for liveness. It is read in one
 * place only — by a daemon that has *already* been refused the lock, and so
 * already knows a live holder exists — purely to put a number in the sentence
 * the user reads. A pid left behind by a `SIGKILL`ed holder is therefore
 * unreachable: the next daemon takes the lock rather than reading the file.
 */
import type { Db } from '@DeFlow/core';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLock } from './sqlite-db.ts';

/** The lease file, in the global data directory (docs/16-repo-layout.md §7.2). */
export const LOCK_FILE = 'DeFlow.lock';

/** Where the holder publishes its pid, for the message a losing daemon prints. */
export const HOLDER_FILE = 'DeFlow.lock.pid';

/**
 * A second DeFlowd against a data directory another one already holds (AC2).
 *
 * The message is one sentence and is the whole of what the user sees: no stack
 * trace, no `SQLITE_BUSY`, no `EWOULDBLOCK`. `pid` is the process that holds
 * the lease, so "which terminal is it in?" is answerable.
 */
export class DaemonAlreadyRunning extends Error {
  /** The pid holding the lease, or null when the lock file did not record one. */
  readonly pid: number | null;
  readonly dataDir: string;

  constructor(pid: number | null, dataDir: string) {
    super(`DeFlowd is already running (pid ${pid ?? 'unknown'}) — data dir ${dataDir}`);
    this.name = 'DaemonAlreadyRunning';
    this.pid = pid;
    this.dataDir = dataDir;
  }
}

/** A held lease. Releasing it is closing the file the kernel locked. */
export interface Lease {
  /** This process. The pid a later daemon will be told about. */
  readonly pid: number;
  /** The lock file itself, for the operator and for tests. */
  readonly file: string;
  /**
   * Releases the lease. Idempotent, and rarely called — the normal end of a
   * lease is the process exiting, which is the case that has to work anyway.
   */
  release(): void;
}

/**
 * The lock connections this process holds.
 *
 * This is a garbage-collection root, and it is load-bearing rather than
 * bookkeeping. The kernel lock lives on a file descriptor owned by a
 * better-sqlite3 `Database`, and that object has a finalizer that closes it:
 * if the only reference to it is the `Lease` this function returns, then a
 * caller who keeps `lease.pid` for a log line and lets the object go has
 * handed the lease to V8 to release at a time of its choosing. That is not a
 * hypothetical — it collects within milliseconds under a normal boot's
 * allocation rate, and a second daemon then acquires the lease of a daemon
 * that is still running, which is the whole of what AC1 forbids. Holding the
 * connection here makes the lease last exactly as long as the process, no
 * matter what the caller does with the return value.
 */
const held = new Set<Db>();

/** True for the one error that means "someone else holds it". */
function isBusy(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SQLITE_BUSY';
}

/**
 * Takes the lock, or answers false. Anything that is not contention — a
 * read-only data directory, a full disk — is rethrown as itself.
 *
 * The transaction this opens is never closed. There is no matching commit or
 * rollback anywhere in this file, and adding one would give the lease away.
 */
function take(db: Db): boolean {
  try {
    db.exec('BEGIN IMMEDIATE');
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
}

/**
 * Publishes this process's pid beside the lock, for the sentence a losing
 * daemon prints. Called only once the lock is held.
 *
 * Removed before it is rewritten, and renamed into place rather than written
 * in place, so a daemon reading it concurrently sees either nothing or a
 * complete pid — never a previous run's pid, and never half of one. "Nothing"
 * degrades to `pid unknown`, which is honest; a stale number is a lie that
 * sends the user to kill an unrelated process.
 */
function publishHolder(holderFile: string, pid: number): void {
  rmSync(holderFile, { force: true });
  const scratch = `${holderFile}.${pid}`;
  writeFileSync(scratch, `${pid}\n`);
  renameSync(scratch, holderFile);
}

/**
 * The pid published by whoever holds the lease. Null when there is nothing
 * legible there — a holder that has the lock but has not published yet, or a
 * data directory from a build that did not write the file.
 */
function readHolder(holderFile: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(holderFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the single-instance lease on `dataDir`, creating the directory if this
 * is the first ever start.
 *
 * Throws `DaemonAlreadyRunning` — and nothing else, for contention — when
 * another live process holds it. Call this **before** anything else in boot.
 */
export function acquireLease(dataDir: string): Lease {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE);
  const holderFile = join(dataDir, HOLDER_FILE);
  const db = openLock(file);

  try {
    // The one and only arbitration point in this function, and the whole of
    // the lease. Everything after it runs with the lock already held.
    if (!take(db)) throw new DaemonAlreadyRunning(readHolder(holderFile), dataDir);
    publishHolder(holderFile, process.pid);
  } catch (error) {
    db.close();
    throw error;
  }

  held.add(db);
  let holding = true;
  return {
    pid: process.pid,
    file,
    release(): void {
      if (!holding) return;
      holding = false;
      held.delete(db);
      rmSync(holderFile, { force: true });
      db.close();
    },
  };
}
