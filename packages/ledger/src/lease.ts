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
 * The pid is committed *before* the held transaction is re-taken, which is why
 * the holder's pid is readable by the daemon that fails: `RESERVED` blocks
 * writers, not readers. Nothing is written inside the held transaction, so a
 * `SIGKILL`ed holder leaves no journal to roll back and the next start needs
 * no manual cleanup.
 */
import type { Db } from '@DeFlow/core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openLock } from './sqlite-db.ts';

/** The lease file, in the global data directory (docs/16-repo-layout.md §7.2). */
export const LOCK_FILE = 'DeFlow.lock';

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

const CREATE_LEASE = `CREATE TABLE IF NOT EXISTS lease (
    id  INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL
  ) STRICT`;

const CLAIM = `INSERT INTO lease (id, pid) VALUES (1, ?)
  ON CONFLICT(id) DO UPDATE SET pid = excluded.pid`;

const HOLDER = 'SELECT pid FROM lease WHERE id = ?';

/** True for the one error that means "someone else holds it". */
function isBusy(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SQLITE_BUSY';
}

/**
 * Takes the lock, or answers false. Anything that is not contention — a
 * read-only data directory, a full disk — is rethrown as itself.
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
 * The pid recorded by whoever holds the lease. Null when the row is not there
 * to be read — a lock file abandoned mid-creation, or one written by a build
 * that did not record it.
 */
function holderPid(db: Db): number | null {
  try {
    return db.prepare<{ pid: number }>(HOLDER).get(1)?.pid ?? null;
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
  const db = openLock(file);

  try {
    if (!take(db)) throw new DaemonAlreadyRunning(holderPid(db), dataDir);

    // Committed rather than held, so the *next* daemon can read the pid it
    // has to name. Readers are not blocked by a RESERVED lock; they are
    // blocked by an uncommitted row.
    db.exec(CREATE_LEASE);
    db.prepare(CLAIM).run(process.pid);
    db.exec('COMMIT');

    // And re-taken, to hold for the lifetime of this process. The gap between
    // the two is one statement wide: a daemon that wins it takes the lease and
    // this one fails here instead, which is the same outcome an instant later
    // and never two holders.
    if (!take(db)) throw new DaemonAlreadyRunning(holderPid(db), dataDir);
  } catch (error) {
    db.close();
    throw error;
  }

  let held = true;
  return {
    pid: process.pid,
    file,
    release(): void {
      if (!held) return;
      held = false;
      db.close();
    },
  };
}
