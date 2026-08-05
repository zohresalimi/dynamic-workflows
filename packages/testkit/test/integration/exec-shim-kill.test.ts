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
 * No fake timers anywhere near this file: freezing the loop's timers with a
 * live child stops its real I/O being read at all, and the spec would hang
 * instead of failing (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-04-S19 · KAR-04.6 AC6 · test plan row 6
 */
import { execFileSync, spawn } from 'node:child_process';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { FAKE_AGENT_BIN, it, sleep } from '../../src/index.ts';

interface Row {
  readonly pid: number;
  readonly pgid: number;
  readonly stat: string;
}

/** Every process the OS currently lists, with its group and its state. */
function processTable(): Row[] {
  const out = execFileSync('ps', ['-eo', 'pid,pgid,stat'], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && /^\d+$/.test(parts[0] as string))
    .map((parts) => ({
      pid: Number(parts[0]),
      pgid: Number(parts[1]),
      stat: parts[2] as string,
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
