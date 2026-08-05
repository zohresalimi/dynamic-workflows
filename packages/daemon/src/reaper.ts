/**
 * KAR-05.9 AC7 — orphan reaping on boot (docs/07-provider-adapter-layer.md §9.5).
 *
 * Every agent is spawned `detached: true`, which is what makes a wedged agent
 * and everything it started reachable with one signal — and which means the
 * agent **survives DeFlowd's death**. A daemon that crashed mid-run left real
 * processes editing a real worktree, and the `process` rows the ledger kept are
 * the only handle this daemon has on them.
 *
 * Three answers, and the interesting one is the refusal:
 *
 * | the pid…                                  | what happens                          |
 * | ----------------------------------------- | ------------------------------------- |
 * | exists, and its start time **matches**     | `killTree`, row `reaped`, event       |
 * | exists, start time **differs**             | **no signal**, row `discarded`, logged |
 * | is gone                                    | release the worktree lock, row `exited` |
 *
 * A bare pid is not evidence. Pids are recycled within hours on a busy machine
 * and from the first boot after a restart, so a reaper that trusted one would
 * eventually send SIGKILL to an unrelated user process — a browser, a build, an
 * editor. That is the kind of bug that ends a tool's credibility in a single
 * incident, and it is why the start time is compared as an opaque string
 * straight from the OS rather than parsed into something comparable-ish.
 *
 * A row whose start time was never recorded is treated the same way as a
 * mismatch. "We could not verify it" and "it is not the process we meant" have
 * the same correct response, which is to leave it alone and say so.
 */
import { killTree, processStartTime } from '@DeFlow/adapters';
import type { Clock, Db, NodeId, RunId } from '@DeFlow/core';
import { appendEvents, markProcess, type ProcessRow, readLiveProcesses } from '@DeFlow/ledger';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './logging.ts';

const run = promisify(execFile);
const reaper = log.child({ mod: 'reaper' });

/** What the reaper decided about one row. */
export type ReapOutcome =
  /** The pid was ours and still running; its group was killed. */
  | 'reaped'
  /** The pid now belongs to something else. Nothing was signalled. */
  | 'pid-reused'
  /** The row never recorded a start time, so nothing could be verified. */
  | 'unverifiable'
  /** The pid is gone; only the worktree lock it may have held was released. */
  | 'gone';

export interface ReapDecision {
  readonly row: ProcessRow;
  readonly outcome: ReapOutcome;
  /** What the OS says now, for the two outcomes where it disagreed. */
  readonly observedStartedAt: string | null;
}

export interface ReapPorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on the events the reaper appends. */
  readonly epoch: number;
  /** Defaults to the POSIX `killTree`. Injected only by specs that must not
   * kill anything, never to avoid a real signal in a real test. */
  readonly killTree?: (pid: number, signal: NodeJS.Signals) => unknown;
  /** Defaults to reading the OS. @see processStartTime */
  readonly startTime?: (pid: number) => string | null;
  /** Defaults to `git worktree unlock`. */
  readonly unlockWorktree?: (worktree: string) => Promise<void>;
  /** Every decision, for an operator log a spec can also read. */
  readonly onDecision?: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Releases the lock a dead agent's worktree may still be under.
 *
 * `git -C <worktree>` rather than the repository root: the row records the
 * worktree, the worktree is a full git directory, and the repository it belongs
 * to is discoverable from it — whereas the reverse is not true of a data
 * directory that may supervise several repositories.
 *
 * A failure is logged and swallowed. `git worktree unlock` on a worktree that
 * was not locked exits non-zero and is exactly the common case, and a boot that
 * refused to continue because of it would be a daemon that cannot start.
 */
async function unlockWith(worktree: string): Promise<void> {
  await run('git', ['-C', worktree, 'worktree', 'unlock', worktree]);
}

function decide(row: ProcessRow, observed: string | null): ReapOutcome {
  if (observed === null) return 'gone';
  if (row.startedAt === null) return 'unverifiable';
  return row.startedAt === observed ? 'reaped' : 'pid-reused';
}

/**
 * Reconciles every non-terminal `process` row, and returns what it decided
 * about each — in the order it read them, oldest spawn first.
 *
 * Called on boot **before providers are probed**: a probe spawns a child, and
 * spawning anything while a previous daemon's agents are still running is how
 * two generations of agents end up in the same worktree.
 */
export async function reapOrphans(db: Db, ports: ReapPorts): Promise<readonly ReapDecision[]> {
  const startTime = ports.startTime ?? ((pid: number) => processStartTime(pid));
  const kill = ports.killTree ?? ((pid: number, signal: NodeJS.Signals) => killTree(pid, signal));
  const unlock = ports.unlockWorktree ?? unlockWith;
  const report =
    ports.onDecision ??
    ((fields: Record<string, unknown>, message: string) => {
      reaper.warn(fields, message);
    });

  const decisions: ReapDecision[] = [];

  for (const row of readLiveProcesses(db)) {
    const observed = startTime(row.pid);
    const outcome = decide(row, observed);
    const key = { runId: row.runId, nodeId: row.nodeId, attempt: row.attempt };
    const fields = {
      outcome,
      runId: row.runId,
      nodeId: row.nodeId,
      attempt: row.attempt,
      pid: row.pid,
      pgid: row.pgid,
      recordedStartedAt: row.startedAt,
      observedStartedAt: observed,
    };

    if (outcome === 'reaped') {
      kill(row.pgid, 'SIGKILL');
      markProcess(db, key, 'reaped');
      // A domain fact, not a log line: the run's own history has to show that
      // its node was still running when this daemon started and was stopped by
      // it, or a reader of the ledger sees a node that simply stopped.
      appendEvents(db, [
        {
          runId: row.runId as RunId,
          ts: ports.clock.now(),
          kind: 'node.progress',
          v: 1,
          epoch: ports.epoch,
          nodeId: row.nodeId as NodeId,
          attempt: row.attempt,
          payload: {
            node: row.nodeId,
            attempt: row.attempt,
            phase: 'process.orphan-reaped',
            message: `pid ${row.pid} survived the previous daemon; its process group was killed`,
          },
        },
      ]);
      report(fields, `reaped orphaned agent pid ${row.pid}`);
    } else if (outcome === 'gone') {
      // The process is gone, but a lock it took is not: `git worktree lock` is
      // a file in the repository, and nothing releases it when the holder dies.
      if (row.worktree !== null) {
        try {
          await unlock(row.worktree);
        } catch (error) {
          report(
            { ...fields, error: (error as Error).message },
            `could not unlock ${row.worktree}; it may simply not have been locked`,
          );
        }
      }
      markProcess(db, key, 'exited');
      report(fields, `pid ${row.pid} was already gone`);
    } else {
      // pid-reused or unverifiable. **No signal is sent**, and both start times
      // are logged: this line is the whole explanation of why an orphan the
      // operator can see running was left alone.
      markProcess(db, key, 'discarded');
      report(
        fields,
        outcome === 'pid-reused'
          ? `pid ${row.pid} has been reused since it was recorded, so it was not signalled`
          : `pid ${row.pid} has no recorded start time, so it could not be verified or signalled`,
      );
    }

    decisions.push({ row, outcome, observedStartedAt: observed });
  }

  return decisions;
}
