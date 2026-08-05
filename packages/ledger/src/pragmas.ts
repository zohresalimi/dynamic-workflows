/**
 * The seven PRAGMAs, in the order docs/05-durable-execution.md §7.1 names, and
 * the escape hatch for the transaction that cannot afford them.
 *
 * Order is part of the specification, not an implementation detail:
 * `journal_mode` is **persistent** — it is written into the database header and
 * survives a reopen — while the other six are per-connection and are re-applied
 * every time anything opens the file. `busy_timeout` comes before anything that
 * could contend, because a connection that has not yet set it fails instantly
 * under write pressure rather than waiting.
 */
import type { Db } from '@DeFlow/core';

/**
 * The durability setting. One constant, one place, and the number that decides
 * it is recorded here rather than in a commit message.
 *
 * `NORMAL` protects against a **process crash**: the daemon can be SIGKILLed
 * mid-write and every committed row is still there. It does **not** protect
 * against power loss — the WAL is not fsynced on every commit, so a kernel
 * panic or a pulled plug can lose the most recent commits. That is stated
 * plainly in ../README.md rather than hidden behind "WAL".
 *
 * The price of the alternative, from the architecture's Linux benchmark
 * (2026-08-02): **979 ev/s at FULL against 22,982 ev/s at NORMAL — roughly a
 * 23x penalty** for one transaction per event.
 *
 * The shipping value comes from a measurement on the machine that runs it, not
 * from those Linux figures (roadmap A1-1, closed by spike S5):
 * **MacBook Mac15,4, darwin/arm64, APFS, 2026-08-04** — 10,000 events per
 * configuration, one transaction per event. There, `FULL` reads as *cheap*
 * (41,246 ev/s against NORMAL's 137,549) for a reason that inverts the
 * decision: macOS's `fsync(2)` does not flush the drive's write cache, and
 * SQLite only issues the `fcntl(F_FULLFSYNC)` that does under
 * `PRAGMA fullfsync = 1`, which is **off by default on darwin**. Turn it on and
 * the real barrier costs **335 ev/s against NORMAL's 48,143 — 144x**. So at the
 * platform default `FULL` costs 3.3x and buys nothing extra against power loss;
 * bought honestly it costs 144x. `NORMAL` globally, and `withFullSync` below
 * for the single transaction that records something genuinely irreversible.
 */
export const SYNCHRONOUS = 'NORMAL';

/**
 * Applied in this order on **every** open — the write connection and every
 * reader alike. Consumed through `Db.pragma`, so the `PRAGMA` keyword is not
 * part of these strings.
 */
export const LEDGER_PRAGMAS: readonly string[] = [
  'journal_mode = WAL', // persistent; survives reopen
  `synchronous = ${SYNCHRONOUS}`, // see the constant above for what this does and does not buy
  'busy_timeout = 5000', // before anything that could contend
  'foreign_keys = ON',
  'wal_autocheckpoint = 1000', // pages
  'journal_size_limit = 67108864', // 64 MB cap after checkpoint
  'cache_size = -32000', // 32 MB
];

/**
 * Applies them, in order.
 *
 * Worth knowing when reading a test: on the pinned better-sqlite3@13.0.2 build,
 * four of the seven are already in force before this function runs —
 * `DEFAULT_WAL_SYNCHRONOUS=1`, `DEFAULT_FOREIGN_KEYS` and
 * `DEFAULT_WAL_AUTOCHECKPOINT=1000` are compiled in, and the driver's own
 * `timeout` option sets `busy_timeout` to 5000. That is exactly why the order
 * is asserted by observing the calls against a fake rather than by reading
 * values back off a connection: a read-back proves nothing about a setting the
 * build already agreed with, and the next driver, or the next release of this
 * one, will agree with a different set.
 */
export function applyPragmas(db: Db): void {
  for (const pragma of LEDGER_PRAGMAS) db.pragma(pragma);
}

/** Whether `fullfsync` has to be raised too for `FULL` to mean anything here. */
const NEEDS_FULLFSYNC = process.platform === 'darwin';

/**
 * Runs `fn` in a transaction committed at `synchronous = FULL`, then restores
 * the connection's previous setting — including when `fn` throws.
 *
 * Reach for this **only** for a transaction that records a genuinely
 * irreversible external effect: a publish, a deploy, a push to a remote. It is
 * the one place the ledger pays for a durability guarantee the rest of the
 * daemon deliberately does not buy, and paying for it everywhere would cost the
 * factor the constant above records.
 *
 * On darwin it raises `fullfsync` as well, and that is load-bearing rather than
 * belt-and-braces: at the platform default of 0, `synchronous = FULL` on macOS
 * hands the bytes to the drive and returns without flushing its write cache, so
 * a `withFullSync` that set only `synchronous` would be decoration — measured
 * at about 3 ms per commit for the real barrier.
 */
export function withFullSync<T>(db: Db, fn: () => T): T {
  const previousSynchronous = numericPragma(db, 'synchronous');
  const previousFullFsync = NEEDS_FULLFSYNC ? numericPragma(db, 'fullfsync') : undefined;

  // Outside the transaction on purpose: SQLite ignores a `synchronous` change
  // made while one is open.
  db.pragma('synchronous = FULL');
  if (NEEDS_FULLFSYNC) db.pragma('fullfsync = 1');
  try {
    return db.transaction(fn);
  } finally {
    db.pragma(`synchronous = ${previousSynchronous}`);
    if (previousFullFsync !== undefined) db.pragma(`fullfsync = ${previousFullFsync}`);
  }
}

/**
 * Reads a pragma that must be a number, and says so if it is not.
 *
 * The restore path in `withFullSync` writes this value back, so a surprise here
 * would otherwise be interpolated into a `PRAGMA synchronous = [object Object]`
 * — a statement SQLite accepts and ignores, leaving the connection at `FULL`
 * for the rest of its life. Failing loudly is the cheaper outcome.
 */
function numericPragma(db: Db, name: string): number {
  const value = db.pragma(name);
  if (typeof value !== 'number') {
    throw new TypeError(`PRAGMA ${name} returned ${typeof value} where a number was expected`);
  }
  return value;
}
