/**
 * KAR-19.6 test plan #6 / EPIC-19-S37 — `DeFlow cancel <runId>`, as an
 * operator meets it: one command, one line, no token.
 *
 * `'DeFlow cancel <runId>' to stop` has been printed by `DeFlow run`'s detach
 * sentence since 2026-08-11 and has never resolved to a command. So this is
 * asserted from outside the process, because that is all the operator had:
 * stdout, an exit code, and the ledger the daemon wrote. The in-process halves
 * — the argv, the two mode sentences, the refusals — are unit specs beside the
 * code (`packages/cli/src/cancel.test.ts`); what only a spawned binary can
 * settle is that the command exists at all and that it reaches the route.
 *
 * **What is asserted here is the run that never started**, which is the state
 * all three reported runs were in and the one no route could end. A cancel of a
 * run with a live agent in flight needs a shipped path that executes nodes,
 * which is KAR-19.4's; the forceful ladder behind the same route — the group
 * signal, the verified kill and the `Z` exclusion — is asserted over real
 * processes in `packages/daemon/test/integration/cancel-forceful-api.test.ts`
 * and `cancel-recovery.test.ts` rather than duplicated here.
 *
 * Verifies: EPIC-19-S37, EPIC-19-S40, EPIC-19-S41 · KAR-19.6 AC1, AC2, AC6,
 * AC7, AC9
 */

import type { RunId } from '@DeFlow/core';
import { openRead, readRange } from '@DeFlow/ledger';
import { makeRepo } from '@DeFlow/testkit';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CliProcess,
  MOCK_AGENT_BIN,
  makeDataDir,
  removeDataDir,
  sleep,
  spawnCli,
  spawnUp,
  waitForUrl,
} from './support/up.ts';

let tmp = '';
const running: CliProcess[] = [];

beforeEach(async () => {
  tmp = await makeDataDir();
});

afterEach(async () => {
  for (const cli of running.splice(0)) await cli.stop();
  await removeDataDir(tmp);
});

const start = (options: Parameters<typeof spawnCli>[0]): CliProcess => {
  const cli = spawnCli(options);
  running.push(cli);
  return cli;
};

/**
 * A bin directory holding the bundled mock agent under a vendor's name.
 *
 * A run is admitted only when something on this machine can serve it
 * (KAR-19.2), and this spec is about stopping a run rather than about that
 * refusal — so the hermetic PATH gets one adapter, and it is the mock that
 * ships in this repository rather than anybody's real vendor CLI.
 */
function withMockAgent(dir: string): string {
  mkdirSync(dir, { recursive: true });
  // The vendor CLI, answering `--version`, and the ACP bridge DeFlow actually
  // spawns: admission asks for both, and a machine with only one of them is
  // KAR-19.2's refusal rather than this story's subject.
  const vendor = join(dir, 'claude');
  writeFileSync(vendor, '#!/bin/sh\necho 2.1.220\n', { mode: 0o755 });
  chmodSync(vendor, 0o755);

  const shim = join(dir, 'claude-agent-acp');
  writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${MOCK_AGENT_BIN} "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(shim, 0o755);
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

/** Runs one `DeFlow` subcommand to completion. */
async function run(
  dataDir: string,
  argv: readonly string[],
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = start({
    dataDir,
    argv,
    binDirs: [join(tmp, 'bin')],
    ...(cwd === undefined ? {} : { cwd }),
  });
  const { code } = await cli.exited;
  return { code, stdout: cli.stdout(), stderr: cli.stderr() };
}

/** The run this operator submitted, which parks exactly where theirs did. */
async function submitRun(dataDir: string, repoDir: string): Promise<string> {
  const cli = start({
    dataDir,
    cwd: repoDir,
    binDirs: [join(tmp, 'bin')],
    argv: ['run', 'add a health endpoint'],
  });
  return waitFor('the CLI printed a run id', () => {
    if (cli.child.exitCode !== null) {
      throw new Error(`DeFlow run exited ${cli.child.exitCode}:\n${cli.stderr()}`);
    }
    return RUN_ID.exec(cli.stdout())?.[0] ?? null;
  });
}

/**
 * Every event kind the ledger holds for `runId`, read from the file the daemon
 * wrote — read-only, and on a second connection, so this asserts what is
 * durable rather than what an API is holding in memory.
 */
function kindsOf(dataDir: string, runId: string): string[] {
  const db = openRead(join(dataDir, 'ledger.db'));
  try {
    return readRange(db, runId as RunId, 0, 500).events.map((event) => event.kind);
  } finally {
    db.close();
  }
}

suite('EPIC-19-S37 — the command the detach sentence has always named', () => {
  it('stops a run, names the mode, and drops it from every list of live runs', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const up = spawnUp({ dataDir, binDirs: [withMockAgent(join(tmp, 'bin'))] });
    running.push(up);
    const url = await waitForUrl(up);
    const port = Number(/:(\d+)\//.exec(url)?.[1] ?? 0);

    const runId = await submitRun(dataDir, repo.dir);

    // The operator has never opened the token file — this command reads it.
    const cancelled = await run(dataDir, ['cancel', runId]);

    expect(cancelled.stderr).toBe('');
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain(runId);
    // AC2 — which mode it used, and what that means.
    expect(cancelled.stdout).toContain('cooperative');
    expect(cancelled.stdout).toContain('transcript');
    // AC1 — and nothing anywhere sends the operator to a bearer token.
    expect(cancelled.stdout).not.toContain('curl');

    // AC4 — on disk, both events, in that order.
    const kinds = kindsOf(dataDir, runId);
    expect(kinds.slice(-2)).toEqual(['run.cancel.requested', 'run.aborted']);

    // AC7 — every surface that lists runs agrees, at the same head sequence.
    const token = (
      JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as { token: string }
    ).token;
    const active = await fetch(`http://127.0.0.1:${port}/api/runs?status=active`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const listed = ((await active.json()) as { runs: { runId: string }[] }).runs.map(
      (row) => row.runId,
    );
    expect(listed).not.toContain(runId);

    const status = await run(dataDir, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).not.toContain(runId);
  });

  it('exits 0 on a repeat, saying the run had already ended, and non-zero on an unknown id', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const up = spawnUp({ dataDir, binDirs: [withMockAgent(join(tmp, 'bin'))] });
    running.push(up);
    await waitForUrl(up);

    const runId = await submitRun(dataDir, repo.dir);
    expect((await run(dataDir, ['cancel', runId])).code).toBe(0);

    const again = await run(dataDir, ['cancel', runId]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already ended');

    // AC6 — an unknown id is the daemon's own sentence and a non-zero exit,
    // with no stack trace to read past.
    const missing = await run(dataDir, ['cancel', 'run_20260812T133401Z_ffffff']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('run_not_found');
    expect(missing.stderr).not.toContain('    at ');
  });

  it('refuses a mode the daemon does not have before it opens a socket', async () => {
    const dataDir = join(tmp, 'data');

    // No daemon is running at all, which is the point: the refusal is the
    // parser's, so it does not need one.
    const refused = await run(dataDir, ['cancel', 'run_20260812T133401Z_318740', '--mode', 'hard']);

    expect(refused.code).toBe(64);
    expect(refused.stderr).toContain('"cooperative"');
    expect(refused.stderr).toContain('"forceful"');
  });
});
