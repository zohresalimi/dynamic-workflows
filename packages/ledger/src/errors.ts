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
