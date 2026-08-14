/**
 * KAR-20.1 — `deflow-mcp` answers `--help`, because a published bin that
 * cannot say what it is has no way of being checked.
 *
 * EPIC-20-S2 spawns all three of the tarball's bins by their lowercase names
 * and asserts each exits 0. For `deflow` and `deflow-mock-agent` that is
 * `--version`; for this one there is nothing to ask that does not first
 * require a running DeFlowd, a socket path and a run token — so `--help` is
 * the only argv that can prove the bin exists, resolves and executes without
 * standing a daemon up first.
 *
 * Before this, every argv that was not `--socket <path> --run <runId>` was
 * `EX_USAGE`, `--help` included: the shipped entry point could be entirely
 * broken and the clean room's only way to notice was a 64 that a correct
 * build produces too.
 *
 * The unit half of EPIC-20-S2. The clean-room half — that this is what the
 * *tarball's* `deflow-mcp` does — is `e2e/install-verification.test.ts`,
 * because a bin key renamed without its target shipping is invisible from
 * inside the monorepo.
 *
 * Verifies: EPIC-20-S2 (unit half) · AC1
 */
import { PassThrough } from 'node:stream';
import { expect, it, describe as suite } from 'vitest';
import { RUN_TOKEN_ENV } from './server-entry.ts';
import { EX_USAGE, runMcpShim, SHIM_NAME, SHIM_USAGE } from './shim.ts';

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the shim over real streams with an **empty environment** — no run
 * token, no socket, nothing a daemon would have set.
 *
 * That is the point rather than a shortcut: `--help` is the one argv a person
 * types, and a person has none of those. A help path that needed the daemon's
 * environment to reach its own usage text would be no more spawnable from a
 * clean room than the argv it replaced.
 */
async function run(argv: readonly string[]): Promise<Ran> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  stdout.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  stderr.on('data', (chunk: Buffer) => err.push(chunk.toString()));

  const code = await runMcpShim({ argv, env: {}, stdin, stdout, stderr });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

suite('deflow-mcp --help (EPIC-20-S2)', () => {
  it('exits 0 and prints its usage, for both spellings of the flag', async () => {
    for (const flag of ['--help', '-h']) {
      const ran = await run([flag]);
      expect([flag, ran.code]).toEqual([flag, 0]);
      expect(ran.stdout).toBe(SHIM_USAGE);
      // Nothing on stderr: this is an answer to a question, not a refusal.
      expect([flag, ran.stderr]).toEqual([flag, '']);
    }
  });

  it('names itself, its two arguments and the environment variable it needs', async () => {
    const { stdout } = await run(['--help']);
    expect(stdout).toContain(SHIM_NAME);
    expect(stdout).toContain('--socket');
    expect(stdout).toContain('--run');
    // The one thing an operator who runs it by hand will get wrong, said
    // before they get it wrong.
    expect(stdout).toContain(RUN_TOKEN_ENV);
  });

  it('answers even when no run token is set, which is the whole of a clean room', async () => {
    // The order matters and this is what pins it: the token check comes
    // before the socket connection and after argv parsing, so a `--help`
    // handled anywhere but first would exit 64 in exactly the environment
    // EPIC-20-S2 runs in.
    const ran = await run(['--help']);
    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toContain(RUN_TOKEN_ENV);
  });

  it('leaves every other bad argv refusing exactly as it did', async () => {
    // `--help` is an addition, not a loosening. A shim that answered 0 to
    // anything it did not understand would let DeFlowd spawn a misconfigured
    // one and never hear about it.
    for (const argv of [[], ['--socket', '/tmp/s'], ['--run', 'run_1'], ['--socket']]) {
      const ran = await run(argv);
      expect([argv.join(' '), ran.code]).toEqual([argv.join(' '), EX_USAGE]);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toContain(SHIM_NAME);
    }
  });
});
