/**
 * EPIC-05-S31 — the kill switch, end to end, and the row that survives it.
 *
 * Three claims, none of which can be made without real processes:
 *
 * **A `stopReason` ends the turn, not the tree.** A cooperative cancel is the
 * only stage that produces a clean transcript, and the agent that answers it
 * exits politely — leaving behind whatever it backgrounded, reparented to init
 * and still in its process group. Stages 2 and 3 run *after* stage 1 succeeds
 * for exactly that reason (§9.4), and AC8 is the measurement: five cancelled
 * agents, five process groups, zero non-`Z` members in any of them.
 *
 * **The `process` row is written with `node.started` and cleared on exit.**
 * Written in the same transaction, because the window between two writes is
 * the moment the daemon is most likely to die — it has just started a child.
 * Cleared once the exit is observed, because a row that still says `live`
 * makes the next daemon's reaper try to kill a pid that may by then belong to
 * somebody else.
 *
 * **Stage 3 is not decoration.** The `ignore-sigterm` fixture from KAR-04.6
 * installs a real `SIG_IGN` on SIGTERM in the agent *and* in the two children
 * it backgrounds, so the group genuinely survives stage 2 and only SIGKILL ends
 * it. The escalation is measured on the injected `Clock` — no fake timers, ever,
 * with a live child (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-05-S30 (scenario 4), EPIC-05-S31 (scenarios 1, 4) · AC3, AC6,
 * AC8 · test plan #4
 */
import {
  FAKE_AGENT_BIN,
  makeTempDir,
  removeTempDir,
  sleep,
  TestClock,
  waitFor,
} from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { processStartTime, runAcpNode, sweepTree } from '../../src/index.ts';
import {
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  scenario,
  type TestLedger,
} from './support/harness.ts';
import { groupRows, killGroup, liveRows } from './support/ps.ts';

let dir = '';
let worktree = '';
let ledger: TestLedger;
const groups: number[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  for (const pgid of groups.splice(0)) killGroup(pgid);
  ledger.close();
  await removeTempDir(dir);
});

suite('a process row accompanies node.started and is cleared on exit (AC6)', () => {
  it('records pid, pgid, start time and binary digest, then clears the row when the agent exits', async () => {
    let rowWhileRunning: ReturnType<TestLedger['processRows']>[number] | undefined;

    // Read the moment the `node.started` append resolves — which is the moment
    // its transaction committed. A row written *after* the event rather than in
    // the same transaction would not be visible here.
    const processes = {
      ...ledger.processes,
      async appendWithProcess(...args: Parameters<TestLedger['processes']['appendWithProcess']>) {
        const seq = await ledger.processes.appendWithProcess(...args);
        rowWhileRunning = ledger.processRows()[0];
        return seq;
      },
    };

    const outcome = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '42', '--scenario', scenario('minimal-turn.jsonc')],
        mcpServers: [],
        prompt: 'do something short',
      },
      {
        clock: new TestClock(),
        ledger: ledger.sink,
        processes,
        captureEvidence: ledger.captureEvidence,
      },
    );

    expect(outcome.status).toBe('completed');
    expect(rowWhileRunning).toBeDefined();
    expect(rowWhileRunning).toMatchObject({
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      pid: outcome.pgid,
      pgid: outcome.pgid,
      binarySha256: mockAgentBinary().sha256,
      worktree,
      state: 'live',
    });
    // The PID-reuse guard's input, read from the OS while the process was
    // alive — not invented, and not normalised.
    expect(rowWhileRunning?.startedAt).toEqual(expect.any(String));

    // Cleared on clean exit: nothing is left for a future reaper to act on.
    expect(ledger.processRows().map((row) => row.state)).toEqual(['exited']);
  });
});

suite('five concurrent agents, one kill switch (EPIC-05-S31 scenario 4, AC8)', () => {
  it('leaves zero non-Z processes in any of the five pgids', async () => {
    const controller = new AbortController();
    const clock = new TestClock();
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'];

    const runs = nodes.map(async (node) => {
      const tree = join(dir, 'wt', node);
      await mkdir(tree, { recursive: true });
      return runAcpNode(
        {
          runId: RUN_ID,
          nodeId: node as typeof NODE_ID,
          attempt: 0,
          provider: PROVIDER,
          permission: 'worktree',
          worktree: tree,
          binary: mockAgentBinary(),
          argv: ['--seed', '42', '--scenario', scenario('hang-with-grandchildren.jsonc')],
          mcpServers: [],
          prompt: 'do something long',
        },
        {
          clock,
          ledger: ledger.sink,
          processes: ledger.processes,
          captureEvidence: ledger.captureEvidence,
          signal: controller.signal,
        },
      );
    });

    // Every one of the five is wedged with two live grandchildren.
    await waitFor(() => ledger.processRows().filter((row) => row.state === 'live').length === 5, {
      describe: 'all five agents to have started',
    });
    const pgids = ledger.processRows().map((row) => row.pgid);
    for (const pgid of pgids) groups.push(pgid);
    await waitFor(() => pgids.every((pgid) => liveRows(pgid).length >= 3), {
      describe: 'each agent to have backgrounded its two grandchildren',
    });

    controller.abort();
    const outcomes = await Promise.all(runs);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);

    // Within the 5 s + 2 s window, and excluding Z-state rows: the whole tree
    // is gone, not merely the agent that answered the protocol cancel.
    await waitFor(() => pgids.every((pgid) => liveRows(pgid).length === 0), {
      describe: 'every one of the five process groups to empty',
      timeoutMs: 7_000,
    });
    for (const pgid of pgids) expect(liveRows(pgid)).toEqual([]);

    // And no row is left claiming a live process.
    expect(ledger.processRows().filter((row) => row.state === 'live')).toEqual([]);
  });
});

suite('stage 2 then stage 3 against a group that ignores SIGTERM (test plan #4)', () => {
  it('survives the SIGTERM and dies to the SIGKILL the injected clock releases', async () => {
    const clock = new TestClock();
    const child = spawn(
      FAKE_AGENT_BIN,
      ['-p', 'hang', '--output-format', 'stream-json', '--verbose'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          DeFlow_FAKE_DIALECT: 'claude-stream-json',
          DeFlow_FAKE_SCENARIO: 'ignore-sigterm',
          DeFlow_FAKE_SEED: '42',
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const pgid = child.pid as number;
    groups.push(pgid);
    child.stdout.resume();

    // Not merely "three processes exist": the two children are
    // `sh -c 'trap "" TERM; exec sleep 300'`, and until the `exec` has happened
    // the shell has not yet made SIGTERM ignorable. Waiting for the *comm* to
    // be `sleep` is waiting for the disposition this spec depends on — a count
    // alone is a race that only shows up under load.
    await waitFor(() => liveRows(pgid).filter((row) => row.comm.endsWith('sleep')).length === 2, {
      describe: 'both SIGTERM-ignoring children to have reached their exec',
    });
    expect(liveRows(pgid).length).toBeGreaterThanOrEqual(3);

    const pending = sweepTree(pgid, { clock, killGraceMs: 2_000 });

    // Stage 2 landed and was ignored: the group is untouched, and none of what
    // `ps` lists is a zombie being counted as alive.
    await sleep(300);
    expect(liveRows(pgid).length).toBeGreaterThanOrEqual(3);

    // Stage 3, released by the clock rather than by waiting two real seconds.
    await clock.advance(2_000);
    await waitFor(() => liveRows(pgid).length === 0, {
      describe: 'the group to go on SIGKILL',
    });
    pending.cancel();

    // The Z-filter is what makes that assertion true: `ps` is still listing
    // members of a group that is entirely dead.
    expect(groupRows(pgid).every((row) => row.stat.includes('Z'))).toBe(true);
  });
});

suite('the start time is read from the OS, per platform (EPIC-05-S32 outline)', () => {
  it('answers for a live process and null for one that never existed', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    groups.push(child.pid as number);

    expect(processStartTime(child.pid as number)).toEqual(expect.any(String));
    // pid 0 is never a process a spawn produced, and asking for it must not
    // return this daemon's own start time by accident.
    expect(processStartTime(0)).toBeNull();
  });
});
