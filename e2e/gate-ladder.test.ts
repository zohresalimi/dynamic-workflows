/**
 * KAR-12.1 test plan #12 / EPIC-12-S2 — a red typecheck never buys a review,
 * end to end.
 *
 * e2e rather than integration because the claim is about a **run**, not about
 * three functions agreeing when a spec calls them in order. Three separate
 * processes are involved and each one is load-bearing:
 *
 *   1. a real `tsc`, spawned by the gate runner, over a real type error;
 *   2. a real run in its own process — `node packages/daemon/scripts/run-gates.ts`,
 *      which is DeFlowd's executor and gate performer behind a `main()` —
 *      holding the ledger's lease while it works;
 *   3. a real DeFlowd afterwards, over the same data directory, answering the
 *      cost question on the wire.
 *
 * The two assertions S2 names are asked of the world rather than of a log. The
 * review gate's command is a real executable that creates a file when it runs,
 * so *"never scheduled"* is `existsSync` on that file; and the cost delta is
 * the run summary the daemon serves over HTTP, read once before the gates ran
 * and once after, byte for byte.
 *
 * Verifies: EPIC-12-S2 · AC1, AC2 · test plan #12
 */
import { openLedger, readRange } from '@DeFlow/ledger';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, describe as suite } from 'vitest';
import {
  asClient,
  type DaemonProcess,
  freePort,
  makeDataDir,
  removeDataDir,
  repoRoot,
  spawnDaemon,
  waitForHealth,
} from './support/daemon.ts';
import { GATE_RUN, seedGateLadder } from './support/gate-ladder-fixture.ts';

const RUN_GATES = join(repoRoot, 'packages/daemon/scripts/run-gates.ts');

const dirs: string[] = [];
const running: DaemonProcess[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) await removeDataDir(dir);
});

/** Runs the plan to settle in its own process, and returns what it printed. */
function runGatesProcess(dataDir: string, worktree: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_GATES, dataDir, worktree, GATE_RUN], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out.join('').trim());
      else reject(new Error(`run-gates exited ${String(code)}\n${err.join('')}`));
    });
  });
}

/** The run as the daemon serves it, as an authenticated client (KAR-15.2). */
async function summary(daemon: DaemonProcess): Promise<Record<string, unknown>> {
  const response = await asClient(daemon)(`${daemon.origin}/api/runs/${GATE_RUN}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** Every event of the run, straight from the ledger the run wrote. */
function events(dataDir: string): { kind: string; nodeId: string | null; payload: unknown }[] {
  const db = openLedger(dataDir);
  try {
    return readRange(db, GATE_RUN, 0, 500).events.map((event) => ({
      kind: event.kind,
      nodeId: event.nodeId ?? null,
      payload: event.payload,
    }));
  } finally {
    db.close();
  }
}

suite('EPIC-12-S2 — the ladder short-circuits, in a real run', () => {
  it('never schedules the review gate, and the run costs exactly what it did before', async () => {
    const dataDir = await makeDataDir();
    dirs.push(dataDir);
    const worktree = join(dataDir, 'repo');
    await mkdir(worktree, { recursive: true });
    const fixture = await seedGateLadder(dataDir, worktree);

    // Before: a real DeFlowd over the seeded run, asked what it has spent.
    const before = spawnDaemon({ dataDir, port: await freePort() });
    running.push(before);
    await waitForHealth(before);
    const costBefore = JSON.stringify((await summary(before)).budget ?? null);
    await before.stop();
    running.length = 0;

    // The run itself: its own process, its own lease, real child processes.
    await runGatesProcess(dataDir, worktree);

    const log = events(dataDir);
    const verdicts = log.filter((event) => event.kind === 'gate.evaluated');
    expect(verdicts).toHaveLength(1);
    expect((verdicts[0]?.payload as { gate: string }).gate).toBe('typecheck');
    expect((verdicts[0]?.payload as { verdict: { outcome: string } }).verdict.outcome).toBe('fail');

    for (const kind of ['node.scheduled', 'node.started', 'node.completed']) {
      expect(log.filter((event) => event.kind === kind).map((event) => event.nodeId)).not.toContain(
        'gate-review',
      );
    }
    // Asked of the world: the reviewer's command would have left this behind.
    expect(existsSync(fixture.reviewMarker)).toBe(false);

    // After: the same question, over the wire, to a second real daemon.
    const after = spawnDaemon({ dataDir, port: await freePort() });
    running.push(after);
    await waitForHealth(after);
    expect(JSON.stringify((await summary(after)).budget ?? null)).toBe(costBefore);
  }, 180_000);
});
