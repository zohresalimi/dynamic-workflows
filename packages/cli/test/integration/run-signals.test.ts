/**
 * KAR-18.3 AC3, AC4 / EPIC-18-S20, EPIC-18-S21 — what a signal does, and to
 * whom.
 *
 * Everything here is asserted from outside the process, because that is the
 * only place the claim lives: a `detached: true` that was quietly dropped looks
 * identical from inside the CLI and takes the daemon down with the terminal.
 * The process-group assertion is the one that catches it — a daemon in the
 * CLI's process group is a daemon the tty's Ctrl-C reaches.
 *
 * The two suites reach their daemon differently, on purpose. S21 is *about* the
 * autostart, so it lets the CLI perform one. S20 is about the two Ctrl-Cs, and
 * it wants a run the second press can meaningfully cancel — which means the
 * F1.3 gate has to be open — so the daemon is booted in this process and the
 * gate is opened through it while the spawned CLI watches over a real socket.
 *
 * > **Amended 2026-08-11 while implementing KAR-18.3.** EPIC-18-S20's first
 * > scenario ends *"and the run reaches `run.completed` afterwards"*, and S21's
 * > ends with an agent child still alive. Neither is reachable in this
 * > repository yet: no shipped code path executes a submitted run — nothing
 * > calls `compilePlanV1` or `executeRun`, and `boot()` starts no ticker — so
 * > no node is ever scheduled and no agent is ever spawned. What those clauses
 * > are *about* — the run outliving its viewer — is asserted here in the form
 * > that is reachable: the daemon survives in its own process group, the run is
 * > still there to be advanced after the CLI is gone, and a second
 * > `DeFlow run --attach` renders the transcript so far. The completed-plan
 * > half belongs to the orchestration wiring and is a follow-up on the story.
 *
 * Verifies: EPIC-18-S20, EPIC-18-S21 · AC3, AC4 · test plan #3, #4
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { drainEvents } from '@DeFlow/ledger';
import { it, makeRepo } from '@DeFlow/testkit';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import {
  alive,
  api,
  daemonFile,
  HERMETIC_PATH,
  MOCK_AGENT_BIN,
  type RunProcess,
  sleep,
  spawnRun,
  stopDaemon,
  until,
} from './support/cli-process.ts';
import { openSpecGate } from './support/run-fixture.ts';

const started: { dataDir: string; process: RunProcess }[] = [];
let booted: Booted | undefined;

afterEach(async () => {
  for (const entry of started.splice(0)) {
    if (entry.process.child.exitCode === null && entry.process.child.signalCode === null) {
      entry.process.child.kill('SIGKILL');
    }
    if (booted === undefined) await stopDaemon(entry.dataDir);
  }
  await booted?.shutdown();
  booted = undefined;
});

const RUN_ID = /run_\d{8}T\d{6}Z_[0-9a-f]{6}/;

/**
 * KAR-19.2 — the bundled mock agent, linked on under both names admission
 * resolves. Needed only by S21, whose `DeFlow run` autostarts its own daemon
 * and would otherwise be refused at submission before there is anything to
 * signal; harmless for S20, whose daemon is already up and was admitted (or
 * not) at its own boot, before this ever runs.
 */
async function usableProviderBinDir(dir: string): Promise<string> {
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  await symlink(MOCK_AGENT_BIN, join(binDir, 'claude'));
  await symlink(MOCK_AGENT_BIN, join(binDir, 'claude-agent-acp'));
  return binDir;
}

/** Starts `DeFlow run` and waits until it has created a run and is watching. */
async function startWatching(
  tmp: string,
): Promise<{ cli: RunProcess; dataDir: string; runId: string }> {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  const binDir = await usableProviderBinDir(tmp);

  const cli = spawnRun({
    dataDir,
    cwd: repo.dir,
    args: ['add a health endpoint'],
    env: { PATH: [binDir, HERMETIC_PATH].join(':') },
  });
  started.push({ dataDir, process: cli });

  const runId = await until('the CLI printed a run id', () => {
    if (cli.child.exitCode !== null) {
      throw new Error(`DeFlow run exited ${cli.child.exitCode}:\n${cli.stderr()}`);
    }
    return RUN_ID.exec(cli.stdout())?.[0] ?? null;
  });

  return { cli, dataDir, runId };
}

/** The process group id of `pid`, straight from `ps`. */
function processGroup(pid: number): number {
  return Number(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
  );
}

suite('EPIC-18-S20 — the first Ctrl-C detaches, the second cancels (AC3)', () => {
  /** A daemon in *this* process, so the spec can open the F1.3 gate on the
   * run the spawned CLI creates through it. */
  async function withGate(tmp: string): Promise<{ cli: RunProcess; runId: string }> {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    booted = await boot({ dataDir, port: 0, dev: false });

    const { cli, runId } = await startWatching(tmp);
    openSpecGate(RunIdSchema.parse(runId), {
      db: booted.db,
      epoch: booted.epoch,
      ts: Date.now(),
    });
    return { cli, runId };
  }

  it('the first press prints both alternatives, exits 130, and leaves the run alone', async ({
    tmp,
  }) => {
    const { cli, runId } = await withGate(tmp);

    cli.child.kill('SIGINT');
    const exit = await cli.exited;

    expect(exit.code).toBe(130);
    expect(cli.stdout()).toContain(
      `detached — run ${runId} continues; 'DeFlow run --attach ${runId}' to watch, ` +
        `'DeFlow cancel ${runId}' to stop`,
    );

    // The run outlived its viewer: nothing was appended to end it.
    const kinds = drainEvents(booted?.db as never, RunIdSchema.parse(runId)).map(
      (event) => event.kind,
    );
    expect(kinds).not.toContain('run.aborted');
    expect(kinds).not.toContain('run.completed');
  });

  it('the second press within three seconds ends the run in the ledger', async ({ tmp }) => {
    const { cli, runId } = await withGate(tmp);

    cli.child.kill('SIGINT');
    await sleep(300); // Well inside the window the first press opened.
    cli.child.kill('SIGINT');

    const exit = await cli.exited;
    expect(exit.code).toBe(130);

    // It ended in the **ledger**, not in the CLI: a `DeFlow run` that
    // "cancelled" by exiting would leave this run standing.
    const kinds = drainEvents(booted?.db as never, RunIdSchema.parse(runId)).map(
      (event) => event.kind,
    );
    expect(kinds).toContain('run.aborted');
  });
});

suite('EPIC-18-S21 — killing the CLI does not kill the run (AC4)', () => {
  it('SIGKILLs the launcher and leaves DeFlowd alive, in its own process group', async ({
    tmp,
  }) => {
    const { cli, dataDir, runId } = await startWatching(tmp);
    const daemon = daemonFile(dataDir);
    expect(daemon).not.toBeNull();

    // AC4's mechanism, before the kill: DeFlowd is not in the CLI's group, so
    // a signal aimed at that group cannot reach it.
    expect(processGroup(daemon?.pid ?? 0)).not.toBe(processGroup(cli.child.pid ?? 0));

    cli.child.kill('SIGKILL');
    const exit = await cli.exited;
    expect(exit.signal).toBe('SIGKILL');

    await sleep(200);
    expect(alive(daemon?.pid ?? 0)).toBe(true);
    expect((await api(dataDir, '/api/health')).status).toBe(200);
    expect((await api(dataDir, `/api/runs/${runId}`)).status).toBe(200);

    // …and a new terminal picks the run back up and renders its transcript.
    const attach = spawnRun({
      dataDir,
      cwd: join(tmp, 'repo'),
      args: ['--attach', runId],
    });
    started.push({ dataDir, process: attach });

    await until('the second terminal rendered the transcript', () =>
      attach.stdout().includes('task') && attach.stdout().includes('submitted') ? true : null,
    );
    attach.child.kill('SIGINT');
    expect((await attach.exited).code).toBe(130);
  });
});
