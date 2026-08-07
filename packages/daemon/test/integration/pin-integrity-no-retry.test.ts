/**
 * KAR-09.3 AC6 — a pin-integrity failure does not retry, and reaches a human.
 *
 * The other half of EPIC-09-S17 lives in
 * `packages/adapters/test/integration/pin-integrity.test.ts`, where the check
 * refuses the dispatch. This is what the scheduler does with the refusal, and
 * the assertion that matters is a *negative* one: a node whose retry policy
 * allows three attempts gets no `node.retry.scheduled` and no `node_wake` row,
 * so nothing wakes up and quietly re-sends the same broken prompt.
 *
 * A real ledger file, because "no wake row" is a claim about a table.
 *
 * Verifies: EPIC-09-S17 (first and third scenarios) · AC6
 */

import { type Db, PinIntegrityViolation, seededRandom, toNodeFailure } from '@DeFlow/core';
import { openLedger, readRange, readWakes } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { recordNodeFailure } from '../../src/retry.ts';
import { IMPLEMENT, IMPLEMENT_NODE, RETRY_RUN, seedRetryRun, T0 } from './support/retry-run.ts';

const RETRY = IMPLEMENT_NODE.retry;

const events = (db: Db) => readRange(db, RETRY_RUN, 0, 500).events;
const kinds = (db: Db): string[] => events(db).map((event) => event.kind);
const payloadOf = (db: Db, kind: string): Record<string, unknown> | undefined =>
  events(db).find((event) => event.kind === kind)?.payload as Record<string, unknown> | undefined;

/** The failure the adapter's refusal becomes, through the one boundary that
 * turns a throw into a ledger row. */
function pinFailure() {
  const violation = new PinIntegrityViolation([
    {
      id: 'pinned-constraints-safety' as never,
      contentHash: `sha256-${'d'.repeat(64)}`,
      kind: 'absent',
    },
  ]);
  return toNodeFailure(violation, {
    occurredAtEvent: 1 as never,
    attempt: 0,
    captureEvidence: () => 'artifact://'.concat('e'.repeat(64)) as never,
  });
}

suite('a pin-integrity failure is never retried (AC6)', () => {
  it('writes no node.retry.scheduled and no wake row, on a node allowed three attempts', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const failure = pinFailure();
    expect(failure.reason).toBe('safety.pin-integrity-violated');
    // Three attempts are allowed. That is the whole point of the fixture: the
    // absence below is a decision, not a policy that had nothing to give.
    expect(RETRY.maxAttempts).toBe(3);

    const recorded = recordNodeFailure(db, {
      runId: RETRY_RUN,
      nodeId: IMPLEMENT,
      failure,
      retry: RETRY,
      epoch: 1,
      ts: T0,
      random: seededRandom(42),
    });

    expect(recorded.plan.action).toBe('gate');
    expect(recorded.wakeAt).toBeNull();
    expect(kinds(db)).not.toContain('node.retry.scheduled');
    expect(kinds(db)).not.toContain('plan.patch.proposed');
    expect(readWakes(db, T0 + 10 * 60 * 1000)).toEqual([]);
    db.close();
  });

  it('suspends the node and asks a human, carrying the reason with it', ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);

    recordNodeFailure(db, {
      runId: RETRY_RUN,
      nodeId: IMPLEMENT,
      failure: pinFailure(),
      retry: RETRY,
      epoch: 1,
      ts: T0,
      random: seededRandom(42),
    });

    const after = kinds(db);
    expect(after).toContain('node.failed');
    expect(after).toContain('node.suspended');
    expect(after).toContain('run.needs_human');
    expect(after.indexOf('node.failed')).toBeLessThan(after.indexOf('node.suspended'));

    expect(payloadOf(db, 'node.suspended')).toMatchObject({
      node: IMPLEMENT,
      until: { kind: 'human' },
    });
    // The specific reason travels on `node.failed`, which is what the approval
    // queue renders beside the link to the packet.
    expect(payloadOf(db, 'node.failed')).toMatchObject({
      node: IMPLEMENT,
      failure: { reason: 'safety.pin-integrity-violated' },
    });
    db.close();
  });

  it('keeps the failure typed rather than falling through to internal', ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const failure = pinFailure();

    expect(failure.class).toBe('gate');
    expect(failure.detail).toMatchObject({
      missingDigests: [`sha256-${'d'.repeat(64)}`],
      segmentIds: ['pinned-constraints-safety'],
    });
    db.close();
  });
});
