/**
 * KAR-08.6 — the operator's kill switch: one control that stops **every** child
 * process in a run and then proves it did (F5.7,
 * docs/09-workspace-and-safety.md §11).
 *
 * `cancelNode` (./cancel.ts) is the scheduler's `CancelNode` command: it stops
 * one attempt, politely, and a well-behaved agent that answers `session/cancel`
 * ends it there. This is the other control — the one a human presses — and it
 * makes two guarantees `cancelNode` deliberately does not:
 *
 * **A polite exit is not a stopped tree.** An agent that answers the protocol
 * cancel flushes its tail and exits *itself*; whatever it backgrounded is still
 * running, reparented to init, still holding the worktree open. §9.4 puts rungs
 * 2 and 3 *after* a successful rung 1 for exactly that reason, so the kill
 * switch sweeps the group even when the node ladder concluded `flushed` or
 * `not-running`. That is the difference between "the process I knew about
 * exited" and "stopped".
 *
 * **Success is never assumed from the absence of an error.** The switch returns
 * only after a positive check that every group it signalled is empty, excluding
 * `Z`-state processes — and when something is left, `run.kill_failed` names the
 * surviving pids and their states, because a kill that did not take is an event
 * and not a silent condition (EPIC-08-S29).
 *
 * It is idempotent, and the idempotence is a **safety** property rather than a
 * convenience: by the time a second press runs, the pgid may belong to somebody
 * else entirely. Every rung is behind the same start-time revalidation the boot
 * reaper uses, and a row that no longer matches is discarded rather than
 * signalled (EPIC-07-S31, EPIC-08-S29 scenario 3).
 *
 * Verifies: EPIC-08-S26, EPIC-08-S27, EPIC-08-S29 · AC1, AC2, AC3, AC4, AC6,
 * AC7
 */
import { type GroupMember, liveGroupRows, processStartTime } from '@DeFlow/adapters';
import type { CancellationSource, CancelMode, CancelStage, Db, NodeId, RunId } from '@DeFlow/core';
import type { EventDraft, ProcessKey, ProcessRow } from '@DeFlow/ledger';
import { appendEvents, markProcess, readProcesses } from '@DeFlow/ledger';
import { type CancelPorts, type CancelReport, cancelNode, sweepGroup } from './cancel.ts';
import { log } from './logging.ts';

/** How the run's processes ended up. */
export type KillRunOutcome =
  /** Every group the switch was told about is empty. */
  | 'stopped'
  /** There was nothing live to stop. Also the answer to a second press. */
  | 'nothing-running'
  /**
   * A recorded pid no longer belongs to the process it was recorded for, so
   * **nothing was signalled**. Its own outcome rather than `stopped`, because
   * the run's agents may well still be running under different pids and an
   * operator told "stopped" would stop looking.
   */
  | 'refused'
  /** Something outlived the whole ladder. `run.kill_failed` names it. */
  | 'survived';

/** One process that outlived the ladder, and the attempt it belonged to. */
export interface KillSurvivor extends GroupMember {
  readonly node: NodeId;
  readonly attempt: number;
  readonly pgid: number;
}

export interface KillRunReport {
  readonly outcome: KillRunOutcome;
  /** One per attempt the switch acted on, in the order it acted. */
  readonly attempts: readonly CancelReport[];
  /** Every non-`Z` process still running, across every attempt. */
  readonly survivors: readonly KillSurvivor[];
}

export interface KillRunPorts extends Omit<CancelPorts, 'db'> {
  readonly db: Db;
  /**
   * Whether rung 1 is offered at all. `cooperative` — the default — gives the
   * agent its chance to flush a readable transcript before anything is
   * signalled; `forceful` skips straight to the group signal.
   */
  readonly mode?: CancelMode;
}

const killLog = log.child({ mod: 'kill-switch' });

/**
 * The `node_id` column, as the branded id the rest of the daemon speaks.
 *
 * A cast rather than a `parse`: the value was written by this daemon from a
 * `NodeId` it already held, and the kill switch is the very last place that
 * should learn a row is malformed — a throw here leaves the agent running,
 * which is the one outcome this module exists to prevent.
 */
const nodeIdOf = (row: ProcessRow): NodeId => row.nodeId as NodeId;

/**
 * Stops every in-flight attempt of `runId`, and verifies that it happened.
 *
 * Attempts are stopped one after another rather than concurrently: the rungs
 * are the run's own timeline, and interleaving two ladders in the ledger would
 * make "where did the seven seconds go" unanswerable for either of them. The
 * graces are on the injected clock, so the cost of doing so is microseconds in
 * a test and the specified 5 s + 2 s in production.
 */
export async function killRun(runId: RunId, ports: KillRunPorts): Promise<KillRunReport> {
  const { db } = ports;
  const mode: CancelMode = ports.mode ?? 'cooperative';
  const by: CancellationSource = ports.by ?? 'user';

  // The rows are read once, up front. A row that appears while the switch is
  // running belongs to a node the scheduler admitted after the operator pressed
  // stop, which is a scheduling bug and not something to paper over by looping
  // until the table is empty.
  const rows = readProcesses(db).filter((row) => row.runId === runId && row.state === 'live');
  if (rows.length === 0) {
    // Idempotent, and silent: a second press must not signal a pgid that may by
    // now belong to somebody else, and must not append an event claiming to
    // have stopped something.
    killLog.info({ runId }, 'kill switch pressed with nothing running');
    return { outcome: 'nothing-running', attempts: [], survivors: [] };
  }

  const attempts: CancelReport[] = [];
  const survivors: KillSurvivor[] = [];

  for (const row of rows) {
    const report = await cancelNode(
      { kind: 'CancelNode', runId, node: nodeIdOf(row), attempt: row.attempt, mode },
      { ...ports, by },
    );
    attempts.push(report);
    for (const member of report.survivors) {
      survivors.push({ ...member, node: nodeIdOf(row), attempt: row.attempt, pgid: row.pgid });
    }

    // The kill switch's own guarantee. `flushed` means the agent answered and
    // exited; `not-running` means it had already gone. Neither says anything
    // about what it left behind, and both are the case §9.4 wrote rungs 2 and 3
    // for. `pid-reused` is deliberately absent: that pgid is somebody else's.
    if (report.outcome === 'flushed' || report.outcome === 'not-running') {
      survivors.push(...(await sweepAfterExit(runId, row, ports)));
    }
  }

  if (survivors.length > 0) {
    appendEvents(db, [killFailed(runId, ports, survivors)]);
    killLog.error(
      { runId, survivors },
      `the kill switch did not take: pids ${survivors.map((one) => one.pid).join(', ')} are still running`,
    );
    return { outcome: 'survived', attempts, survivors };
  }

  if (attempts.some((report) => report.outcome === 'pid-reused')) {
    killLog.warn(
      { runId, attempts: attempts.map((report) => report.outcome) },
      'the kill switch refused to signal a reused pid; nothing was stopped for that attempt',
    );
    return { outcome: 'refused', attempts, survivors: [] };
  }

  killLog.info(
    { runId, attempts: attempts.length },
    `kill switch stopped ${attempts.length} attempt(s)`,
  );
  return { outcome: 'stopped', attempts, survivors: [] };
}

/**
 * The group of an attempt whose agent is already gone.
 *
 * Nothing is signalled unless something is actually there — the ordinary case
 * is that the agent had no children and the group emptied with it, and that
 * must not cost a signal, two graces or four ledger events.
 *
 * The start-time guard is inverted from `cancelNode`'s on purpose. There, a
 * live pid whose start time disagrees is a **refusal**: the number is ours, the
 * process is not. Here the leader is expected to be gone, and `null` — no such
 * pid — is what makes signalling the group safe, because a pgid can only be
 * reissued to a *new leader with that pid*. A pid that does exist and disagrees
 * is that new leader, and it is refused.
 */
async function sweepAfterExit(
  runId: RunId,
  row: ProcessRow,
  ports: KillRunPorts,
): Promise<KillSurvivor[]> {
  const live = ports.liveMembers ?? ((pgid: number) => liveGroupRows(pgid));
  const remaining = live(row.pgid);
  if (remaining.length === 0) return [];

  const startTime = ports.startTime ?? ((pid: number) => processStartTime(pid));
  const observed = startTime(row.pid);
  if (observed !== null && observed !== row.startedAt) {
    killLog.warn(
      { runId, nodeId: row.nodeId, pid: row.pid, pgid: row.pgid },
      `pid ${row.pid} has been reused since it was recorded, so its group was not signalled`,
    );
    return [];
  }

  killLog.warn(
    { runId, nodeId: row.nodeId, pgid: row.pgid, remaining: remaining.map((one) => one.pid) },
    `${row.nodeId} exited and left ${remaining.length} process(es) in its group`,
  );

  const key: ProcessKey = { runId, nodeId: row.nodeId, attempt: row.attempt };
  const startedAt = ports.clock.now();
  const outstanding = await sweepGroup(row.pgid, startedAt, {
    ...ports,
    onRung: (stage, elapsedMs) => appendOrphanStage(runId, row, ports, stage, elapsedMs),
  });

  markProcess(ports.db, key, outstanding.length > 0 ? 'discarded' : 'reaped');
  return outstanding.map((member) => ({
    ...member,
    node: nodeIdOf(row),
    attempt: row.attempt,
    pgid: row.pgid,
  }));
}

function appendOrphanStage(
  runId: RunId,
  row: ProcessRow,
  ports: KillRunPorts,
  stage: CancelStage,
  elapsedMs: number,
): void {
  appendEvents(ports.db, [
    {
      runId,
      ts: ports.clock.now(),
      kind: 'node.cancel.stage',
      v: 1,
      epoch: ports.epoch,
      nodeId: nodeIdOf(row),
      attempt: row.attempt,
      payload: {
        node: row.nodeId,
        attempt: row.attempt,
        stage,
        mode: 'forceful',
        pid: row.pid,
        pgid: row.pgid,
        elapsedMs,
      },
    },
  ]);
}

function killFailed(
  runId: RunId,
  ports: KillRunPorts,
  survivors: readonly KillSurvivor[],
): EventDraft {
  return {
    runId,
    ts: ports.clock.now(),
    kind: 'run.kill_failed',
    v: 1,
    epoch: ports.epoch,
    payload: {
      survivors: survivors.map((one) => ({
        node: one.node,
        attempt: one.attempt,
        pid: one.pid,
        pgid: one.pgid,
        stat: one.stat,
      })),
    },
  };
}
