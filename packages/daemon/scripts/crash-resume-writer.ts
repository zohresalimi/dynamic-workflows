/**
 * The child that dies mid-write, so the `crash-resume-seq-gap` fixture is a
 * crash rather than a description of one.
 *
 *     node crash-resume-writer.ts <dataDir>
 *
 * It appends a scripted interleaving of **two** runs into one ledger — which is
 * where the gap comes from, since `event` is a single global `AUTOINCREMENT`
 * sequence keyed by `run_id` (docs/11-api-and-realtime.md §4.2) — announces the
 * last event of the run under test on stdout, and then keeps writing until
 * somebody kills it. `kill -9` is the only crash worth building a durability
 * fixture from, and there is no way to ask for one from inside the process
 * being killed, which is why this is a separate file.
 *
 * Every write goes through `appendEvents`, so the fixture is written by the
 * production path: a hand-built INSERT would drift from what DeFlow actually
 * commits the first time the envelope changes.
 */
import type { RunId } from '@DeFlow/core';
import { appendEvents, bumpEpoch, type EventDraft, openLedger } from '@DeFlow/ledger';
import { CRASH_RESUME_OTHER_RUN, CRASH_RESUME_RUN } from './crash-resume-runs.ts';

const dataDir = process.argv.slice(2).at(0) ?? '';
if (dataDir === '') throw new Error('usage: crash-resume-writer.ts <dataDir>');

/** Fixed, so the fixture is byte-stable apart from what the crash decides. */
const T0 = 1_754_308_400_000;

const db = openLedger(dataDir);
const epoch = bumpEpoch(db);

let ordinal = 0;
const progress = (runId: RunId, phase: string): EventDraft => {
  ordinal += 1;
  return {
    runId,
    ts: T0 + ordinal,
    kind: 'node.progress',
    v: 1,
    epoch,
    payload: { node: 'impl', attempt: 1, phase, message: `step ${ordinal}` },
  };
};

const write = (runId: RunId, count: number, phase: string): number[] =>
  appendEvents(
    db,
    Array.from({ length: count }, () => progress(runId, phase)),
  );

// 1,2,3 → 4,5 → 6 → 7,8 → 9,10 → 11. The run under test therefore commits
// 4, 5, 7, 8, 11, and every hole in it is a row belonging to the other run.
write(CRASH_RESUME_OTHER_RUN, 3, 'starting');
write(CRASH_RESUME_RUN, 2, 'starting');
write(CRASH_RESUME_OTHER_RUN, 1, 'running');
write(CRASH_RESUME_RUN, 2, 'running');
write(CRASH_RESUME_OTHER_RUN, 2, 'running');
const last = write(CRASH_RESUME_RUN, 1, 'running');

process.stdout.write(`committed ${String(last[0])}\n`);

/**
 * Still writing when the knife lands.
 *
 * The crash has to interrupt a *working* daemon for the fixture to be honest —
 * a process killed while idle proves nothing about what a commit boundary
 * survives — so this appends to the other run until the parent kills the group.
 * Synchronous and unthrottled: `better-sqlite3` is synchronous, and this loop
 * yielding to the event loop between batches is what lets the signal arrive.
 */
setInterval(() => {
  write(CRASH_RESUME_OTHER_RUN, 1, 'running');
}, 1);
