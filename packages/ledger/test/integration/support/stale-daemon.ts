/**
 * Daemon A of EPIC-03-S22: a second daemon that got past the lease it should
 * never have got past — a stale lock file on a network mount, a
 * debugger-suspended process, a container restart that inherited the file.
 *
 * It deliberately does **not** call `acquireLease`. That is the whole point of
 * the scenario: the epoch is the belt to `flock`'s braces, and a test that
 * relied on the lock would prove nothing about it.
 *
 * argv[2] is the data directory. It reports the epoch it booted at, then
 * appends one event per `append` message and reports what happened. It never
 * retries a rejected append — `attempts` is the count the parent asserts on.
 */
import { appendEvents, bumpEpoch, openLedger, StaleEpoch } from '../../../src/index.ts';
import { draft } from './events.ts';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('usage: stale-daemon.ts <dataDir>');

const db = openLedger(dataDir);
const epoch = bumpEpoch(db);
let attempts = 0;

process.on('message', (message: { append?: number; stop?: true }) => {
  if (message.stop === true) {
    db.close();
    process.exit(0);
  }
  if (message.append === undefined) return;

  attempts += 1;
  try {
    const [seq] = appendEvents(db, [
      { ...draft({ epoch }), payload: { from: 'A', ordinal: message.append } },
    ]);
    process.send?.({ ok: true, seq, attempts });
  } catch (error) {
    process.send?.({
      ok: false,
      attempts,
      name: (error as Error).name,
      stale: error instanceof StaleEpoch,
      epoch: error instanceof StaleEpoch ? error.epoch : null,
      currentEpoch: error instanceof StaleEpoch ? error.currentEpoch : null,
    });
  }
});

process.send?.({ booted: true, epoch });
