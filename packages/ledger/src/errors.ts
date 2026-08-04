/**
 * The ledger's typed errors.
 *
 * Typed rather than a bare `Error` because the daemon has to be able to tell
 * "you started a second DeFlowd" from "the disk is full" without matching on a
 * message string — and because the message a user sees for the first one has to
 * be a sentence about two terminals, not a SQLite code.
 */

/**
 * A second `openWrite()` for a ledger this process already has open.
 *
 * The write connection is a singleton per path per process: SQLite permits
 * exactly one writer, so a pool of write connections is a queue of connections
 * all failing with `SQLITE_BUSY` in turn, plus a much harder concurrency story.
 * There is no pool, no queue and no `acquireWriter()` — this error is what
 * stands where they would have been.
 */
export class LedgerAlreadyOpen extends Error {
  readonly file: string;

  constructor(file: string) {
    super(
      `the ledger at ${file} is already open for writing in this process. SQLite permits exactly ` +
        'one writer, so @DeFlow/ledger holds a single write connection and hands out read-only ' +
        'connections through openRead(). If this is a second DeFlowd, the flock on ' +
        'DeFlow.lock is what should have caught it first.',
    );
    this.name = 'LedgerAlreadyOpen';
    this.file = file;
  }
}

/**
 * A ledger whose `PRAGMA user_version` is higher than this binary's highest
 * shipped migration id — it was written by a newer DeFlowd.
 *
 * There is no `down` migration (docs/05-durable-execution.md §7.2), so there
 * is nothing honest this binary can do but refuse: not partially migrate, not
 * run backward, not guess. The reducer's tolerance for an unknown event
 * `kind` is what makes a *payload*-level downgrade safe; there is no
 * equivalent at the schema layer, because a write from the older binary could
 * violate a constraint it does not know about. Recovery is installing the
 * newer build, or restoring a `pre-migrate-*.db` backup taken by an earlier,
 * compatible run.
 */
export class LedgerTooNew extends Error {
  readonly ledgerVersion: number;
  readonly highestKnownMigration: number;
  readonly dataDir: string;

  constructor(ledgerVersion: number, highestKnownMigration: number, dataDir: string) {
    super(
      `this ledger's PRAGMA user_version is ${ledgerVersion}, but this build's highest shipped ` +
        `migration id is ${highestKnownMigration}. It was written by a newer DeFlowd, and there ` +
        `is no down migration to run backward, so this binary refuses to open it rather than ` +
        `guess. Install the build that wrote it, or restore ${dataDir}/pre-migrate-*.db.`,
    );
    this.name = 'LedgerTooNew';
    this.ledgerVersion = ledgerVersion;
    this.highestKnownMigration = highestKnownMigration;
    this.dataDir = dataDir;
  }
}
