/**
 * KAR-06.7 — the kill switch's mechanics: what a `CancelNode` command actually
 * does (docs/09-workspace-and-safety.md §11.1, docs/05-durable-execution.md
 * §10.4).
 *
 * `decide()` owns the decision — which nodes stop, on which ladder — because
 * that is derivable from the log. This file owns the four rungs, and every one
 * of them is an **event** rather than a condition somebody has to have been
 * watching the console to know about:
 *
 * 1. `session/cancel` at the protocol level, so the agent flushes its final
 *    `session/update`s and answers with `stopReason: 'cancelled'`. The only
 *    rung that produces a clean transcript, and the only one the client can do
 *    without a pid — it is performed by the live turn through `protocolCancel`,
 *    because the connection is the adapter's, not the ledger's.
 * 2. `kill(-pgid, 'SIGTERM')` — **the negative pid**, which is the whole group.
 * 3. after a configurable grace, `kill(-pgid, 'SIGKILL')`.
 * 4. after a further two seconds, verify, and **say so either way**.
 *
 * Three things here look like they could be simplified and cannot:
 *
 * - **The pid is never signalled without checking its start time.** Pids are
 *   recycled; a cancel that trusted a journalled number would eventually
 *   SIGKILL the operator's editor. The refusal is the same one the boot reaper
 *   makes (`src/reaper.ts`), and it is a refusal rather than a best guess.
 * - **The verification excludes `Z`-state processes.** After a successful group
 *   SIGKILL, `ps` still lists the grandchildren as zombies awaiting reaping by
 *   init. Counting them reports a working kill as a failure.
 * - **The grace is a parameter, not a constant.** Long-running CLIs need time
 *   to flush transcripts, and 5 s is a default rather than a law. (`execa`'s
 *   `forceKillAfterDelay` is not this: it does not fire when the subprocess is
 *   killed with an explicit signal, which DeFlow always passes — so the timer is
 *   by hand, on the injected `Clock`.)
 *
 * Verifies: EPIC-06-S24, EPIC-06-S25 · AC5, AC6, AC7, AC8, AC9
 */
import {
  awaitGroupDrained,
  type GroupMember,
  liveGroupRows,
  killTree as posixKillTree,
  processStartTime,
} from '@DeFlow/adapters';
import type {
  CancellationSource,
  CancelNode,
  CancelStage,
  Clock,
  Db,
  IdempotencyKey,
  NodeId,
  RunId,
} from '@DeFlow/core';
import type { EventDraft, ProcessKey, ProcessRow } from '@DeFlow/ledger';
import {
  appendEvents,
  markEffectCancelled,
  markProcess,
  readEffects,
  readProcess,
} from '@DeFlow/ledger';
import { log } from './logging.ts';

/**
 * SIGTERM → SIGKILL. The default of §11.1 rung 2, and configurable for the same
 * reason the document says it is: a CLI writing out a transcript needs longer
 * than a hung one does.
 */
export const TERM_GRACE_MS = 5_000;

/** SIGKILL → verification (§11.1 rung 3). */
export const KILL_VERIFY_MS = 2_000;

/** How the attempt ended up stopping. */
export type CancelOutcome =
  /** The agent answered the protocol cancel; nothing was signalled. */
  | 'flushed'
  /** The group was signalled and is empty. */
  | 'signalled'
  /** Nothing was left to signal — no `process` row, or it had already exited. */
  | 'not-running'
  /** The pid now belongs to something else. **Nothing was signalled.** */
  | 'pid-reused'
  /** Signalled through the whole ladder and something is still running. */
  | 'survived';

export interface CancelReport {
  readonly outcome: CancelOutcome;
  /**
   * Non-`Z` members of the group after the last rung, with the state that made
   * each one a survivor. Empty unless `survived`.
   */
  readonly survivors: readonly GroupMember[];
  readonly pid: number | null;
  readonly pgid: number | null;
}

export interface CancelPorts {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9), so the ladder is testable in
   * microseconds while real children are alive. */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on every event appended here. */
  readonly epoch: number;
  /** Who is cancelling. `user` is an operator's kill switch; `policy` is a
   * ceiling or a circuit breaker deciding for them. */
  readonly by?: CancellationSource;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  /**
   * Rung 1, performed by whatever is holding the live ACP connection: sends
   * `session/cancel` and resolves `true` once the turn answered with
   * `stopReason: 'cancelled'`.
   *
   * A port rather than a call because @DeFlow/daemon does not own the
   * connection — and because the loop must **keep reading `session/update`
   * after the cancel**, which is the adapter's contract (KAR-05.1) and the
   * difference between a flushed tail and a deadlock.
   */
  readonly protocolCancel?: (key: ProcessKey) => Promise<boolean>;
  /** Defaults to the POSIX group signal. Injected only to exercise the
   * kill-did-not-take path, never to avoid a real signal in a real test. */
  readonly killTree?: (pid: number, signal: NodeJS.Signals) => unknown;
  /** Defaults to the `Z`-filtered `ps` read. */
  readonly liveMembers?: (pgid: number) => GroupMember[];
  /** Defaults to reading the OS. @see processStartTime */
  readonly startTime?: (pid: number) => string | null;
}

const cancelLog = log.child({ mod: 'cancel' });

/**
 * Stops one in-flight attempt, and records everything it did.
 *
 * Always concludes the node with `node.cancelled`, on every path including the
 * one where nothing could be signalled. That is AC8's "does not wedge": the
 * terminal event is what lets the next `decide()` reclaim the node's locks and
 * stop treating it as in flight, and a cancel that gave up quietly would leave
 * the repository write lock held by a node nobody is waiting for.
 */
export async function cancelNode(command: CancelNode, ports: CancelPorts): Promise<CancelReport> {
  const { db } = ports;
  const by = ports.by ?? 'user';
  const key: ProcessKey = {
    runId: command.runId,
    nodeId: command.node,
    attempt: command.attempt,
  };
  const row = readProcess(db, key);
  // Rung 1 starts the ladder's stopwatch, so every `elapsedMs` on the stage
  // events is measured from the same instant on the same injected clock
  // (KAR-08.6 AC2, AC7).
  const startedAt = ports.clock.now();

  const report = await stop(command, ports, key, row, startedAt);

  // The node's terminal record, then the rows its attempt left open.
  appendEvents(db, [
    event(command, ports, 'node.cancelled', {
      node: command.node,
      attempt: command.attempt,
      result: { status: 'cancelled', by },
    }),
  ]);
  const closed = closePendingEffects(command, ports, by);
  cancelLog.info(
    {
      runId: command.runId,
      nodeId: command.node,
      attempt: command.attempt,
      mode: command.mode,
      outcome: report.outcome,
      effectsClosed: closed,
    },
    `cancelled ${command.node} (${report.outcome})`,
  );

  return report;
}

/** The ladder itself, up to but not including the node's terminal record. */
async function stop(
  command: CancelNode,
  ports: CancelPorts,
  key: ProcessKey,
  row: ProcessRow | undefined,
  startedAt: number,
): Promise<CancelReport> {
  const { db } = ports;

  if (command.mode === 'cooperative' && ports.protocolCancel !== undefined) {
    if (row !== undefined && row.state === 'live') {
      appendStage(command, ports, 'protocol', row, startedAt);
    }
    // Rung 1 is given its whole chance before anything is signalled: it is the
    // only rung that ends with a transcript somebody can read.
    if (await ports.protocolCancel(key)) {
      if (row !== undefined) markProcess(db, key, 'exited');
      return { outcome: 'flushed', survivors: [], pid: row?.pid ?? null, pgid: row?.pgid ?? null };
    }
  }

  if (row === undefined || row.state !== 'live') {
    return {
      outcome: 'not-running',
      survivors: [],
      pid: row?.pid ?? null,
      pgid: row?.pgid ?? null,
    };
  }

  const startTime = ports.startTime ?? ((pid: number) => processStartTime(pid));
  const observed = startTime(row.pid);
  if (observed === null) {
    markProcess(db, key, 'exited');
    return { outcome: 'not-running', survivors: [], pid: row.pid, pgid: row.pgid };
  }
  if (row.startedAt === null || row.startedAt !== observed) {
    // **Never kill by bare pid.** The number is ours; the process is not.
    markProcess(db, key, 'discarded');
    cancelLog.warn(
      {
        runId: row.runId,
        nodeId: row.nodeId,
        attempt: row.attempt,
        pid: row.pid,
        pgid: row.pgid,
        recordedStartedAt: row.startedAt,
        observedStartedAt: observed,
      },
      row.startedAt === null
        ? `pid ${row.pid} has no recorded start time, so it could not be verified or signalled`
        : `pid ${row.pid} has been reused since it was recorded, so it was not signalled`,
    );
    return { outcome: 'pid-reused', survivors: [], pid: row.pid, pgid: row.pgid };
  }

  return signalLadder(command, ports, key, row, startedAt);
}

export interface GroupSweepPorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  /** Defaults to the POSIX group signal. Injected only to exercise the
   * kill-did-not-take path, never to avoid a real signal in a real test. */
  readonly killTree?: (pid: number, signal: NodeJS.Signals) => unknown;
  /** Defaults to the `Z`-filtered `ps` read. */
  readonly liveMembers?: (pgid: number) => GroupMember[];
  /** Called as each rung is climbed, with the ms the clock says it took. */
  readonly onRung?: (stage: CancelStage, elapsedMs: number) => void;
}

/**
 * Rungs 2, 3 and 4 over one process group: SIGTERM, grace, SIGKILL, verify.
 *
 * Shared with the operator's kill switch (./kill-switch.ts) rather than copied,
 * because two implementations of an escalation ladder is two chances to lose
 * the negative pid, the `Z` filter or the verification — and KAR-08.6 AC1's
 * whole claim is that there is one of each.
 *
 * Returns the non-`Z` members still present at the end. **Empty is the only
 * thing that means success**, and it is established by a positive check rather
 * than by the signal call not having thrown (EPIC-08-S29 scenario 2).
 */
export async function sweepGroup(
  pgid: number,
  startedAt: number,
  ports: GroupSweepPorts,
): Promise<readonly GroupMember[]> {
  const { clock } = ports;
  const send =
    ports.killTree ?? ((pid: number, signal: NodeJS.Signals) => posixKillTree(pid, signal));
  const live = ports.liveMembers ?? ((group: number) => liveGroupRows(group));
  const rung = (stage: CancelStage): void => ports.onRung?.(stage, clock.now() - startedAt);

  /**
   * Signal the group, and **let the verification be the arbiter**.
   *
   * `kill(2)` failing is not the same as the kill having failed. A group whose
   * every member is a zombie answers `EPERM` on darwin — the processes are
   * already dead, which is the outcome the caller wanted — and a group that has
   * been fully reaped answers `ESRCH`, which `killTree` already turns into
   * `'gone'`. Aborting the ladder on either would report a failure about a group
   * that is not there, and would skip the rung that establishes that.
   *
   * Only errno failures are absorbed. A `NotImplementedOnWin32` or a refused
   * pid is a claim about *this code*, not about the group, and swallowing it
   * would produce the exact thing AC1 exists to prevent: a kill switch that
   * reports success having signalled nothing.
   */
  const kill = (signal: NodeJS.Signals): void => {
    try {
      send(pgid, signal);
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException | null)?.code !== 'string') throw error;
      cancelLog.warn(
        { pgid, signal, code: (error as NodeJS.ErrnoException).code },
        `${signal} to process group ${pgid} failed; the verification decides whether it mattered`,
      );
    }
  };

  rung('sigterm');
  kill('SIGTERM');
  await clock.sleep(ports.termGraceMs ?? TERM_GRACE_MS);

  let survivors = live(pgid);
  if (survivors.length > 0) {
    rung('sigkill');
    kill('SIGKILL');
    // A window rather than a snapshot: zombie reaping lags inside containers,
    // and a single instantaneous `ps` is how a working kill reads as a failure
    // (EPIC-08-S27, last scenario).
    survivors = await awaitGroupDrained(pgid, {
      clock,
      windowMs: ports.killGraceMs ?? KILL_VERIFY_MS,
      members: live,
    });
  }

  if (survivors.length === 0) rung('verified');
  return survivors;
}

/** Rungs 2, 3 and 4 for one attempt, with the ledger record of each. */
async function signalLadder(
  command: CancelNode,
  ports: CancelPorts,
  key: ProcessKey,
  row: ProcessRow,
  startedAt: number,
): Promise<CancelReport> {
  const { db } = ports;

  const survivors = await sweepGroup(row.pgid, startedAt, {
    ...ports,
    onRung: (stage, elapsedMs) => appendStage(command, ports, stage, row, startedAt, elapsedMs),
  });

  if (survivors.length > 0) {
    const pids = survivors.map((member) => member.pid);
    // AC8. Not a log line: the run's own history has to say that it stopped
    // admitting work because something out there is still running.
    appendEvents(db, [
      event(command, ports, 'node.cancel.failed', {
        node: command.node,
        attempt: command.attempt,
        pid: row.pid,
        pgid: row.pgid,
        survivors: pids,
      }),
    ]);
    cancelLog.error(
      { runId: row.runId, nodeId: row.nodeId, pid: row.pid, pgid: row.pgid, survivors },
      `the process group of ${row.nodeId} survived SIGKILL: pids ${pids.join(', ')} are still running`,
    );
    markProcess(db, key, 'discarded');
    return { outcome: 'survived', survivors, pid: row.pid, pgid: row.pgid };
  }

  markProcess(db, key, 'reaped');
  return { outcome: 'signalled', survivors: [], pid: row.pid, pgid: row.pgid };
}

/**
 * AC9 — every effect this attempt journalled and never finished goes terminal.
 *
 * A `pending` row is how the next daemon life recognises "we died mid-effect",
 * and it answers that with `reconcile()` or, failing that, a human. Neither is
 * right for an effect the operator deliberately stopped: nobody is confused
 * about what happened, and asking a human to adjudicate their own cancel is the
 * ambiguity AC9 exists to remove.
 */
function closePendingEffects(
  command: CancelNode,
  ports: CancelPorts,
  by: CancellationSource,
): number {
  const { db } = ports;
  const pending = readEffects(db, command.runId).filter(
    (row) =>
      row.nodeId === command.node && row.attempt === command.attempt && row.state === 'pending',
  );

  const result = { status: 'cancelled', by } as const;
  for (const row of pending) {
    markEffectCancelled(
      db,
      row.ikey,
      result,
      ports.clock.now(),
      event(
        command,
        ports,
        'effect.cancelled',
        { ikey: row.ikey, result },
        row.ikey as IdempotencyKey,
      ),
    );
  }

  return pending.length;
}

function appendStage(
  command: CancelNode,
  ports: CancelPorts,
  stage: CancelStage,
  row: ProcessRow,
  startedAt: number,
  elapsedMs: number = ports.clock.now() - startedAt,
): void {
  appendEvents(ports.db, [
    event(command, ports, 'node.cancel.stage', {
      node: command.node,
      attempt: command.attempt,
      stage,
      mode: command.mode,
      // Both, on every rung: the pid is the agent DeFlow spawned, the pgid is
      // what the signal reached.
      pid: row.pid,
      pgid: row.pgid,
      // AC2: how long this rung took to reach, on the injected clock.
      elapsedMs,
    }),
  ]);
}

function event(
  command: CancelNode,
  ports: CancelPorts,
  kind: string,
  payload: unknown,
  ikey?: IdempotencyKey,
): EventDraft {
  return {
    runId: command.runId as RunId,
    ts: ports.clock.now(),
    kind,
    v: 1,
    epoch: ports.epoch,
    nodeId: command.node as NodeId,
    attempt: command.attempt,
    ...(ikey === undefined ? {} : { ikey }),
    payload,
  };
}
