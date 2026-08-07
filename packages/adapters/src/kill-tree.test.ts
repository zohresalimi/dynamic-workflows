/**
 * KAR-05.9 — the one abstraction every signal in the daemon goes through.
 *
 * Three claims are made here rather than at integration level, because all
 * three are about what the function *refuses* to do and a refusal is invisible
 * in a spec that watches processes die:
 *
 * 1. **Windows throws.** Windows has no process groups; the path there is
 *    `taskkill /PID <pid> /T /F`, and the POSIX result was not tested and does
 *    not transfer (docs/07-provider-adapter-layer.md §9.5). A POSIX branch that
 *    silently no-opped there would be a kill switch that reports success and
 *    leaves the agent editing the worktree.
 * 2. **The pid is negated, always.** `process.kill(pid)` and
 *    `process.kill(-pid)` differ by one character and by the whole point of
 *    `detached: true` — the measured difference is in
 *    `test/integration/process-group.test.ts`.
 * 3. **pid 0, 1 and negatives are refused.** `process.kill(-0, 'SIGKILL')` is
 *    `process.kill(0, …)`, which signals *this* daemon's own process group, and
 *    `-1` is every process the user is allowed to signal. A pid read back from
 *    a stale `process` row is exactly where a 0 comes from.
 *
 * Verifies: EPIC-05-S31, EPIC-05-S32 · AC5 · test plan #8
 */
import { TestClock } from '@DeFlow/testkit';
import { expect, it, describe as suite } from 'vitest';
import { NotImplementedOnWin32 } from './failures.ts';
import {
  awaitGroupDrained,
  killTree,
  liveGroupMembers,
  liveGroupRows,
  startTimeSource,
  sweepTree,
} from './kill-tree.ts';

/** A recording stand-in for `process.kill`. Never a mocked module: the port is
 * a function parameter precisely so nothing has to be intercepted. */
function recordingKill(behaviour: (pid: number) => void = () => {}) {
  const sent: { pid: number; signal: NodeJS.Signals }[] = [];
  // A plain arrow rather than a method: nothing here reads `this`, and a
  // method handed around as a value is the shape lint objects to.
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    sent.push({ pid, signal });
    behaviour(pid);
  };
  return { sent, kill };
}

suite('killTree is a single abstraction with a win32 stub (AC5, test plan #8)', () => {
  it('throws a typed "not implemented on win32" error rather than taking a POSIX path', () => {
    const killer = recordingKill();
    expect(() => killTree(4242, 'SIGKILL', { platform: 'win32', kill: killer.kill })).toThrow(
      NotImplementedOnWin32,
    );
    expect(() => killTree(4242, 'SIGKILL', { platform: 'win32', kill: killer.kill })).toThrow(
      /not implemented on win32/,
    );
    // Nothing was signalled on the way to the throw.
    expect(killer.sent).toEqual([]);
  });

  it('names the operation and the reason the POSIX result does not transfer', () => {
    try {
      killTree(4242, 'SIGTERM', { platform: 'win32' });
      expect.unreachable('killTree should have thrown on win32');
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedOnWin32);
      const typed = error as NotImplementedOnWin32;
      expect(typed.name).toBe('NotImplementedOnWin32');
      expect(typed.operation).toBe('killTree');
      expect(typed.message).toMatch(/taskkill/);
    }
  });
});

suite('killTree signals the group and never the bare pid', () => {
  it('negates the pid, which is what makes it reach every descendant', () => {
    const killer = recordingKill();
    const outcome = killTree(4242, 'SIGTERM', { platform: 'darwin', kill: killer.kill });
    expect(killer.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
    expect(outcome).toBe('signalled');
  });

  it('reports "gone" rather than throwing when the group has already been reaped', () => {
    const killer = recordingKill(() => {
      const esrch = new Error('kill ESRCH') as NodeJS.ErrnoException;
      esrch.code = 'ESRCH';
      throw esrch;
    });
    expect(killTree(4242, 'SIGKILL', { platform: 'linux', kill: killer.kill })).toBe('gone');
  });

  it('rethrows anything that is not "the group is gone"', () => {
    const killer = recordingKill(() => {
      const eperm = new Error('kill EPERM') as NodeJS.ErrnoException;
      eperm.code = 'EPERM';
      throw eperm;
    });
    expect(() => killTree(4242, 'SIGKILL', { platform: 'linux', kill: killer.kill })).toThrow(
      /EPERM/,
    );
  });

  for (const pid of [0, 1, -1, -4242, 1.5, Number.NaN]) {
    it(`refuses pid ${pid} instead of signalling something catastrophic`, () => {
      const killer = recordingKill();
      expect(() => killTree(pid, 'SIGKILL', { platform: 'darwin', kill: killer.kill })).toThrow(
        RangeError,
      );
      expect(killer.sent).toEqual([]);
    });
  }
});

suite('sweepTree runs stage 2 then stage 3 on the injected clock (AC3)', () => {
  it('sends SIGTERM immediately and SIGKILL only after the grace elapses', async () => {
    const clock = new TestClock();
    const killer = recordingKill();

    sweepTree(4242, { clock, killGraceMs: 2_000, platform: 'darwin', kill: killer.kill });

    expect(killer.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    await clock.advance(1_999);
    expect(killer.sent).toHaveLength(1);

    await clock.advance(1);
    expect(killer.sent).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('cancels the SIGKILL when the group is already gone', async () => {
    const clock = new TestClock();
    const killer = recordingKill();

    sweepTree(4242, { clock, killGraceMs: 2_000, platform: 'darwin', kill: killer.kill }).cancel();

    await clock.advance(10_000);
    expect(killer.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });
});

suite('the start-time source is platform-specific (EPIC-05-S32 scenario outline)', () => {
  it('reads /proc/<pid>/stat field 22 on linux', () => {
    expect(startTimeSource('linux')).toBe('/proc/<pid>/stat field 22');
  });

  it('reads ps -o lstart= -p <pid> on darwin', () => {
    expect(startTimeSource('darwin')).toBe('ps -o lstart= -p <pid>');
  });

  it('throws the same typed error on win32 as killTree does', () => {
    expect(() => startTimeSource('win32')).toThrow(NotImplementedOnWin32);
  });
});

// ── KAR-06.7 AC7 — the Z filter, deterministically ───────────────────────────

/**
 * A `ps -eo pid,pgid,stat` table, spelled out.
 *
 * The filter is proved here rather than against a real kill for one reason: the
 * zombie window is a race. After a successful group SIGKILL the members linger
 * in state `Z` until init reaps them, which is *usually* long enough to observe
 * and, under load or on a fast reaper, is not. A spec that asserted "a zombie is
 * still listed" would be intermittently red about something that is not the
 * claim; the claim is what the function does with a `Z` row when it sees one.
 */
const PS_TABLE = [
  '  PID  PGID STAT',
  ' 4242  4242 Z   ', // the group leader, already dead and awaiting reaping
  ' 4243  4242 Z+  ', // a grandchild, likewise — `Z+` is still a zombie
  ' 4244  4242 Ss  ', // the one member that really is still running
  ' 4250  4250 S   ', // another group entirely, alive, and none of our business
].join('\n');

suite('liveGroupMembers excludes zombies and other groups (AC7)', () => {
  const ps = () => PS_TABLE;

  it('counts only the non-Z members of the group asked about', () => {
    expect(liveGroupMembers(4242, { ps })).toEqual([4244]);
  });

  it('reports an emptied group as empty even while ps still lists every member', () => {
    const allDead = PS_TABLE.replace(' 4244  4242 Ss  ', ' 4244  4242 Z   ');

    // Three rows for this pgid, and the honest answer is still "nothing is
    // running". Counting them is how a working kill reads as a failure.
    expect(allDead.split('\n').filter((line) => line.includes('4242')).length).toBe(3);
    expect(liveGroupMembers(4242, { ps: () => allDead })).toEqual([]);
  });

  it('refuses the pids that are not a group DeFlow created', () => {
    for (const pgid of [0, 1, -1, 1.5]) {
      expect(liveGroupMembers(pgid, { ps })).toEqual([]);
    }
  });

  it('answers "nothing to report" rather than inventing survivors when ps fails', () => {
    // A survivor list nobody can name would turn a working kill into a
    // permanent failure event that no operator can act on.
    expect(
      liveGroupMembers(4242, {
        ps: () => {
          throw new Error('ps: command not found');
        },
      }),
    ).toEqual([]);
  });
});

// ── KAR-08.6 — verification is a window, not a snapshot ──────────────────────

/**
 * `liveGroupRows` is `liveGroupMembers` with the evidence kept.
 *
 * A kill that did not take is reported to an operator who then has to go and
 * look, and "pid 4244 survived" is a different sentence from "pid 4244 survived
 * in state `D`, uninterruptible in a syscall" — the second says why SIGKILL did
 * not land and the first invites a bug report. The state is carried into
 * `run.kill_failed` for that reason (EPIC-08-S29 scenario 1).
 */
suite('liveGroupRows keeps the state it filtered on (KAR-08.6 AC6)', () => {
  const ps = () => PS_TABLE;

  it('names the survivor and the state that makes it one', () => {
    expect(liveGroupRows(4242, { ps })).toEqual([{ pid: 4244, stat: 'Ss' }]);
  });

  it('agrees with liveGroupMembers, which is defined in terms of it', () => {
    expect(liveGroupRows(4242, { ps }).map((row) => row.pid)).toEqual(
      liveGroupMembers(4242, { ps }),
    );
  });
});

/**
 * EPIC-08-S27, last scenario: **container timing**.
 *
 * Zombie reaping is prompt under launchd and systemd and can lag badly inside
 * containers, which is where this code runs in CI. A verification that read one
 * instantaneous `ps` snapshot would report survivors for a group that was
 * already dead — the same false negative the `Z` filter exists to prevent,
 * arriving through the other door. So the post-SIGKILL check is a *window*: it
 * asks again, on the injected clock, until the group is empty or the two
 * seconds are up.
 */
suite('awaitGroupDrained polls within the window (EPIC-08-S27 container timing)', () => {
  it('answers immediately, without sleeping, when the group is already empty', async () => {
    const clock = new TestClock();
    let asked = 0;
    const survivors = await awaitGroupDrained(4242, {
      clock,
      members: () => {
        asked += 1;
        return [];
      },
    });

    expect(survivors).toEqual([]);
    expect(asked).toBe(1);
    // Nothing was scheduled: a cancelled node's outcome does not wait out a
    // window that had already been satisfied.
    expect(clock.pending).toBe(0);
  });

  it('keeps asking, so a group that drains late is still a success', async () => {
    const clock = new TestClock();
    const answers = [
      [{ pid: 4243, stat: 'S' }],
      [{ pid: 4243, stat: 'S' }],
      [] as { pid: number; stat: string }[],
    ];
    let asked = 0;
    const pending = awaitGroupDrained(4242, {
      clock,
      windowMs: 2_000,
      pollMs: 250,
      members: () =>
        answers[Math.min(asked++, answers.length - 1)] as { pid: number; stat: string }[],
    });

    await clock.advance(2_000);
    expect(await pending).toEqual([]);
    // More than the one snapshot a naive check would have taken, and it stopped
    // as soon as it had an answer rather than waiting the window out.
    expect(asked).toBe(3);
  });

  it('reports the survivors once the window is spent, and stops asking', async () => {
    const clock = new TestClock();
    let asked = 0;
    const alive = [{ pid: 4243, stat: 'D' }];
    const pending = awaitGroupDrained(4242, {
      clock,
      windowMs: 2_000,
      pollMs: 500,
      members: () => {
        asked += 1;
        return alive;
      },
    });

    await clock.advance(2_000);
    expect(await pending).toEqual(alive);
    // One snapshot up front plus one per poll across the window — bounded, so a
    // wedged group cannot turn the verification into a busy loop.
    expect(asked).toBe(5);
  });

  it('never claims success from the absence of an error (EPIC-08-S29 scenario 2)', async () => {
    const clock = new TestClock();
    const pending = awaitGroupDrained(4242, {
      clock,
      windowMs: 1_000,
      pollMs: 1_000,
      // The whole group is in state Z: `ps` still lists three rows, and the
      // honest answer is still "nothing is running".
      members: () => liveGroupRows(4242, { ps: () => PS_TABLE.replaceAll('Ss', 'Z') }),
    });
    await clock.advance(1_000);
    expect(await pending).toEqual([]);
  });
});
