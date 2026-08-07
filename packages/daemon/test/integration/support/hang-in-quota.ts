/**
 * A daemon that suspends a node on a vendor's own quota reset and then dies
 * inside the window (EPIC-14-S23).
 *
 * The same shape as `hang-in-backoff.ts` next door and for the same reason:
 * `kill -9` is the only crash worth testing for durability, and it cannot be
 * produced from inside the parent process.
 *
 *     node hang-in-quota.ts <dataDir> <readyFile>
 *
 * Writes `readyFile` with the `wakeAt` it committed, then never returns.
 */

import type { Handle, ProviderId } from '@DeFlow/core';
import { rateLimitedFailure, seededRandom } from '@DeFlow/core';
import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import { recordNodeFailure } from '../../../src/retry.ts';
import { IMPLEMENT, RETRY_RUN, seedRetryRun, T0 } from './retry-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: hang-in-quota.ts <dataDir> <readyFile>');
}

/** Four hours out, so the crash lands unambiguously inside the suspension. */
const RESETS_AT = T0 + 4 * 3_600_000;

const RETRY = {
  maxAttempts: 3,
  backoff: { base: 2_000, cap: 300_000, jitter: 'full' },
} as const;

const db = openLedger(dataDir);
seedRetryRun(db);

const recorded = recordNodeFailure(db, {
  runId: RETRY_RUN,
  nodeId: IMPLEMENT,
  failure: rateLimitedFailure(
    {
      provider: 'claude-code' as ProviderId,
      resetsAt: RESETS_AT,
      raw: { type: 'rate_limit_event', rate_limit_info: { resetsAt: RESETS_AT / 1000 } },
    },
    {
      occurredAtEvent: 1 as never,
      attempt: 0,
      captureEvidence: (): Handle => `artifact://${'0'.repeat(64)}` as Handle,
    },
  ),
  retry: RETRY,
  epoch: 1,
  ts: T0,
  random: seededRandom(42),
});

if (recorded.wakeAt !== RESETS_AT) {
  throw new Error(`expected the wake at the vendor's reset, got ${String(recorded.wakeAt)}`);
}

writeFileSync(readyFile, JSON.stringify({ wakeAt: recorded.wakeAt }), 'utf8');

// And now: nothing. The `node_wake` row this process committed is on disk with
// a deadline four hours out, and the attempt it belongs to has not run.
setInterval(() => {}, 1_000);
