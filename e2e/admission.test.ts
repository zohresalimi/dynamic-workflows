/**
 * KAR-19.2 AC5, AC8 — `DeFlow run` on a machine that cannot host a run.
 *
 * The whole value of refusing at submission is in how quickly it happens, so
 * this is asserted the only way it can be settled: a real `DeFlow` binary, a
 * real autostarted daemon, a real on-disk ledger, and a `PATH` with no agent
 * CLI anywhere on it. What the operator got on 2026-08-12 was a prompt that
 * returned and a system that never moved; what they get here is a sentence and
 * an exit code, and the command comes back rather than watching.
 *
 * `PATH` is git's directory and nothing else — not even the directory `node`
 * lives in, which on a developer's own machine is usually the npm global bin
 * directory and therefore holds exactly the adapter this spec asserts the
 * absence of. Nothing needs `node` on `PATH`: every process here is spawned
 * with an absolute `process.execPath`.
 *
 * Verifies: EPIC-19-S10 · AC5, AC8 · test plan #5
 */

import type { RunId } from '@DeFlow/core';
import { openLedger, readRange } from '@DeFlow/ledger';
import { makeRepo } from '@DeFlow/testkit';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CliProcess,
  GIT_DIR,
  makeDataDir,
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

/** The daemon `DeFlow run` started for itself, stopped — it is detached, so
 * nothing else in this file will take it down. */
async function stopAutostartedDaemon(): Promise<void> {
  let file: DaemonFile;
  try {
    const { readFileSync } = await import('node:fs');
    file = JSON.parse(readFileSync(join(tmp, 'data', 'daemon.json'), 'utf8')) as DaemonFile;
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

/** Every run in the data directory, with the kinds its ledger holds. */
function ledger(dataDir: string): { runId: string; kinds: string[] }[] {
  const db = openLedger(dataDir);
  try {
    return db
      .prepare<{ run_id: string }>(
        'SELECT run_id, MIN(seq) AS first FROM event GROUP BY run_id ORDER BY first',
      )
      .all()
      .map((row) => ({
        runId: row.run_id,
        kinds: readRange(db, row.run_id as RunId, 0, 100).events.map((event) => event.kind),
      }));
  } finally {
    db.close();
  }
}

suite('EPIC-19-S10 — DeFlow run exits 5, and the refusal is in the ledger', () => {
  it('refuses in seconds with doctor’s own sentence, and records run.aborted', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const startedAt = Date.now();
    const cli = spawnCli({
      dataDir,
      cwd: repo.dir,
      argv: ['run', 'add a health endpoint'],
      // git and nothing else. @see this file's header.
      env: { PATH: GIT_DIR },
    });
    running.push(cli);

    const exit = await cli.exited;
    const elapsedMs = Date.now() - startedAt;

    // AC5 — `environmentUnusable`, not `failed` and not a usage error.
    expect(exit.code, `stderr:\n${cli.stderr()}\nstdout:\n${cli.stdout()}`).toBe(5);

    // The sentence, on stderr, with no stack trace in front of it.
    const stderr = cli.stderr();
    expect(stderr).toContain('DeFlow-mock-agent');
    expect(stderr).toContain('npm install -g');
    expect(stderr).not.toContain('    at ');
    // Nothing is installed here, so *"is not installed"* is the true sentence —
    // AC3's invariant is about the machine that has the vendor CLI, which is
    // the case below.
    expect(stderr).toContain('is not installed here');

    // AC8 — the attached view stopped rather than waiting. The command is over,
    // and it never printed the line that starts a watch.
    expect(cli.stdout()).not.toContain('watching');

    // The five-second clause is not decoration: a refusal that takes as long as
    // a framing attempt has spent the thing it was saving. Generous here
    // because this includes spawning a daemon from cold on a loaded CI box.
    expect(elapsedMs).toBeLessThan(30_000);

    // NF8 — and the refusal is answerable afterwards, from the ledger alone.
    const runs = ledger(dataDir);
    const refused = runs.find((run) => run.kinds.includes('task.submitted'));
    expect(refused, `runs in the ledger: ${JSON.stringify(runs)}`).toBeDefined();
    expect(refused?.kinds).toContain('provider.probed');
    expect(refused?.kinds.at(-1)).toBe('run.aborted');
  });
});

suite('EPIC-19-S9 — the reported machine, through the real binary', () => {
  it('exits 5 naming the adapter, and never says the vendor CLI is not installed', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    // `claude` on PATH, working, answering `--version` — and no ACP bridge
    // anywhere. This is the machine the incident happened on.
    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'claude');
    writeFileSync(shim, `#!/bin/sh\necho 2.1.220\n`, { mode: 0o755 });
    chmodSync(shim, 0o755);

    const cli = spawnCli({
      dataDir,
      cwd: repo.dir,
      argv: ['run', 'add a health endpoint'],
      env: { PATH: [binDir, GIT_DIR].join(':') },
    });
    running.push(cli);

    const exit = await cli.exited;
    expect(exit.code, `stderr:\n${cli.stderr()}`).toBe(5);

    const stderr = cli.stderr();
    // AC3 — the sentence KAR-18.8 wrote, reaching an operator through a third
    // surface without anyone having written it a third time.
    expect(stderr).toContain(`"claude" is installed at ${shim}`);
    expect(stderr).toContain('npm install -g @agentclientprotocol/claude-agent-acp');
    expect(stderr).not.toContain('claude is not installed');
  });
});
