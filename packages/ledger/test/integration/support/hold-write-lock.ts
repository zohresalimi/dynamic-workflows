/**
 * A real second process that opens the ledger and sits inside an open
 * `BEGIN IMMEDIATE`.
 *
 * A real process, not a second connection in the test's own process and not a
 * mocked driver: SQLite's writer exclusivity is enforced by the operating
 * system's locks on the database file, which is precisely the thing that a
 * same-process test cannot exercise honestly.
 *
 * argv[2] is the ledger path. It reports "held" over the fork IPC channel once
 * the lock is taken and the rows are written, then waits to be killed. The
 * timer is a backstop so an abandoned child cannot outlive the suite.
 */
import { openWrite } from '../../../src/index.ts';

const file = process.argv[2];
if (file === undefined) throw new Error('usage: hold-write-lock.ts <ledger.db>');

const db = openWrite(file);
db.exec('BEGIN IMMEDIATE');
const insert = db.prepare('INSERT INTO fixture (label) VALUES (?)');
for (let i = 0; i < 100; i += 1) insert.run(`inside-txn-${i}`);

process.send?.('held');

// Never reached in a passing run — the parent kills this process. 60 s is
// twice the integration slice's timeout, so it cannot mask a hang either.
setTimeout(() => {
  db.exec('ROLLBACK');
  db.close();
}, 60_000);
