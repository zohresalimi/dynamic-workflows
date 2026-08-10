/**
 * KAR-13.2 test plan #7, #8 — answering a queued patch, and the two `409`s.
 *
 * Integration, over a file-backed ledger, because both conflicts are questions
 * about *what else the log says* — the policy timer applied something while the
 * panel was open, or another tab answered first — and neither can be produced
 * without a real second write landing between the render and the decision.
 *
 * Verifies: EPIC-13-S13, EPIC-13-S14 · AC6, AC7
 */
import type { Db, PlanPatch, RunId } from '@DeFlow/core';
import { appendEvents, headSeq, openLedger, pendingPatchApprovals } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { decideQueuedPatch } from '../../src/human/patch-decision.ts';
import { EPOCH, GATE_NODE, PATCH_ID, RUN_A, seedRunA, T0 } from './support/approval-queue-run.ts';

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const NEXT_HASH = `sha256-${'b'.repeat(64)}`;

/** A ledger holding run A's queued patch and nothing else. */
function ledger(tmp: string): Db {
  const db = openLedger(tmp);
  seedRunA(db);
  return db;
}

/** Twenty progress frames: a head that advanced without changing anything. */
function progress(db: Db, runId: RunId, count: number): void {
  appendEvents(
    db,
    Array.from({ length: count }, (_, index) => ({
      runId,
      ts: T0 + index,
      kind: 'node.progress',
      v: 1,
      epoch: EPOCH,
      payload: { node: GATE_NODE, attempt: 0, phase: 'running', message: `working ${index}` },
    })),
  );
}

/** The policy timer, applying a *different* patch while the panel was open. */
function autoApplyAnotherPatch(db: Db, runId: RunId): void {
  appendEvents(db, [
    {
      runId,
      ts: T0 + 1,
      kind: 'plan.patched',
      v: 2,
      epoch: EPOCH,
      payload: {
        version: 2,
        fromHash: PLAN_HASH,
        toHash: NEXT_HASH,
        patchId: 'patch-somebody-else',
        decision: {
          decision: 'auto',
          by: 'policy',
          rule: 'small-blast-radius',
          at: '2026-08-10T09:00:00.000Z',
        },
        proposedBy: 'planner',
      },
    },
  ]);
}

/** An `apply` port that stands in for KAR-11.3's commit and records the call. */
function applier(
  db: Db,
  runId: RunId,
): {
  apply: (request: {
    patch: PlanPatch;
  }) => Promise<{ seq: number; planHash: string; version: number }>;
  calls: PlanPatch[];
} {
  const calls: PlanPatch[] = [];
  return {
    calls,
    apply: (request) => {
      calls.push(request.patch);
      const [seq] = appendEvents(db, [
        {
          runId,
          ts: T0 + 2,
          kind: 'plan.patched',
          v: 2,
          epoch: EPOCH,
          payload: {
            version: 2,
            fromHash: PLAN_HASH,
            toHash: NEXT_HASH,
            patchId: request.patch.id,
            decision: {
              decision: 'approved',
              by: 'human',
              rule: 'approved-by-operator',
              at: '2026-08-10T09:00:00.000Z',
            },
            proposedBy: 'planner',
          },
        },
      ]);
      if (seq === undefined) throw new Error('the fake applier appended nothing');
      return Promise.resolve({ seq, planHash: NEXT_HASH, version: 2 });
    },
  };
}

const decide = (
  db: Db,
  overrides: Partial<Parameters<typeof decideQueuedPatch>[0]> = {},
): ReturnType<typeof decideQueuedPatch> =>
  decideQueuedPatch({
    db,
    runId: RUN_A,
    patchId: PATCH_ID,
    decision: 'approve',
    ts: T0 + 10,
    epoch: EPOCH,
    ...overrides,
  });

suite('EPIC-13-S13 — the panel went stale while the Operator was reading (AC6)', () => {
  it('409s a decision whose cursor predates a change to the decision surface', async ({ tmp }) => {
    const db = ledger(tmp);
    try {
      const cursor = headSeq(db);
      autoApplyAnotherPatch(db, RUN_A);

      const { apply, calls } = applier(db, RUN_A);
      const result = await decide(db, { ifLastSeq: cursor, apply });

      expect(result).toMatchObject({ status: 'conflict', http: 409, code: 'stale_cursor' });
      // …carrying the current head, so the client re-hydrates from its cursor.
      if (result.status === 'conflict' && result.code === 'stale_cursor') {
        expect(result.head).toBe(headSeq(db));
        expect(result.movedAt).toBeGreaterThan(cursor);
      }

      // And nothing was applied.
      expect(calls).toEqual([]);
      expect(pendingPatchApprovals(db, RUN_A).map((entry) => entry.patchId)).toEqual([PATCH_ID]);
    } finally {
      db.close();
    }
  });

  it('accepts a decision whose cursor only predates twenty node.progress frames', async ({
    tmp,
  }) => {
    const db = ledger(tmp);
    try {
      const cursor = headSeq(db);
      progress(db, RUN_A, 20);
      expect(headSeq(db)).toBe(cursor + 20);

      const { apply, calls } = applier(db, RUN_A);
      const result = await decide(db, { ifLastSeq: cursor, apply });

      // A 409 on every progress frame would train the Operator to retry blindly.
      expect(result).toMatchObject({ status: 'ok', http: 200, decision: 'approve' });
      expect(calls.map((patch) => patch.id)).toEqual([PATCH_ID]);
    } finally {
      db.close();
    }
  });

  it('accepts a write that carries no ifLastSeq at all, on current state', async ({ tmp }) => {
    const db = ledger(tmp);
    try {
      const { apply } = applier(db, RUN_A);
      const result = await decide(db, { apply });
      expect(result).toMatchObject({ status: 'ok', http: 200 });
      if (result.status === 'ok') expect(result.seq).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-13-S14 — an already-decided patch answers with what happened (AC7)', () => {
  it('409s the second tab with the original decision, and patches the plan once', async ({
    tmp,
  }) => {
    const db = ledger(tmp);
    try {
      const { apply, calls } = applier(db, RUN_A);

      const tabA = await decide(db, { apply });
      expect(tabA).toMatchObject({ status: 'ok', decision: 'approve' });

      const tabB = await decide(db, { decision: 'reject', apply });
      expect(tabB).toMatchObject({
        status: 'conflict',
        http: 409,
        code: 'patch_already_decided',
      });
      if (tabB.status === 'conflict' && tabB.code === 'patch_already_decided') {
        expect(tabB.original).toMatchObject({ decision: 'approved', by: 'human' });
        expect(tabB.original.seq).toBeGreaterThan(0);
      }

      // Exactly once. The second decision is reported, never applied.
      expect(calls).toHaveLength(1);
      expect(patchedCount(db, RUN_A)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps a policy-rejected patch answerable — a rejection is not a dead end', async ({
    tmp,
  }) => {
    const db = ledger(tmp);
    try {
      appendEvents(db, [
        {
          runId: RUN_A,
          ts: T0 + 1,
          kind: 'plan.patch.rejected',
          v: 2,
          epoch: EPOCH,
          payload: { patchId: PATCH_ID, rule: 'replan-depth-exceeded', by: 'policy' },
        },
      ]);

      // Still in the queue, with the rule that refused it…
      expect(pendingPatchApprovals(db, RUN_A)).toMatchObject([
        { patchId: PATCH_ID, status: 'rejected', rule: 'replan-depth-exceeded', by: 'policy' },
      ]);

      // …and the Operator may still approve it explicitly.
      const { apply, calls } = applier(db, RUN_A);
      const result = await decide(db, { apply });
      expect(result).toMatchObject({ status: 'ok', decision: 'approve' });
      expect(calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('closes the patch once a human rejects it, and echoes that rejection after', async ({
    tmp,
  }) => {
    const db = ledger(tmp);
    try {
      const rejected = await decide(db, { decision: 'reject', reason: 'not this sprint' });
      expect(rejected).toMatchObject({ status: 'ok', decision: 'reject' });

      const again = await decide(db, { decision: 'approve', apply: applier(db, RUN_A).apply });
      expect(again).toMatchObject({ status: 'conflict', code: 'patch_already_decided' });
      if (again.status === 'conflict' && again.code === 'patch_already_decided') {
        expect(again.original).toMatchObject({ decision: 'rejected', by: 'human' });
      }
    } finally {
      db.close();
    }
  });

  it('404s a patch this run never proposed', async ({ tmp }) => {
    const db = ledger(tmp);
    try {
      const result = await decide(db, { patchId: 'patch-nobody-proposed' });
      expect(result).toMatchObject({ status: 'refused', http: 404, code: 'patch_not_found' });
    } finally {
      db.close();
    }
  });

  it('refuses an approval it has no way to apply rather than recording a lie', async ({ tmp }) => {
    const db = ledger(tmp);
    try {
      const result = await decide(db);
      expect(result).toMatchObject({ status: 'refused', http: 422, code: 'apply_unavailable' });
      // The patch is still answerable, and nothing claims it landed.
      expect(pendingPatchApprovals(db, RUN_A)).toHaveLength(1);
      expect(patchedCount(db, RUN_A)).toBe(0);
    } finally {
      db.close();
    }
  });
});

function patchedCount(db: Db, runId: RunId): number {
  const row = db
    .prepare<{ n: number }>(
      "SELECT COUNT(*) AS n FROM event WHERE run_id = ? AND kind = 'plan.patched'",
    )
    .get(runId);
  return row?.n ?? 0;
}
