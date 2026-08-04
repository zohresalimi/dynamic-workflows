/**
 * KAR-01.4 AC6 — a real fake binary, on a real PATH, spawned for real.
 *
 * The load-bearing assertion is the fourth one: the fixture resolves and returns
 * an *absolute* path, and spawning by that absolute path works with PATH
 * emptied entirely — because DeFlowd's PATH at daemon start is not the user's
 * login shell PATH, so production code must store the resolved path rather than
 * a bare name it looks up again at spawn time.
 *
 * Verifies: EPIC-01-S14 (fake-binary half) · AC6
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { describe as suite, expect } from 'vitest';
import { it, linkFakeAgent } from '../../src/index.ts';

const run = promisify(execFile);

suite('the agentPath fixture', () => {
  it('links the fake binary into a tmp bin/ and prepends it to PATH', ({ agentPath, tmp }) => {
    expect(agentPath.binDir).toBe(join(tmp, 'bin'));
    expect(agentPath.pathEnv.startsWith(`${agentPath.binDir}${delimiter}`)).toBe(true);
    expect(agentPath.pathEnv).toContain(process.env.PATH ?? '');
  });

  it('returns the binary as an absolute path', ({ agentPath }) => {
    expect(isAbsolute(agentPath.binary)).toBe(true);
    expect(agentPath.binary).toBe(join(agentPath.binDir, agentPath.name));
  });

  it('is spawnable by bare name once its directory is on PATH', async ({ agentPath }) => {
    const { stdout } = await run(agentPath.name, ['--hello'], {
      env: { ...process.env, PATH: agentPath.pathEnv },
    });
    expect(JSON.parse(stdout)).toMatchObject({ argv: ['--hello'] });
  });

  it('is spawnable by absolute path when PATH cannot find it — the daemon case', async ({ tmp }) => {
    // A name no real CLI has, linked into a directory that is deliberately not
    // on PATH: this is DeFlowd's situation, whose PATH at daemon start is not
    // the login shell's. A bare name is unresolvable; the stored absolute path
    // is not. Production code must keep the latter.
    const agent = await linkFakeAgent(tmp, 'deflow-not-on-any-path');
    const env = { ...process.env };

    await expect(run(agent.name, [], { env })).rejects.toMatchObject({ code: 'ENOENT' });

    const { stdout } = await run(agent.binary, ['--hello'], { env });
    expect(JSON.parse(stdout)).toMatchObject({
      argv: ['--hello'],
      invokedAs: agent.binary,
    });
  });

  it('appends an invocation log a duplicate-execution check can count', async ({
    agentPath,
    tmp,
  }) => {
    const log = join(tmp, 'invocations.ndjson');
    const env = { ...process.env, PATH: agentPath.pathEnv, DeFlow_FAKE_LOG: log };
    await run(agentPath.name, ['one'], { env });
    await run(agentPath.name, ['two'], { env });

    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { argv: string[] }).argv)).toEqual([
      ['one'],
      ['two'],
    ]);
  });

  it('exits with the code its scenario asks for, so failure paths are real', async ({
    agentPath,
  }) => {
    await expect(
      run(agentPath.binary, [], { env: { ...process.env, DeFlow_FAKE_EXIT_CODE: '3' } }),
    ).rejects.toMatchObject({ code: 3 });
  });
});
