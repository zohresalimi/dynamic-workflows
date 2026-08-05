/**
 * EPIC-04-S22 — making "this effect was executed twice" observable.
 *
 * The crash-fuzz suite's first invariant is "no effect ran twice", and it is
 * deliberately not checked against the effect journal: the journal is the
 * mechanism that is supposed to prevent the second execution, so reading it
 * back to ask whether one happened proves only that it agrees with itself
 * (docs/14-testing-strategy.md §11). One line per invocation, written by the
 * child itself, turns the question into a duplicate-key check on a text file.
 *
 * The third suite is the distinction the whole effect journal rests on:
 * crash-resume (same attempt, memoise) and failure-retry (new attempt,
 * re-execute) are different operations, so a log keyed only on
 * `(runId, nodeId)` would make them indistinguishable.
 *
 * Verifies: EPIC-04-S22 · AC6 · test plan row 7
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { scenarioPath, spawnMockAgent } from '../support/harness.ts';

let dir = '';
let logPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'DeFlow-'));
  logPath = join(dir, 'effects.log');
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(dir, { recursive: true, force: true });
});

interface Effect {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

async function readLog(): Promise<Effect[]> {
  const text = await readFile(logPath, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Effect);
}

/** Runs the binary to completion, closing stdin immediately. */
async function invoke(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const agent = spawnMockAgent(args, {
    env: { ...process.env, DeFlow_SIDE_EFFECT_LOG: logPath, ...env },
  });
  return agent.finish();
}

suite('EPIC-04-S22 — one line per invocation', () => {
  it('writes exactly one line carrying the four fields verbatim from argv', async () => {
    const exit = await invoke([
      '--seed',
      '42',
      '--run-id',
      'r1',
      '--node-id',
      'n3',
      '--attempt',
      '1',
      '--ikey',
      'r1/n3/1/0',
    ]);
    expect(exit.code).toBe(0);

    expect(await readLog()).toEqual([
      { runId: 'r1', nodeId: 'n3', attempt: 1, idempotencyKey: 'r1/n3/1/0' },
    ]);
  });

  it('reads the same four fields from the environment when argv is silent', async () => {
    // DeFlowd passes them one way or the other depending on how the adapter
    // builds its argv, and a fixture that only worked one way would look green
    // right up until the adapter changed.
    await invoke(['--seed', '42'], {
      DeFlow_RUN_ID: 'r1',
      DeFlow_NODE_ID: 'n3',
      DeFlow_ATTEMPT: '1',
      DeFlow_IKEY: 'r1/n3/1/0',
    });

    expect(await readLog()).toEqual([
      { runId: 'r1', nodeId: 'n3', attempt: 1, idempotencyKey: 'r1/n3/1/0' },
    ]);
  });

  it('logs a scripted invocation too, not only the built-in turn', async () => {
    await invoke(['--seed', '42', '--scenario', scenarioPath('streaming-cadence.jsonc')], {
      DeFlow_RUN_ID: 'r1',
      DeFlow_NODE_ID: 'n3',
      DeFlow_ATTEMPT: '2',
      DeFlow_IKEY: 'r1/n3/2/0',
    });
    expect(await readLog()).toHaveLength(1);
  });
});

suite('EPIC-04-S22 — a duplicate is a duplicate key, not an inference', () => {
  it('records two lines under one idempotencyKey when the same node runs twice', async () => {
    const args = [
      '--seed',
      '42',
      '--run-id',
      'r1',
      '--node-id',
      'n3',
      '--attempt',
      '1',
      '--ikey',
      'r1/n3/1/0',
    ];
    await invoke(args);
    await invoke(args);

    const byKey = new Map<string, number>();
    for (const effect of await readLog()) {
      byKey.set(effect.idempotencyKey, (byKey.get(effect.idempotencyKey) ?? 0) + 1);
    }
    expect([...byKey.entries()]).toEqual([['r1/n3/1/0', 2]]);
  });
});

suite('EPIC-04-S22 — a retry is not a duplicate', () => {
  it('keeps attempt 1 and attempt 2 under different keys', async () => {
    const at = (attempt: number) => [
      '--seed',
      '42',
      '--run-id',
      'r1',
      '--node-id',
      'n3',
      '--attempt',
      String(attempt),
      '--ikey',
      `r1/n3/${attempt}/0`,
    ];
    await invoke(at(1));
    await invoke(at(2));

    const entries = await readLog();
    expect(entries.map((effect) => effect.idempotencyKey)).toEqual(['r1/n3/1/0', 'r1/n3/2/0']);
    expect(new Set(entries.map((effect) => effect.idempotencyKey)).size).toBe(2);
  });
});

suite('EPIC-04-S22 — the variable is optional', () => {
  it('creates no file and completes the turn when it is unset', async () => {
    const agent = spawnMockAgent(['--seed', '42'], {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'DeFlow_SIDE_EFFECT_LOG'),
      ) as NodeJS.ProcessEnv,
    });
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
    expect(existsSync(logPath)).toBe(false);
  });
});
