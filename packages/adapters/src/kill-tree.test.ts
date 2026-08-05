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
import { killTree, startTimeSource, sweepTree } from './kill-tree.ts';

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
