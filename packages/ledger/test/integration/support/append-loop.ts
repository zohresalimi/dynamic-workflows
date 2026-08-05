/**
 * A real process that appends to a real ledger in a tight loop until something
 * kills it (EPIC-03-S24).
 *
 * A separate process rather than a loop in the spec, because the thing under
 * test is `SIGKILL`: no handler, no flush, no `close()`, no `finally`. There is
 * no way to ask a process to be killed *that* rudely from inside itself, and a
 * simulated crash that runs any cleanup at all is testing the cleanup.
 *
 * Progress is reported by rewriting a small file with `writeFileSync` rather
 * than by writing to stdout. Stdout to a pipe is asynchronous — a number
 * written there may still be sitting in a buffer when the signal lands, which
 * would make the parent's "it had committed at least N rows" a claim about a
 * buffer instead of about the database. `writeFileSync` has returned only once
 * the write reached the file.
 *
 *   argv[2]  the data directory
 *   argv[3]  the progress file: the committed row count, rewritten per batch
 *   argv[4]  rows per transaction
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { writeFileSync } from 'node:fs';
import { type EventDraft, openLedger, RunCheckpointer } from '../../../src/index.ts';

const [, , dataDir, progressFile, batchSizeArgument] = process.argv;
if (dataDir === undefined || progressFile === undefined || batchSizeArgument === undefined) {
  throw new Error('usage: append-loop.ts <dataDir> <progressFile> <batchSize>');
}
const batchSize = Number.parseInt(batchSizeArgument, 10);

const RUN = RunIdSchema.parse('run_20260805T090000Z_5c1d2e');
const NODE = NodeIdSchema.parse('step-01');
const START_TS = 1_754_308_293_000;

const db = openLedger(dataDir);
// Through a checkpointer, so the cache is written in the same transaction as
// the rows it covers and the crash lands on the pair — which is what makes
// `run.last_seq <= max(event.seq)` an observation rather than a hope.
const checkpointer = new RunCheckpointer(db, RUN, { interval: batchSize });

let committed = 0;
for (;;) {
  const drafts: EventDraft[] = Array.from({ length: batchSize }, (_unused, index) => ({
    runId: RUN,
    ts: START_TS + committed + index,
    kind: 'node.progress',
    v: 1,
    epoch: 1,
    nodeId: NODE,
    attempt: 0,
    payload: { node: NODE, attempt: 0, phase: 'tool-use' },
  }));

  checkpointer.append(drafts);
  committed += batchSize;
  writeFileSync(progressFile, String(committed));
}
