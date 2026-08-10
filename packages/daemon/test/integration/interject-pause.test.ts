/**
 * KAR-13.3 — `pause-and-inject` over a real file-backed ledger and the real
 * effect journal (EPIC-13-S19).
 *
 * The claim under test is the one that would fail *only in production*: an
 * interjection must not look like a retry. `attempt` is part of every
 * idempotency key (docs/05-durable-execution.md §9.2), so a resume that minted
 * a new attempt would re-run every effect the node had already paid for — and
 * a resume that reset a runtime ordinal counter would hand effect number three
 * the key of effect number one, read that row's `done` result and memoise
 * **the wrong answer**, silently.
 *
 * So this drives the real `createEffectRunner` across the pause and asserts on
 * the journal and on a real side-effect log, exactly as `effect-ordinal.test.ts`
 * does for the crash case. A pause-and-inject is an interruption of the same
 * shape as a crash, which is why the property is worth asserting here rather
 * than only in EPIC-06.
 *
 * No fake timers anywhere: a child process is alive (docs/14-testing-strategy.md
 * §8).
 *
 * Verifies: EPIC-13-S19 · AC3, AC4 · test plan #6
 */
import type { Db } from '@DeFlow/core';
import { EventSeqSchema, initialRunState, interjectionsOf } from '@DeFlow/core';
import { openLedger, readEffects, readRange, replayAll } from '@DeFlow/ledger';
import {
  duplicateIdempotencyKeys,
  it,
  readSideEffectLog,
  TestClock,
  waitFor,
} from '@DeFlow/testkit';
import { join } from 'node:path';
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import { interjectIntoNode, recordInterjectionsDelivered } from '../../src/human/interject.ts';
import { createEffectRunner, type Effect, type EffectCtx } from '../../src/index.ts';
import {
  EPOCH,
  GUIDANCE,
  IMPL,
  INTERJECT_RUN,
  seedInterjectRun,
  T0,
} from './support/interject-run.ts';

const HASH = `sha256-${'a'.repeat(64)}`;

/** An effect that really spawns the fake agent, so "ran once" is observable. */
const agentEffect = (binary: string, log: string): Effect<string> => ({
  runId: INTERJECT_RUN,
  nodeId: IMPL,
  attempt: 1,
  kind: 'agent',
  requestHash: HASH,
  async perform(ctx: EffectCtx): Promise<string> {
    await execa(binary, ['--print'], {
      env: {
        DeFlow_SIDE_EFFECT_LOG: log,
        DeFlow_RUN_ID: INTERJECT_RUN,
        DeFlow_NODE_ID: IMPL,
        DeFlow_ATTEMPT: '1',
        DeFlow_IKEY: ctx.ikey,
      },
    });
    return ctx.ikey;
  },
});

const events = (db: Db) => readRange(db, INTERJECT_RUN, 0, 500).events;

const countOf = (db: Db, kind: string): number =>
  events(db).filter((event) => event.kind === kind).length;

const stateOf = (db: Db) => replayAll(db).runs.get(INTERJECT_RUN) ?? initialRunState();

const runner = (db: Db) =>
  createEffectRunner({
    db,
    clock: new TestClock(T0),
    daemonStartedAt: T0,
    epoch: EPOCH,
  });

suite('EPIC-13-S19 — suspend, rebuild the packet, resume (AC3)', () => {
  it('resumes on the same attempt with the ordinal sequence continuing', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const db = openLedger(tmp);
    try {
      seedInterjectRun(db);

      // Two effects complete before the Operator says anything.
      const before = [
        await runner(db).durable(agentEffect(agentPath.binary, log)),
        await runner(db).durable(agentEffect(agentPath.binary, log)),
      ];
      expect(before).toEqual([`${INTERJECT_RUN}/${IMPL}/1/0`, `${INTERJECT_RUN}/${IMPL}/1/1`]);

      const posted = interjectIntoNode({
        db,
        runId: INTERJECT_RUN,
        nodeId: IMPL,
        text: GUIDANCE,
        mode: 'pause-and-inject',
        epoch: EPOCH,
        ts: T0 + 1000,
      });
      expect(posted.status).toBe('ok');

      // The node is suspended at the boundary, on the attempt it was running.
      const paused = stateOf(db);
      expect(paused.nodes[IMPL]?.status).toBe('suspended');
      expect(paused.nodes[IMPL]?.suspension).toEqual({ kind: 'human' });
      expect(paused.nodes[IMPL]?.attempt).toBe(1);

      // The packet is re-assembled with the guidance in it; the receipt is what
      // ends the pause.
      recordInterjectionsDelivered({
        db,
        runId: INTERJECT_RUN,
        nodeId: IMPL,
        seqs: interjectionsOf(paused, IMPL).map((one) => EventSeqSchema.parse(one.seq)),
        epoch: EPOCH,
        ts: T0 + 2000,
      });

      const resumed = stateOf(db);
      expect(resumed.nodes[IMPL]?.status).toBe('running');
      expect(resumed.nodes[IMPL]?.attempt).toBe(1);
      expect(interjectionsOf(resumed, IMPL).map((one) => one.delivery)).toEqual(['delivered']);

      // The third effect continues the ordinal sequence rather than restarting.
      const third = await runner(db).durable(agentEffect(agentPath.binary, log));
      expect(third).toBe(`${INTERJECT_RUN}/${IMPL}/1/2`);
      expect(readEffects(db, INTERJECT_RUN).map((row) => row.ordinal)).toEqual([0, 1, 2]);

      // No retry was scheduled and nothing was cancelled: the run was not
      // discarded, it was steered.
      expect(countOf(db, 'node.retry.scheduled')).toBe(0);
      expect(countOf(db, 'node.cancelled')).toBe(0);
      expect(countOf(db, 'run.cancel.requested')).toBe(0);
      expect(countOf(db, 'human.interjected')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('memoises the effects that completed before the pause, never re-running them', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const db = openLedger(tmp);
    try {
      seedInterjectRun(db);

      const first = agentEffect(agentPath.binary, log);
      await runner(db).durable({ ...first, ordinal: 0 });
      await runner(db).durable({ ...first, ordinal: 1 });

      interjectIntoNode({
        db,
        runId: INTERJECT_RUN,
        nodeId: IMPL,
        text: GUIDANCE,
        mode: 'pause-and-inject',
        epoch: EPOCH,
        ts: T0 + 1000,
      });

      // The resumed attempt re-enters the two effects it already ran. Both come
      // back from the journal; neither spawns anything.
      await waitFor(() => readSideEffectLog(log).entries.length === 2, {
        describe: 'the two pre-pause effects to have been performed exactly once each',
      });
      expect(await runner(db).durable({ ...first, ordinal: 0 })).toBe(
        `${INTERJECT_RUN}/${IMPL}/1/0`,
      );
      expect(await runner(db).durable({ ...first, ordinal: 1 })).toBe(
        `${INTERJECT_RUN}/${IMPL}/1/1`,
      );

      const entries = readSideEffectLog(log).entries;
      expect(entries).toHaveLength(2);
      expect(duplicateIdempotencyKeys(entries)).toEqual([]);
      expect(readEffects(db, INTERJECT_RUN).every((row) => row.state === 'done')).toBe(true);
    } finally {
      db.close();
    }
  });
});
