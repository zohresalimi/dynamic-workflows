/**
 * KAR-14.2 — a ceiling pauses a real run, and the run comes back from it.
 *
 * Everything here is a real file-backed ledger, the real `decide()`, the real
 * effect journal and a real child process per attempt — the fake agent binary,
 * which appends one line per invocation to a log of its own. That log, and not
 * the journal, is what "executed twice" is checked against: the journal is the
 * mechanism that is supposed to prevent a second execution, so reading it back
 * to ask whether one happened proves only that it agrees with itself.
 *
 * The four scenarios are the story in order. The trip stops admission and
 * leaves everything intact (S8); raising the ceiling and resuming continues the
 * run without re-executing a thing (S9); a node ceiling stops one branch and
 * not its siblings (S11); and a `kill -9` between the trip and the resume
 * changes none of it, because the pause is an event rather than a flag (S12).
 *
 * Verifies: EPIC-14-S8, EPIC-14-S9, EPIC-14-S11, EPIC-14-S12 ·
 * KAR-14.2 AC2, AC3, AC4, AC5, AC6, AC7, AC10 · test plan #6, #7, #8, #9
 */
import {
  decide,
  type EventSeq,
  initialRunState,
  type NodeFailure,
  type NodeId,
  seededRandom,
} from '@DeFlow/core';
import {
  appendEvents,
  type Db,
  openLedger,
  readEffects,
  readRange,
  readWake,
  replayAll,
} from '@DeFlow/ledger';
import {
  type Crashable,
  it,
  readSideEffectLog,
  startCrashable,
  TestClock,
  waitFor,
} from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { recordNodeFailure } from '../../src/index.ts';
import { runUntilSettled } from '../support/run-loop.ts';
import {
  BRANCHES,
  BUDGET_RUN,
  ceilingSet,
  draft,
  LEAVES,
  leafOf,
  RECON,
  seedBudgetRun,
  T0,
} from './support/budget-run.ts';

const HOUR = 3_600_000;

/** What every node's completion reports having spent. Four nodes, $0.40. */
const SPEND_PER_NODE = 0.1;

const CRASH_SCRIPT = fileURLToPath(new URL('./support/budget-then-hang.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

interface LoopOptions {
  readonly clock?: TestClock;
  readonly costUsdPerNode?: (node: NodeId) => number;
  readonly tickStepMs?: number;
  readonly failFirstAttempt?: ReadonlySet<string>;
}

/** One pass of the real loop over `db`, until the run ends or halts. */
const drive = (db: Db, tmp: string, agent: string, options: LoopOptions = {}) =>
  runUntilSettled(
    {
      db,
      runId: BUDGET_RUN,
      clock: options.clock ?? new TestClock(T0),
      epoch: 1,
      daemonStartedAt: T0,
      random: seededRandom(11),
      agent,
      sideEffects: join(tmp, 'side-effects.ndjson'),
      costUsdPerNode: options.costUsdPerNode ?? (() => SPEND_PER_NODE),
      ...(options.tickStepMs === undefined ? {} : { tickStepMs: options.tickStepMs }),
      ...(options.failFirstAttempt === undefined
        ? {}
        : { failFirstAttempt: options.failFirstAttempt }),
      budgetMs: 30_000,
    },
    () => false,
  );

/** Every event of the run, oldest first. Bounded, and the bound is asserted. */
function ledger(db: Db) {
  const page = readRange(db, BUDGET_RUN, 0, 500);
  expect(page.hasMore, 'the fixture run outgrew this spec’s page').toBe(false);
  return page.events;
}

const kinds = (db: Db): string[] => ledger(db).map((event) => event.kind);

const rows = (db: Db, kind: string) => ledger(db).filter((event) => event.kind === kind);

const payload = (db: Db, kind: string): Record<string, unknown> =>
  (rows(db, kind)[0]?.payload ?? {}) as Record<string, unknown>;

suite('EPIC-14-S8 — the cost ceiling pauses the run and stops admission (test plan #6)', () => {
  it('appends the three in one transaction and admits nothing after them', async ({
    tmp,
    agentPath,
  }) => {
    const db = openLedger(tmp);
    try {
      // $0.25 against $0.10 a node: recon and one branch fit, the third
      // completion crosses it.
      seedBudgetRun(db, [ceilingSet('run', { costUsd: 0.25 })]);

      const result = await drive(db, tmp, agentPath.binary);

      expect(result.state.status).toBe('paused');

      const trip = rows(db, 'budget.exceeded');
      expect(trip).toHaveLength(1);
      expect(trip[0]?.payload).toMatchObject({
        scope: 'run',
        dimension: 'cost',
        limit: 0.25,
        failureClass: 'gate',
        firedBy: 'deflow',
      });
      // AC7 — the figure carries how it was measured, so an operator can see
      // whether a bill or an estimate stopped the run.
      expect(trip[0]?.payload).toMatchObject({
        basis: { vendorReported: expect.any(Number), estimateDriven: false },
      });
      expect(Number((trip[0]?.payload as { actual: number }).actual)).toBeGreaterThan(0.25);

      // AC2 — one transaction. Three adjacent seqs with nothing interleaved is
      // what a single `BEGIN IMMEDIATE` looks like from outside, and it is the
      // property that makes "exceeded but not paused" an unreachable state.
      const tripSeq = trip[0]?.seq ?? 0;
      const after = readRange(db, BUDGET_RUN, tripSeq - 1, 3).events;
      expect(after.map((event) => event.kind)).toEqual([
        'budget.exceeded',
        'run.paused',
        'run.needs_human',
      ]);
      expect(after.map((event) => event.seq)).toEqual([tripSeq, tripSeq + 1, tripSeq + 2]);

      expect(payload(db, 'run.paused')).toMatchObject({ by: 'policy' });
      expect(payload(db, 'run.needs_human')).toMatchObject({ reason: 'budget' });

      // AC3 — nothing was admitted after the trip.
      const startedAfter = rows(db, 'node.started').filter((event) => event.seq > tripSeq);
      expect(startedAfter).toEqual([]);
      // …and the run really did have something left to admit: every leaf is
      // still `scheduled`, so "nothing was admitted" is a claim about the
      // ceiling rather than about a plan that had run out of work.
      const pending = LEAVES.filter((leaf) => result.state.nodes[leaf]?.status !== 'completed');
      expect(pending.length).toBeGreaterThan(0);

      // The pause is not a cancel: nothing was torn down.
      expect(kinds(db)).not.toContain('node.cancelled');
      expect(kinds(db)).not.toContain('run.aborted');
    } finally {
      db.close();
    }
  });

  it('records a class that is a gate, never permanent and never transient (AC2)', async ({
    tmp,
    agentPath,
  }) => {
    const db = openLedger(tmp);
    try {
      seedBudgetRun(db, [ceilingSet('run', { costUsd: 0.25 })]);
      await drive(db, tmp, agentPath.binary);

      const recorded = payload(db, 'budget.exceeded').failureClass;
      expect(recorded).toBe('gate');
      expect(recorded).not.toBe('permanent');
      expect(recorded).not.toBe('transient');
      // A ceiling is not a node failure at all: nothing failed here.
      expect(rows(db, 'node.failed')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('trips a wall-clock ceiling on the injected clock alone (AC10)', async ({
    tmp,
    agentPath,
  }) => {
    const db = openLedger(tmp);
    try {
      seedBudgetRun(db, [ceilingSet('run', { wallclockMs: 6 * HOUR })]);
      const clock = new TestClock(T0);

      // Three hours of *injected* time per tick, so the six-hour ceiling is
      // crossed in the milliseconds this spec actually takes. No timer exists
      // to fake, and no child process is frozen: the scheduler's whole view of
      // time is the `now` the loop hands `decide()`.
      const result = await drive(db, tmp, agentPath.binary, { clock, tickStepMs: 3 * HOUR });

      expect(result.state.status).toBe('paused');
      expect(clock.now() - T0).toBeGreaterThan(6 * HOUR);
      expect(payload(db, 'budget.exceeded')).toMatchObject({
        scope: 'run',
        dimension: 'wallclock',
        limit: 6 * HOUR,
      });
    } finally {
      db.close();
    }
  });
});

suite('EPIC-14-S9 — a paused run retains full state and resumes (test plan #7)', () => {
  it('resumes without re-executing a completed node, and finishes', async ({ tmp, agentPath }) => {
    const db = openLedger(tmp);
    const sideEffects = join(tmp, 'side-effects.ndjson');
    try {
      seedBudgetRun(db, [ceilingSet('run', { costUsd: 0.25 })]);

      const paused = await drive(db, tmp, agentPath.binary);
      expect(paused.state.status).toBe('paused');

      const completedAtPause = Object.entries(paused.state.nodes)
        .filter(([, node]) => node.status === 'completed')
        .map(([id]) => id);
      expect(completedAtPause.length).toBeGreaterThan(1);
      const startsBefore = rows(db, 'node.started').length;
      const journalBefore = readEffects(db, BUDGET_RUN).map((row) => row.ikey);
      const spentBefore = paused.state.budget.run.costUsd.subscription;

      // The operator raises the ceiling and says continue. Both are events:
      // a ceiling that lived anywhere else would not survive the restart that
      // so often follows a pause.
      appendEvents(db, [
        ceilingSet('run', { costUsd: 5 }, { source: 'operator' }),
        draft('run.resumed', { by: 'user' }),
      ]);

      const finished = await drive(db, tmp, agentPath.binary);

      expect(finished.state.status).toBe('completed');
      expect(finished.state.outcome).toBe('succeeded');

      // Every node that had completed is still completed, and none of them was
      // started again — the whole promise of the resume path.
      for (const node of completedAtPause) {
        expect(finished.state.nodes[node]?.status).toBe('completed');
        expect(finished.state.nodes[node]?.result).not.toBeNull();
      }
      const restarted = rows(db, 'node.started')
        .slice(startsBefore)
        .map((event) => (event.payload as { node: string }).node);
      expect(restarted.filter((node) => completedAtPause.includes(node))).toEqual([]);

      // The effect journal kept its entries: the ikeys that existed before the
      // pause are still there, still `done`, and no key appears twice.
      const journalAfter = readEffects(db, BUDGET_RUN);
      for (const ikey of journalBefore) {
        expect(journalAfter.find((row) => row.ikey === ikey)?.state).toBe('done');
      }
      const log = readSideEffectLog(sideEffects);
      expect(log.malformed).toBe(0);
      const invocations = log.entries.map((entry) => entry.idempotencyKey);
      expect(new Set(invocations).size).toBe(invocations.length);

      // Nothing that belonged to work already finished was touched by the
      // resume: no effect, no fact and no workspace event names a node that had
      // already completed when the run paused. A worktree, a branch and a
      // blackboard fact are all downstream of exactly these events, so a resume
      // that disturbed one would have had to append one.
      const resumedSeq = rows(db, 'run.resumed')[0]?.seq ?? 0;
      const disturbed = ledger(db)
        .filter((event) => event.seq > resumedSeq)
        .filter(
          (event) =>
            event.kind.startsWith('effect.') ||
            event.kind.startsWith('fact.') ||
            event.kind.startsWith('workspace.'),
        )
        .filter((event) => completedAtPause.includes(String(event.nodeId)));
      expect(disturbed).toEqual([]);
      // The claim is only worth making if the resume did something at all.
      expect(ledger(db).filter((event) => event.seq > resumedSeq).length).toBeGreaterThan(0);

      // The rollup still holds what was spent before the pause.
      const spentAfter = finished.state.budget.run.costUsd.subscription ?? 0;
      expect(spentAfter).toBeGreaterThanOrEqual(spentBefore ?? 0);
      // The plan is the one it was paused on.
      expect(finished.state.planVersion).toBe(paused.state.planVersion);
      expect(finished.state.planHash).toBe(paused.state.planHash);
    } finally {
      db.close();
    }
  });

  it('pauses again if the ceiling was not actually raised', async ({ tmp, agentPath }) => {
    const db = openLedger(tmp);
    try {
      seedBudgetRun(db, [ceilingSet('run', { costUsd: 0.25 })]);
      await drive(db, tmp, agentPath.binary);

      appendEvents(db, [draft('run.resumed', { by: 'user' })]);
      const again = await drive(db, tmp, agentPath.binary);

      expect(again.state.status).toBe('paused');
      expect(rows(db, 'budget.exceeded')).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-14-S11 — a node ceiling suspends one branch; siblings keep running', () => {
  it('suspends the expensive branch and lets the others complete (test plan #9)', async ({
    tmp,
    agentPath,
  }) => {
    const db = openLedger(tmp);
    try {
      const expensive = BRANCHES[0] as string;
      seedBudgetRun(db, [ceilingSet('node', { costUsd: 0.15 })]);

      // One branch burns past its own ceiling on an attempt that *fails*, so
      // there is a retry to withhold — admission is the lever, and a node whose
      // work is already done has nothing left to withhold. Every other node
      // stays well under the same ceiling.
      const result = await drive(db, tmp, agentPath.binary, {
        costUsdPerNode: (node) => (node === expensive ? 0.2 : 0.01),
        failFirstAttempt: new Set([expensive]),
      });

      const trip = rows(db, 'budget.exceeded');
      expect(trip).toHaveLength(1);
      expect(trip[0]?.payload).toMatchObject({ scope: 'node', node: expensive, dimension: 'cost' });

      // The run itself is not paused, and no ask was raised run-wide.
      expect(rows(db, 'run.paused')).toEqual([]);
      expect(rows(db, 'run.needs_human')).toEqual([]);
      expect(result.state.status).not.toBe('paused');

      // The tripping node is suspended for a human; its siblings completed.
      expect(result.state.nodes[expensive]?.status).toBe('suspended');
      expect(result.state.nodes[expensive]?.suspension).toEqual({ kind: 'human' });
      for (const branch of BRANCHES.slice(1)) {
        expect(result.state.nodes[branch]?.status).toBe('completed');
      }

      // And the scopes differ where it counts: the tripped branch's dependent
      // was never admitted, while its siblings' were and finished.
      expect(result.state.nodes[leafOf(expensive)]?.status).not.toBe('completed');
      for (const branch of BRANCHES.slice(1)) {
        expect(result.state.nodes[leafOf(branch)]?.status).toBe('completed');
      }
    } finally {
      db.close();
    }
  });
});

suite('EPIC-14-S14 — the vendor’s own ceiling pauses; it is never retried', () => {
  /** The failure `runShimNode` hands over for an `error_max_budget_usd` turn. */
  const vendorCeilingFailure = (node: string): NodeFailure => ({
    reason: 'budget.cost-exceeded',
    class: 'gate',
    message: 'the agent ended the turn with result subtype error_max_budget_usd',
    detail: {
      subtype: 'error_max_budget_usd',
      stopReason: 'max_budget',
      permissionDenials: 0,
      breach: {
        scope: 'node',
        node,
        dimension: 'cost',
        limit: 2,
        actual: 2.0104,
        firedBy: 'vendor',
      },
    },
    evidence: [],
    occurredAtEvent: 1 as EventSeq,
    attempt: 0,
  });

  it('schedules no retry and takes the same pause path (test plan #10)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedBudgetRun(db, [ceilingSet('run', { costUsd: 25 })]);
      // One node in flight, so there is a real attempt for the vendor to refuse.
      appendEvents(db, [
        draft(
          'node.started',
          {
            node: RECON,
            attempt: 0,
            ikey: `${BUDGET_RUN}/${RECON}/0/0`,
            binary: { path: '/usr/bin/claude', version: '2.1.220', sha256: 'd'.repeat(64) },
          },
          { nodeId: RECON, attempt: 0 },
        ),
      ]);

      const recorded = recordNodeFailure(db, {
        runId: BUDGET_RUN,
        nodeId: RECON,
        failure: vendorCeilingFailure(RECON),
        retry: { maxAttempts: 3, backoff: { base: 20, cap: 200, jitter: 'full' } },
        epoch: 1,
        ts: T0,
        random: seededRandom(3),
      });

      // A gate, not a retry: the vendor will refuse identically three more
      // times, at the cost of three more spawns.
      expect(recorded.plan).toEqual({ action: 'gate' });
      expect(recorded.wakeAt).toBeNull();
      expect(rows(db, 'node.retry.scheduled')).toEqual([]);
      expect(readWake(db, { runId: BUDGET_RUN, nodeId: RECON })).toBeNull();

      // …and the same pause path a DeFlow-side trip takes, with the event
      // recording that it was the vendor's ceiling that fired.
      expect(kinds(db).slice(-5)).toEqual([
        'node.failed',
        'node.suspended',
        'budget.exceeded',
        'run.paused',
        'run.needs_human',
      ]);
      expect(payload(db, 'budget.exceeded')).toMatchObject({
        scope: 'node',
        node: RECON,
        dimension: 'cost',
        limit: 2,
        actual: 2.0104,
        failureClass: 'gate',
        firedBy: 'vendor',
      });
      expect(payload(db, 'run.paused')).toMatchObject({ by: 'policy' });
      expect(payload(db, 'run.needs_human')).toMatchObject({ reason: 'budget' });

      // No second attempt is admitted while the run is paused.
      const state = replayAll(db).runs.get(BUDGET_RUN);
      expect(state?.status).toBe('paused');
      expect(
        decide(state ?? initialRunState(), T0 + 60_000).filter((c) => c.kind === 'StartNode'),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-14-S12 — the pause survives kill -9 and resumes after restart', () => {
  it('comes back paused from the ledger alone, then resumes (test plan #8)', async ({
    tmp,
    agentPath,
  }) => {
    // A child process drives the run to its ceiling and then hangs, so the
    // SIGKILL lands on a daemon that is genuinely alive and holding state in
    // memory — which is the only way to prove none of the pause lived there.
    const ready = join(tmp, 'ready.json');
    const child = startCrashable({ script: CRASH_SCRIPT, args: [tmp, ready] });
    alive.push(child);
    await waitFor(() => existsSync(ready), { describe: 'the child to reach its ceiling' });
    expect(JSON.parse(readFileSync(ready, 'utf8')) as { status: string }).toEqual({
      status: 'paused',
    });
    await child.sigkill();

    const db = openLedger(tmp);
    try {
      // Nothing but the bytes on disk. The pause is reconstructed by folding.
      const state = () => drive(db, tmp, agentPath.binary);

      const before = await state();
      expect(before.state.status).toBe('paused');
      // `seq` is KAR-13.2's addition: the `run.needs_human` that asked, so the
      // approval-queue row it produces can be ordered and deep-linked.
      expect(before.state.needsHuman).toEqual({
        reason: 'budget',
        detail: expect.any(String),
        seq: expect.any(Number),
      });
      // No ceiling trip was ever recorded without the pause that answers it.
      expect(rows(db, 'budget.exceeded').length).toBe(rows(db, 'run.paused').length);
      // And the restarted loop admitted nothing on its first tick.
      expect(before.started).toEqual([]);

      appendEvents(db, [
        ceilingSet('run', { costUsd: 5 }, { source: 'operator' }),
        draft('run.resumed', { by: 'user' }),
      ]);
      const after = await state();

      expect(after.state.status).not.toBe('paused');
      expect(after.started.length).toBeGreaterThan(0);
      expect(db.pragma('integrity_check')).toBe('ok');
    } finally {
      db.close();
    }
  });
});
