/**
 * What a run does *after* `DeFlow run` has submitted it, for the CLI specs that
 * have to watch one.
 *
 * ## Why this file exists at all
 *
 * `POST /api/runs` appends `task.submitted` and stops there — deliberately, per
 * KAR-10.1: *"No interpretation happens here."* What is supposed to happen next
 * is the framing interview, then the F1.3 gate, then a plan, then execution.
 * **As of KAR-18.3 nothing in the shipped daemon drives that**: no production
 * code path calls `compilePlanV1` or `executeRun`, and `boot()` starts no
 * ticker. A submitted run therefore sits at `task.submitted` for ever.
 *
 * That gap belongs to the orchestration epics, not to this one — EPIC-18 is a
 * *client* of the daemon (see the epic's "Out of scope") — so what these specs
 * do is exactly what `packages/cli/test/integration/resume-cursor.test.ts`
 * already does for KAR-15.4: append the events a daemon would, through the
 * daemon's own shipped functions, onto the daemon's own write connection, while
 * the CLI watches over a real socket. The CLI cannot tell the difference,
 * because there is none from its side of the stream — which is the whole point
 * of it being a client.
 *
 * Everything here goes through a **shipped** function (`openSpecApprovalGate`)
 * rather than hand-written rows, so a spec cannot quietly assert a shape the
 * daemon does not produce.
 */
import type { Db, RunId, TaskSpecDraft } from '@DeFlow/core';
import { openSpecApprovalGate } from '@DeFlow/daemon';
import { listRunIds, readRange } from '@DeFlow/ledger';

/** The draft an operator reviews at the F1.3 gate. Synthetic, and small. */
export const DRAFT: TaskSpecDraft = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Keep the checkout module compiling.',
  scope: { included: ['src'] },
  nonGoals: ['Do not touch anything outside src.'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'the project typechecks', verifiedBy: ['typecheck'] },
  ],
  knownFailureModes: [],
} as unknown as TaskSpecDraft;

export interface LedgerAt {
  readonly db: Db;
  readonly epoch: number;
  readonly ts: number;
}

/**
 * Opens the F1.3 spec approval gate on `runId`, the way the framing node's
 * completion does — which is what moves the reduced status to
 * `awaiting-spec-approval` and gives `--no-wait` something to exit 4 on.
 */
export function openSpecGate(runId: RunId, at: LedgerAt): void {
  openSpecApprovalGate({ db: at.db, runId, epoch: at.epoch, ts: at.ts, document: DRAFT });
}

/**
 * The one run this data directory holds, once the CLI has created it.
 *
 * Polled rather than returned by the command, because the command is still
 * running: these specs press Ctrl-C at it, drop its socket and read its
 * transcript, all of which need the run id before it has exited.
 */
export async function waitForRun(db: Db, timeoutMs = 10_000): Promise<RunId> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [runId] = listRunIds(db);
    if (runId !== undefined && readRange(db, runId, 0, 1).events.length > 0) return runId;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no run appeared in the ledger within ${timeoutMs} ms`);
}
