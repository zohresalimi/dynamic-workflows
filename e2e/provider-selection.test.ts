/**
 * KAR-19.10 AC1, AC4 / EPIC-19-S65 — `deflow run --provider` is honoured, not
 * merely accepted.
 *
 * The built binary, a temp `PATH`, and the one assertion that cannot be faked:
 * **which binary actually ran**. On 2026-08-13 the operator typed
 * `--provider mock` and got `deflow run: unknown option "--provider"`; the
 * failure mode this spec is written against is the fix for that going in
 * halfway — a flag that parses and is then dropped, which is worse than an
 * absent one, because the operator now believes something about the run that is
 * not true and has no way to find out.
 *
 * So the machine below has **two** providers on `PATH`: a vendor CLI shim under
 * `claude`'s name, and the bundled agent. Registry order puts the vendor first,
 * so a `--provider` that was ignored would spawn the shim — and the shim writes
 * a file when it is invoked. The absence of that file is the assertion.
 *
 * The second scenario is the control: with no flag, selection is exactly what
 * KAR-19.7 AC8 left it, and the run announces the vendor rather than the
 * bundled agent. Without it, "the flag is honoured" could be satisfied by a
 * build that always picked `mock`.
 *
 * Verifies: EPIC-19-S65 · AC1, AC3, AC4 · test plan #3
 */

import { PROVIDER_SPECS } from '@DeFlow/adapters';
import { makeRepo } from '@DeFlow/testkit';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CliProcess,
  GIT_DIR,
  MOCK_AGENT_BIN,
  makeDataDir,
  NODE_DIR,
  removeDataDir,
  sleep,
  spawnCli,
} from './support/up.ts';

let tmp = '';
const running: CliProcess[] = [];

beforeEach(async () => {
  tmp = await makeDataDir();
});

afterEach(async () => {
  for (const cli of running.splice(0)) await cli.stop();
  await stopAutostartedDaemon();
  await removeDataDir(tmp);
});

interface DaemonFile {
  readonly pid: number;
}

/** The daemon `deflow run` started for itself, stopped — it is detached, so
 * nothing else here will take it down. */
async function stopAutostartedDaemon(): Promise<void> {
  let file: DaemonFile;
  try {
    file = JSON.parse(await readFile(join(tmp, 'data', 'daemon.json'), 'utf8')) as DaemonFile;
  } catch {
    return;
  }
  try {
    process.kill(file.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(file.pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
}

/** Where the vendor shim records that it was invoked at all. */
const witness = (): string => join(tmp, 'vendor-was-spawned');

/**
 * A `PATH` with the bundled agent and one fully-installed vendor provider.
 *
 * Three binaries, and each is there for a reason:
 *
 *  * `deflow-mock-agent` — the bundled agent, which the registry orders **last**
 *    (KAR-19.7 AC8). It is what `--provider mock` has to reach past the vendor.
 *  * `claude` — the vendor CLI, as a shim that touches `witness()` the instant
 *    it starts and then refuses. This spec is about *whether* it was spawned; a
 *    shim that produced a plausible turn would let a wrong selection finish and
 *    look like a success.
 *  * `claude-agent-acp` — the bundled agent again, under the bridge's name, so
 *    the boot probe completes a real ACP handshake and records a capability row
 *    for `claude`. Without it the vendor is not selectable by the chain at all
 *    and the control below would prove nothing.
 */
function twoProviders(): string {
  const dir = join(tmp, 'bin');
  mkdirSync(dir, { recursive: true });

  for (const name of [PROVIDER_SPECS.mock.bin, PROVIDER_SPECS.claude.bin]) {
    const link = join(dir, name);
    if (!existsSync(link)) symlinkSync(MOCK_AGENT_BIN, link);
  }

  writeFileSync(
    join(dir, PROVIDER_SPECS.claude.shim.bin),
    `#!/bin/sh\ntouch ${JSON.stringify(witness())}\necho 'vendor shim refuses' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  return dir;
}

const RUN_ID = /run_\d{8}T\d{6}Z_[0-9a-f]{6}/;

async function waitFor<T>(what: string, read: () => T | null, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await sleep(50);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`);
}

async function repoWithSpec(): Promise<string> {
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  writeFileSync(
    join(repo.dir, 'spec.md'),
    '# Add a health endpoint\n\nExpose GET /health returning 200.\n',
    'utf8',
  );
  return repo.dir;
}

suite('EPIC-19-S65 — the flag is honoured, not merely accepted', () => {
  it('runs on the provider it was told to, and spawns no other', async () => {
    const cwd = await repoWithSpec();
    const binDir = twoProviders();

    const cli = spawnCli({
      dataDir: join(tmp, 'data'),
      cwd,
      argv: ['run', '--provider', 'mock', '--file', 'spec.md'],
      binDirs: [binDir],
    });
    running.push(cli);

    const runId = await waitFor('the CLI printed a run id', () => {
      if (cli.child.exitCode !== null) {
        throw new Error(
          `deflow run exited ${cli.child.exitCode} instead of admitting the run:\n` +
            `stderr:\n${cli.stderr()}\nstdout:\n${cli.stdout()}`,
        );
      }
      return RUN_ID.exec(cli.stdout())?.[0] ?? null;
    });
    expect(runId).toMatch(RUN_ID);

    // AC4 — the announcement, before the first turn: the provider, the resolved
    // absolute path, and the route.
    const announced = await waitFor('the run announced its provider', () => {
      const line = cli
        .stdout()
        .split('\n')
        .find((entry) => entry.startsWith('provider '));
      return line ?? null;
    });
    expect(announced).toContain('provider mock');
    expect(announced).toContain(join(binDir, PROVIDER_SPECS.mock.bin));
    expect(announced).toContain('exec shim');

    // The clause that makes this an e2e: the vendor CLI was never spawned. A
    // flag that parsed and was then dropped would have selected it — registry
    // order puts a real adapter ahead of the bundled one.
    await waitFor('the run reached its framing turn', () =>
      cli.stdout().includes('provider mock') && cli.child.exitCode === null ? true : null,
    );
    expect(existsSync(witness()), 'the vendor CLI was spawned despite --provider mock').toBe(false);

    cli.child.kill('SIGINT');
    expect((await cli.exited).code).toBe(130);
  });

  it('without the flag, selection is what KAR-19.7 AC8 left it', async () => {
    const cwd = await repoWithSpec();
    const binDir = twoProviders();

    const cli = spawnCli({
      dataDir: join(tmp, 'data'),
      cwd,
      argv: ['run', '--file', 'spec.md'],
      binDirs: [binDir],
    });
    running.push(cli);

    const announced = await waitFor('the run announced its provider', () => {
      if (cli.child.exitCode !== null) {
        throw new Error(
          `deflow run exited ${cli.child.exitCode}:\nstderr:\n${cli.stderr()}\n` +
            `stdout:\n${cli.stdout()}`,
        );
      }
      return (
        cli
          .stdout()
          .split('\n')
          .find((entry) => entry.startsWith('provider ')) ?? null
      );
    });

    // The bundled agent is last, so the vendor CLI wins — unchanged by this
    // story, which made the choice statable rather than different.
    expect(announced).toContain(`provider ${PROVIDER_SPECS.claude.id}`);
    expect(announced).toContain(join(binDir, PROVIDER_SPECS.claude.shim.bin));

    // And the witness fires. This is what stops the assertion in the scenario
    // above being vacuous: the shim really does record its own invocation, so
    // "no vendor CLI was spawned under --provider mock" is a fact about that
    // run rather than about a file nothing ever writes.
    await waitFor('the vendor CLI was spawned', () => (existsSync(witness()) ? true : null));

    cli.child.kill('SIGINT');
    await cli.exited;
  });
});
