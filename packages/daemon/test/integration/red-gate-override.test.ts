/**
 * EPIC-12-S5's third scenario, finished — the two lines EPIC-12 could not
 * automate and handed to KAR-13.1.
 *
 * The flow file for EPIC-12 records the handoff explicitly: the first two lines
 * of that scenario are covered in `packages/gates`, and the last two were
 * blocked on this epic, because `HumanRespondedSchema` carried no responder and
 * there was no way to produce the event at all. Both exist now, so the scenario
 * is finished here against the same wording rather than restated against the
 * milestone rule — which by design reads only verdicts and writes, and so can
 * never be the thing that proves an operator's decision was recorded.
 *
 * What the two lines actually claim, and why this is not a tautology:
 *
 *   - *"the ledger contains `human.responded` with optionId, an at timestamp
 *     and the responder"* — the identity is the whole mechanism. §9.1 ranks
 *     *"there is no override flag"* second of five defences against gates that
 *     stop being treated as gates, and the design's answer is that passing a
 *     red gate is possible but never invisible. An `optionId` with no `by` is
 *     an override flag with extra steps.
 *   - *"the milestone advances only after that event"* — asserted as an
 *     ordering over `seq`, from both ends. Before the response the milestone is
 *     unadvanced; **the response alone does not advance it either**, which is
 *     the negative half that keeps `human.responded` from becoming the override
 *     flag §9.1 says does not exist; and the `pass` that finally advances it is
 *     at a `seq` strictly greater than the response's.
 *
 * File-backed, because the claim is an ordering between rows and the `seq` the
 * rule compares has to be one SQLite really assigned.
 *
 * Verifies: EPIC-12-S5 (third scenario, last two lines), EPIC-13-S1 · AC3
 */
import type { Db, NodeId, RunState } from '@DeFlow/core';
import { initialRunState } from '@DeFlow/core';
import {
  gateVerdictsFromEvents,
  type Milestone,
  type MilestoneStatus,
  milestoneStatus,
} from '@DeFlow/gates';
import { appendEvents, openLedger, readRange, replayAll } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { respondToHumanNode } from '../../src/human/gate.ts';
import {
  driveToTheGate,
  EPOCH,
  GATE,
  HUMAN_RUN,
  SIBLING,
  SPEC_HASH,
  seedHumanRun,
  T0,
} from './support/human-gate-run.ts';

/** One gate, and the milestone that will not advance without it. */
const M1: Milestone = {
  id: 'm1',
  requires: ['unit'],
  scope: ['packages/ui/**'],
} as Milestone;

const verdictDraft = (outcome: 'pass' | 'fail', ts: number) => ({
  runId: HUMAN_RUN,
  ts,
  kind: 'gate.evaluated',
  v: 2,
  epoch: EPOCH,
  payload: {
    gate: 'unit',
    node: 'gate-unit' as NodeId,
    verdict: {
      schemaId: 'DeFlow.verdict.v2',
      outcome,
      gate: 'unit',
      evaluatedNode: SIBLING,
      by: { node: 'gate-unit' as NodeId, provider: 'deflow', model: 'deterministic-gate' },
      criteria: [{ id: 'ac-1', status: outcome === 'pass' ? 'satisfied' : 'unsatisfied' }],
      findings: [],
      summary: `unit ${outcome}`,
      specHash: SPEC_HASH,
    },
  },
});

const events = (db: Db) => readRange(db, HUMAN_RUN, 0, 500).events;

const stateOf = (db: Db): RunState => replayAll(db).runs.get(HUMAN_RUN) ?? initialRunState();

/** The rule's answer over whatever is in the ledger right now. No writes in
 * scope, so nothing here is about staleness — only about the verdict. */
const milestoneNow = (db: Db): MilestoneStatus =>
  milestoneStatus(M1, gateVerdictsFromEvents(events(db)), []);

suite('EPIC-12-S5 third scenario — the only path past a red gate is attributed', () => {
  it('records optionId, an at timestamp and the responder, and advances only after it', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db);
      // The gate goes red before anything else happens.
      appendEvents(db, [verdictDraft('fail', T0 + 1_000)]);

      const clock = new TestClock(T0);
      await driveToTheGate(db, clock);

      // Given a gate whose verdict is "fail".
      expect(milestoneNow(db)).toMatchObject({ advanced: false, reason: 'gate-not-passed' });
      // And a human node was scheduled rather than a flag being offered.
      expect(events(db).filter((event) => event.kind === 'human.requested')).toHaveLength(1);
      expect(stateOf(db).nodes[GATE]?.status).toBe('suspended');

      // When the operator chooses to proceed.
      const at = clock.now() + 60_000;
      const answered = respondToHumanNode({
        db,
        runId: HUMAN_RUN,
        nodeId: GATE,
        optionId: 'yes',
        epoch: EPOCH,
        ts: at,
      });
      expect(answered.status).toBe('ok');

      // Then the ledger contains `human.responded` with optionId, an at
      // timestamp and the responder.
      const responded = events(db).filter((event) => event.kind === 'human.responded');
      expect(responded).toHaveLength(1);
      const decision = responded[0];
      expect(decision?.payload).toMatchObject({
        node: GATE,
        optionId: 'yes',
        at: new Date(at).toISOString(),
        by: 'operator',
      });

      // And the milestone advances only after that event — the response is not
      // itself the thing that advances it. Passing a red gate is possible, and
      // it is never a field somebody set (§9.1).
      expect(milestoneNow(db)).toMatchObject({ advanced: false, reason: 'gate-not-passed' });

      // Only a green does that, and it is strictly later in the ledger than the
      // decision that allowed the work to get there.
      appendEvents(db, [verdictDraft('pass', at + 1_000)]);
      const advanced = milestoneNow(db);
      expect(advanced.advanced).toBe(true);

      const green = events(db)
        .filter((event) => event.kind === 'gate.evaluated')
        .at(-1);
      // Ordered by seq, never by ts — the wall clock is not monotonic.
      expect(green?.seq).toBeGreaterThan(decision?.seq ?? 0);
    } finally {
      db.close();
    }
  });

  it('will not advance on a response alone, whichever option was chosen', async ({ tmp }) => {
    // The same claim as a table, because "advanced stayed false" is only
    // meaningful if it stays false for the option an operator would actually
    // reach for when they mean *"go anyway"*.
    for (const optionId of ['yes', 'guide'] as const) {
      // A directory each: two runs with the same id cannot share one ledger.
      const dataDir = join(tmp, optionId);
      mkdirSync(dataDir, { recursive: true });
      const db = openLedger(dataDir);
      try {
        seedHumanRun(db);
        appendEvents(db, [verdictDraft('fail', T0 + 1_000)]);
        const clock = new TestClock(T0);
        await driveToTheGate(db, clock);

        const answered = respondToHumanNode({
          db,
          runId: HUMAN_RUN,
          nodeId: GATE,
          optionId,
          epoch: EPOCH,
          ts: clock.now() + 60_000,
          ...(optionId === 'guide' ? { text: 'ship it, I looked at the diff myself' } : {}),
        });
        expect(answered.status).toBe('ok');

        expect(milestoneNow(db)).toMatchObject({ advanced: false, reason: 'gate-not-passed' });
      } finally {
        db.close();
      }
    }
  });
});
