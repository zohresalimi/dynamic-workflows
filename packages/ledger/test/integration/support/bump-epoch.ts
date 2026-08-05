/**
 * One daemon life's worth of epoch bump, in a real process.
 *
 * Forked several times at once by `epoch.test.ts` to prove the
 * read-increment-persist is one atomic step: five processes racing on one
 * ledger file must produce five different epochs, and a read followed by a
 * separate write would not.
 *
 * argv[2] is the data directory. It reports the epoch it was handed over the
 * fork IPC channel and exits.
 */
import { bumpEpoch, openLedger } from '../../../src/index.ts';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('usage: bump-epoch.ts <dataDir>');

const db = openLedger(dataDir);
try {
  process.send?.({ epoch: bumpEpoch(db) });
} finally {
  db.close();
}
