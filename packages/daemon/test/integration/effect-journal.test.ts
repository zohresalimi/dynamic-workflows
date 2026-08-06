/**
 * KAR-06.3 — `durable()`: intent first, then act, then record
 * (docs/05-durable-execution.md §8.2).
 *
 * Everything here runs against a real file-backed ledger, and every side
 * effect is a **real invocation of the real fake agent binary**, which appends
 * one line per invocation to a text file of its own. That file, not the effect
 * journal, is what "performed twice" is checked against: the journal is the
 * mechanism that is supposed to prevent the second execution, so reading it
 * back to ask whether one happened proves only that it agrees with itself.
 *
 * The ordering assertion in the first suite is the one that could not be made
 * any other way. Asserting after the fact that the row exists proves nothing
 * about *when* it was written — so the assertion is made from inside
 * `perform()`, at the instant the side effect is about to happen, and it
 * asserts the log is still empty.
 *
 * Verifies: EPIC-06-S8, EPIC-06-S10, EPIC-06-S11, EPIC-06-S17 · AC2–AC5, AC7
 */
import type { EffectRequest, NodeFailure, NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema, requestHash, toNodeFailure } from '@DeFlow/core';
import { journalEffect, markEffectFailed, openLedger, readEffect, readRange } from '@DeFlow/ledger';
import { duplicateIdempotencyKeys, it, readSideEffectLog, TestClock } from '@DeFlow/testkit';
import { join } from 'node:path';
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import {
  createEffectRunner,
  type Effect,
  type EffectCtx,
  EffectFailed,
  EffectNeedsReconciliation,
  EffectRequestHashMismatch,
  type EffectRunner,
} from '../../src/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T090000Z_5c1d2e');
const HASH = `sha256-${'a'.repeat(64)}`;
const OTHER_HASH = `sha256-${'b'.repeat(64)}`;
const DAEMON_STARTED_AT = 1_754_313_000_000;

interface Harness {
  readonly runner: EffectRunner;
  readonly db: ReturnType<typeof openLedger>;
  readonly clock: TestClock;
  readonly log: string;
}

const openHarness = (tmp: string, daemonStartedAt = DAEMON_STARTED_AT): Harness => {
  const db = openLedger(tmp);
  const clock = new TestClock(daemonStartedAt + 1000);
  return {
    db,
    clock,
    log: join(tmp, 'side-effects.ndjson'),
    runner: createEffectRunner({ db, clock, daemonStartedAt, epoch: 1 }),
  };
};

interface AgentEffectOptions {
  readonly node?: NodeId;
  readonly attempt?: number;
  readonly ordinal?: number;
  readonly requestHash?: string;
  /** Runs at the top of `perform()`, before the child is spawned. */
  readonly beforePerform?: (ctx: EffectCtx) => void;
}

/**
 * An effect whose `perform()` really spawns the fake agent binary, which
 * really appends a line to `log`. Nothing here is mocked: the process boundary
 * is a process boundary.
 */
function agentEffect(
  binary: string,
  log: string,
  options: AgentEffectOptions = {},
): Effect<string> & { performed: number } {
  const effect = {
    runId: RUN,
    nodeId: options.node ?? NodeIdSchema.parse('implement'),
    attempt: options.attempt ?? 0,
    ...(options.ordinal === undefined ? {} : { ordinal: options.ordinal }),
    kind: 'agent' as const,
    requestHash: options.requestHash ?? HASH,
    performed: 0,
    async perform(ctx: EffectCtx): Promise<string> {
      effect.performed += 1;
      options.beforePerform?.(ctx);
      await execa(binary, ['--print'], {
        env: {
          DeFlow_SIDE_EFFECT_LOG: log,
          DeFlow_RUN_ID: RUN,
          DeFlow_NODE_ID: effect.nodeId,
          DeFlow_ATTEMPT: String(effect.attempt),
          DeFlow_IKEY: ctx.ikey,
        },
      });
      return `performed ${ctx.ikey}`;
    },
  };
  return effect;
}

const failure = (message: string): NodeFailure => ({
  reason: 'agent.nonzero-exit',
  class: 'permanent',
  message,
  evidence: [],
  occurredAtEvent: 1,
  attempt: 0,
});

suite('the intent row precedes the side effect (EPIC-06-S8, AC2)', () => {
  it('has the row pending and effect.started appended while the log is still empty', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log } = openHarness(tmp);
    const seenAtSideEffect: unknown[] = [];
    try {
      const effect = agentEffect(agentPath.binary, log, {
        beforePerform: (ctx) => {
          seenAtSideEffect.push({
            row: readEffect(db, ctx.ikey),
            events: readRange(db, RUN, 0, 10).events.map((event) => event.kind),
            log: readSideEffectLog(log).entries,
          });
        },
      });

      await runner.durable(effect);

      expect(seenAtSideEffect).toEqual([
        {
          row: {
            ikey: `${RUN}/implement/0/0`,
            runId: RUN,
            nodeId: 'implement',
            attempt: 0,
            ordinal: 0,
            kind: 'agent',
            requestHash: HASH,
            state: 'pending',
            resultJson: null,
            startedAt: DAEMON_STARTED_AT + 1000,
            endedAt: null,
          },
          events: ['effect.started'],
          // The whole point: the world had not been touched yet.
          log: [],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('carries { ikey, kind, requestHash } on the effect.started event', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log } = openHarness(tmp);
    try {
      await runner.durable(agentEffect(agentPath.binary, log));

      const [started] = readRange(db, RUN, 0, 10).events;
      expect(started?.kind).toBe('effect.started');
      expect(started?.payload).toEqual({
        ikey: `${RUN}/implement/0/0`,
        kind: 'agent',
        requestHash: HASH,
      });
    } finally {
      db.close();
    }
  });
});

suite('the result is recorded after the effect (EPIC-06-S8)', () => {
  it('moves the row to done with result_json and ended_at, and appends effect.completed', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log } = openHarness(tmp);
    try {
      const result = await runner.durable(agentEffect(agentPath.binary, log));

      const row = readEffect(db, `${RUN}/implement/0/0`);
      expect(row?.state).toBe('done');
      expect(row?.endedAt).toBe(DAEMON_STARTED_AT + 1000);
      expect(JSON.parse(row?.resultJson ?? 'null')).toBe(result);

      const events = readRange(db, RUN, 0, 10).events;
      expect(events.map((event) => event.kind)).toEqual(['effect.started', 'effect.completed']);
      expect(events[1]?.payload).toEqual({
        ikey: `${RUN}/implement/0/0`,
        result,
        reconciled: false,
      });
      expect(readSideEffectLog(log).entries).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

suite('a concurrent second entry does not double-perform (EPIC-06-S8, AC3)', () => {
  it('leaves one row, one log line, and returns the same value to both callers', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log } = openHarness(tmp);
    try {
      const effect = agentEffect(agentPath.binary, log);
      const [first, second] = await Promise.all([runner.durable(effect), runner.durable(effect)]);

      expect(first).toBe(second);
      expect(effect.performed).toBe(1);
      expect(readSideEffectLog(log).entries).toHaveLength(1);
      expect(readRange(db, RUN, 0, 10).events.map((event) => event.kind)).toEqual([
        'effect.started',
        'effect.completed',
      ]);
    } finally {
      db.close();
    }
  });
});

suite('a done row short-circuits (EPIC-06-S11, AC4)', () => {
  it('memoises through the ledger, not an in-process cache', async ({ tmp, agentPath }) => {
    const first = openHarness(tmp);
    const result = await first.runner.durable(agentEffect(agentPath.binary, first.log));
    first.db.close();

    // A whole new daemon life: new connection, new runner, nothing carried
    // over in memory. Only the ledger survives.
    const second = openHarness(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      const effect = agentEffect(agentPath.binary, second.log, { ordinal: 0 });
      expect(await second.runner.durable(effect)).toBe(result);
      expect(effect.performed).toBe(0);
      expect(readSideEffectLog(second.log).entries).toHaveLength(1);
    } finally {
      second.db.close();
    }
  });

  it('does not re-emit effect.completed for a memoised result', async ({ tmp, agentPath }) => {
    const { runner, db, log } = openHarness(tmp);
    try {
      await runner.durable(agentEffect(agentPath.binary, log));
      await runner.durable(agentEffect(agentPath.binary, log, { ordinal: 0 }));

      expect(readRange(db, RUN, 0, 10).events.map((event) => event.kind)).toEqual([
        'effect.started',
        'effect.completed',
      ]);
    } finally {
      db.close();
    }
  });
});

suite('the adapter is told which situation it is in (EPIC-06-S17)', () => {
  it('says fresh when this call created the intent row', async ({ tmp, agentPath }) => {
    const { runner, db, log } = openHarness(tmp);
    const modes: string[] = [];
    try {
      await runner.durable(
        agentEffect(agentPath.binary, log, {
          beforePerform: (ctx) => {
            modes.push(ctx.mode);
          },
        }),
      );
      expect(modes).toEqual(['fresh']);
    } finally {
      db.close();
    }
  });

  it('says resume when it inherited a row a previous daemon life wrote', async ({
    tmp,
    agentPath,
  }) => {
    const first = openHarness(tmp);
    const ikey = `${RUN}/implement/0/0`;
    journalEffect(
      first.db,
      {
        ikey,
        runId: RUN,
        nodeId: 'implement',
        attempt: 0,
        ordinal: 0,
        kind: 'agent',
        requestHash: HASH,
        startedAt: first.clock.now(),
      },
      {
        runId: RUN,
        ts: first.clock.now(),
        kind: 'effect.started',
        v: 1,
        epoch: 1,
        nodeId: 'implement',
        attempt: 0,
        ikey,
        payload: { ikey, kind: 'agent', requestHash: HASH },
      },
    );
    first.db.close();

    const second = openHarness(tmp, DAEMON_STARTED_AT + 100_000);
    const modes: string[] = [];
    try {
      const effect = agentEffect(agentPath.binary, second.log, {
        ordinal: 0,
        beforePerform: (ctx) => {
          modes.push(ctx.mode);
        },
      });
      // The probe says the effect never landed, so it is safe to perform —
      // and the adapter is told it is re-entering, not starting.
      await second.runner.durable({
        ...effect,
        perform: effect.perform.bind(effect),
        reconcile: async (ctx: EffectCtx) => {
          modes.push(`reconcile:${ctx.mode}`);
          return { status: 'not-started' as const };
        },
      });

      expect(modes).toEqual(['reconcile:resume', 'resume']);
    } finally {
      second.db.close();
    }
  });
});

suite('a failed row is rethrown, not re-run (EPIC-06-S11, AC5)', () => {
  it('throws EffectFailed carrying the stored NodeFailure and does not perform', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log, clock } = openHarness(tmp);
    try {
      const ikey = `${RUN}/implement/0/0`;
      const stored = failure('the agent exited 2');
      journalEffect(
        db,
        {
          ikey,
          runId: RUN,
          nodeId: 'implement',
          attempt: 0,
          ordinal: 0,
          kind: 'agent',
          requestHash: HASH,
          startedAt: clock.now(),
        },
        {
          runId: RUN,
          ts: clock.now(),
          kind: 'effect.started',
          v: 1,
          epoch: 1,
          nodeId: 'implement',
          attempt: 0,
          ikey,
          payload: { ikey, kind: 'agent', requestHash: HASH },
        },
      );
      markEffectFailed(db, ikey, stored, clock.now(), {
        runId: RUN,
        ts: clock.now(),
        kind: 'effect.failed',
        v: 1,
        epoch: 1,
        nodeId: 'implement',
        attempt: 0,
        ikey,
        payload: { ikey, failure: stored },
      });

      const effect = agentEffect(agentPath.binary, log, { ordinal: 0 });
      const thrown = await runner.durable(effect).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(EffectFailed);
      expect((thrown as EffectFailed).failure).toEqual(stored);
      expect((thrown as EffectFailed).ikey).toBe(ikey);
      expect(effect.performed).toBe(0);
      expect(readSideEffectLog(log).entries).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('leaves the retry-or-fail decision to the scheduler by carrying the class untouched', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log, clock } = openHarness(tmp);
    try {
      const ikey = `${RUN}/implement/0/0`;
      const stored: NodeFailure = { ...failure('rate limited'), reason: 'provider.rate-limited' };
      journalEffect(
        db,
        {
          ikey,
          runId: RUN,
          nodeId: 'implement',
          attempt: 0,
          ordinal: 0,
          kind: 'agent',
          requestHash: HASH,
          startedAt: clock.now(),
        },
        {
          runId: RUN,
          ts: clock.now(),
          kind: 'effect.started',
          v: 1,
          epoch: 1,
          nodeId: 'implement',
          attempt: 0,
          ikey,
          payload: { ikey, kind: 'agent', requestHash: HASH },
        },
      );
      markEffectFailed(db, ikey, { ...stored, class: 'transient' }, clock.now(), {
        runId: RUN,
        ts: clock.now(),
        kind: 'effect.failed',
        v: 1,
        epoch: 1,
        nodeId: 'implement',
        attempt: 0,
        ikey,
        payload: { ikey, failure: { ...stored, class: 'transient' } },
      });

      const thrown = (await runner
        .durable(agentEffect(agentPath.binary, log, { ordinal: 0 }))
        .catch((error: unknown) => error)) as EffectFailed;

      // The runner does not retry a transient failure and does not fail the
      // node either. It hands the classified failure up and stops.
      expect(thrown.failure.class).toBe('transient');
    } finally {
      db.close();
    }
  });
});

suite('a pending row from THIS daemon life is ordinary concurrency (EPIC-06-S11)', () => {
  it('does not reconcile, and falls through to perform', async ({ tmp, agentPath }) => {
    const { runner, db, log, clock } = openHarness(tmp);
    let reconciled = 0;
    try {
      const ikey = `${RUN}/implement/0/0`;
      journalEffect(
        db,
        {
          ikey,
          runId: RUN,
          nodeId: 'implement',
          attempt: 0,
          ordinal: 0,
          kind: 'agent',
          requestHash: HASH,
          // After the daemon started: another in-process caller is mid-flight.
          startedAt: clock.now(),
        },
        {
          runId: RUN,
          ts: clock.now(),
          kind: 'effect.started',
          v: 1,
          epoch: 1,
          nodeId: 'implement',
          attempt: 0,
          ikey,
          payload: { ikey, kind: 'agent', requestHash: HASH },
        },
      );

      const effect = agentEffect(agentPath.binary, log, { ordinal: 0 });
      await runner.durable({
        ...effect,
        perform: effect.perform.bind(effect),
        reconcile: async () => {
          reconciled += 1;
          return { status: 'not-started' as const };
        },
      });

      expect(reconciled).toBe(0);
      expect(readSideEffectLog(log).entries).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('but a pending row from a PREVIOUS life is the ambiguous case and never just re-performs', async ({
    tmp,
    agentPath,
  }) => {
    const first = openHarness(tmp);
    const ikey = `${RUN}/implement/0/0`;
    journalEffect(
      first.db,
      {
        ikey,
        runId: RUN,
        nodeId: 'implement',
        attempt: 0,
        ordinal: 0,
        kind: 'agent',
        requestHash: HASH,
        startedAt: first.clock.now(),
      },
      {
        runId: RUN,
        ts: first.clock.now(),
        kind: 'effect.started',
        v: 1,
        epoch: 1,
        nodeId: 'implement',
        attempt: 0,
        ikey,
        payload: { ikey, kind: 'agent', requestHash: HASH },
      },
    );
    first.db.close();

    const second = openHarness(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      const effect = agentEffect(agentPath.binary, second.log, { ordinal: 0 });
      const thrown = await second.runner.durable(effect).catch((error: unknown) => error);

      // KAR-06.4 supplies the probe. Until an effect declares one, the honest
      // answer is "cannot tell" — never "assume it did not happen".
      expect(thrown).toBeInstanceOf(EffectNeedsReconciliation);
      expect(effect.performed).toBe(0);
    } finally {
      second.db.close();
    }
  });
});

suite('request_hash guards a live effect against a plan edit (EPIC-06-S10, AC7)', () => {
  it('raises effect.request-hash-mismatch naming both hashes, and returns no memoised result', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log } = openHarness(tmp);
    try {
      await runner.durable(agentEffect(agentPath.binary, log));

      const edited = agentEffect(agentPath.binary, log, {
        ordinal: 0,
        requestHash: OTHER_HASH,
      });
      const thrown = await runner.durable(edited).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(EffectRequestHashMismatch);
      expect((thrown as Error).message).toContain(HASH);
      expect((thrown as Error).message).toContain(OTHER_HASH);
      expect(edited.performed).toBe(0);
      // A hard error, not a warning: nothing was returned in its place.
      expect(readSideEffectLog(log).entries).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('classifies as reason effect.request-hash-mismatch, class permanent', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log } = openHarness(tmp);
    try {
      await runner.durable(agentEffect(agentPath.binary, log));
      const thrown = await runner
        .durable(agentEffect(agentPath.binary, log, { ordinal: 0, requestHash: OTHER_HASH }))
        .catch((error: unknown) => error);

      const classified = toNodeFailure(thrown, {
        occurredAtEvent: 1,
        attempt: 0,
        captureEvidence: () => `artifact://${'a'.repeat(64)}` as never,
      });
      expect(classified.reason).toBe('effect.request-hash-mismatch');
      expect(classified.class).toBe('permanent');
    } finally {
      db.close();
    }
  });

  it('returns the memoised result normally when the request is unchanged', async ({
    tmp,
    agentPath,
  }) => {
    const { runner, db, log } = openHarness(tmp);
    try {
      const result = await runner.durable(agentEffect(agentPath.binary, log));
      const again = agentEffect(agentPath.binary, log, { ordinal: 0 });

      expect(await runner.durable(again)).toBe(result);
      expect(again.performed).toBe(0);
    } finally {
      db.close();
    }
  });

  /**
   * The test-plan item this suite exists for (#6), wired end to end: the two
   * hashes are computed by `requestHash` from a real node descriptor rather
   * than picked out of the air, so the assertion is that a *permission
   * escalation* invalidates the memoised result — not that two different
   * strings differ.
   */
  it('catches a PlanPatch escalating the permission from worktree to worktree+net', async ({
    tmp,
    agentPath,
  }) => {
    const request: EffectRequest = {
      brief: 'implement the header',
      provider: 'claude',
      model: null,
      permission: 'worktree',
      pathScopes: { write: ['src/**'] },
      reads: [],
      writes: ['src/Header.vue'],
    };
    const before = await requestHash(request);
    const escalated = await requestHash({ ...request, permission: 'worktree+net' });
    // Renaming the node changes nothing the effect does, so it changes no hash.
    const renamed = await requestHash(request);

    const { runner, db, log } = openHarness(tmp);
    try {
      const result = await runner.durable(
        agentEffect(agentPath.binary, log, { requestHash: before }),
      );

      const unrelated = agentEffect(agentPath.binary, log, {
        ordinal: 0,
        requestHash: renamed,
      });
      expect(await runner.durable(unrelated)).toBe(result);
      expect(unrelated.performed).toBe(0);

      const patched = agentEffect(agentPath.binary, log, {
        ordinal: 0,
        requestHash: escalated,
      });
      await expect(runner.durable(patched)).rejects.toBeInstanceOf(EffectRequestHashMismatch);
      expect(patched.performed).toBe(0);
    } finally {
      db.close();
    }
  });
});

suite('crash-resume memoises; failure-retry re-executes (EPIC-06-S17)', () => {
  it('keeps the ikey across a restart of the same attempt, and mints a new one for a retry', async ({
    tmp,
    agentPath,
  }) => {
    const first = openHarness(tmp);
    await first.runner.durable(agentEffect(agentPath.binary, first.log, { attempt: 1 }));
    first.db.close();

    const second = openHarness(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      // Crash-resume: SAME attempt, same key, memoised.
      const resumed = agentEffect(agentPath.binary, second.log, { attempt: 1, ordinal: 0 });
      await second.runner.durable(resumed);
      expect(resumed.performed).toBe(0);
      expect(readSideEffectLog(second.log).entries).toHaveLength(1);

      // Failure-retry: NEW attempt, different key by construction, performed.
      const retried = agentEffect(agentPath.binary, second.log, { attempt: 2 });
      await second.runner.durable(retried);
      expect(retried.performed).toBe(1);

      const entries = readSideEffectLog(second.log).entries;
      expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
        `${RUN}/implement/1/0`,
        `${RUN}/implement/2/0`,
      ]);
      expect(duplicateIdempotencyKeys(entries)).toEqual([]);
    } finally {
      second.db.close();
    }
  });
});
