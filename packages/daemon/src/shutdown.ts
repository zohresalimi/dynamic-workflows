/**
 * KAR-18.2 AC7 — what SIGINT means: stop the children, conclude what they were
 * doing, and leave nothing behind (EPIC-18-S16).
 *
 * The mirror image of `./reaper.ts`, and the difference between them is which
 * daemon started the processes. The reaper deals with *another* daemon's
 * orphans on the way in, conservatively, because it cannot know what they are
 * mid-doing. This deals with **this** daemon's own children on the way out,
 * and it can be decisive: nothing else is going to receive their output, and a
 * child left running edits a worktree that the next daemon will hand to a fresh
 * attempt.
 *
 * Two guarantees, and the second is the one that matters at the next boot:
 *
 * 1. **The group is stopped and the stop is verified** — SIGTERM, a grace, then
 *    SIGKILL, then a positive check with `Z`-state processes excluded. The
 *    ladder is `sweepGroup`, shared with the kill switch and the cancel path,
 *    because three implementations of an escalation ladder is three chances to
 *    lose the negative pid or the zombie filter.
 * 2. **The node is concluded with a typed failure rather than left `running`.**
 *    Recovery would conclude it on the next boot anyway (KAR-06.9 step 5), and
 *    that path stays exactly where it is for the `SIGKILL` case that has no
 *    chance to do this. But a *graceful* stop knows more than a crash recovery
 *    can infer: the attempt did not merely lose its daemon, it was interrupted
 *    by an operator, and the retry ladder should see that at the moment it
 *    happened rather than a boot later.
 *
 * The failure is `internal`/`transient` for the same reason
 * `interruptedFailure` is: no taxonomy entry describes "the operator stopped
 * the daemon", inventing one would put a reason in the closed set no classifier
 * produces, and nothing about the work was wrong — the same attempt run again
 * is expected to succeed. `detail.cause` is what a test and the node inspector
 * read, so neither depends on the wording.
 *
 * KAR-27.10 closes the three ways this could still leave a process running
 * (EPIC-27-S45, EPIC-27-S46), and none of them needed a second ladder:
 *
 * - **The ladder is given the wall clock it needs.** `SHUTDOWN_DEADLINE_MS` is
 *   the bound an entrypoint may put on its own exit, derived from the ladder
 *   rather than chosen — `main.ts` armed two seconds against a five-second
 *   SIGTERM grace, so rung 3 was unreachable and a SIGTERM-proof child always
 *   outlived the daemon.
 * - **The groups are swept concurrently.** Sequentially, `n` children cost `n`
 *   ladders of wall clock, and any deadline that is honest for one child is a
 *   lie for two. Nothing here is shared between rows but the ledger, and every
 *   ledger call in this file is synchronous.
 * - **A survivor is a ledger record, not a log line.** `run.kill_failed` is the
 *   kill switch's own vocabulary for the same fact — pid, node and the `ps`
 *   state that says *why* it did not die — and its row is deliberately left
 *   `live`, so the next boot's reaper inherits the problem instead of a
 *   silence. A `discarded` row is invisible to the reaper, which is the exact
 *   opposite of what "the next daemon knows what survived" requires.
 */
import { type GroupMember, processStartTime } from '@DeFlow/adapters';
import type { Clock, Db, EventSeq, NodeFailure, NodeId, Random, RunId } from '@DeFlow/core';
import type { AppendOptions, ProcessRow } from '@DeFlow/ledger';
import { appendEvents, headSeq, markProcess, readLiveProcesses, replayAll } from '@DeFlow/ledger';
import { type GroupSweepPorts, KILL_VERIFY_MS, sweepGroup, TERM_GRACE_MS } from './cancel.ts';
import { log } from './logging.ts';
import { recordNodeFailure } from './retry.ts';

const stopping = log.child({ mod: 'shutdown' });

/**
 * The longest a graceful stop may take before an entrypoint is entitled to
 * exit on top of it — SIGTERM, the whole grace, SIGKILL, the verification, and
 * room for the ledger writes that record what happened.
 *
 * Derived rather than chosen, and asserted against the ladder's own constants
 * in `test/shutdown-deadline.test.ts`: `TERM_GRACE_MS` is documented as a
 * default rather than a law, and a literal here would go quietly wrong the day
 * it is raised. The groups are swept concurrently, so this is one ladder's
 * worth of clock however many children there are.
 */
export const SHUTDOWN_DEADLINE_MS = TERM_GRACE_MS + KILL_VERIFY_MS + 3_000;

/** What happened to one child on the way out. */
export interface StoppedChild {
  readonly row: ProcessRow;
  readonly outcome: 'stopped' | 'survived' | 'gone' | 'pid-reused';
  /**
   * Non-zombie members still in the group after the ladder. Empty is success.
   *
   * The `ps` `STAT` travels with each pid rather than the bare number, because
   * "pid 4244 survived" invites a bug report and "pid 4244 survived in state
   * `D`" says why SIGKILL did not land.
   */
  readonly survivors: readonly GroupMember[];
}

/** One surviving process, as `run.kill_failed` names it. */
interface ShutdownSurvivor {
  readonly node: string;
  readonly attempt: number;
  readonly pid: number;
  readonly pgid: number;
  readonly stat: string;
}

export interface StopChildrenPorts extends GroupSweepPorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on what the conclusion appends. */
  readonly epoch: number;
  /** The generator the concluded attempt's backoff is drawn from. */
  readonly random: Random;
  /** Defaults to reading the OS. @see processStartTime */
  readonly startTime?: (pid: number) => string | null;
  /** Data directory an oversized event payload spills into (KAR-03.9). */
  readonly spillTo?: string | undefined;
}

/**
 * The policy used when the plan cannot be read for a node that is running —
 * the same floor recovery applies, and for the same reason: an unreadable plan
 * must not become an unbounded restart loop.
 */
const DEFAULT_SHUTDOWN_RETRY = {
  maxAttempts: 1,
  backoff: { base: 2_000, cap: 300_000, jitter: 'full' },
} as const;

function interruptedByShutdown(db: Db, nodeId: NodeId, attempt: number): NodeFailure {
  return {
    reason: 'internal',
    class: 'transient',
    message:
      `attempt ${attempt} of ${nodeId} was still running when the daemon was asked to stop; its ` +
      'process group was terminated and the attempt is concluded here rather than left running ' +
      'for the next daemon to find and have to reconcile',
    detail: { node: nodeId, attempt, cause: 'daemon-shutdown' },
    evidence: [],
    occurredAtEvent: Math.max(1, headSeq(db)) as EventSeq,
    attempt,
  };
}

/**
 * Stops every child this daemon still has running, and concludes the attempts
 * that were holding them.
 *
 * Returns immediately when there is nothing live — the overwhelmingly common
 * case, and the reason nothing here is folded or read until a row says
 * otherwise: a clean shutdown must not pay for a full replay.
 */
export async function stopChildren(
  db: Db,
  ports: StopChildrenPorts,
): Promise<readonly StoppedChild[]> {
  const rows = readLiveProcesses(db);
  if (rows.length === 0) return [];

  const startTime = ports.startTime ?? ((pid: number) => processStartTime(pid));
  const stopped: StoppedChild[] = [];
  const appendOptions: AppendOptions =
    ports.spillTo === undefined ? {} : { spillTo: ports.spillTo };

  // Attribution first, for every row, and **before a single signal is sent**.
  // The same revalidation the reaper and the kill switch perform, and for the
  // same reason: by the time a shutdown runs, the pid this daemon recorded may
  // belong to somebody else entirely. A row that cannot be verified is
  // discarded rather than signalled — "we could not check" and "it is not the
  // process we meant" have the same correct answer (AC4).
  const attributed: ProcessRow[] = [];
  for (const row of rows) {
    const key = { runId: row.runId, nodeId: row.nodeId, attempt: row.attempt };
    const observed = startTime(row.pid);
    if (observed === null) {
      // The child is already gone. The row is deliberately **left alone**:
      // closing it here would take with it the one thing this module cannot do,
      // which is release the `git worktree lock` a dead agent may still hold.
      // The boot reaper does both, in the order KAR-07.8 requires (reap, then
      // unlock, then prune), and it will find this row on the next start.
      stopped.push({ row, outcome: 'gone', survivors: [] });
      continue;
    }
    if (row.startedAt === null || observed !== row.startedAt) {
      markProcess(db, key, 'discarded');
      stopped.push({ row, outcome: 'pid-reused', survivors: [] });
      continue;
    }
    attributed.push(row);
  }

  // All at once, not one after another: a stop with three children in flight
  // would otherwise cost three full ladders of wall clock, and no exit deadline
  // can be honest about that. The sweeps share nothing — the ledger calls below
  // are synchronous, and every `await` in the ladder is a `Clock` sleep.
  const swept = await Promise.all(
    attributed.map(async (row) => ({
      row,
      survivors: await sweepGroup(row.pgid, ports.clock.now(), ports),
    })),
  );

  for (const { row, survivors } of swept) {
    const key = { runId: row.runId, nodeId: row.nodeId, attempt: row.attempt };
    if (survivors.length === 0) {
      markProcess(db, key, 'reaped');
      stopped.push({ row, outcome: 'stopped', survivors: [] });
      continue;
    }

    // The row stays `live` on purpose (AC2, AC3). This daemon is out of moves,
    // and marking the row terminal here would hide the survivor from the only
    // thing left that can act on it: the next boot's reaper, which re-checks
    // the start time and signals again.
    stopped.push({ row, outcome: 'survived', survivors });
    const pids = survivors.map((member) => member.pid);
    stopping.error(
      { runId: row.runId, nodeId: row.nodeId, pgid: row.pgid, survivors: pids },
      `the process group of ${row.nodeId} survived SIGKILL: pids ${pids.join(', ')} are still running`,
    );
  }

  reportSurvivors(db, stopped, ports);
  concludeInterrupted(db, stopped, ports, appendOptions);
  return stopped;
}

/**
 * AC2 — everything this daemon could not terminate, in the ledger, before the
 * process ends.
 *
 * `run.kill_failed` and not a new kind: the operator's kill switch already
 * writes exactly this fact, every surface already renders it, and a second
 * spelling of "these pids outlived us" would be a second thing every reader
 * has to learn. One event per run rather than per node, for the same reason it
 * is run-scoped there — what an operator needs is one list naming everything
 * that outlived the daemon, not a record per node they have to assemble.
 *
 * A log line was what this was until now, and a log line is not readable by the
 * next daemon, by the API, or by an operator who comes back to the machine
 * tomorrow.
 */
function reportSurvivors(db: Db, stopped: readonly StoppedChild[], ports: StopChildrenPorts): void {
  const byRun = new Map<string, ShutdownSurvivor[]>();
  for (const entry of stopped) {
    if (entry.outcome !== 'survived') continue;
    const survivors = entry.survivors.map((member) => ({
      node: entry.row.nodeId,
      attempt: entry.row.attempt,
      pid: member.pid,
      pgid: entry.row.pgid,
      // The reason, in the OS's own words: `D` is uninterruptible in a syscall,
      // which is not a DeFlow bug and is not fixable by signalling harder.
      stat: member.stat,
    }));
    byRun.set(entry.row.runId, [...(byRun.get(entry.row.runId) ?? []), ...survivors]);
  }

  for (const [runId, survivors] of byRun) {
    appendEvents(db, [
      {
        runId: runId as RunId,
        ts: ports.clock.now(),
        kind: 'run.kill_failed',
        v: 1,
        epoch: ports.epoch,
        payload: { survivors },
      },
    ]);
  }
}

/**
 * Fails every node whose child was just stopped, so the ledger never says a
 * node is `running` while no process is executing it.
 *
 * The replay happens here rather than at the top because it is only needed when
 * something was actually stopped, and it is the retry *policy* it is read for:
 * the plan's own `retry` for the node, so how many interruptions a node
 * survives is the plan's decision rather than this module's.
 */
function concludeInterrupted(
  db: Db,
  stopped: readonly StoppedChild[],
  ports: StopChildrenPorts,
  appendOptions: AppendOptions,
): void {
  const relevant = stopped.filter((entry) => entry.outcome !== 'pid-reused');
  if (relevant.length === 0) return;

  const { runs } = replayAll(db);
  for (const entry of relevant) {
    const runId = entry.row.runId as RunId;
    const nodeId = entry.row.nodeId as NodeId;
    const state = runs.get(runId);
    const node = state?.nodes[nodeId];
    if (node?.status !== 'running') continue;

    const planned = state?.plan?.nodes.find((one) => one.id === nodeId);
    recordNodeFailure(db, {
      runId,
      nodeId,
      failure: interruptedByShutdown(db, nodeId, node.attempt),
      retry: planned?.retry ?? DEFAULT_SHUTDOWN_RETRY,
      epoch: ports.epoch,
      ts: ports.clock.now(),
      random: ports.random,
      appendOptions,
    });

    stopping.warn(
      { runId, nodeId, attempt: node.attempt },
      `attempt ${node.attempt} of ${nodeId} was interrupted by shutdown and was concluded`,
    );
  }
}
