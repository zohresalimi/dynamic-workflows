/**
 * KAR-18.3 AC1, AC2 — `DeFlow run` as a user meets it: one command, one run, no
 * browser.
 *
 * Asserted from outside the process, because that is all an operator has:
 * stdout, an exit code, the file the daemon wrote and the socket it is
 * listening on. The in-process halves — the argv, the exit-code table, the two
 * renderers, the resume cursor, the two Ctrl-Cs — are specs next to the code
 * they exercise; what only a spawned binary can settle is that the autostart,
 * the health poll and the attach are wired to them at all.
 *
 * > **Amended 2026-08-11 while implementing KAR-18.3.** EPIC-18-S18 ends with a
 * > four-node mock plan completing and an exit code of 0. That is not reachable
 * > in this repository: **no shipped code path executes a submitted run.**
 * > Nothing calls `compilePlanV1` or `executeRun`, `boot()` starts no ticker,
 * > and `POST /api/runs` deliberately stops at `task.submitted` (KAR-10.1:
 * > *"No interpretation happens here"*). Every run therefore parks after intake
 * > until the orchestration wiring exists, which is EPIC-06/EPIC-10/EPIC-11
 * > work and explicitly out of this epic's scope. What is asserted below is
 * > everything the scenario claims that *is* reachable — the detached
 * > autostart, the unauthenticated health poll, the run created, the
 * > subscription from seq 0, the rendered transcript through the normalising
 * > serializer, and a documented exit code — and the completion half is
 * > recorded as a follow-up on the story rather than faked here.
 *
 * Verifies: EPIC-18-S18, EPIC-18-S19 · AC1, AC2 · test plan #1, #2
 */

import { makeRepo } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CliProcess,
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
  await stopAutostartedDaemon();
  await removeDataDir(tmp);
});

interface DaemonFile {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

const daemonFile = (dataDir: string): DaemonFile | null => {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as DaemonFile;
  } catch {
    return null;
  }
};

/** The daemon `DeFlow run` started for itself, stopped — it is detached, so
 * nothing else in this file will take it down. */
async function stopAutostartedDaemon(): Promise<void> {
  const file = daemonFile(join(tmp, 'data'));
  if (file === null) return;
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

const start = (options: Parameters<typeof spawnCli>[0]): CliProcess => {
  const cli = spawnCli(options);
  running.push(cli);
  return cli;
};

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

async function health(port: number): Promise<{ daemonEpoch: number | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  return (await response.json()) as { daemonEpoch: number | null };
}

suite('EPIC-18-S18 — one command, one run, no browser (AC1)', () => {
  it('autostarts DeFlowd detached, polls health unauthenticated, and streams the run', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const cli = start({
      dataDir,
      cwd: repo.dir,
      argv: ['run', 'add a health endpoint'],
    });

    const runId = await waitFor('the CLI printed a run id', () => {
      if (cli.child.exitCode !== null) {
        throw new Error(`DeFlow run exited ${cli.child.exitCode}:\n${cli.stderr()}`);
      }
      return RUN_ID.exec(cli.stdout())?.[0] ?? null;
    });

    // AC1 — a daemon exists that this command started, and it is *not* this
    // command's child process group.
    const file = daemonFile(dataDir);
    expect(file).not.toBeNull();
    expect(file?.pid).not.toBe(cli.child.pid);
    expect((await fetch(`http://127.0.0.1:${file?.port ?? 0}/api/health`)).status).toBe(200);

    // …and the poll that got here sent no bearer header: /api/health is the one
    // public route, and the token does not exist until the daemon writes the
    // file. A CLI that authenticated its health poll would 401 itself before
    // the file was there to read.
    expect(cli.stderr()).not.toContain('401');

    // AC1 — the run was created and the stream was subscribed from seq 0: the
    // very first event of the run is in the transcript.
    const transcript = await waitFor('the transcript reached task.submitted', () =>
      cli.stdout().includes('submitted') ? cli.stdout() : null,
    );

    // The rendered transcript, through the normalising serializer — with the
    // run id itself replaced, because it is minted from the wall clock and six
    // random bytes and the serializer has no rule that would recognise one.
    expect(transcript.replaceAll(runId, '<runId>')).toMatchSnapshot();

    // AC6 — and it ends on a documented code rather than by dying: the first
    // Ctrl-C detaches, which is 130.
    cli.child.kill('SIGINT');
    expect((await cli.exited).code).toBe(130);
  });
});

suite('EPIC-18-S19 — attach, never launch a second (AC2)', () => {
  it('reuses a running daemon, leaves daemon_epoch alone and never trips the lease', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const up = start({ dataDir, argv: ['up', '--no-open'] });
    await waitForUrl(up);

    const before = daemonFile(dataDir);
    const bytes = readFileSync(join(dataDir, 'daemon.json'), 'utf8');
    const epochBefore = (await health(before?.port ?? 0)).daemonEpoch;

    const cli = start({ dataDir, cwd: repo.dir, argv: ['run', 'add a health endpoint'] });
    await waitFor('the CLI printed a run id', () => {
      if (cli.child.exitCode !== null) {
        throw new Error(`DeFlow run exited ${cli.child.exitCode}:\n${cli.stderr()}`);
      }
      return RUN_ID.exec(cli.stdout())?.[0] ?? null;
    });

    // Nothing was spawned: same pid, same token, same bytes on disk.
    expect(readFileSync(join(dataDir, 'daemon.json'), 'utf8')).toBe(bytes);
    // And nothing was refused: a second daemon would have exited 2 against the
    // lease, and this one is still watching.
    expect(cli.child.exitCode).toBeNull();
    expect(cli.stderr()).not.toContain('already running');

    const epochAfter = (await health(before?.port ?? 0)).daemonEpoch;
    expect(epochAfter).toBe(epochBefore);

    cli.child.kill('SIGINT');
    expect((await cli.exited).code).toBe(130);
  });
});
