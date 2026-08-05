/**
 * EPIC-04-S20 — vendors are not uniform.
 *
 * Copilot CLI 1.0.77 offers `--output-format text|json` and **no
 * `stream-json`** (verified from `--help`, 2026-08-02). This is the single most
 * likely place for a shim to make a silently wrong uniformity assumption, so
 * the fake refuses rather than emulating: a fake that helpfully produced
 * `stream-json` for every vendor would make the assumption *work under test*
 * and fail only against the real binary.
 *
 * The other three specs give three downstream mechanisms a genuine input:
 * `rate_limit_event.resetsAt` is what a backoff scheduler must schedule against
 * instead of retrying blindly; `permission_denials` is the only place the shim
 * path can learn a tool was refused; and a file written *above* `cwd` is the
 * only positive case path-scope detection can be tested against — on the ACP
 * path DeFlow refuses the write at `fs/write_text_file` and the violation never
 * reaches the filesystem at all.
 *
 * Verifies: EPIC-04-S20 · KAR-04.6 AC4, AC5, AC7 · test plan rows 4, 7, 8
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import { it } from '../../src/index.ts';

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  binary: string,
  dialect: string,
  scenario: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
  cwd?: string,
): Promise<Run> {
  const result = await execa(binary, [...args], {
    reject: false,
    cwd,
    // 32 MB: the huge-line scenario writes a single 10 MB line and execa's
    // default buffer would truncate it into a different test.
    maxBuffer: 32 * 1024 * 1024,
    env: {
      DeFlow_FAKE_DIALECT: dialect,
      DeFlow_FAKE_SCENARIO: scenario,
      DeFlow_FAKE_SEED: '42',
      ...extra,
    },
  });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
}

suite('EPIC-04-S20 — Copilot has no stream-json (AC4)', () => {
  it('exits non-zero when stream-json is requested, loudly', async ({ agentPath }) => {
    const result = await run(agentPath.binary, 'copilot-json', 'claude-turn', [
      '-p',
      'say ok',
      '--output-format',
      'stream-json',
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stream-json');
  });

  it('accepts json, and answers with a single document', async ({ agentPath }) => {
    const result = await run(agentPath.binary, 'copilot-json', 'claude-turn', [
      '-p',
      'say ok',
      '--output-format',
      'json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: 'result' });
  });
});

suite('EPIC-04-S20 — a rate limit event carries a resetsAt (AC5)', () => {
  it('puts resetsAt 900 seconds ahead of the clock the run was given', async ({ agentPath }) => {
    // A fixed clock reading, so the assertion is an equality rather than a
    // window — the field is a timestamp a scheduler does arithmetic on, and
    // "roughly right" is how you ship a retry that fires at the wrong minute.
    const nowMs = 1_785_000_000_000;
    const result = await run(
      agentPath.binary,
      'claude-stream-json',
      'rate-limited',
      ['-p', 'say ok', '--output-format', 'stream-json', '--verbose'],
      { DeFlow_FAKE_NOW: String(nowMs) },
    );

    const frames = result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const limit = frames.find((frame) => frame.type === 'rate_limit_event');
    expect(limit, 'the stream carries a rate_limit_event line').toBeDefined();

    const info = limit?.rate_limit_info as Record<string, unknown>;
    expect(info.status).toBe('allowed_warning');
    expect(info.resetsAt).toBe(Math.floor(nowMs / 1000) + 900);
  });

  it('reads as an epoch timestamp against the real clock too', async ({ agentPath }) => {
    const before = Math.floor(Date.now() / 1000);
    const result = await run(agentPath.binary, 'claude-stream-json', 'rate-limited', [
      '-p',
      'say ok',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);

    const limit = result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((frame) => frame.type === 'rate_limit_event') as Record<string, unknown>;

    const resetsAt = (limit.rate_limit_info as { resetsAt: number }).resetsAt;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 900);
    expect(resetsAt).toBeLessThan(before + 960);
  });
});

suite('EPIC-04-S20 — a permission refusal on the shim path', () => {
  it('names the denied tool in the result envelope’s permission_denials', async ({ agentPath }) => {
    const result = await run(agentPath.binary, 'claude-stream-json', 'permission-refusal', [
      '-p',
      'say ok',
      '--output-format',
      'json',
    ]);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const denials = envelope.permission_denials as Record<string, unknown>[];
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ tool_name: 'Bash', tool_use_id: 'toolu_01denied' });
  });
});

suite('EPIC-04-S20 — writing outside the worktree (AC7)', () => {
  it('resolves declared paths against cwd, escape and all', async ({ tmp, agentPath }) => {
    const worktree = join(tmp, 'worktree');
    mkdirSync(worktree, { recursive: true });

    const result = await run(
      agentPath.binary,
      'claude-stream-json',
      'write-files',
      ['-p', 'write please', '--output-format', 'json'],
      {},
      worktree,
    );
    expect(result.exitCode).toBe(0);

    expect(readFileSync(join(worktree, 'inside.txt'), 'utf8')).toContain('written by the fake');
    // Directories are created on the way, so a nested declared path is not a
    // silent no-op the spec would read as a scope decision.
    expect(existsSync(join(worktree, 'nested/deeper/inside.txt'))).toBe(true);

    const escaped = resolve(worktree, '../outside.txt');
    expect(escaped.startsWith(worktree)).toBe(false);
    expect(readFileSync(escaped, 'utf8')).toContain('written OUTSIDE the worktree');
  });
});

suite('EPIC-04-S20 — Codex JSONL, including one 10 MB line (test plan row 8)', () => {
  it('emits one JSON object per line under --json', async ({ agentPath }) => {
    const result = await run(agentPath.binary, 'codex-jsonl', 'claude-turn', [
      'exec',
      'say ok',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const emitted = result.stdout.split('\n').filter((line) => line !== '');
    expect(emitted.length).toBeGreaterThan(1);
    for (const line of emitted) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('writes the flood as a single line of at least 10 MB, not as chunks', async ({
    agentPath,
  }) => {
    const result = await run(agentPath.binary, 'codex-jsonl', 'huge-line', [
      'exec',
      'flood',
      '--json',
    ]);

    const longest = result.stdout
      .split('\n')
      .reduce((best, line) => Math.max(best, Buffer.byteLength(line)), 0);
    expect(longest).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it('has no --output-format, and says so rather than guessing', async ({ agentPath }) => {
    const result = await run(agentPath.binary, 'codex-jsonl', 'claude-turn', [
      'exec',
      'x',
      '--output-format',
      'json',
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--output-format');
  });
});
