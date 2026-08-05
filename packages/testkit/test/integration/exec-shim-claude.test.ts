/**
 * EPIC-04-S17 — the Claude Code `stream-json` envelope, out of a real process.
 *
 * The `--verbose` requirement is verified by execution rather than by reading:
 * a rule the fake merely documents is a rule the shim can still get wrong. It
 * is also the easiest gotcha in the vendor matrix to miss, because
 * `--output-format json` succeeds without `--verbose` and that is the format
 * most people try first.
 *
 * Each line's `uuid` is the shim path's **event-log dedup key** — the
 * equivalent of the ACP notification id, and what makes replay-after-crash
 * idempotent (F4.3). A fake that emitted a constant `uuid` would let a broken
 * dedup implementation pass, so "no duplicates" is asserted on the real bytes
 * of a real run.
 *
 * Verifies: EPIC-04-S17 · KAR-04.6 AC1, AC2, AC3, AC8 · test plan rows 1, 2
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import { CLAUDE_VERBOSE_REQUIRED } from '../../src/exec-shim/dialects.ts';
import { it, linkFakeAgent, readSideEffectLog } from '../../src/index.ts';

interface Run {
  readonly scenario: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly binary?: string;
  readonly cwd?: string;
}

async function claude(
  binary: string,
  run: Run,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(run.binary ?? binary, [...run.args], {
    reject: false,
    cwd: run.cwd,
    env: {
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      DeFlow_FAKE_SCENARIO: run.scenario,
      DeFlow_FAKE_SEED: '42',
      ...run.env,
    },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const lines = (stdout: string): Record<string, unknown>[] =>
  stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

suite('EPIC-04-S17 — --verbose is required alongside stream-json (AC2)', () => {
  it('exits non-zero printing the exact string the real binary prints', async ({ agentPath }) => {
    const run = await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: ['-p', 'say ok', '--output-format', 'stream-json'],
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toBe(CLAUDE_VERBOSE_REQUIRED);
    expect(run.stdout).toBe('');
  });

  it('resolves under any vendor name on PATH, and refuses just the same (AC1)', async ({ tmp }) => {
    // The symlink is named `copilot` while the dialect is Claude Code's: the
    // binary's behaviour comes from the environment, not from what it was
    // called, so one fixture serves every vendor the matrix has.
    const linked = await linkFakeAgent(tmp, 'not-claude-at-all');
    const run = await claude('', {
      binary: 'not-claude-at-all',
      scenario: 'claude-turn',
      args: ['-p', 'say ok', '--output-format', 'stream-json'],
      env: { PATH: linked.pathEnv },
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toBe(CLAUDE_VERBOSE_REQUIRED);
  });
});

suite('EPIC-04-S17 — with --verbose the envelope is emitted (AC3)', () => {
  it('every line parses, carries session_id, and has a uuid of its own', async ({ agentPath }) => {
    const run = await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: ['-p', 'say ok', '--output-format', 'stream-json', '--verbose'],
    });

    expect(run.exitCode).toBe(0);
    const frames = lines(run.stdout);
    expect(frames.length).toBeGreaterThan(3);

    const sessions = new Set(frames.map((frame) => frame.session_id));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toEqual(expect.any(String));

    const uuids = frames.map((frame) => frame.uuid as string);
    expect(uuids.every((uuid) => typeof uuid === 'string' && uuid !== '')).toBe(true);
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it('emits system/init, then assistant, then result, in that relative order', async ({
    agentPath,
  }) => {
    const run = await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: ['-p', 'say ok', '--output-format', 'stream-json', '--verbose'],
    });

    const frames = lines(run.stdout);
    const first = (type: string): number => frames.findIndex((frame) => frame.type === type);

    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(first('system')).toBeLessThan(first('assistant'));
    expect(first('assistant')).toBeLessThan(first('result'));
  });

  it('ends on a result envelope carrying the verified field set', async ({ agentPath }) => {
    const run = await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: ['-p', 'say ok', '--output-format', 'stream-json', '--verbose'],
    });

    const last = lines(run.stdout).at(-1) as Record<string, unknown>;
    expect(last).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      result: 'ok',
    });
    expect(last.total_cost_usd).toBeTypeOf('number');
    expect(last.usage).toBeTypeOf('object');
    expect(last.modelUsage).toBeTypeOf('object');
    expect(last.permission_denials).toEqual([]);
  });

  it('is byte-identical across two seeded runs, so a snapshot can be trusted', async ({
    agentPath,
  }) => {
    const args = ['-p', 'say ok', '--output-format', 'stream-json', '--verbose'];
    const first = await claude(agentPath.binary, { scenario: 'claude-turn', args });
    const second = await claude(agentPath.binary, { scenario: 'claude-turn', args });
    expect(second.stdout).toBe(first.stdout);
  });
});

suite('EPIC-04-S17 — --output-format json succeeds without --verbose', () => {
  it('exits 0 with a single JSON document on stdout', async ({ agentPath }) => {
    const run = await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: ['-p', 'say ok', '--output-format', 'json'],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(run.stdout)).toMatchObject({ type: 'result', subtype: 'success' });
  });
});

suite('EPIC-04-S17 — failure subtypes are scriptable', () => {
  const cases = [
    ['claude-turn', 'success', 0],
    ['schema-repair-exhausted', 'error_max_structured_output_retries', 1],
    ['error-during-execution', 'error_during_execution', 1],
  ] as const;

  for (const [scenario, subtype, exitCode] of cases) {
    it(`${scenario} ends on subtype ${subtype} and exit ${exitCode}`, async ({ agentPath }) => {
      const run = await claude(agentPath.binary, {
        scenario,
        args: ['-p', 'say ok', '--output-format', 'stream-json', '--verbose'],
      });

      const last = lines(run.stdout).at(-1) as Record<string, unknown>;
      expect(last.subtype).toBe(subtype);
      expect(last.is_error).toBe(subtype !== 'success');
      expect(run.exitCode).toBe(exitCode);
    });
  }
});

suite('EPIC-04-S17 — the side-effect log contract is KAR-04.2’s (AC8)', () => {
  it('appends one line per invocation, with the four idempotency fields', async ({
    tmp,
    agentPath,
  }) => {
    const log = join(tmp, 'side-effects.ndjson');
    const args = ['-p', 'say ok', '--output-format', 'json'];

    await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: [
        ...args,
        '--run-id',
        'run_1',
        '--node-id',
        'step-01',
        '--attempt',
        '0',
        '--ikey',
        'k1',
      ],
      env: { DeFlow_SIDE_EFFECT_LOG: log },
    });
    // The same four values as environment variables, which is the other way
    // DeFlowd passes them depending on how the adapter builds its argv.
    await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args,
      env: {
        DeFlow_SIDE_EFFECT_LOG: log,
        DeFlow_RUN_ID: 'run_1',
        DeFlow_NODE_ID: 'step-02',
        DeFlow_ATTEMPT: '1',
        DeFlow_IKEY: 'k2',
      },
    });

    const read = readSideEffectLog(log);
    expect(read.malformed).toBe(0);
    expect(read.entries).toEqual([
      { runId: 'run_1', nodeId: 'step-01', attempt: 0, idempotencyKey: 'k1' },
      { runId: 'run_1', nodeId: 'step-02', attempt: 1, idempotencyKey: 'k2' },
    ]);
  });

  it('records the invocation even when the argv is one the dialect refuses', async ({
    tmp,
    agentPath,
  }) => {
    // The invocation whose absence from the log would be hardest to explain
    // later is exactly the one that failed, so the line is written first.
    const log = join(tmp, 'side-effects.ndjson');
    const run = await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: ['-p', 'x', '--output-format', 'stream-json', '--ikey', 'k-refused'],
      env: { DeFlow_SIDE_EFFECT_LOG: log },
    });

    expect(run.exitCode).not.toBe(0);
    expect(readSideEffectLog(log).entries).toEqual([
      { runId: '', nodeId: '', attempt: 0, idempotencyKey: 'k-refused' },
    ]);
  });

  it('writes nothing at all when no log is configured', async ({ tmp, agentPath }) => {
    await claude(agentPath.binary, {
      scenario: 'claude-turn',
      args: ['-p', 'say ok', '--output-format', 'json'],
    });
    expect(readSideEffectLog(join(tmp, 'absent.ndjson')).entries).toEqual([]);
  });
});

suite('the scenario is required rather than guessed', () => {
  it('refuses to run with a dialect and no scenario, naming the variable', async ({
    agentPath,
  }) => {
    const result = await execa(agentPath.binary, ['-p', 'x'], {
      reject: false,
      env: { DeFlow_FAKE_DIALECT: 'claude-stream-json' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('DeFlow_FAKE_SCENARIO');
  });

  it('refuses an unknown dialect and lists the ones it knows', async ({ agentPath }) => {
    const result = await execa(agentPath.binary, ['-p', 'x'], {
      reject: false,
      env: { DeFlow_FAKE_DIALECT: 'claude-stream-jsonl', DeFlow_FAKE_SCENARIO: 'claude-turn' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('copilot-json');
  });

  it('keeps the pre-KAR-04.6 behaviour when no dialect is set at all', async ({ agentPath }) => {
    // EPIC-01 and EPIC-03 spawn this binary with no dialect and read the
    // invocation echo. Adding a mode must not take that away.
    const result = await execa(agentPath.binary, ['--print'], { env: {} });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ argv: ['--print'] });
  });
});

suite('the fake writes a real file the shim can read back', () => {
  it('writes the declared paths relative to cwd (AC7)', async ({ tmp, agentPath }) => {
    const worktree = join(tmp, 'worktree');
    mkdirSync(worktree, { recursive: true });
    await claude(agentPath.binary, {
      scenario: 'write-files',
      args: ['-p', 'write', '--output-format', 'json'],
      cwd: worktree,
    });

    expect(readFileSync(join(worktree, 'inside.txt'), 'utf8')).toContain('written by the fake');
  });
});
