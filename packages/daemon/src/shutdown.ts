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
 */
import { processStartTime } from '@DeFlow/adapters';
import type { Clock, Db, EventSeq, NodeFailure, NodeId, Random, RunId } from '@DeFlow/core';
import type { AppendOptions, ProcessRow } from '@DeFlow/ledger';
import { headSeq, markProcess, readLiveProcesses, replayAll } from '@DeFlow/ledger';
import { type GroupSweepPorts, sweepGroup } from './cancel.ts';
import { log } from './logging.ts';
import { recordNodeFailure } from './retry.ts';

const stopping = log.child({ mod: 'shutdown' });

/** What happened to one child on the way out. */
export interface StoppedChild {
  readonly row: ProcessRow;
  readonly outcome: 'stopped' | 'survived' | 'gone' | 'pid-reused';
  /** Non-zombie members still in the group after the ladder. Empty is success. */
  readonly survivors: readonly number[];
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

  for (const row of rows) {
    const key = { runId: row.runId, nodeId: row.nodeId, attempt: row.attempt };

    // The same revalidation the reaper and the kill switch perform, and for the
    // same reason: by the time a shutdown runs, the pid this daemon recorded
    // may belong to somebody else entirely. A row that cannot be verified is
    // discarded rather than signalled — "we could not check" and "it is not the
    // process we meant" have the same correct answer.
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

    const survivors = await sweepGroup(row.pgid, ports.clock.now(), ports);
    const pids = survivors.map((member) => member.pid);
    markProcess(db, key, survivors.length === 0 ? 'reaped' : 'discarded');
    stopped.push({
      row,
      outcome: survivors.length === 0 ? 'stopped' : 'survived',
      survivors: pids,
    });

    if (survivors.length > 0) {
      stopping.error(
        { runId: row.runId, nodeId: row.nodeId, pgid: row.pgid, survivors: pids },
        `the process group of ${row.nodeId} survived SIGKILL: pids ${pids.join(', ')} are still running`,
      );
    }
  }

  concludeInterrupted(db, stopped, ports, appendOptions);
  return stopped;
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
