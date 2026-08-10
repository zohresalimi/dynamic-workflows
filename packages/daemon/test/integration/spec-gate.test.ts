/**
 * KAR-10.3 — the F1.3 approval gate, against a real file-backed ledger.
 *
 * Integration rather than unit because every claim here is about something
 * durable: how many `node_wake` rows a suspended gate costs, that a tick loop
 * over thirty simulated minutes writes nothing, that the approval and the pin
 * are one commit rather than two, and that the pre-edit spec is still on disk
 * afterwards. `:memory:` cannot express the middle one at all
 * (docs/14-testing-strategy.md §7).
 *
 * The `SIGKILL` half is ./spec-gate-crash.test.ts, which needs a real child
 * process; everything here runs in-process against a real file.
 *
 * Verifies: EPIC-10-S13, EPIC-10-S14, EPIC-10-S15, EPIC-10-S16 (scenarios 1
 * and 3), EPIC-10-S29 · AC1-AC5, AC7, AC8, AC9 · test plan #2, #4, #6, #7, #8
 */
import type { Command, Db, PlanGraph } from '@DeFlow/core';
import {
  decide,
  initialRunState,
  NO_DEADLINE_WAKE_AT,
  type RunState,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
  sealTaskSpec,
  specHistory,
} from '@DeFlow/core';
import {
  appendEvents,
  dueWakes,
  nextWakeAt,
  openLedger,
  readRange,
  readWakes,
  replayAll,
} from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  abandonRun,
  approveSpec,
  editSpec,
  rejectSpec,
  SPEC_REJECTION_LIMIT,
} from '../../src/spec/gate.ts';
import { startTicker } from '../../src/ticker.ts';
import { recordingDb } from './support/recording-db.ts';
import {
  FRAMING_NODE,
  framed,
  minutes,
  REPO,
  SPEC_RUN,
  seedSpecGateRun,
  T0,
} from './support/spec-gate-run.ts';

const events = (db: Db) => readRange(db, SPEC_RUN, 0, 500).events;
const kinds = (db: Db) => events(db).map((event) => event.kind);
const payloadsOf = (db: Db, kind: string) =>
  events(db)
    .filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);
const stateOf = (db: Db): RunState => replayAll(db).runs.get(SPEC_RUN) ?? initialRunState();

/** A plan whose one gate node covers the two criteria the fixture spec has
 * that are not marked unverifiable. */
function planCovering(criteria: readonly string[], planHash: string): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: SPEC_RUN,
    version: 3,
    planHash,
    parent: null,
    taskSpecHash: `sha256-${'c'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-07T09:00:00.000Z',
    nodes: [
      {
        id: 'gate-1',
        title: 'the acceptance gate',
        type: 'gate',
        deps: [],
        lifecycle: 'active',
        reads: [],
        writes: [],
        permission: 'read',
        pathScopes: { write: [] },
        returns: { schemaId: 'DeFlow.verdict.v1', maxTokens: 1500 },
        retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
        budget: {},
        gate: { kind: 'deterministic', gateId: 'typecheck' },
        criteria: [...criteria],
        independence: { notSessionOf: [], preferDifferentProvider: false },
      },
    ],
    edges: [],
  };
}

// ── EPIC-10-S13 / test plan #2 — the gate blocks, and costs one row ──────────

suite('EPIC-10-S13 — the approval gate genuinely blocks execution', () => {
  it('opens as a blocking human node carrying the rendered spec and the four options', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const spec = await seedSpecGateRun(db);

      const requested = payloadsOf(db, 'human.requested');
      expect(requested).toHaveLength(1);
      expect(requested[0]?.node).toBe(SPEC_GATE_NODE);
      expect(requested[0]?.options).toEqual(SPEC_APPROVAL_OPTIONS);
      expect(String(requested[0]?.prompt)).toContain(spec.goal);

      const state = stateOf(db);
      expect(state.status).toBe('awaiting-spec-approval');
      expect(state.nodes[SPEC_GATE_NODE]?.status).toBe('suspended');
    } finally {
      db.close();
    }
  });

  it('costs exactly one node_wake row with reason human_gate, and no timer', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await seedSpecGateRun(db);

      expect(readWakes(db, SPEC_RUN)).toEqual([
        {
          runId: SPEC_RUN,
          nodeId: SPEC_GATE_NODE,
          wakeAt: NO_DEADLINE_WAKE_AT,
          reason: 'human_gate',
        },
      ]);
      // The gate declares no deadline, so nothing is ever due (EPIC-10-S16's
      // third scenario: six hours pass and no deadline fires).
      expect(dueWakes(db, T0 + minutes(30))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('derives an empty ready set on every tick for thirty simulated minutes, writing nothing', async ({
    tmp,
  }) => {
    const inner = openLedger(tmp);
    try {
      await seedSpecGateRun(inner);
      const db = recordingDb(inner);
      const state = stateOf(inner);

      // Its own clock rather than the fixture's, anchored where the run is: a
      // scheduler asked about an instant before its own watermark is being
      // asked a question no real tick asks.
      const clock = new TestClock(T0);
      db.forget();
      const ticks: (readonly Command[])[] = [];
      const ticker = startTicker({
        clock,
        // The real hint, off the real table — which is also how the sentinel
        // `wake_at` gets exercised: 8.64e15 must not become a 273-million-year
        // timer, and `sleepHint` capping at one second is what stops it.
        nextWakeAt: () => nextWakeAt(db),
        onTick: (now) => {
          dueWakes(db, now);
          ticks.push(decide(state, now));
        },
      });
      await clock.advance(minutes(30));
      ticker.stop();

      // 1 Hz for thirty minutes, and not one of those ticks found work.
      //
      // "No work" is not "no commands": KAR-13.1 has the scheduler restate an
      // open gate's own `node_wake` row on every tick, which is the idempotent
      // restatement that makes the row survive a crash between the event that
      // scheduled it and the row that records it. It writes nothing —
      // `scheduleWakeIfChanged` skips a row that already says exactly this —
      // which is what the `db.writes` assertion below proves. What must never
      // appear is a command that *starts* something.
      expect(ticks.length).toBeGreaterThan(1_700);
      for (const commands of ticks) {
        expect(commands).toEqual([
          {
            kind: 'ScheduleWake',
            runId: SPEC_RUN,
            node: SPEC_GATE_NODE,
            wakeAt: NO_DEADLINE_WAKE_AT,
            reason: 'human_gate',
          },
        ]);
      }

      // "Zero CPU" as a countable fact: no statement the loop ran could have
      // changed a row, and every one of them was an indexed read of node_wake.
      expect(db.writes).toEqual([]);
      for (const statement of db.statements) {
        expect(statement.sql.toLowerCase()).toContain('from node_wake');
      }
    } finally {
      inner.close();
    }
  });

  it('has no node.scheduled for any node but framing, and no plan.proposed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await seedSpecGateRun(db);

      expect(payloadsOf(db, 'node.scheduled').map((payload) => payload.node)).toEqual([
        FRAMING_NODE,
      ]);
      expect(kinds(db)).not.toContain('plan.proposed');
      expect(kinds(db)).not.toContain('run.spec.approved');
    } finally {
      db.close();
    }
  });
});

// ── test plan #4 — approval and the pin are one commit ───────────────────────

suite('EPIC-10-S13 — approval unblocks it, in that order (test plan #4)', () => {
  it('appends run.spec.approved and spec.pinned at adjacent seqs from one commit', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const spec = await seedSpecGateRun(db);
      await approveSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0 + minutes(4), by: 'ui' });

      const all = events(db);
      const approved = all.find((event) => event.kind === 'run.spec.approved');
      const pinned = all.find((event) => event.kind === 'spec.pinned');
      expect(approved?.payload).toEqual({ specHash: spec.specHash, by: 'ui' });
      expect(pinned?.seq).toBe((approved?.seq ?? 0) + 1);

      // The pinned set is the digests of what was approved, not a copy of it.
      const segments = (pinned?.payload as { segments: { id: string }[] }).segments;
      expect(segments.map((segment) => segment.id)).toEqual([
        'pinned-spec-goal',
        'pinned-spec-criteria',
        'pinned-constraints-safety',
      ]);
      expect((pinned?.payload as { specHash: string }).specHash).toBe(spec.specHash);

      // The wake is gone in the same transaction, and the run is schedulable.
      expect(readWakes(db, SPEC_RUN)).toEqual([]);
      const state = stateOf(db);
      expect(state.status).toBe('spec-approved');
      expect(state.specApproved).toEqual({ specHash: spec.specHash, by: 'ui' });
    } finally {
      db.close();
    }
  });

  it('refuses a second approval of a gate that is not open', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await seedSpecGateRun(db);
      await approveSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0, by: 'ui' });
      await expect(
        approveSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0, by: 'cli' }),
      ).rejects.toThrow(/no approval gate is open/);
      expect(payloadsOf(db, 'run.spec.approved')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('produces the same ledger from the CLI as from the API, apart from `by`', async ({ tmp }) => {
    await mkdir(join(tmp, 'ui'), { recursive: true });
    await mkdir(join(tmp, 'cli'), { recursive: true });
    const viaUi = openLedger(join(tmp, 'ui'));
    const viaCli = openLedger(join(tmp, 'cli'));
    try {
      await seedSpecGateRun(viaUi);
      await seedSpecGateRun(viaCli);
      await approveSpec({ db: viaUi, runId: SPEC_RUN, epoch: 1, ts: T0, by: 'ui' });
      await approveSpec({ db: viaCli, runId: SPEC_RUN, epoch: 1, ts: T0, by: 'cli' });

      const normalise = (db: Db) =>
        events(db).map((event) => ({
          kind: event.kind,
          payload: JSON.stringify(event.payload).replaceAll('"cli"', '"ui"'),
        }));
      expect(normalise(viaCli)).toEqual(normalise(viaUi));
    } finally {
      viaUi.close();
      viaCli.close();
    }
  });
});

// ── EPIC-10-S14 / test plan #6 — an edit ─────────────────────────────────────

suite('EPIC-10-S14 — the operator edits the draft before approving', () => {
  /** S14's two edits: sharpen a criterion, add a non-goal. */
  function edited(): Record<string, unknown> {
    const document = framed();
    const target = document.acceptanceCriteria[0];
    if (target === undefined) throw new Error('the fixture has no acceptance criteria');
    (target as { statement: string }).statement =
      'pnpm build exits zero and emits no new type errors.';
    return {
      ...document,
      nonGoals: [...document.nonGoals, 'changing the public API of @voyado/ui'],
    };
  }

  it('appends spec.amended with the patch, and leaves the pre-edit spec readable', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const before = await seedSpecGateRun(db);
      const amendment = await editSpec({
        db,
        runId: SPEC_RUN,
        epoch: 1,
        ts: T0 + minutes(6),
        by: 'ui',
        edited: edited(),
      });

      expect(amendment.to).not.toBe(before.specHash);
      const amended = payloadsOf(db, 'spec.amended');
      expect(amended).toHaveLength(1);
      expect(amended[0]?.from).toBe(before.specHash);
      expect(amended[0]?.to).toBe(amendment.to);
      expect(amended[0]?.patch).toEqual(amendment.patch);

      // Nothing was overwritten: both versions are readable, each at its hash.
      const history = await specHistory(events(db));
      expect(history.map((version) => version.specHash)).toEqual([before.specHash, amendment.to]);
      expect(history[0]?.spec).toEqual(before);

      // And the gate is still open — an edit is not an approval.
      expect(stateOf(db).status).toBe('awaiting-spec-approval');
      expect(kinds(db)).not.toContain('run.spec.approved');
      expect(readWakes(db, SPEC_RUN)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('pins the edited spec when the operator then approves', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await seedSpecGateRun(db);
      const amendment = await editSpec({
        db,
        runId: SPEC_RUN,
        epoch: 1,
        ts: T0 + minutes(6),
        by: 'ui',
        edited: edited(),
      });
      await approveSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0 + minutes(7), by: 'ui' });

      expect(payloadsOf(db, 'run.spec.approved')[0]?.specHash).toBe(amendment.to);
      expect(payloadsOf(db, 'spec.pinned')[0]?.specHash).toBe(amendment.to);
    } finally {
      db.close();
    }
  });

  it('refuses an edit that breaks the criteria contract, and leaves the gate open', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const before = await seedSpecGateRun(db);
      const broken = framed();
      const target = broken.acceptanceCriteria[0];
      if (target === undefined) throw new Error('the fixture has no acceptance criteria');
      delete (target as { verifiedBy?: unknown }).verifiedBy;

      await expect(
        editSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0, by: 'ui', edited: broken }),
      ).rejects.toThrow(/must name at least one gate in verifiedBy/);

      expect(kinds(db)).not.toContain('spec.amended');
      expect(kinds(db)).not.toContain('node.failed');
      expect(stateOf(db).status).toBe('awaiting-spec-approval');
      expect(stateOf(db).specHash).toBe(before.specHash);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-10-S15 / test plan #7 — rejection re-frames ─────────────────────────

suite('EPIC-10-S15 — rejection is not abandonment', () => {
  const REASON = 'The criteria are untestable and you missed that packages/legacy is frozen.';

  it('records the reason, keeps the rejected spec, and schedules a second framing attempt', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const rejectedSpec = await seedSpecGateRun(db);
      const outcome = await rejectSpec({
        db,
        runId: SPEC_RUN,
        epoch: 1,
        ts: T0 + minutes(9),
        by: 'ui',
        reason: REASON,
        provider: 'claude-code',
      });

      expect(outcome.attempt).toBe(1);
      expect(outcome.rejected.specHash).toBe(rejectedSpec.specHash);
      expect(outcome.reason).toBe(REASON);

      const responded = payloadsOf(db, 'human.responded');
      expect(responded[0]?.optionId).toBe('reject');
      expect(responded[0]?.text).toBe(REASON);

      // A second framing attempt, and nothing else: no plan, no worktree.
      const scheduled = payloadsOf(db, 'node.scheduled');
      expect(scheduled.map((payload) => payload.node)).toEqual([FRAMING_NODE, FRAMING_NODE]);
      expect(kinds(db)).not.toContain('plan.proposed');
      expect(kinds(db)).not.toContain('workspace.worktree_created');

      // The rejected spec stays addressable at its own hash.
      const history = await specHistory(events(db));
      expect(history.map((version) => version.specHash)).toEqual([rejectedSpec.specHash]);
      // And the gate is closed until the next attempt reopens it.
      expect(readWakes(db, SPEC_RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('stops at the third rejection with needs_human and schedules no fourth attempt', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      await seedSpecGateRun(db);

      for (let round = 0; round < SPEC_REJECTION_LIMIT; round += 1) {
        if (round > 0) {
          // Each attempt returns a spec and reopens the gate. The document does
          // not have to differ for the churn count to be about attempts.
          const { openSpecApprovalGate } = await import('../../src/spec/gate.ts');
          openSpecApprovalGate({
            db,
            runId: SPEC_RUN,
            epoch: 1,
            ts: T0 + minutes(10 * round),
            document: framed(),
          });
        }
        await rejectSpec({
          db,
          runId: SPEC_RUN,
          epoch: 1,
          ts: T0 + minutes(10 * round + 1),
          by: 'ui',
          reason: `${REASON} (${round})`,
          provider: 'claude-code',
        });
      }

      const needsHuman = payloadsOf(db, 'run.needs_human');
      expect(needsHuman).toHaveLength(1);
      expect(needsHuman[0]?.reason).toBe('churn');
      expect(stateOf(db).status).toBe('needs-human');

      // Two re-framing attempts were scheduled, not three: the third rejection
      // stops rather than trying again.
      expect(payloadsOf(db, 'node.scheduled')).toHaveLength(1 + SPEC_REJECTION_LIMIT - 1);
    } finally {
      db.close();
    }
  });

  it('abandons the run cleanly, leaving every artifact on disk', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await seedSpecGateRun(db);
      const before = events(db).length;

      abandonRun({ db, runId: SPEC_RUN, epoch: 1, ts: T0 + minutes(2), by: 'cli' });

      const aborted = payloadsOf(db, 'run.aborted');
      expect(aborted).toEqual([{ outcome: 'failed', criteriaSatisfied: [] }]);
      expect(stateOf(db).status).toBe('aborted');
      expect(readWakes(db, SPEC_RUN)).toEqual([]);
      // NF8 — nothing was deleted to end the run.
      expect(events(db).length).toBeGreaterThan(before);
      expect(kinds(db)).toContain('run.created');
    } finally {
      db.close();
    }
  });
});

// ── EPIC-10-S29 / test plan #8 — a mid-run edit ──────────────────────────────

suite('EPIC-10-S29 — a mid-run spec edit re-pins and forces revalidation', () => {
  const PLAN_HASH = `sha256-${'a'.repeat(64)}`;

  /** A run past the gate, executing plan version 3. */
  async function running(db: Db, criteria: readonly string[]): Promise<void> {
    await seedSpecGateRun(db);
    await approveSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0 + minutes(4), by: 'ui' });
    appendEvents(db, [
      {
        runId: SPEC_RUN,
        ts: T0 + minutes(5),
        kind: 'plan.proposed',
        v: 1,
        epoch: 1,
        payload: {
          version: 3,
          planHash: PLAN_HASH,
          graph: planCovering(criteria, PLAN_HASH),
          by: 'planner',
        },
      },
      {
        runId: SPEC_RUN,
        ts: T0 + minutes(5),
        kind: 'run.started',
        v: 1,
        epoch: 1,
        payload: { planHash: PLAN_HASH },
      },
    ]);
  }

  /** S29's edit: a new criterion nothing in the plan covers. */
  function withAc8(): Record<string, unknown> {
    const document = framed();
    return {
      ...document,
      acceptanceCriteria: [
        ...document.acceptanceCriteria,
        {
          id: 'ac-8',
          statement: 'No component may import from packages/legacy.',
          verifiedBy: ['import-lint'],
        },
      ],
    };
  }

  it('re-pins at the new hash and revalidates against the current plan', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await running(db, ['ac-1', 'ac-2', 'ac-8']);
      const amendment = await editSpec({
        db,
        runId: SPEC_RUN,
        epoch: 1,
        ts: T0 + minutes(20),
        by: 'ui',
        edited: withAc8(),
      });

      expect(amendment.revalidation).toEqual([]);
      const pins = payloadsOf(db, 'spec.pinned');
      expect(pins).toHaveLength(2);
      expect(pins[1]?.specHash).toBe(amendment.to);
      // The edit is the operator approving the edited spec, so the run keeps
      // running against a digest gates can resolve.
      expect(stateOf(db).specApproved).toEqual({ specHash: amendment.to, by: 'ui' });
      expect(stateOf(db).status).toBe('running');
    } finally {
      db.close();
    }
  });

  it('drives the run to needs_human when a criterion reaches no gate', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await running(db, ['ac-1', 'ac-2']);
      const amendment = await editSpec({
        db,
        runId: SPEC_RUN,
        epoch: 1,
        ts: T0 + minutes(20),
        by: 'ui',
        edited: withAc8(),
      });

      expect(amendment.revalidation.map((issue) => issue.criterion)).toEqual(['ac-8']);
      const needsHuman = payloadsOf(db, 'run.needs_human');
      expect(needsHuman).toHaveLength(1);
      expect(needsHuman[0]?.reason).toBe('spec-revalidation');
      expect(String(needsHuman[0]?.detail)).toContain('ac-8');

      const state = stateOf(db);
      expect(state.status).toBe('needs-human');
      // Running nodes are not killed — the run stops scheduling new ones.
      expect(kinds(db)).not.toContain('node.cancelled');
      expect(decide(state, T0 + minutes(21)).filter((c) => c.kind === 'StartNode')).toEqual([]);
      // The edit is still recorded, and both versions are still readable.
      const history = await specHistory(events(db));
      expect(history).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

// ── AC1 — the spec on the gate is the one that was framed ────────────────────

suite('the rendered prompt is the framed document, not a summary of it', () => {
  it('contains every acceptance criterion the sealed spec carries', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      await seedSpecGateRun(db);
      const prompt = String(payloadsOf(db, 'human.requested')[0]?.prompt);
      const spec = await sealTaskSpec(framed());
      for (const criterion of spec.acceptanceCriteria) {
        expect(prompt).toContain(criterion.statement);
      }
      expect(prompt).not.toContain(REPO);
    } finally {
      db.close();
    }
  });
});

/** Referenced so the plan builder above is not dead code when a case is
 * skipped; also documents that the fixture spec's third criterion needs no
 * gate because it is unverifiable. */
export type { PlanGraph };
