/**
 * KAR-15.6 AC3 — how long a node took, for the inspector bundle.
 *
 * `RunState.nodes[id].startedTs` is the instant the node first started and
 * there is deliberately no `endedTs` beside it: the projection carries the
 * fields `decide()` needs, and when a node *stopped* is not one of them. So the
 * inspector reads it out of the ledger, as two aggregates over the node's own
 * rows — never a fold of the run, and never `now - startedTs`, which would
 * report a finished node as though it were still running.
 *
 * Verifies: EPIC-15-S42 · KAR-15.6 AC3
 */
import { NodeIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { appendEvents, openLedger, readNodeTiming } from '../../src/index.ts';
import { draft, RUN_A } from './support/events.ts';

const NODE = NodeIdSchema.parse('n-impl');
const T0 = 1_754_308_293_000;

const at = (kind: string, ts: number, attempt: number, nodeId = NODE) =>
  draft({ kind, ts, nodeId, attempt, payload: {} });

suite('a node’s wall clock (AC3)', () => {
  it('spans the first start and the last terminal event, across attempts', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        at('node.started', T0, 0),
        at('node.failed', T0 + 4_000, 0),
        at('node.started', T0 + 5_000, 1),
        at('node.completed', T0 + 9_000, 1),
      ]);

      // Across attempts, like `startedTs`: a repair loop that burned nine
      // seconds over two tries burned nine seconds.
      expect(readNodeTiming(db, RUN_A, NODE)).toEqual({
        startedTs: T0,
        endedTs: T0 + 9_000,
        durationMs: 9_000,
      });
    } finally {
      db.close();
    }
  });

  it('leaves the end open while the node is still running', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [at('node.started', T0, 0)]);

      // `null` rather than a duration measured against the wall clock: a
      // running node has no duration yet, and inventing one would make the
      // inspector's figure change every time somebody reloaded the page.
      expect(readNodeTiming(db, RUN_A, NODE)).toEqual({
        startedTs: T0,
        endedTs: null,
        durationMs: null,
      });
    } finally {
      db.close();
    }
  });

  it('is null all through for a node that has never run', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [at('node.started', T0, 0, NodeIdSchema.parse('n-other'))]);

      expect(readNodeTiming(db, RUN_A, NODE)).toEqual({
        startedTs: null,
        endedTs: null,
        durationMs: null,
      });
    } finally {
      db.close();
    }
  });
});
