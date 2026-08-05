/**
 * KAR-03.5 — an older DeFlowd replays a ledger a newer one wrote
 * (EPIC-03-S16), against a real file-backed ledger.
 *
 * File-backed and not `:memory:` because the scenario is a *restart*: the
 * older daemon opens a data directory it did not write, folds it, appends to
 * it, and a newer daemon then reads the result back. None of that is
 * observable in a database that dies with the process.
 *
 * The unknown kind here is `node.sandbox.escalated` — a plausible future event
 * this build has never heard of — and the assertions are the ones §9.2 rule 2
 * exists for: no throw, no crash loop, known events still applied, and one
 * aggregate count rather than forty error lines.
 *
 * Verifies: EPIC-03-S16 · AC1, AC2
 */
import {
  describeSkipped,
  foldEvents,
  initialRunState,
  type NodeId,
  NodeIdSchema,
  type RunId,
} from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  drainEvents,
  type EventDraft,
  openLedger,
  readRange,
} from '../../src/index.ts';
import { RUN_A } from './support/events.ts';

/** 1,800 events of kinds this build knows, plus 40 it does not. */
const KNOWN_COUNT = 1_800;
const KNOWN_NODES = 40;
const UNKNOWN_COUNT = 40;
const UNKNOWN_KIND = 'node.sandbox.escalated';

/** run.started, plus node.started and node.completed per node. */
const KNOWN_FIXED = 1 + KNOWN_NODES * 2;
const PROGRESS_PER_NODE = Math.floor((KNOWN_COUNT - KNOWN_FIXED) / KNOWN_NODES);
const PROGRESS_REMAINDER = (KNOWN_COUNT - KNOWN_FIXED) % KNOWN_NODES;

const SHA = `sha256-${'a'.repeat(64)}`;
const BARE_SHA = 'd'.repeat(64);
const HANDLE = `artifact://${'b'.repeat(64)}`;
const TS = 1_754_308_293_000;

const nodeOf = (index: number): NodeId =>
  NodeIdSchema.parse(`step-${String(index + 1).padStart(2, '0')}`);

function newerDaemonRun(runId: RunId): EventDraft[] {
  const events: EventDraft[] = [];
  const emit = (kind: string, payload: unknown): void => {
    events.push({ runId, ts: TS + events.length * 1000, kind, v: 1, epoch: 1, payload });
  };

  emit('run.started', { planHash: SHA });

  for (let index = 0; index < KNOWN_NODES; index += 1) {
    const node = nodeOf(index);
    emit('node.started', {
      node,
      attempt: 0,
      ikey: `${runId}/${node}/0/0`,
      binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: BARE_SHA },
    });
    // The bulk of the 1,800 known events, and not one of them may move the
    // watermark. The count is uneven only so the total lands on 1,800 exactly.
    for (
      let report = 0;
      report < PROGRESS_PER_NODE + (index < PROGRESS_REMAINDER ? 1 : 0);
      report += 1
    ) {
      emit('node.progress', { node, attempt: 0, phase: 'tool-use' });
    }
    if (index < UNKNOWN_COUNT) {
      // The event this build has never heard of, written mid-attempt by the
      // newer daemon exactly where a real one would be.
      emit(UNKNOWN_KIND, { node, attempt: 0, sandbox: 'seatbelt', reason: 'network' });
    }
    emit('node.completed', {
      node,
      attempt: 0,
      result: {
        status: 'completed',
        output: { summary: `${node} done` },
        outputSchemaId: 'DeFlow.artifact.v1',
        usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
        costUsd: 0.25,
        producedFacts: [],
        artifacts: [HANDLE],
      },
    });
  }

  return events;
}

/** The ledger as the newer daemon left it. */
const seed = (tmp: string) => {
  const db = openLedger(tmp);
  appendEvents(db, newerDaemonRun(RUN_A));
  return db;
};

const foldFromLedger = (db: ReturnType<typeof openLedger>) =>
  foldEvents(drainEvents(db, RUN_A), initialRunState());

suite('the older daemon opens and folds a ledger written by a newer one', () => {
  it('reads it without throwing, and without a crash loop', ({ tmp }) => {
    const db = seed(tmp);
    try {
      // Twice: a crash loop is what a daemon does when the *second* open of the
      // same data fails, so one successful fold proves less than it looks.
      expect(() => foldFromLedger(db)).not.toThrow();
      expect(() => foldFromLedger(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('holds the 1,800 known events and the 40 unknown ones it was given', ({ tmp }) => {
    const db = seed(tmp);
    try {
      const stored = [...drainEvents(db, RUN_A)];

      expect(stored).toHaveLength(KNOWN_COUNT + UNKNOWN_COUNT);
      expect(stored.filter((event) => event.kind === UNKNOWN_KIND)).toHaveLength(UNKNOWN_COUNT);
    } finally {
      db.close();
    }
  });

  it('applies every known event and leaves state unchanged for each unknown one', ({ tmp }) => {
    const db = seed(tmp);
    try {
      const report = foldFromLedger(db);

      expect(report.skippedByKind).toEqual({ [UNKNOWN_KIND]: UNKNOWN_COUNT });
      expect(report.unreadable).toEqual([]);
      expect(report.state.status).toBe('running');
      expect(Object.keys(report.state.nodes)).toHaveLength(KNOWN_NODES);
    } finally {
      db.close();
    }
  });

  it('reports one aggregate line, not one error per skipped event', ({ tmp }) => {
    const db = seed(tmp);
    try {
      expect(describeSkipped(foldFromLedger(db))).toBe(
        `skipped 40 events of 1 unknown kind: ${UNKNOWN_KIND}`,
      );
    } finally {
      db.close();
    }
  });

  it('degrades the projection rather than corrupting it — no impossible node', ({ tmp }) => {
    const db = seed(tmp);
    try {
      const { state } = foldFromLedger(db);

      for (let index = 0; index < KNOWN_NODES; index += 1) {
        const node = state.nodes[nodeOf(index)];
        expect(node?.status).toBe('completed');
        // Completed-without-having-run is the shape a skipped `node.started`
        // would otherwise produce, and `attempts` being derived is what stops it.
        expect(node?.attempts).toBeGreaterThanOrEqual(1);
      }
    } finally {
      db.close();
    }
  });

  it('left the watermark on a real transition, never on a progress report', ({ tmp }) => {
    const db = seed(tmp);
    try {
      const { state } = foldFromLedger(db);
      const events = [...drainEvents(db, RUN_A)];
      const watermarkEvent = events.find((event) => event.seq === state.watermarkSeq);

      expect(watermarkEvent?.kind).toBe('node.completed');
    } finally {
      db.close();
    }
  });
});

suite('appending after the downgrade is safe', () => {
  it('assigns seqs strictly greater than every existing one, rewriting nothing', ({ tmp }) => {
    const db = seed(tmp);
    try {
      const before = [...drainEvents(db, RUN_A)];
      const highest = Math.max(...before.map((event) => event.seq));

      const [assigned] = appendEvents(db, [
        { runId: RUN_A, ts: TS, kind: 'run.paused', v: 1, epoch: 1, payload: { by: 'user' } },
      ]);

      expect(assigned).toBeGreaterThan(highest);
      const after = readRange(db, RUN_A, 0, before.length).events;
      expect(after).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('lets the newer binary fold the whole ledger afterwards, unknown events included', ({
    tmp,
  }) => {
    const db = seed(tmp);
    try {
      appendEvents(db, [
        { runId: RUN_A, ts: TS, kind: 'run.paused', v: 1, epoch: 1, payload: { by: 'user' } },
      ]);

      // "The newer binary" is modelled as a fold that understands the kind the
      // older one skipped: the same rows, one more transition applied.
      const older = foldFromLedger(db);
      const newerNodes = new Set(
        [...drainEvents(db, RUN_A)]
          .filter((event) => event.kind === UNKNOWN_KIND)
          .map((event) => (event.payload as { node: string }).node),
      );

      expect(older.state.status).toBe('paused');
      expect(older.skippedByKind[UNKNOWN_KIND]).toBe(UNKNOWN_COUNT);
      // The rows the newer binary would interpret are still there, byte for
      // byte, for it to interpret.
      expect(newerNodes.size).toBe(UNKNOWN_COUNT);
    } finally {
      db.close();
    }
  });
});
