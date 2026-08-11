/**
 * KAR-17.2 AC1 — the half of the scrubber's rail that is **not** a version.
 *
 * Verifies: EPIC-17-S9 · KAR-17.2 AC1
 *
 * > *"the proposal is recorded even when it was refused"*
 *
 * `listPlanVersions` next door answers *"what versions exist"*, and it cannot
 * answer this: a patch that was refused never produced a version, so it is
 * invisible to a rail built from `plan.proposed`. And it is the most
 * interesting mark on the rail — a planner that proposed the same widening
 * three times and was refused three times is a diagnosable pattern, and it is
 * a pattern nobody can see if only applied patches are shown.
 *
 * One bounded statement over `event`, like the version rail beside it: a
 * nine-hour run with forty replans and a dozen refusals costs fifty-two rows
 * rather than forty thousand folded events.
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { appendEvents, listPlanPatches, openLedger } from '../../src/index.ts';
import { draft, RUN_A, RUN_B } from './support/events.ts';

const proposal = (id: string, reason: string, runId = RUN_A) =>
  draft({
    runId,
    kind: 'plan.patch.proposed',
    v: 1,
    payload: {
      patch: {
        id,
        reason,
        proposedBy: 'planner',
        ops: [{ op: 'insert-nodes', nodes: [], edges: [] }],
      },
    },
  });

const applied = (id: string, version: number, decision: string, by: string) =>
  draft({
    runId: RUN_A,
    kind: 'plan.patched',
    v: 2,
    payload: {
      version,
      fromHash: `sha256-${'a'.repeat(64)}`,
      toHash: `sha256-${'b'.repeat(64)}`,
      patchId: id,
      decision: { decision, by, rule: 'adds-no-write-capability', at: '2026-08-11T09:00:00.000Z' },
    },
  });

const refused = (id: string, rule: string, by: string) =>
  draft({
    runId: RUN_A,
    kind: 'plan.patch.rejected',
    v: 1,
    payload: { patchId: id, rule, by, diagnostics: [] },
  });

const queued = (id: string, rule: string) =>
  draft({
    runId: RUN_A,
    kind: 'plan.patch.queued',
    v: 1,
    payload: {
      patchId: id,
      rule,
      estimate: {
        costUsdDelta: 1.5,
        blastRadiusFiles: 14,
        maxPermission: 'worktree+net',
        replanDepth: 1,
      },
    },
  });

suite('KAR-17.2 AC1 — every proposal, with what became of it', () => {
  it('reports a refused proposal, which no version rail can', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        proposal('p-widen', 'the payment step needs the shared money helper'),
        refused('p-widen', 'escalates-permission', 'policy'),
      ]);

      const rail = listPlanPatches(db, RUN_A, 50);

      expect(rail).toHaveLength(1);
      expect(rail[0]).toMatchObject({
        patchId: 'p-widen',
        outcome: 'rejected',
        rule: 'escalates-permission',
        by: 'policy',
        // Verbatim, never summarised: the reason is the whole diagnostic value.
        reason: 'the payment step needs the shared money helper',
        proposedBy: 'planner',
      });
      // NF10: the mark deep-links to both events that made it.
      expect(rail[0]?.seq).toBeGreaterThan(0);
      expect(rail[0]?.decidedSeq).toBeGreaterThan(rail[0]?.seq ?? 0);
    } finally {
      db.close();
    }
  });

  it('reports an applied proposal with the version it produced', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        proposal('p-insert', 'a security review is required before checkout ships'),
        applied('p-insert', 2, 'auto', 'policy'),
      ]);

      expect(listPlanPatches(db, RUN_A, 50)[0]).toMatchObject({
        patchId: 'p-insert',
        outcome: 'applied',
        version: 2,
        decision: 'auto',
        by: 'policy',
      });
    } finally {
      db.close();
    }
  });

  it('reports a proposal a human approved as approved, not as auto', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        proposal('p-split', 'two independent changes'),
        applied('p-split', 3, 'approved', 'human'),
      ]);

      expect(listPlanPatches(db, RUN_A, 50)[0]).toMatchObject({
        outcome: 'applied',
        decision: 'approved',
        by: 'human',
      });
    } finally {
      db.close();
    }
  });

  it('reports a proposal still waiting on a human as queued', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        proposal('p-wait', 'widen the blast radius'),
        queued('p-wait', 'blast-radius > 12 files'),
      ]);

      expect(listPlanPatches(db, RUN_A, 50)[0]).toMatchObject({
        outcome: 'queued',
        rule: 'blast-radius > 12 files',
      });
    } finally {
      db.close();
    }
  });

  it('reports a proposal nothing has decided yet as pending, rather than dropping it', ({
    tmp,
  }) => {
    // The window between the proposal and the policy engine's answer is real,
    // and a rail that showed nothing there would blink a mark into existence.
    const db = openLedger(tmp);
    try {
      appendEvents(db, [proposal('p-open', 'still being judged')]);

      expect(listPlanPatches(db, RUN_A, 50)[0]).toMatchObject({
        outcome: 'pending',
        rule: null,
        by: null,
      });
    } finally {
      db.close();
    }
  });

  it('keeps them in seq order and never crosses runs', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        proposal('p-1', 'first'),
        applied('p-1', 2, 'auto', 'policy'),
        proposal('p-other', 'another run entirely', RUN_B),
        proposal('p-2', 'second'),
        refused('p-2', 'escalates-permission', 'policy'),
      ]);

      const rail = listPlanPatches(db, RUN_A, 50);

      expect(rail.map((row) => row.patchId)).toEqual(['p-1', 'p-2']);
    } finally {
      db.close();
    }
  });

  it('is bounded, because a looping planner is exactly when this list is long', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(
        db,
        Array.from({ length: 12 }, (_unused, index) => proposal(`p-${index}`, 'again')),
      );

      expect(listPlanPatches(db, RUN_A, 5)).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it('refuses a limit that is not a positive integer, rather than scanning the log', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => listPlanPatches(db, RUN_A, 0)).toThrow(RangeError);
    } finally {
      db.close();
    }
  });
});
