/**
 * KAR-13.1 — a blocking `human` node, against a real file-backed ledger and the
 * daemon's own run executor (EPIC-13-S1, S2, S5, S6, S7, S8, S9).
 *
 * Three properties are only observable here and not in `@DeFlow/core`'s unit
 * specs, and they are the ones the story is about.
 *
 * **The three writes are one transaction.** `decide()` returning a `SuspendNode`
 * proves the *intent*; only a database can show that `human.requested`,
 * `node.suspended` and the `node_wake` row landed together, and that a refused
 * append takes the row with it.
 *
 * **Six hours cost one row and no events.** Advanced on the injected `Clock`, so
 * the whole gate is exercised in microseconds — and with no fake timers
 * anywhere, because a fake timer while a child process is alive deadlocks the
 * spec for its full timeout (docs/14-testing-strategy.md §8).
 *
 * **A pending approval is not a paused run.** The sibling branch has to actually
 * complete while the gate waits, which needs the executor rather than a hand-run
 * command list.
 *
 * Verifies: EPIC-13-S1, EPIC-13-S2, EPIC-13-S5, EPIC-13-S6, EPIC-13-S7,
 * EPIC-13-S8, EPIC-13-S9 · AC1, AC2, AC3, AC5, AC7, AC8, AC9, AC10
 */
import type { Db, NodeId, RunState } from '@DeFlow/core';
import {
  HUMAN_DECISION_SCHEMA_ID,
  initialRunState,
  injectedGuidance,
  NO_DEADLINE_WAKE_AT,
  openHumanGate,
} from '@DeFlow/core';
import { openLedger, readRange, readWakes, replayAll } from '@DeFlow/ledger';
import { it, repoRoot, TestClock } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { createEffectRunner } from '../../src/effects/durable.ts';
import { executeRun } from '../../src/exec/run-executor.ts';
import { expireDueHumanGates, respondToHumanNode } from '../../src/human/gate.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import {
  type Deadline,
  days,
  driveToTheGate,
  EPOCH,
  GATE,
  HUMAN_RUN,
  hours,
  OPTIONS,
  PROMPT,
  RANDOM,
  SIBLING,
  seedHumanRun,
  T0,
  WRITER,
} from './support/human-gate-run.ts';

const stateOf = (db: Db): RunState => replayAll(db).runs.get(HUMAN_RUN) ?? initialRunState();

/**
 * The repository's own `schemas/` directory, which is what `DeFlow init` copies
 * into a run as `.DeFlow/schemas`. Passed explicitly so an `edit` is validated
 * against the real emitted document rather than against a stub.
 */
const SCHEMAS = loadSchemaDirectory(join(repoRoot, 'schemas'));

const events = (db: Db) => readRange(db, HUMAN_RUN, 0, 500).events;

const kinds = (db: Db): string[] => events(db).map((event) => event.kind);

const countOf = (db: Db, kind: string): number =>
  events(db).filter((event) => event.kind === kind).length;

// ── EPIC-13-S1, EPIC-13-S9 — the gate blocks its branch and nothing else ─────

suite('EPIC-13-S1 — admitting a human node writes three things at once (AC1)', () => {
  it('appends human.requested and node.suspended at adjacent seqs, with one row', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      await driveToTheGate(db, new TestClock(T0));

      const requested = events(db).filter((event) => event.kind === 'human.requested');
      const suspendedEvents = events(db).filter((event) => event.kind === 'node.suspended');
      expect(requested).toHaveLength(1);
      expect(suspendedEvents).toHaveLength(1);
      // Adjacent, so there is no crash point between them by construction.
      expect(suspendedEvents[0]?.seq).toBe((requested[0]?.seq ?? 0) + 1);

      expect(requested[0]?.payload).toMatchObject({ node: GATE, prompt: PROMPT });
      expect((requested[0]?.payload as { options: unknown[] }).options).toEqual(
        OPTIONS.map((option) => ({ ...option })),
      );

      expect(readWakes(db, HUMAN_RUN)).toEqual([
        { runId: HUMAN_RUN, nodeId: GATE, wakeAt: NO_DEADLINE_WAKE_AT, reason: 'human_gate' },
      ]);
    } finally {
      db.close();
    }
  });

  it('is a gate the projection can answer questions about', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      await driveToTheGate(db, new TestClock(T0));

      const gate = openHumanGate(stateOf(db), GATE);
      expect(gate).toMatchObject({ node: GATE, prompt: PROMPT, escalated: false, response: null });
      expect(gate?.requestedSeq).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-13-S9 — a pending approval is not a paused run (AC10)', () => {
  it('keeps the sibling branch moving and withholds only the dependents', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      const { started, state } = await driveToTheGate(db, new TestClock(T0));

      expect(started).toEqual([SIBLING]);
      expect(state.status).toBe('running');
      expect(state.nodes[GATE]?.status).toBe('suspended');
      expect(state.nodes[SIBLING]?.status).toBe('completed');
      // Not merely "not running": no event has touched the dependent at all,
      // which is what a node named only by the plan looks like.
      expect(state.nodes[WRITER]).toBeUndefined();
      expect(events(db).some((event) => event.nodeId === WRITER)).toBe(false);
      expect(kinds(db)).not.toContain('run.paused');
    } finally {
      db.close();
    }
  });

  it('never spawns the gate: a human node is admitted by going to sleep', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      await driveToTheGate(db, new TestClock(T0));

      const startedGate = events(db).filter(
        (event) => event.kind === 'node.started' && event.nodeId === GATE,
      );
      expect(startedGate).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('answering it admits the dependent, on the same attempt', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);

      const answered = respondToHumanNode({
        db,
        runId: HUMAN_RUN,
        nodeId: GATE,
        optionId: 'yes',
        epoch: EPOCH,
        ts: clock.now() + 60_000,
      });
      expect(answered.status).toBe('ok');

      // The wait is gone in the same transaction as the answer.
      expect(readWakes(db, HUMAN_RUN)).toEqual([]);

      const { started, state } = await driveToTheGate(db, clock);
      expect(started).toEqual([WRITER]);
      expect(state.status).toBe('completed');
      expect(state.nodes[GATE]).toMatchObject({ status: 'completed', attempt: 0 });
      expect(countOf(db, 'human.responded')).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-13-S2 — six hours cost one row and zero events ─────────────────────

suite('EPIC-13-S2 — the operator goes to a wedding (AC2)', () => {
  it('advances six hours with the node still suspended, one row, and nothing appended', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);

      const before = events(db).length;
      const rowBefore = readWakes(db, HUMAN_RUN);

      await clock.advance(hours(6));
      expect(expireDueHumanGates({ db, clock, epoch: EPOCH })).toEqual([]);

      expect(events(db).length).toBe(before);
      expect(readWakes(db, HUMAN_RUN)).toEqual(rowBefore);
      expect(stateOf(db).nodes[GATE]?.status).toBe('suspended');
    } finally {
      db.close();
    }
  });

  it('and thirty days cost exactly the same one row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);
      const before = events(db).length;

      await clock.advance(days(30));
      expect(expireDueHumanGates({ db, clock, epoch: EPOCH })).toEqual([]);

      expect(readWakes(db, HUMAN_RUN)).toHaveLength(1);
      expect(events(db).length).toBe(before);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-13-S5 — a backwards clock does not move the gate ───────────────────

suite('EPIC-13-S5 — laptop sleep and NTP do not move the gate (AC5)', () => {
  const twoHours = (): Deadline => ({
    wakeAt: new Date(T0 + hours(2)).toISOString(),
    onTimeout: 'fail',
  });

  it('does not fire early when the clock steps backwards, and fires once when it passes', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db, twoHours());
      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);

      expect(readWakes(db, HUMAN_RUN)).toEqual([
        { runId: HUMAN_RUN, nodeId: GATE, wakeAt: T0 + hours(2), reason: 'human_gate' },
      ]);

      // An NTP correction and a DST transition, both backwards.
      clock.jumpTo(T0 - hours(2));
      expect(expireDueHumanGates({ db, clock, epoch: EPOCH })).toEqual([]);
      clock.jumpTo(T0 + hours(1));
      expect(expireDueHumanGates({ db, clock, epoch: EPOCH })).toEqual([]);
      expect(stateOf(db).nodes[GATE]?.status).toBe('suspended');

      // A laptop that slept through the deadline: the row is found on the next
      // tick, and fired exactly once.
      clock.jumpTo(T0 + hours(10));
      expect(expireDueHumanGates({ db, clock, epoch: EPOCH })).toHaveLength(1);
      expect(expireDueHumanGates({ db, clock, epoch: EPOCH })).toEqual([]);
      expect(countOf(db, 'node.failed')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('orders the ledger by seq, never by the timestamps a backwards clock wrote', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db, twoHours());
      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);

      clock.jumpTo(T0 - hours(5));
      respondToHumanNode({
        db,
        runId: HUMAN_RUN,
        nodeId: GATE,
        optionId: 'yes',
        epoch: EPOCH,
        ts: clock.now(),
      });

      const seqs = events(db).map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      // The response's `ts` really is older than the request's, and the
      // projection is still right — because nothing compared the two.
      const requested = events(db).find((event) => event.kind === 'human.requested');
      const responded = events(db).find((event) => event.kind === 'human.responded');
      expect(responded?.ts).toBeLessThan(requested?.ts ?? 0);
      expect(responded?.seq).toBeGreaterThan(requested?.seq ?? 0);
      expect(stateOf(db).nodes[GATE]?.status).toBe('completed');
    } finally {
      db.close();
    }
  });
});

// ── EPIC-13-S6 — the deadline matrix ────────────────────────────────────────

suite('EPIC-13-S6 — what happens when nobody answers in time (AC7)', () => {
  const at = (onTimeout: Deadline['onTimeout'], fallback?: string): Deadline => ({
    wakeAt: new Date(T0 + hours(2)).toISOString(),
    onTimeout,
    ...(fallback === undefined ? {} : { default: fallback }),
  });

  const expire = async (db: Db, deadline: Deadline) => {
    seedHumanRun(db, deadline);
    const clock = new TestClock(T0);
    await driveToTheGate(db, clock);
    await clock.advance(hours(3));
    return expireDueHumanGates({ db, clock, epoch: EPOCH });
  };

  it('fail fails the node with a typed reason and poisons its dependents', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(await expire(db, at('fail'))).toHaveLength(1);

      const state = stateOf(db);
      expect(state.nodes[GATE]).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout', class: 'permanent' },
      });
      expect(readWakes(db, HUMAN_RUN)).toEqual([]);
      expect(state.nodes[WRITER]?.status).not.toBe('running');
    } finally {
      db.close();
    }
  });

  it('escalate re-asks more visibly and goes back to waiting on one row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await expire(db, at('escalate'));

      expect(countOf(db, 'human.requested')).toBe(2);
      const gate = openHumanGate(stateOf(db), GATE);
      expect(gate).toMatchObject({ escalated: true, deadline: null, response: null });

      // Still asleep, now for ever, and still one row.
      expect(readWakes(db, HUMAN_RUN)).toEqual([
        { runId: HUMAN_RUN, nodeId: GATE, wakeAt: NO_DEADLINE_WAKE_AT, reason: 'human_gate' },
      ]);
    } finally {
      db.close();
    }
  });

  it('default answers on the operator’s behalf and says who did', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await expire(db, at('default', 'no'));

      const responded = events(db).find((event) => event.kind === 'human.responded');
      expect(responded?.payload).toMatchObject({ optionId: 'no', by: 'policy' });
      // `no` is the `reject` option, so the branch fails rather than proceeds.
      expect(stateOf(db).nodes[GATE]).toMatchObject({
        status: 'failed',
        failure: { reason: 'gate.failed' },
      });
      expect(readWakes(db, HUMAN_RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-13-S7 — the four option effects ────────────────────────────────────

suite('EPIC-13-S7 — each effect does what it says (AC8)', () => {
  const answerWith = async (
    db: Db,
    optionId: string,
    extra: Record<string, unknown> = {},
  ): Promise<ReturnType<typeof respondToHumanNode>> => {
    seedHumanRun(db);
    const clock = new TestClock(T0);
    await driveToTheGate(db, clock);
    return respondToHumanNode({
      db,
      runId: HUMAN_RUN,
      nodeId: GATE,
      optionId,
      epoch: EPOCH,
      ts: clock.now(),
      schemas: SCHEMAS,
      ...extra,
    });
  };

  it('approve completes the node', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect((await answerWith(db, 'yes')).status).toBe('ok');
      expect(stateOf(db).nodes[GATE]?.status).toBe('completed');
    } finally {
      db.close();
    }
  });

  it('reject fails the branch with a typed reason', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await answerWith(db, 'no');
      expect(stateOf(db).nodes[GATE]).toMatchObject({
        status: 'failed',
        failure: { reason: 'gate.failed', class: 'permanent' },
      });
    } finally {
      db.close();
    }
  });

  it('edit replaces the output once it validates against returns.schemaId', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const finding = {
        id: 'scope-extended-by-hand',
        severity: 'minor',
        message: 'the operator extended the migration scope to the three extra packages',
        evidence: [],
      };
      expect((await answerWith(db, 'amend', { output: finding })).status).toBe('ok');

      expect(stateOf(db).nodes[GATE]?.result).toMatchObject({
        output: finding,
        outputSchemaId: 'DeFlow.finding.v1',
      });
    } finally {
      db.close();
    }
  });

  it('an edit payload that violates the schema is refused, and the node stays suspended', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const refused = await answerWith(db, 'amend', {
        output: { id: 'f-1', severity: 'catastrophic', message: '', evidence: [] },
      });

      expect(refused).toMatchObject({ status: 'refused', code: 'schema_violation' });
      expect(countOf(db, 'human.responded')).toBe(0);
      expect(stateOf(db).nodes[GATE]?.status).toBe('suspended');
      // Still answerable: the operator gets another go, and it costs nothing.
      expect(readWakes(db, HUMAN_RUN)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('inject completes the node and carries the text into the dependent’s reads', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const text = "Use the existing useToast composable, don't add a new one.";
      expect((await answerWith(db, 'guide', { text })).status).toBe('ok');

      const state = stateOf(db);
      expect(state.nodes[GATE]?.result).toMatchObject({
        outputSchemaId: HUMAN_DECISION_SCHEMA_ID,
        output: { effect: 'inject', text },
      });
      expect(injectedGuidance(state, WRITER)).toEqual([{ node: GATE, text }]);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-13-S8 — answering twice ────────────────────────────────────────────

suite('EPIC-13-S8 — the operator double-clicks (AC9)', () => {
  it('refuses the second answer with 409 and echoes the first', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);

      const first = respondToHumanNode({
        db,
        runId: HUMAN_RUN,
        nodeId: GATE,
        optionId: 'yes',
        epoch: EPOCH,
        ts: clock.now(),
      });
      const second = respondToHumanNode({
        db,
        runId: HUMAN_RUN,
        nodeId: GATE,
        optionId: 'no',
        epoch: EPOCH,
        ts: clock.now() + 1_000,
      });

      expect(first.status).toBe('ok');
      expect(second).toMatchObject({ status: 'conflict', code: 'already_answered', http: 409 });
      if (second.status !== 'conflict') throw new Error('narrowing');
      expect(second.response).toMatchObject({ optionId: 'yes', by: 'operator' });

      expect(countOf(db, 'human.responded')).toBe(1);
      expect(stateOf(db).nodes[GATE]?.status).toBe('completed');
    } finally {
      db.close();
    }
  });

  it('refuses an answer to a node with no open gate', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);

      expect(
        respondToHumanNode({
          db,
          runId: HUMAN_RUN,
          nodeId: SIBLING as NodeId,
          optionId: 'yes',
          epoch: EPOCH,
          ts: T0,
        }),
      ).toMatchObject({ status: 'refused', code: 'gate_not_open' });
      expect(countOf(db, 'human.responded')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('refuses an option the plan never offered, appending nothing', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);

      expect(
        respondToHumanNode({
          db,
          runId: HUMAN_RUN,
          nodeId: GATE,
          optionId: 'maybe',
          epoch: EPOCH,
          ts: clock.now(),
        }),
      ).toMatchObject({ status: 'refused', code: 'unknown_option' });
      expect(countOf(db, 'human.responded')).toBe(0);
      expect(readWakes(db, HUMAN_RUN)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
