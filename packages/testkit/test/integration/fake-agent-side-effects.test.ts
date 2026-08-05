/**
 * KAR-03.8 — the fake agent's own side-effect log, and the `--seed` that makes
 * everything before the crash deterministic (EPIC-03-S26 background).
 *
 * "No effect executed twice" has to be checked against something the effect
 * journal did not write, or the assertion is the journal marking its own
 * homework: the journal is the mechanism that is *supposed* to prevent the
 * second execution, so reading it back proves only that it is self-consistent.
 * So every invocation of the fake binary appends
 * `{runId, nodeId, attempt, idempotencyKey}` to a text file, and "executed
 * twice" becomes a duplicate-key check on that file.
 *
 * Real invocations of the real linked binary throughout — the whole point of a
 * fake *binary* is that the process boundary is real.
 *
 * Verifies: EPIC-03-S26 (background) · AC5, AC6
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import { duplicateIdempotencyKeys, it, readSideEffectLog } from '../../src/index.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';

interface Invocation {
  readonly node: string;
  readonly attempt: number;
  readonly ikey: string;
  readonly seed?: number;
}

/** Runs the linked fake agent exactly as an effect runner would. */
async function invoke(binary: string, log: string, call: Invocation): Promise<string> {
  const result = await execa(
    binary,
    call.seed === undefined ? ['--print'] : ['--print', '--seed', String(call.seed)],
    {
      env: {
        DeFlow_FAKE_SIDE_EFFECT_LOG: log,
        DeFlow_FAKE_RUN_ID: RUN,
        DeFlow_FAKE_NODE_ID: call.node,
        DeFlow_FAKE_ATTEMPT: String(call.attempt),
        DeFlow_FAKE_IKEY: call.ikey,
      },
    },
  );
  return result.stdout;
}

suite('every invocation appends one line naming the effect it performed', () => {
  it('records runId, nodeId, attempt and idempotencyKey', async ({ tmp, agentPath }) => {
    const log = join(tmp, 'side-effects.ndjson');
    await invoke(agentPath.binary, log, {
      node: 'step-01',
      attempt: 0,
      ikey: `${RUN}/step-01/0/0`,
    });

    const read = readSideEffectLog(log);
    expect(read.entries).toEqual([
      {
        runId: RUN,
        nodeId: 'step-01',
        attempt: 0,
        idempotencyKey: `${RUN}/step-01/0/0`,
      },
    ]);
    expect(read.malformed).toBe(0);
  });

  it('appends rather than truncating, so a restart’s lines join the first life’s', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    for (const node of ['step-01', 'step-02', 'step-03']) {
      await invoke(agentPath.binary, log, { node, attempt: 0, ikey: `${RUN}/${node}/0/0` });
    }

    expect(readSideEffectLog(log).entries).toHaveLength(3);
  });

  it('writes nothing at all when no log is configured', async ({ tmp, agentPath }) => {
    const stdout = await execa(agentPath.binary, ['--print'], { env: {} });
    expect(stdout.exitCode).toBe(0);
    expect(readSideEffectLog(join(tmp, 'absent.ndjson')).entries).toEqual([]);
  });
});

suite('the duplicate-key check is what "executed twice" means', () => {
  it('finds nothing when every invocation carried its own key', async ({ tmp, agentPath }) => {
    const log = join(tmp, 'side-effects.ndjson');
    for (const node of ['step-01', 'step-02']) {
      await invoke(agentPath.binary, log, { node, attempt: 0, ikey: `${RUN}/${node}/0/0` });
    }

    expect(duplicateIdempotencyKeys(readSideEffectLog(log).entries)).toEqual([]);
  });

  it('names the key when the same effect really was performed twice', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const ikey = `${RUN}/step-01/0/0`;
    await invoke(agentPath.binary, log, { node: 'step-01', attempt: 0, ikey });
    await invoke(agentPath.binary, log, { node: 'step-01', attempt: 0, ikey });

    expect(duplicateIdempotencyKeys(readSideEffectLog(log).entries)).toEqual([
      { idempotencyKey: ikey, invocations: 2 },
    ]);
  });

  it('counts a torn final line rather than reading a duplicate out of it', ({ tmp }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const line = JSON.stringify({
      runId: RUN,
      nodeId: 'step-01',
      attempt: 0,
      idempotencyKey: `${RUN}/step-01/0/0`,
    });
    // A SIGKILL that lands mid-write leaves half a line. It is reported, never
    // silently dropped — a suite that ignores torn output cannot tell a crash
    // from a bug.
    writeFileSync(log, `${line}\n${line.slice(0, 20)}`);

    const read = readSideEffectLog(log);
    expect(read.entries).toHaveLength(1);
    expect(read.malformed).toBe(1);
  });
});

/**
 * The scenario asks that the pre-crash side be deterministic "so the only
 * variable is where the knife lands". `pid` and `cwd` are the process's, not
 * the scenario's — the field under test is the one the seed produces.
 */
suite('--seed makes the pre-crash side deterministic (AC6)', () => {
  const nonceOf = (stdout: string): unknown => (JSON.parse(stdout) as { nonce: unknown }).nonce;

  it('produces the same nonce for the same seed, twice over', async ({ tmp, agentPath }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const call = { node: 'step-01', attempt: 0, ikey: `${RUN}/step-01/0/0`, seed: 7 } as const;

    const first = await invoke(agentPath.binary, log, call);
    const second = await invoke(agentPath.binary, log, call);
    expect(nonceOf(second)).toBe(nonceOf(first));
    expect(nonceOf(first)).not.toBeNull();
  });

  it('produces a different nonce for a different seed, so the flag is not decoration', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const base = { node: 'step-01', attempt: 0, ikey: `${RUN}/step-01/0/0` } as const;

    const first = await invoke(agentPath.binary, log, { ...base, seed: 7 });
    const second = await invoke(agentPath.binary, log, { ...base, seed: 8 });
    expect(nonceOf(second)).not.toBe(nonceOf(first));
  });

  it('never reaches for real randomness — no seed means no nonce at all', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const call = { node: 'step-01', attempt: 0, ikey: `${RUN}/step-01/0/0` } as const;

    const printed = JSON.parse(await invoke(agentPath.binary, log, call)) as Record<
      string,
      unknown
    >;
    expect(printed.seed).toBeNull();
    expect(printed.nonce).toBeNull();
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });
});
