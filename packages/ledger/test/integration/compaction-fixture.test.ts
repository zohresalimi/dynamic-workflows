/**
 * KAR-09.6 AC9 — the committed compaction fixture, and the guard that keeps it
 * honest.
 *
 * `test/fixtures/runs/compaction/ledger.db` holds one compaction of each
 * fidelity: DeFlow's own, with exact before/after and the segments it demoted,
 * and the vendor's, with `pre_tokens` and an honest gap. It is the fixture the
 * replay harness and EPIC-17's context-budget view are both developed against —
 * which is exactly why it needs a spec of its own. A committed binary that
 * nothing checks is a fixture that quietly stops resembling what the code
 * writes, and then the view is developed against a shape production no longer
 * produces.
 *
 * So this file asserts three things: the fixture contains what AC9 says it
 * does, the JSON projection beside it (which the browser spec imports, because
 * a browser cannot open SQLite) agrees with the database, and **rebuilding the
 * fixture from `packages/ledger/scripts/build-compaction-fixture.ts` produces
 * the same payloads**. The last one is the drift check.
 *
 * Verifies: EPIC-09-S30, EPIC-09-S31, EPIC-09-S33 (its fixture half) · AC9
 */
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  buildCompactionFixture,
  COMPACTION_FIXTURE_RUN,
} from '../../scripts/build-compaction-fixture.ts';
import { openRead, readRange } from '../../src/index.ts';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../../test/fixtures/runs/compaction/', import.meta.url),
);

const compactionsIn = (dir: string): Record<string, unknown>[] => {
  const db = openRead(`${dir}ledger.db`);
  try {
    return readRange(db, COMPACTION_FIXTURE_RUN, 0, 1000)
      .events.filter((event) => event.kind === 'context.compacted')
      .map((event) => event.payload);
  } finally {
    db.close();
  }
};

const committed = compactionsIn(FIXTURE_DIR);

suite('AC9 — one compaction of each fidelity, in a real ledger', () => {
  it('holds exactly two, and they are the two kinds', () => {
    expect(committed.map((payload) => payload.scope)).toEqual(['DeFlow.packet', 'vendor.session']);
    expect(committed.map((payload) => payload.fidelity)).toEqual(['exact', 'partial']);
  });

  it('records the exact one with both ends measured and its segments named', () => {
    const exact = committed[0];

    expect(typeof exact?.before).toBe('number');
    expect(typeof exact?.after).toBe('number');
    expect(exact?.droppedSegments).not.toEqual([]);
    expect(exact?.originalHandle).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);
  });

  it('records the partial one with a gap where the vendor said nothing', () => {
    const partial = committed[1];

    expect(partial?.before).toBe(167_000);
    expect(partial?.after).toBeNull();
    expect(partial?.droppedSegments).toEqual([]);
    expect(partial?.demotedToHandles).toEqual([]);
    expect(partial?.trigger).toBe('vendor.auto');
  });
});

suite('the JSON projection beside it is the same data', () => {
  const projected = JSON.parse(readFileSync(`${FIXTURE_DIR}compactions.json`, 'utf8')) as {
    readonly compactions: readonly Record<string, unknown>[];
  };

  it('carries one entry per event, in ledger order', () => {
    expect(projected.compactions).toEqual(committed);
  });
});

suite('rebuilding the fixture produces the same payloads', () => {
  it('does not drift from the code that writes a compaction', async ({ tmp }) => {
    await buildCompactionFixture(tmp);

    // Handles are content addresses and the events are built from the same
    // inputs, so a rebuild is byte-comparable rather than merely similar. A
    // difference here means production changed and the fixture did not.
    expect(compactionsIn(`${tmp}/`)).toEqual(committed);
  });
});
