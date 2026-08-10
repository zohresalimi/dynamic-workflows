/**
 * KAR-13.2 — two concurrent runs with something pending in each, as a real
 * ledger on disk.
 *
 * The queue's whole claim is that it is one call across runs and that it
 * survives a restart, and neither can be told apart from a lucky in-memory map
 * unless the fixture is (a) more than one run and (b) a file. So it is both.
 *
 * The events are appended directly rather than driven through the executor: the
 * queue is a projection over the log, and what is under test is the projection,
 * not the paths that happen to write those events. Every payload here is one
 * `appendEvents` validates, so a fixture that drifted from a schema fails at the
 * door rather than by producing a queue nobody can explain.
 *
 * Shared by the specs and by the child process they `SIGKILL`, so the ledger the
 * parent asserts about and the ledger the child wrote cannot drift apart.
 */
import type { Db, RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RUN_A: RunId = RunIdSchema.parse('run_20260810T093000Z_aa0001');
export const RUN_B: RunId = RunIdSchema.parse('run_20260810T093000Z_bb0002');

export const GATE_NODE = 'approve-migration';
export const T0 = 1_754_308_400_000;
export const EPOCH = 5;

export const PROMPT = 'The codemod changed 41 files. Proceed?';

export const PATCH: Record<string, unknown> = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/patches/three-ops.json', import.meta.url),
    ),
    'utf8',
  ),
);

export const PATCH_ID = String(PATCH.id);

export const QUEUE_RULE = 'escalates-permission';

const draft = (runId: RunId, kind: string, v: number, payload: unknown): EventDraft =>
  ({ runId, ts: T0, kind, v, epoch: EPOCH, payload }) as EventDraft;

/**
 * Run A: a blocking `human` node, and a patch the policy engine queued.
 *
 * Two *different* kinds in one run on purpose — the per-run count AC9 asks for
 * is only meaningful if a run can hold more than one thing.
 */
export function seedRunA(db: Db): void {
  appendEvents(db, [
    draft(RUN_A, 'human.requested', 4, {
      node: GATE_NODE,
      prompt: PROMPT,
      options: [
        { id: 'yes', label: 'Proceed', effect: 'approve' },
        { id: 'no', label: 'Stop', effect: 'reject' },
      ],
    }),
    draft(RUN_A, 'node.suspended', 1, { node: GATE_NODE, until: { kind: 'human' } }),
    draft(RUN_A, 'plan.patch.proposed', 1, { patch: PATCH }),
    draft(RUN_A, 'plan.patch.queued', 1, {
      patchId: PATCH_ID,
      rule: QUEUE_RULE,
      estimate: {
        costUsdDelta: 6.2,
        blastRadiusFiles: 140,
        maxPermission: 'worktree',
        replanDepth: 2,
      },
    }),
  ]);
}

/** Run B: F4.6's ceiling, which pauses the run rather than failing it. */
export function seedRunB(db: Db): void {
  appendEvents(db, [
    draft(RUN_B, 'budget.exceeded', 2, {
      scope: 'run',
      dimension: 'cost',
      limit: 20,
      actual: 21.4,
      failureClass: 'gate',
      firedBy: 'deflow',
      basis: {
        authMode: 'subscription',
        vendorReported: 21.4,
        estimated: null,
        estimateDriven: false,
        unaccounted: [],
      },
    }),
    draft(RUN_B, 'run.paused', 1, { by: 'policy', reason: 'the run reached its cost ceiling' }),
  ]);
}

/** Both runs, in the order the queue then reports them: B's ceiling is older. */
export function seedApprovalRuns(db: Db): void {
  seedRunB(db);
  seedRunA(db);
}

/** A noisy run's output, for the topic filter: frames `runs=*` must not carry. */
export function appendProgress(db: Db, runId: RunId, count: number): void {
  appendEvents(
    db,
    Array.from({ length: count }, (_, index) =>
      draft(runId, 'node.progress', 1, {
        node: GATE_NODE,
        attempt: 0,
        phase: 'running',
        message: `still working (${index})`,
      }),
    ),
  );
}
