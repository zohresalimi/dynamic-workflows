/**
 * EPIC-04-S19 — SIGTERM ignored, SIGKILL not, and the zombie false negative.
 *
 * The kill-escalation path (F5.7) is only exercised by a process that genuinely
 * survives `SIGTERM`, so the fixture installs a real no-op handler and
 * backgrounds two real `sleep 300` children — each with SIGTERM set to SIG_IGN,
 * because a `sleep` that died on the first signal would make "the group
 * survived SIGTERM" a weaker claim than it reads. The scenario's phrase is "all four
 * processes"; the tree this fixture actually builds is three — the agent and
 * the two children AC6 names — so the assertions are written over **the whole
 * process group** rather than a hard-coded count, which is both stronger and
 * right either way.
 *
 * The zombie filter is the trap that costs hours, and it is verified by
 * measurement: after a *successful* group `SIGKILL`, `ps` still lists the
 * grandchildren — in state `Z`, already dead and awaiting reaping by init. A
 * naive "did the kill work?" assertion concludes the group kill failed when it
 * did not, and it bites hardest inside containers where reaping lags.
 *
 * The positive-pid spec is the regression test that stops anyone simplifying
 * the kill path: `process.kill(pid)` leaves the grandchildren alive and
 * reparented, which is why DeFlowd records the **pgid** and kills the group.
 *
 * The tree is only usable once its children are SIGTERM-*proof*, which happens
 * strictly after the fixture announces their pids. `startTree` waits for that,
 * and the third suite is the control/treatment pair that measures why — see
 * both for the race that made this file pass alone and fail under the suite.
 *
 * No fake timers anywhere near this file: freezing the loop's timers with a
 * live child stops its real I/O being read at all, and the spec would hang
 * instead of failing (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-04-S19 · KAR-04.6 AC6 · test plan row 6
 */
import { execFileSync, spawn } from 'node:child_process';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { FAKE_AGENT_BIN, it, sleep, waitFor } from '../../src/index.ts';

interface Row {
  readonly pid: number;
  readonly pgid: number;
  readonly stat: string;
  /**
   * The `UCOMM` column — `ucomm` rather than `comm` because it is the one both
   * darwin and linux print as a bare name. It is what tells a `sh` that has not
   * yet reached its `exec` apart from the `sleep` it becomes, which is the
   * difference between a member that carries the default SIGTERM disposition
   * and one that carries SIG_IGN.
   */
  readonly comm: string;
}

/** Every process the OS currently lists, with its group and its state. */
function processTable(): Row[] {
  const out = execFileSync('ps', ['-eo', 'pid,pgid,stat,ucomm'], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4 && /^\d+$/.test(parts[0] as string))
    .map((parts) => ({
      pid: Number(parts[0]),
      pgid: Number(parts[1]),
      stat: parts[2] as string,
      // Joined rather than `parts[3]`: a process name may itself contain
      // spaces, and a truncated name would silently stop matching.
      comm: parts.slice(3).join(' '),
    }));
}

/** The group's members, excluding the zombies — `ps` lists those long after. */
const aliveInGroup = (pgid: number): Row[] =>
  processTable().filter((row) => row.pgid === pgid && !row.stat.includes('Z'));

const inGroup = (pgid: number): Row[] => processTable().filter((row) => row.pgid === pgid);

function ppidOf(pid: number): number | null {
  try {
    return Number(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
    );
  } catch {
    return null;
  }
}

const groups: number[] = [];

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already reaped, which is the only other acceptable state.
    }
  }
});

interface Tree {
  readonly pid: number;
  readonly grandchildren: readonly number[];
}

/**
 * Starts the fixture `detached: true` — the production spawn mode (§9.3) and
 * the thing that makes the child its own group leader — and waits until it has
 * announced the pids it backgrounded.
 */
async function startTree(): Promise<Tree> {
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

  const pid = child.pid as number;
  groups.push(pid);

  let stdout = '';
  child.stdout.on('data', (bytes: Buffer) => {
    stdout += bytes.toString('utf8');
  });

  const deadline = Date.now() + 10_000;
  let announced: number[] = [];
  while (announced.length === 0) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the tree: ${stdout}`);
    const line = stdout
      .split('\n')
      .find((candidate) => candidate.includes('grandchildren:') && candidate.endsWith('}'));
    if (line !== undefined) {
      const found = /grandchildren: ([0-9,]+)/.exec(line);
      if (found !== null) announced = (found[1] as string).split(',').map(Number);
    }
    if (announced.length === 0) await sleep(20);
  }

  // The announcement is NOT readiness, and the gap is what made this spec fail
  // only under a saturated box. `spawnSleeper` returns the pid the moment
  // `spawn` hands one over — strictly before that `sh` has run its
  // `trap "" TERM` — and the fixture announces those pids immediately. So a
  // SIGTERM arriving between the announcement and the trap reaches a shell
  // still carrying the *default* disposition, and it dies. Measured on this
  // machine: 5-8 ms from announcement to `exec`, with 4 of 12 trees still
  // un-trapped at the instant this function used to return, widening under
  // load until the group SIGTERM below started losing a member outright.
  //
  // Waiting on the `comm` is waiting on the disposition itself: `trap` runs
  // strictly before the `exec`, and POSIX preserves an *ignored* disposition
  // across `exec` while resetting handlers to default — so a row reading
  // `sleep` has SIG_IGN, and one still reading `sh` may not. Counting live rows
  // cannot see that difference, which is why a count-based gate is the wrong
  // gate. The same wait, for the same reason, guards
  // `packages/daemon/test/integration/support/ps.ts` (`waitForSigtermProof`)
  // and `packages/adapters/test/integration/kill-switch.test.ts`; this spec was
  // the one place the lesson had not been applied.
  const followers = (): Row[] => aliveInGroup(pid).filter((row) => row.pid !== pid);
  await waitFor(
    () => {
      const rows = followers();
      return rows.length >= announced.length && rows.every((row) => row.comm.endsWith('sleep'));
    },
    { describe: `both SIGTERM-ignoring children of pgid ${pid} to have reached their exec` },
  );

  return { pid, grandchildren: announced };
}

suite('EPIC-04-S19 — SIGTERM is ignored, SIGKILL is not', () => {
  it('keeps the whole group alive through a group SIGTERM, and loses it to SIGKILL', async () => {
    const tree = await startTree();
    expect(tree.grandchildren).toHaveLength(2);

    // Every member shares a pgid equal to the child's own pid: that identity is
    // what makes `kill(-pid)` reach the children at all.
    const before = aliveInGroup(tree.pid);
    expect(before.map((row) => row.pid).sort()).toEqual(
      [tree.pid, ...tree.grandchildren].sort((a, b) => a - b),
    );

    process.kill(-tree.pid, 'SIGTERM');
    await sleep(1_000);

    const survived = aliveInGroup(tree.pid);
    expect(survived.map((row) => row.pid).sort()).toEqual(before.map((row) => row.pid).sort());
    // …and none of them is a zombie being counted as alive.
    for (const row of survived) expect(row.stat).not.toContain('Z');

    process.kill(-tree.pid, 'SIGKILL');
    await sleep(500);

    // The only rows `ps` may still show for this group are Z-state: dead,
    // awaiting reaping. Anything else means the escalation did not work.
    expect(aliveInGroup(tree.pid)).toEqual([]);
    for (const row of inGroup(tree.pid)) expect(row.stat).toContain('Z');
  });
});

/**
 * The measurement behind the wait in `startTree`, as a control/treatment pair
 * on the same machine rather than a comment asserting it is so.
 *
 * Both halves are the identical process — `sh -c 'sleep 1; trap "" TERM; exec
 * sleep 300'` — and differ only in *when* the group SIGTERM lands relative to
 * the `trap`. The one-second delay is not a timing budget to be tuned: it is
 * there to make a window that is 5-8 ms in the real fixture wide enough that
 * the two halves cannot be confused by scheduling jitter, which is what lets
 * this spec state the claim deterministically instead of reproducing a flake.
 *
 * Without this pair, nothing stops someone deleting the wait in `startTree` and
 * getting a suite that is green on an idle laptop and red on a loaded one.
 */
suite('EPIC-04-S19 — the announcement is not yet the SIGTERM-proof disposition', () => {
  /** Its own group leader, exactly as the fixture is spawned (`detached`). */
  function delayedTrap(): number {
    const child = spawn('/bin/sh', ['-c', 'sleep 1; trap "" TERM; exec sleep 300'], {
      stdio: 'ignore',
      detached: true,
    });
    const pid = child.pid as number;
    groups.push(pid);
    child.unref();
    return pid;
  }

  const liveRow = (pid: number): Row | undefined =>
    processTable().find((row) => row.pid === pid && !row.stat.includes('Z'));

  it('dies to SIGTERM before its trap, and survives the same signal after it', async () => {
    // CONTROL — signalled inside the pre-`trap` window. The shell still carries
    // the default disposition, so the group SIGTERM is fatal, and `ps` proves
    // the `comm` gate would have refused to call this one ready.
    const control = delayedTrap();
    await waitFor(() => liveRow(control) !== undefined, { describe: 'the control to appear' });
    expect(liveRow(control)?.comm).not.toContain('sleep');

    process.kill(-control, 'SIGTERM');
    await sleep(250);
    expect(liveRow(control), 'a pre-trap child survived SIGTERM').toBeUndefined();

    // TREATMENT — the same process, signalled once its `comm` says `sleep`,
    // which is the observable end of that window and the predicate `startTree`
    // now waits on. SIG_IGN is in force and the signal does nothing.
    const treatment = delayedTrap();
    await waitFor(() => liveRow(treatment)?.comm.endsWith('sleep') === true, {
      describe: 'the treatment to reach its exec',
    });

    process.kill(-treatment, 'SIGTERM');
    await sleep(250);
    const survivor = liveRow(treatment);
    expect(survivor, 'a post-trap child died to SIGTERM').toBeDefined();
    expect(survivor?.stat).not.toContain('Z');

    // And it is still killable, so the assertion above is about the
    // disposition and not about a process that was never signalled at all.
    process.kill(-treatment, 'SIGKILL');
    await waitFor(() => liveRow(treatment) === undefined, {
      describe: 'the treatment to go on SIGKILL',
    });
  });
});

suite('EPIC-04-S19 — a positive-pid kill leaves the grandchildren alive', () => {
  it('kills the direct child only, and the two sleeps reparent to init', async () => {
    const tree = await startTree();

    // A POSITIVE pid: the direct child, and nothing else.
    process.kill(tree.pid, 'SIGKILL');
    await sleep(500);

    expect(processTable().find((row) => row.pid === tree.pid && !row.stat.includes('Z'))).toBe(
      undefined,
    );

    for (const pid of tree.grandchildren) {
      const row = processTable().find((candidate) => candidate.pid === pid);
      expect(row, `grandchild ${pid} survived a positive-pid kill`).toBeDefined();
      expect(row?.stat).toContain('S');
      expect(ppidOf(pid)).toBe(1);
      // Still in the dead agent's group — which is the only handle left on
      // them, and the reason DeFlowd stores the pgid rather than the pid.
      expect(row?.pgid).toBe(tree.pid);
    }
  });
});
