/**
 * KAR-06.3 AC6 — the ordinal comes from the reducer's view, not a runtime
 * counter (EPIC-06-S9).
 *
 * This is the subtlest bug in the epic and it fails **only after a crash**,
 * which means it fails only in production if it is not tested here. A counter
 * held in the effect runner resets to zero when the process restarts, so the
 * second effect of an interrupted attempt comes back as ordinal 0, collides
 * with the first through `ON CONFLICT DO NOTHING`, reads that first effect's
 * `done` row and memoises **the wrong result** — silently, with no error
 * anywhere.
 *
 * The first suite therefore uses a **real** crash: a separate process that
 * journals one effect and is then `SIGKILL`ed with its whole process group.
 * Simulating it in-process would leave the runner's memory intact, and the
 * runner's memory is the thing under test.
 *
 * No fake timers anywhere in this file — a child process is alive, and faking
 * timers around one deadlocks (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-06-S9 · AC6
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { openLedger, readEffects } from '@DeFlow/ledger';
import {
  duplicateIdempotencyKeys,
  it,
  readSideEffectLog,
  startCrashable,
  TestClock,
  waitFor,
} from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import { createEffectRunner, type Effect, type EffectCtx } from '../../src/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T090000Z_5c1d2e');
const HASH = `sha256-${'a'.repeat(64)}`;
const SCRIPT = fileURLToPath(new URL('./support/journal-one-effect.ts', import.meta.url));

/** An effect that really spawns the fake agent, exactly as the crashed child did. */
const agentEffect = (binary: string, log: string, name: string): Effect<string> => ({
  runId: RUN,
  nodeId: NodeIdSchema.parse(name),
  attempt: 0,
  kind: 'agent',
  requestHash: HASH,
  async perform(ctx: EffectCtx): Promise<string> {
    await execa(binary, ['--print'], {
      env: {
        DeFlow_SIDE_EFFECT_LOG: log,
        DeFlow_RUN_ID: RUN,
        DeFlow_NODE_ID: name,
        DeFlow_ATTEMPT: '0',
        DeFlow_IKEY: ctx.ikey,
      },
    });
    return ctx.ikey;
  },
});

suite('the second effect of an interrupted attempt does not collide (EPIC-06-S9)', () => {
  it('is journalled at ordinal 1 after a SIGKILL, not back at 0', async ({ tmp, agentPath }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const ready = join(tmp, 'ready');
    const child = startCrashable({
      script: SCRIPT,
      args: [tmp, log, agentPath.binary, ready, 'migrate'],
    });

    try {
      await waitFor(() => existsSync(ready), {
        describe: `the first effect to be journalled and performed (${child.stderr()})`,
      });
    } finally {
      await child.sigkill();
    }

    // A new daemon over the same directory. It knows nothing the first one
    // knew except what is on disk.
    const db = openLedger(tmp);
    try {
      const runner = createEffectRunner({
        db,
        clock: new TestClock(2_000_000_000_000),
        daemonStartedAt: 2_000_000_000_000,
        epoch: 1,
      });

      const second = await runner.durable(agentEffect(agentPath.binary, log, 'migrate'));

      expect(second).toBe(`${RUN}/migrate/0/1`);
      expect(readEffects(db, RUN).map((row) => row.ordinal)).toEqual([0, 1]);

      const entries = readSideEffectLog(log).entries;
      expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
        `${RUN}/migrate/0/0`,
        `${RUN}/migrate/0/1`,
      ]);
      // The collision this test exists for would show up here: the second
      // effect memoising the first one's result and never running at all.
      expect(duplicateIdempotencyKeys(entries)).toEqual([]);
      expect(entries).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

suite('the derivation is stable across arbitrarily many restarts (EPIC-06-S9)', () => {
  it('gives five effects ordinals 0..4 exactly once each, reopening between every pair', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const keys: string[] = [];

    for (let life = 0; life < 5; life += 1) {
      // Reopening a fresh connection over the same file is the code path a
      // daemon restart actually takes.
      const db = openLedger(tmp);
      try {
        const startedAt = 2_000_000_000_000 + life * 1000;
        const runner = createEffectRunner({
          db,
          clock: new TestClock(startedAt),
          daemonStartedAt: startedAt,
          epoch: 1,
        });
        keys.push(await runner.durable(agentEffect(agentPath.binary, log, 'migrate')));
      } finally {
        db.close();
      }
    }

    expect(keys).toEqual([
      `${RUN}/migrate/0/0`,
      `${RUN}/migrate/0/1`,
      `${RUN}/migrate/0/2`,
      `${RUN}/migrate/0/3`,
      `${RUN}/migrate/0/4`,
    ]);

    const db = openLedger(tmp);
    try {
      expect(readEffects(db, RUN).map((row) => row.ordinal)).toEqual([0, 1, 2, 3, 4]);
      expect(readEffects(db, RUN).every((row) => row.state === 'done')).toBe(true);
    } finally {
      db.close();
    }
    expect(duplicateIdempotencyKeys(readSideEffectLog(log).entries)).toEqual([]);
  });
});

suite('the counter is derived, never held (EPIC-06-S9 scenario 2)', () => {
  it('separates the effects of two nodes and two attempts without any shared counter', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const db = openLedger(tmp);
    try {
      const runner = createEffectRunner({
        db,
        clock: new TestClock(2_000_000_000_000),
        daemonStartedAt: 2_000_000_000_000,
        epoch: 1,
      });

      const first = await runner.durable(agentEffect(agentPath.binary, log, 'migrate'));
      const other = await runner.durable(agentEffect(agentPath.binary, log, 'implement'));
      const second = await runner.durable(agentEffect(agentPath.binary, log, 'migrate'));

      // A single shared counter would have made `other` ordinal 1 and
      // `second` ordinal 2.
      expect([first, other, second]).toEqual([
        `${RUN}/migrate/0/0`,
        `${RUN}/implement/0/0`,
        `${RUN}/migrate/0/1`,
      ]);
    } finally {
      db.close();
    }
  });
});
