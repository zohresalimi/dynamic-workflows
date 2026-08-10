/**
 * KAR-15.6 AC1 — the version rail's own query: every plan version this run
 * proposed, in version order, with the `seq` that proposed it.
 *
 * The scrubber in EPIC-17 renders one tick per row of this, so it has to be a
 * single bounded statement over `event` rather than a replay: a nine-hour run
 * with forty replans should cost forty rows, not forty thousand events folded
 * to find them.
 *
 * Verifies: EPIC-15-S39 · KAR-15.6 AC1 · test plan #3
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { appendEvents, listPlanVersions, openLedger } from '../../src/index.ts';
import { draft, RUN_A, RUN_B } from './support/events.ts';

const proposed = (version: number, hash: string, runId = RUN_A) =>
  draft({
    runId,
    kind: 'plan.proposed',
    v: 2,
    payload: {
      version,
      planHash: hash,
      graph: { version },
      by: 'planner',
      planner: { model: 'm', effort: 'max', tier: 'strongest' },
    },
  });

suite('the plan version rail (AC1)', () => {
  it('lists every proposed version of one run in version order', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        proposed(1, `sha256-${'a'.repeat(64)}`),
        proposed(2, `sha256-${'b'.repeat(64)}`),
        proposed(1, `sha256-${'c'.repeat(64)}`, RUN_B),
        proposed(3, `sha256-${'d'.repeat(64)}`),
      ]);

      const rail = listPlanVersions(db, RUN_A, 50);

      expect(rail.map((row) => row.version)).toEqual([1, 2, 3]);
      expect(rail.map((row) => row.planHash)).toEqual([
        `sha256-${'a'.repeat(64)}`,
        `sha256-${'b'.repeat(64)}`,
        `sha256-${'d'.repeat(64)}`,
      ]);
      // NF10: every row deep-links to the event that proposed it.
      expect(rail.every((row) => row.seq > 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('keeps the first proposal of a version when two proposers raced', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        proposed(1, `sha256-${'a'.repeat(64)}`),
        // KAR-11.3 AC10: two rival proposers both compose a v2. One is applied;
        // the rail is a list of versions, so it must not show v2 twice.
        proposed(2, `sha256-${'b'.repeat(64)}`),
        proposed(2, `sha256-${'e'.repeat(64)}`),
      ]);

      const rail = listPlanVersions(db, RUN_A, 50);

      expect(rail.map((row) => row.version)).toEqual([1, 2]);
      expect(rail[1]?.planHash).toBe(`sha256-${'b'.repeat(64)}`);
    } finally {
      db.close();
    }
  });

  it('is bounded, and answers with the earliest versions when it is truncated', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(
        db,
        Array.from({ length: 12 }, (_unused, index) =>
          proposed(index + 1, `sha256-${String(index).padStart(64, '0')}`),
        ),
      );

      expect(listPlanVersions(db, RUN_A, 5).map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      db.close();
    }
  });
});
