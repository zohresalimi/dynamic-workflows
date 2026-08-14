/**
 * KAR-18.7 — `DeFlow status` against a real daemon, a `SIGKILL`ed one, a
 * recycled pid, and nothing at all.
 *
 * The named red for the middle two is the one the flow file spells out: a
 * `status` that trusts the pid in `daemon.json` reports a daemon that is gone
 * — or, worse, matches a pid the OS has since handed to somebody's editor and
 * sends the operator to kill it. So liveness here is the *same*
 * `(pid, process_start_time)` discipline the boot reaper applies
 * (packages/daemon/src/reaper.ts), applied to a read-only command: an opaque
 * start-time string compared for equality, never a pid on its own and never a
 * timestamp reconstructed from one.
 *
 * Real processes throughout — a real daemon this spec boots and a real
 * unrelated process it spawns — because "the pid is alive but it is not ours"
 * cannot be produced with a mock, and a mocked `process.kill` would test the
 * mock.
 *
 * Verifies: EPIC-18-S48, EPIC-18-S49 · AC3, AC4, AC5 · test plan #2, #3
 */
import type { Db, RunId } from '@DeFlow/core';
import { daemonFilePath } from '@DeFlow/daemon';
import { appendEvents, type EventDraft, openRead, readRange } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { readStatus, renderStatusJson, runStatus } from '../../src/status.ts';
import { runUp, type UpResult } from '../../src/up.ts';
import { alive, CLI_BIN, sleep, until } from './support/cli-process.ts';
import { readDaemonFile, upEnv } from './support/up-fixture.ts';

/** A recorded run, for the events that give a status line something to say. */
const FIXTURE_DB = fileURLToPath(
  new URL('../../../../test/fixtures/runs/gate-failure-repair/ledger.db', import.meta.url),
);
const FIXTURE_RUN = 'run_20260810T090000Z_9f31ab' as RunId;

/**
 * The prefix of the recorded run that is still *in flight*: two nodes done and
 * one running, before `run.completed` closes it. A status command that listed
 * finished runs would be a list that only grows.
 */
const IN_FLIGHT_EVENTS = 18;

let tmp = '';
const started: UpResult[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  for (const result of started.splice(0)) {
    if (result.kind === 'started') await result.stop();
  }
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && alive(child.pid)) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Already gone between the check and the signal.
      }
    }
  }
  await removeTempDir(tmp);
});

const remember = (result: UpResult): UpResult => {
  started.push(result);
  return result;
};

/**
 * Replays the first `count` events of the recorded run onto `db` under a new
 * id, carrying this daemon's epoch.
 *
 * The events come out of a real ledger through the shipped reader and go back
 * in through the shipped append boundary, so nothing here can assert a shape
 * the daemon does not produce.
 */
function seedRun(db: Db, runId: RunId, epoch: number, count: number): void {
  const source = openRead(FIXTURE_DB);
  try {
    const drafts: EventDraft[] = readRange(source, FIXTURE_RUN, 0, count).events.map((event) => {
      const { seq: _seq, ...draft } = event;
      return { ...draft, runId, epoch } as EventDraft;
    });
    appendEvents(db, drafts);
  } finally {
    source.close();
  }
}

/** True once `/api/health` answers on `port` — the unauthenticated route. */
async function served(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(25);
  }
  return false;
}

suite('EPIC-18-S48 — a live daemon (AC3)', () => {
  it('reports pid, port, daemon_epoch, uptime and one line per active run', async () => {
    const dataDir = join(tmp, 'data');
    const result = remember(
      await runUp({ env: upEnv({ dataDir }), port: 0, open: false, timings: false }),
    );
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;

    const first = 'run_20260810T090000Z_aaaaaa' as RunId;
    const second = 'run_20260810T090000Z_bbbbbb' as RunId;
    seedRun(result.daemon.db, first, result.epoch, IN_FLIGHT_EVENTS);
    seedRun(result.daemon.db, second, result.epoch, IN_FLIGHT_EVENTS);
    // A finished run, which must not appear: `status` answers "what is
    // running?", not "what has ever run here". The fixture's whole ledger —
    // 31 events, `run.completed` last — rather than its old length of 30, so
    // this copy actually ends on the terminal event and not one short of it.
    seedRun(result.daemon.db, FIXTURE_RUN, result.epoch, 31);

    const file = readDaemonFile(dataDir);
    const env = upEnv({ dataDir });
    const status = readStatus({ env, clock: { now: () => file.startedAt + 65_000 } });

    expect(status.kind).toBe('running');
    if (status.kind !== 'running') return;
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(result.port);
    expect(status.epoch).toBe(result.epoch);
    expect(status.uptimeMs).toBe(65_000);
    expect(status.runs.map((run) => run.runId).sort()).toEqual([first, second]);
    expect(status.runs[0]?.nodeCounts).toEqual({ completed: 2, running: 1 });

    const rendered = runStatus({ env, clock: { now: () => file.startedAt + 65_000 } });
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain(String(result.port));
    expect(rendered.stdout).toContain(String(process.pid));
    expect(rendered.stdout).toContain('1m 5s');
    expect(rendered.stdout).toContain(first);
    expect(rendered.stdout).toContain(second);
    expect(rendered.stdout).not.toContain(FIXTURE_RUN);

    // AC3's last clause: the same values, in one JSON document.
    const json: unknown = JSON.parse(
      renderStatusJson(readStatus({ env, clock: { now: () => file.startedAt + 65_000 } })),
    );
    expect(json).toMatchObject({
      status: 'running',
      pid: process.pid,
      port: result.port,
      daemonEpoch: result.epoch,
      uptimeMs: 65_000,
    });
    expect((json as { runs: unknown[] }).runs).toHaveLength(2);
  });
});

suite('EPIC-18-S48 — no daemon at all (AC5)', () => {
  it('exits 0 and names the command that starts one', () => {
    const dataDir = join(tmp, 'empty');
    mkdirSync(dataDir, { recursive: true });

    const result = runStatus({ env: upEnv({ dataDir }) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no daemon is running/i);
    expect(result.stdout).toContain('DeFlow up');
    expect(result.stderr).toBe('');
  });
});

suite('EPIC-18-S49 — the daemon.json outlived its daemon (AC4)', () => {
  it('reports stale after a SIGKILL, and names the file', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });

    // A daemon in its own process, because this spec kills it outright: a
    // `SIGKILL` of the test worker would take the assertions with it.
    const child = spawn(process.execPath, [CLI_BIN, 'up', '--no-open'], {
      env: upEnv({ dataDir }),
      stdio: 'ignore',
      detached: true,
    });
    children.push(child);

    const file = await until('the daemon wrote daemon.json', () =>
      existsSync(daemonFilePath(dataDir)) ? readDaemonFile(dataDir) : null,
    );
    expect(await served(file.port)).toBe(true);

    process.kill(file.pid, 'SIGKILL');
    await until('the daemon died', () => (alive(file.pid) ? null : true));

    const result = runStatus({ env: upEnv({ dataDir }) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('stale');
    expect(result.stdout).toContain(daemonFilePath(dataDir));
    expect(result.stdout).toMatch(/DeFlow up/);
    expect(result.stdout).toMatch(/take over/i);
    expect(result.stdout).not.toMatch(/^DeFlow status: running/m);
  });

  it('reports a recycled pid as stale, and leaves that process alone', async () => {
    const dataDir = join(tmp, 'recycled');
    mkdirSync(dataDir, { recursive: true });

    // An unrelated process holding a pid — an editor, a build, a browser, as
    // far as `daemon.json` can tell.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(unrelated);
    const pid = await until('the unrelated process started', () => unrelated.pid ?? null);

    writeFileSync(
      daemonFilePath(dataDir),
      `${JSON.stringify({
        pid,
        port: 7777,
        token: 'not-a-real-token',
        startedAt: Date.now() - 60_000,
        // Recorded by a daemon that held this pid before it was recycled.
        processStartedAt: 'Sat Jan  1 00:00:00 2000',
      })}\n`,
    );

    const result = runStatus({ env: upEnv({ dataDir }) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('stale');
    expect(result.stdout).toMatch(/no signal/i);
    expect(result.stdout).not.toMatch(/^DeFlow status: running/m);

    // The whole point: it is still there, and nothing touched it.
    await sleep(50);
    expect(alive(pid)).toBe(true);
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
  });
});
