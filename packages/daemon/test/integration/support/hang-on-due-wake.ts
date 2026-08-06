/**
 * A daemon that finds a due wake and then dies before doing anything about it
 * (EPIC-06-S22 scenario 5).
 *
 * The window under test is the one between the `SELECT` and the append that
 * consumes what it returned. It cannot be produced from inside the parent
 * process — `kill -9` is the only crash worth testing, since SIGTERM tests the
 * shutdown handler and this is about durability — so it is produced here, in a
 * real process that reaches exactly that point and then hangs forever.
 *
 *     node hang-on-due-wake.ts <dataDir> <readyFile> <now>
 *
 * Writes `readyFile` with the node ids it found due, then never returns. The
 * parent SIGKILLs it and reopens the same ledger file.
 */
import { dueWakes, openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import { GATE_RUN, seedGateRun } from './gate-run.ts';

const [dataDir, readyFile, nowArg] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined || nowArg === undefined) {
  throw new Error('usage: hang-on-due-wake.ts <dataDir> <readyFile> <now>');
}

const db = openLedger(dataDir);
seedGateRun(db);

// The scheduler's own restatement of the wait, exactly as a tick would write
// it — the row is the wait, so it has to exist before this process can crash
// "mid-wait" in any meaningful sense.
db.prepare(
  `INSERT INTO node_wake (run_id, node_id, wake_at, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (run_id, node_id) DO UPDATE SET wake_at = excluded.wake_at, reason = excluded.reason`,
).run(GATE_RUN, 'approve-scope', Number(nowArg), 'human_gate');

const due = dueWakes(db, Number(nowArg));
writeFileSync(readyFile, JSON.stringify(due.map((row) => row.nodeId)), 'utf8');

// And now: nothing. No append, no delete, no close. The row this process just
// read as due is still on disk, and the event that would have consumed it does
// not exist. That is the crash the parent is about to cause.
setInterval(() => {}, 1_000);
