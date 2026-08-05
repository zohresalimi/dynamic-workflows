/**
 * A daemon that records a transient failure, schedules the backoff, and then
 * dies inside the window (EPIC-06-S20 scenario 3).
 *
 * The window under test is the one between "the retry is scheduled" and "the
 * retry fires". It cannot be produced from inside the parent process — `kill
 * -9` is the only crash worth testing, since SIGTERM tests the shutdown handler
 * and this is about durability — so it is produced here, in a real process that
 * reaches exactly that point and then hangs forever.
 *
 *     node hang-in-backoff.ts <dataDir> <readyFile>
 *
 * Writes `readyFile` with the `wakeAt` and `nextAttempt` it committed, then
 * never returns. The parent SIGKILLs it and reopens the same ledger file.
 */
import { seededRandom } from '@DeFlow/core';
import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import { recordNodeFailure } from '../../../src/retry.ts';
import { classified, IMPLEMENT, RETRY_RUN, seedRetryRun, T0 } from './retry-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: hang-in-backoff.ts <dataDir> <readyFile>');
}

/**
 * A four-hundred-second window, so the crash lands unambiguously *inside* the
 * backoff rather than racing its own deadline. Everything else — full jitter,
 * one draw from the injected generator — is the production path.
 */
const LONG_BACKOFF = {
  maxAttempts: 3,
  backoff: { base: 400_000, cap: 400_000, jitter: 'full' },
} as const;

const db = openLedger(dataDir);
seedRetryRun(db);

const recorded = recordNodeFailure(db, {
  runId: RETRY_RUN,
  nodeId: IMPLEMENT,
  failure: classified('provider.rate-limited', 'transient'),
  retry: LONG_BACKOFF,
  epoch: 1,
  ts: T0,
  random: seededRandom(42),
});

if (recorded.plan.action !== 'retry') {
  throw new Error(`expected a retry, got ${recorded.plan.action}`);
}

writeFileSync(
  readyFile,
  JSON.stringify({ wakeAt: recorded.plan.wakeAt, nextAttempt: recorded.plan.nextAttempt }),
  'utf8',
);

// And now: nothing. No further append, no close. The wake row this process
// committed is on disk with its deadline still in the future, and the attempt
// it belongs to has not run. That is the crash the parent is about to cause.
setInterval(() => {}, 1_000);
