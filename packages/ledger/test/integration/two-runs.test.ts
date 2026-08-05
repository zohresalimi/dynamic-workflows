/**
 * KAR-03.3 — one global ledger keyed by `run_id` (EPIC-03-S10).
 *
 * docs/16-repo-layout.md §7.2 records this as a deliberate deviation from the
 * PRD §9.4 sketch, which put `ledger.db` under `.DeFlow/runs/<runId>/`: the
 * schema is keyed by `run_id` throughout, cross-run features (project memory,
 * plan templates, the cross-run dashboard, FTS5 retrieval over prior runs) need
 * one queryable store, and a per-run database would put a binary
 * WAL-journalled file inside a git repository.
 *
 * Verifies: EPIC-03-S10 · AC5
 */

import { it } from '@DeFlow/testkit';
import { readdirSync } from 'node:fs';
import { expect, describe as suite } from 'vitest';
import { appendEvents, openLedger, readRange } from '../../src/index.ts';
import { draft, RUN_A, RUN_B } from './support/events.ts';

suite('interleaved appends stay isolated on read (EPIC-03-S10 scenario 1)', () => {
  it('assigns one strictly increasing sequence across both runs', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const assigned: number[] = [];
      for (let index = 0; index < 25; index += 1) {
        assigned.push(
          ...appendEvents(db, [draft({ runId: RUN_A, payload: { of: 'A', index } })]),
          ...appendEvents(db, [draft({ runId: RUN_B, payload: { of: 'B', index } })]),
        );
      }
      expect(assigned).toHaveLength(50);
      expect(assigned.every((seq, index) => index === 0 || seq > (assigned[index - 1] ?? 0))).toBe(
        true,
      );

      const a = readRange(db, RUN_A, 0, 100);
      expect(a.events).toHaveLength(25);
      expect(a.events.every((event) => event.runId === RUN_A)).toBe(true);
      // Relative order matches the append order.
      expect(a.events.map((event) => event.payload)).toEqual(
        Array.from({ length: 25 }, (_unused, index) => ({ of: 'A', index })),
      );

      const b = readRange(db, RUN_B, 0, 100);
      expect(b.events).toHaveLength(25);
      expect(b.events.every((event) => event.runId === RUN_B)).toBe(true);

      // Neither read observed the other's rows, and together they are the whole
      // table.
      expect(a.events.length + b.events.length).toBe(
        db.prepare<{ n: number }>('SELECT count(*) AS n FROM event').get()?.n,
      );
    } finally {
      db.close();
    }
  });

  it('keeps a limited read inside its own run', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        draft({ runId: RUN_B }),
        draft({ runId: RUN_B }),
        draft({ runId: RUN_A, payload: { of: 'A' } }),
        draft({ runId: RUN_B }),
      ]);
      const page = readRange(db, RUN_A, 0, 2);
      expect(page.events.map((event) => event.payload)).toEqual([{ of: 'A' }]);
      expect(page.hasMore).toBe(false);
    } finally {
      db.close();
    }
  });
});

suite('there is exactly one database file (EPIC-03-S10 scenario 2)', () => {
  it('leaves ledger.db in the data directory and no per-run *.db', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [draft({ runId: RUN_A }), draft({ runId: RUN_B })]);
      const databases = readdirSync(tmp).filter((name) => name.endsWith('.db'));
      // `pre-migrate-<user_version>.db` is the migration runner's backup
      // (KAR-03.2), not a per-run store.
      expect(databases.filter((name) => !name.startsWith('pre-migrate-'))).toEqual(['ledger.db']);
      expect(databases.filter((name) => name.includes('run_'))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
