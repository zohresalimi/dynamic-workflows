/**
 * KAR-18.2 AC6 — booting over the wreckage of a daemon that was `SIGKILL`ed:
 * a `daemon.json` nobody removed, and a `process` row nobody concluded.
 *
 * The load-bearing assertion is the *refusal*. Pids are recycled — within hours
 * on a busy machine, and from the first boot after a restart — so a reaper that
 * trusted a bare pid would eventually SIGKILL a browser, a build or a database.
 * The bystander below is a real, live, unrelated process recorded under a start
 * time that no longer matches it, which is exactly that situation.
 *
 * The other half of EPIC-18-S14 — a genuine orphan, whose recorded `(pid,
 * process_start_time)` both match, being killed and verified with the `Z`-state
 * exclusion — is `packages/daemon/test/integration/reaper.test.ts`
 * (EPIC-05-S32 scenario 1), against the same `reapOrphans` this boot calls. It
 * is not repeated here; what is new at this level is that it happens over a
 * stale `daemon.json`, on `DeFlow up`, with no manual cleanup.
 *
 * Verifies: EPIC-18-S13 (the stale-file half), EPIC-18-S14 (scenario 1) · AC6 ·
 * test plan #5
 */
import { openLedger, recordProcess } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runUp, type UpResult } from '../../src/up.ts';
import { readDaemonFile, upEnv } from './support/up-fixture.ts';

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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await removeTempDir(tmp);
});

/** A real, detached, long-lived process — an agent, as far as a row knows. */
function spawnBystander(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

suite('a stale daemon.json and a recycled pid (EPIC-18-S13, EPIC-18-S14)', () => {
  it('boots over the file, and refuses to signal a pid whose start time moved', async () => {
    const dataDir = join(tmp, 'data');
    const bystander = spawnBystander();
    const pid = bystander.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    mkdirSync(dataDir, { recursive: true });

    // The previous daemon's ledger row, with a start time that is *not* this
    // process's: the pid was recycled between then and now.
    const db = openLedger(dataDir);
    recordProcess(db, {
      runId: 'run_20260805T090000Z_5c1d2e',
      nodeId: 'n1',
      attempt: 0,
      pid,
      pgid: pid,
      startedAt: 'Wed Aug  5 10:15:00 2026',
      binarySha256: 'a'.repeat(64),
      worktree: null,
      spawnedAt: 1_754_313_093_000,
    });
    db.close();

    // …and the file it never got to remove, naming a pid and a port that are
    // both lies by now.
    writeFileSync(
      join(dataDir, 'daemon.json'),
      `${JSON.stringify({ pid: 999_999, port: 7777, token: 'stale', startedAt: 1 })}\n`,
      { mode: 0o600 },
    );

    const result = await runUp({ env: upEnv({ dataDir }), port: 0, open: false, timings: false });
    started.push(result);

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;

    // AC6 — the stale file did not block startup, and it now describes the
    // daemon that is actually running.
    const file = readDaemonFile(dataDir);
    expect(file.pid).toBe(process.pid);
    expect(file.port).toBe(result.port);
    expect(file.token).toBe(result.token);
    expect(file.token).not.toBe('stale');
    // A fresh daemon life, and the epoch says so: the ledger this spec seeded
    // has never been booted over, so this is the first.
    expect(result.epoch).toBe(1);

    // The bystander was left strictly alone.
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
    expect(() => process.kill(pid, 0)).not.toThrow();

    const decision = result.reaped.find((entry) => entry.row.pid === pid);
    expect(decision?.outcome).toBe('pid-recycled');
  });
});
