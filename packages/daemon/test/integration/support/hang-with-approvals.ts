/**
 * A daemon that opens two runs with three pending decisions between them and
 * then never returns (KAR-13.2 AC4, EPIC-13-S15).
 *
 *     node hang-with-approvals.ts <dataDir> <readyFile>
 *
 * Writes the queue it produced into `readyFile` — as the `[runId, kind, seq]`
 * triples the parent compares against — and then hangs forever. The parent
 * `SIGKILL`s it, opens the same `.DeFlow/` directory with a fresh process, and
 * asserts the queue is the same one, item for item and seq for seq.
 *
 * It has to be a real process: there is no way to ask a process to be killed
 * that rudely from inside itself, and `SIGTERM` would test the shutdown handler
 * rather than durability, which is the only thing this is about
 * (docs/14-testing-strategy.md §11).
 */
import type { RunId } from '@DeFlow/core';
import { approvalsProjection } from '@DeFlow/core';
import { openLedger, pendingPatchApprovals, readTaintedNodes, replayRun } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import { RUN_A, RUN_B, seedApprovalRuns } from './approval-queue-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: hang-with-approvals.ts <dataDir> <readyFile>');
}

const db = openLedger(dataDir);
seedApprovalRuns(db);

const { items } = approvalsProjection(
  [RUN_B, RUN_A].map((runId: RunId) => ({
    runId,
    state: replayRun(db, runId).state,
    patches: pendingPatchApprovals(db, runId),
    taints: readTaintedNodes(db, runId),
  })),
);

writeFileSync(
  readyFile,
  JSON.stringify(items.map((item) => [item.runId, item.kind, item.seq])),
  'utf8',
);

// And now: nothing. No close, no checkpoint, no flush. Whatever is on disk at
// this moment is what the parent gets back.
setInterval(() => {}, 1_000);
