/**
 * EPIC-04-S18 — the process that says nothing at all.
 *
 * "Exit 0 with no output" is the worst outcome in the F3.4 conformance battery
 * (docs/14-testing-strategy.md §3.2), because it produces a node that *looks*
 * successful and carries nothing: an empty result propagates downstream instead
 * of failing, and every consumer of it inherits the emptiness. It has no
 * natural cause in a scripted happy path, which is exactly why it needs its own
 * scenario and its own spec.
 *
 * Both streams are read to EOF before the assertion. A spec that asserted on
 * whatever had arrived by exit time would pass for a binary that wrote a banner
 * slowly, which is the bug this is meant to catch.
 *
 * Verifies: EPIC-04-S18 · KAR-04.6 AC6 · test plan row 5
 */
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import { it } from '../../src/index.ts';

async function silent(
  binary: string,
  env: Readonly<Record<string, string>> = {},
  args: readonly string[] = ['-p', 'say ok', '--output-format', 'json'],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(binary, [...args], {
    reject: false,
    // Buffered to EOF by execa: the streams are closed by the time this
    // resolves, so "zero bytes" is a statement about the whole run.
    env: {
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      DeFlow_FAKE_SCENARIO: 'no-output',
      ...env,
    },
  });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
}

suite('EPIC-04-S18 — exit zero having written nothing', () => {
  it('exits 0 with zero bytes on stdout and zero on stderr', async ({ agentPath }) => {
    const run = await silent(agentPath.binary);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(Buffer.byteLength(run.stdout)).toBe(0);
    expect(Buffer.byteLength(run.stderr)).toBe(0);
  });
});

suite('EPIC-04-S18 — exit non-zero having written nothing', () => {
  it('carries the scripted exit code with both streams still empty', async ({ agentPath }) => {
    const run = await silent(agentPath.binary, { DeFlow_FAKE_EXIT_CODE: '2' });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });

  it('is silent under every dialect, not just the one that scripts a result', async ({
    agentPath,
  }) => {
    // Silence is a property of the invocation, not of the wire format. A fake
    // that printed a banner under one dialect would leave the shim's empty-
    // output path untested for that vendor alone — the hardest kind of gap to
    // notice, because the suite is green.
    for (const dialect of ['codex-jsonl', 'copilot-json']) {
      // An argv all three accept, so this spec is about the silence rather
      // than about each vendor's flag surface (that is EPIC-04-S20's job).
      const run = await silent(agentPath.binary, { DeFlow_FAKE_DIALECT: dialect }, ['-p', 'ok']);
      expect(run.stdout, dialect).toBe('');
      expect(run.stderr, dialect).toBe('');
      expect(run.exitCode, dialect).toBe(0);
    }
  });
});
