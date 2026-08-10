/**
 * A daemon that has a permission escalation outstanding and a `human` node
 * suspended, and then never returns (EPIC-13-S28).
 *
 *     node hang-with-escalation.ts <dataDir> <readyFile>
 *
 * Writes `readyFile` once both waits are on disk, then hangs forever. The
 * parent `SIGKILL`s it — no cleanup, no flush, no handlers — and runs a real
 * `recover()` over the same directory.
 *
 * It has to be a real process for the same reason ./hang-at-human-gate.ts does:
 * there is no way to ask a process to be killed that rudely from inside itself,
 * and `SIGTERM` would test the shutdown handler rather than durability.
 *
 * The two waits are deliberately in the *same run*, because the whole point of
 * S28 is the distinction between them: a `human` gate needs nothing but a row
 * and must survive; a permission escalation is bound to a live ACP session and
 * cannot.
 */
import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import { seedEscalationRun } from './escalation-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: hang-with-escalation.ts <dataDir> <readyFile>');
}

const db = openLedger(dataDir);
seedEscalationRun(db);

writeFileSync(readyFile, JSON.stringify({ seeded: true }), 'utf8');

// And now: nothing. Whatever is on disk at this moment is what the parent gets.
setInterval(() => {}, 1_000);
