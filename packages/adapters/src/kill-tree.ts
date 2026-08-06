/**
 * KAR-05.9 — the process tree: one way to signal it, one way to identify it.
 *
 * `detached: true` on every agent spawn buys two things and costs one. It buys
 * a process group led by the child, so a wedged agent *and everything it went
 * on to spawn* are reachable with a single signal; and it stops that signal
 * from also reaching DeFlowd, which is what would happen if the grandchildren
 * had stayed in the daemon's own group (§9.3, measured — see
 * `test/integration/process-group.test.ts`). It costs the fact that **the agent
 * survives DeFlowd's death**, which is why `processStartTime` exists at all.
 *
 * Everything that sends a signal in this daemon goes through `killTree`, and
 * `killTree` has exactly one job: turn a pid into `-pid`. That is not a wrapper
 * for its own sake —
 *
 * - `process.kill(pid)` and `process.kill(-pid)` differ by one character and by
 *   the entire behaviour under test. The positive form leaves every grandchild
 *   running with `ppid=1`; the regression test that proves it is scenario 3 of
 *   EPIC-05-S31, and it exists because the positive form looks like a
 *   simplification.
 * - Windows has **no process groups**. The path there is
 *   `taskkill /PID <pid> /T /F`, it was never tested, and the POSIX result does
 *   not transfer (M3, NF5). A single abstraction is what makes that a typed
 *   throw at one place instead of a silent no-op at five.
 * - `-0` is `0`, and `process.kill(0, …)` signals **the caller's own process
 *   group** — that is, DeFlowd and everything it is supervising. A pid of 0 is
 *   exactly what a `process` row written by a spawn that never got a pid holds,
 *   so the guard below is on the shortest path from a stale row to an outage.
 */
import type { Clock, TimerHandle } from '@DeFlow/core';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nodeProcess from 'node:process';
import { NotImplementedOnWin32, UnsignalablePid } from './failures.ts';

/** Default SIGTERM → SIGKILL gap, on the injected clock (§9.4 stage 2 → 3). */
export const SWEEP_KILL_GRACE_MS = 2_000;

/** Whether a signal was delivered, or the group had already been reaped. */
export type KillOutcome = 'signalled' | 'gone';

export interface KillTreePorts {
  /** Defaults to this process's platform. Injected so the win32 refusal is
   * testable from a POSIX machine — the only way it ever gets tested at M1. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.kill`. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * The pids that must never be negated and handed to `kill(2)`.
 *
 * 0 is the caller's own group, 1 is init, and a negative number is already a
 * group — negating it would signal a single process chosen at random by
 * arithmetic. All three are what a corrupt or half-written `process` row looks
 * like, and none of them is a group DeFlow ever created.
 */
function requireSpawnedPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) throw new UnsignalablePid(pid);
}

/** Whether an error from `kill(2)` means "there was nothing left to signal". */
function alreadyGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH';
}

/**
 * Signals the whole process group led by `pid`.
 *
 * The single abstraction of AC5: POSIX negates the pid, win32 throws. Returns
 * `'gone'` — rather than throwing — when the group has already been reaped,
 * because "there is nothing left to kill" is the outcome every caller wanted.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals,
  ports: KillTreePorts = {},
): KillOutcome {
  const platform = ports.platform ?? nodeProcess.platform;
  if (platform === 'win32') throw new NotImplementedOnWin32('killTree');
  requireSpawnedPid(pid);

  const kill =
    ports.kill ?? ((target: number, sent: NodeJS.Signals) => nodeProcess.kill(target, sent));
  try {
    // The negation is the whole function.
    kill(-pid, signal);
    return 'signalled';
  } catch (error) {
    if (alreadyGone(error)) return 'gone';
    throw error;
  }
}

export interface SweepPorts extends KillTreePorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** How long after SIGTERM before SIGKILL. Defaults to `SWEEP_KILL_GRACE_MS`. */
  readonly killGraceMs?: number;
}

/**
 * Stages 2 and 3 of §9.4: SIGTERM the group now, SIGKILL it once the grace has
 * elapsed on the injected clock.
 *
 * Returns the pending SIGKILL's handle rather than awaiting it. A cancelled
 * node's outcome must not sit behind two seconds of wall clock, and the group
 * is almost always empty long before the timer comes due — the timer is the
 * answer to an agent that ignores SIGTERM, not the normal path.
 *
 * The SIGKILL is sent unconditionally rather than after checking whether the
 * group still has non-`Z` members. Reading that answer costs a `ps` child
 * process to decide whether to send a signal that is a no-op when the group is
 * empty, and `Z`-state members would make the check say "still alive" about
 * processes that are already dead (AC4).
 */
export function sweepTree(pgid: number, ports: SweepPorts): TimerHandle {
  killTree(pgid, 'SIGTERM', ports);
  return ports.clock.setTimer(ports.killGraceMs ?? SWEEP_KILL_GRACE_MS, () => {
    killTree(pgid, 'SIGKILL', ports);
  });
}

/**
 * The members of `pgid` that are **actually still running** — the one honest
 * answer to "did the kill work?" (KAR-06.7 AC7, docs/09-workspace-and-safety.md
 * §11.2).
 *
 * This is the AC's own command, minus the `awk`:
 *
 * ```bash
 * ps -eo pid,pgid,stat | awk -v g="$PGID" '$2==g && $3 !~ /Z/'
 * ```
 *
 * **Verified.** After a *successful* group SIGKILL, `ps` still lists every
 * grandchild — in state `Z`, `ppid = 1`, already dead and waiting for init to
 * reap them. An implementation that counted those reports a working kill as a
 * failure, and it bites hardest inside containers where reaping lags and the
 * test is the only thing that ever notices.
 *
 * `-eo` and a filter in this process rather than `-g`, because `ps -g` means
 * "session leader or effective group name" on GNU ps and "process group" on
 * BSD ps — the same flag, two different questions, and the wrong answer here is
 * either a signal that was never sent or one that was sent twice.
 */
export function liveGroupMembers(
  pgid: number,
  ports: { readonly ps?: () => string } = {},
): number[] {
  return liveGroupRows(pgid, ports).map((row) => row.pid);
}

/** A survivor, and the state that makes it one. */
export interface GroupMember {
  readonly pid: number;
  /** The `STAT` column: `S`, `Ss`, `R+`, `D`. Never `Z` — see above. */
  readonly stat: string;
}

/**
 * `liveGroupMembers`, with the evidence kept (KAR-08.6 AC6).
 *
 * "pid 4244 survived" and "pid 4244 survived in state `D`, uninterruptible in
 * a syscall" are different sentences: the second tells an operator why SIGKILL
 * did not land, and the first invites a bug report. `run.kill_failed` carries
 * the state for that reason.
 */
export function liveGroupRows(
  pgid: number,
  ports: { readonly ps?: () => string } = {},
): GroupMember[] {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];

  let out: string;
  try {
    out = (ports.ps ?? readProcessTable)();
  } catch {
    // `ps` itself failing is not "the group is empty" — but there is nothing
    // truthful to return, and claiming survivors nobody can name would turn a
    // working kill into a permanent failure event.
    return [];
  }

  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && /^\d+$/.test(parts[0] ?? ''))
    .filter((parts) => Number(parts[1]) === pgid && !(parts[2] as string).includes('Z'))
    .map((parts) => ({ pid: Number(parts[0]), stat: parts[2] as string }));
}

/** How long after SIGKILL the group has to actually empty (§11.1 rung 4). */
export const KILL_VERIFY_WINDOW_MS = 2_000;

/** How often the window is re-read. */
export const GROUP_POLL_MS = 250;

export interface DrainPorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** Total time the group is given to empty. Defaults to `KILL_VERIFY_WINDOW_MS`. */
  readonly windowMs?: number;
  /** Defaults to `GROUP_POLL_MS`. */
  readonly pollMs?: number;
  /** Defaults to the `Z`-filtered `ps` read. */
  readonly members?: (pgid: number) => GroupMember[];
}

/**
 * The non-`Z` members of `pgid` still present after `windowMs` — empty when the
 * kill took.
 *
 * **A window, not a snapshot** (EPIC-08-S27, last scenario). Zombie reaping is
 * prompt under launchd and systemd and *lags badly inside containers*, which is
 * where this runs in CI: a verification that read one instantaneous `ps` would
 * report survivors for a group that is already dead, which is the same false
 * negative the `Z` filter exists to prevent arriving through the other door.
 *
 * It asks once up front, so the ordinary case — the group went on SIGTERM —
 * costs one `ps` and no waiting at all, and a cancelled node's outcome does not
 * sit behind two seconds of clock that had nothing to wait for.
 */
export async function awaitGroupDrained(pgid: number, ports: DrainPorts): Promise<GroupMember[]> {
  const members = ports.members ?? ((group: number) => liveGroupRows(group));
  const windowMs = ports.windowMs ?? KILL_VERIFY_WINDOW_MS;
  const pollMs = Math.max(1, ports.pollMs ?? GROUP_POLL_MS);

  let survivors = members(pgid);
  let waited = 0;
  while (survivors.length > 0 && waited < windowMs) {
    const step = Math.min(pollMs, windowMs - waited);
    await ports.clock.sleep(step);
    waited += step;
    survivors = members(pgid);
  }
  return survivors;
}

const readProcessTable = (): string =>
  execFileSync('/bin/ps', ['-eo', 'pid,pgid,stat'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/**
 * Where a process's start time is read from, per platform.
 *
 * Exported as a string because it is documentation the reaper's log lines
 * carry: when a row is discarded as a PID reuse, the operator is told which two
 * start times disagreed and where they came from.
 */
export function startTimeSource(platform: NodeJS.Platform = nodeProcess.platform): string {
  if (platform === 'linux') return '/proc/<pid>/stat field 22';
  if (platform === 'darwin') return 'ps -o lstart= -p <pid>';
  throw new NotImplementedOnWin32('startTimeSource');
}

/**
 * The `starttime` field of `/proc/<pid>/stat`, in clock ticks since boot.
 *
 * Parsed from the last `)` rather than by splitting the line: field 2 is the
 * executable name **in parentheses and unescaped**, so a process called
 * `sleep 300) 0 0` would otherwise shift every subsequent field. Field 22
 * counting from 1 is index 19 counting from the field after the `)`.
 */
function linuxStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim();
  const fields = afterComm.split(/\s+/);
  // fields[0] is field 3 (state), so field 22 is fields[19].
  return fields[19] ?? null;
}

/**
 * `ps -o lstart=`, which prints the process's start time to the second.
 *
 * `/bin/ps` absolutely, never `ps` for `PATH` to answer: DeFlowd's `PATH` at
 * daemon start is not the user's login-shell `PATH` (§4.3), and this runs on
 * the boot path where a wrong answer means either killing an unrelated process
 * or leaving an agent running.
 */
function darwinStartTime(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.trim();
    return line === '' ? null : line;
  } catch {
    // `ps` exits non-zero when the pid does not exist, which is the answer.
    return null;
  }
}

/**
 * When the process with this pid started, as the OS reports it, or `null` when
 * there is no such process.
 *
 * The value is **opaque and platform-specific on purpose**: it is only ever
 * compared for equality against the value recorded at spawn. Normalising it
 * into a timestamp would invent precision the source does not have — `lstart`
 * is second-resolution, and `/proc` ticks are relative to a boot that may
 * itself have changed — and a comparison that is nearly right is what kills an
 * unrelated user process (EPIC-05-S32).
 */
export function processStartTime(
  pid: number,
  platform: NodeJS.Platform = nodeProcess.platform,
): string | null {
  if (platform === 'win32') throw new NotImplementedOnWin32('processStartTime');
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return platform === 'linux' ? linuxStartTime(pid) : darwinStartTime(pid);
}
