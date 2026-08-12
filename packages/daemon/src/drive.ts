/**
 * KAR-19.1 AC2, AC3, AC7 — the run driver: what one tick of the ticker
 * actually does (docs/05-durable-execution.md §10, §11).
 *
 * Before this file, `boot()` performed five of `RECOVERY_STEPS`' eight and
 * stopped before `start-ticker`, so the `node_wake` table had a writer and no
 * reader. Intake could have written a perfect row and the run would still have
 * sat there — which is the second of the three joints EPIC-19 exists to
 * reconnect, and the one that makes the other two invisible.
 *
 * The file is deliberately small, and what it is *not* is the interesting part.
 *
 * **It owns no policy.** Whether a run has stalled is `noProgress()`'s answer,
 * in `@DeFlow/core`, computed from `(RunState, now)` and from nothing else. This
 * file appends the event that answer asks for; it does not re-derive the
 * question. A second stall rule living beside the first is precisely the
 * "three surfaces, three answers" failure this story is about, one level down.
 *
 * **It performs no work of its own.** A due framing wake is dispatched to the
 * `FramingRunner` port. That port is where the ACP session, the packet and the
 * provider live, and it belongs to
 * [KAR-19.3](../../../docs/delivery/epics/EPIC-19-live-run-pipeline.md); a
 * daemon booted without one consumes nothing and says so in its log, rather
 * than growing a second, simpler interview here — the exact temptation
 * KAR-19.3 AC7's source guard exists to refuse.
 *
 * **It never holds a wait.** There is no timer, no sleep and no promise kept
 * across a tick boundary. A framing turn that is still running when the next
 * tick arrives is skipped by run id, so one run is never framed twice
 * concurrently, and the row stays in `node_wake` — where a crash leaves it, and
 * where the next daemon finds it (EPIC-19-S5).
 *
 * Verifies: EPIC-19-S1, EPIC-19-S4, EPIC-19-S5, EPIC-19-S8 · KAR-19.1 AC2,
 * AC3, AC7
 */
import type { Clock, Db, EventSeq, NodeId, RunId, StallReport } from '@DeFlow/core';
import { DEFAULT_NO_PROGRESS_POLICY, EVENT_CURRENT_VERSIONS, noProgress } from '@DeFlow/core';
import type { AppendOptions, NodeWakeRow } from '@DeFlow/ledger';
import {
  appendEvents,
  clearWake,
  dueWakes,
  listRunIds,
  readEventTs,
  readRunCreatedSpec,
  readWake,
  replayRun,
  runHeadSeq,
  scheduleWake,
} from '@DeFlow/ledger';
import { log } from './logging.ts';
import { FRAMING_NODE } from './spec/gate.ts';

const driver = log.child({ mod: 'drive' });

/**
 * How long a framing wake is pushed forward after an attempt that produced no
 * `run.created`.
 *
 * Without it, a runner that fails fast is re-dispatched on every tick — one
 * agent spawn a second, for as long as nobody is watching. With it, the run is
 * retried at a human pace and the stall detector gets to speak about it.
 */
export const FRAMING_RETRY_MS = 30_000;

/** What the driver hands the framing runner: one due wake, and everything it
 * needs to append the result of acting on it. */
export interface FramingWake {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** The clock's instant for this tick — the same `now` the due query used. */
  readonly now: number;
  /**
   * The daemon's own write connection, and its epoch.
   *
   * Handed over rather than captured by the runner, because there is exactly
   * one writer per data directory and a runner that had opened its own would be
   * the second — the state the lease exists to make impossible. It also means a
   * runner can be built before the daemon it will serve exists, which is the
   * order `boot()` actually assembles things in.
   */
  readonly db: Db;
  readonly epoch: number;
}

/**
 * The port that turns a due framing wake into `run.created`.
 *
 * A port rather than a call into `./framing/interview.ts`, for the same reason
 * `BootOptions.probeProviders` is one: the interview needs a live ACP session on
 * a provider chosen from the probed manifest, and *which* provider — and whether
 * this machine can host one at all — is knowledge the daemon's own environment
 * does not have. `DeFlow up` is the caller that supplies it.
 */
export type FramingRunner = (wake: FramingWake) => Promise<void> | void;

export interface DriverPorts {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on everything the driver appends. */
  readonly epoch: number;
  /** Data directory an oversized event payload spills into (KAR-03.9). */
  readonly spillTo?: string | undefined;
  readonly runFraming?: FramingRunner | undefined;
  /**
   * Called once per appended `run.stalled`, with the run and the report.
   *
   * The driver appends; the caller is what turns that into the line an operator
   * reads (AC7). Keeping the two apart is what lets `DeFlow run` print one
   * sentence and the daemon log print another without either of them deciding
   * *whether* the run is stalled.
   */
  readonly onStalled?: ((runId: RunId, report: StallReport) => void) | undefined;
  /**
   * The shortest stall threshold any run in this directory could have
   * configured, used only to skip runs that cannot possibly have stalled
   * without folding them.
   *
   * A pre-filter and never the decision: a run quieter than this is replayed and
   * asked properly, and `noProgress()` applies that run's own pinned policy. It
   * exists because folding every run in a data directory once a second is a cost
   * that grows with the operator's history rather than with their work.
   */
  readonly stallPrefilterMs?: number | undefined;
  /**
   * When this driver started, from the same clock. Defaults to `clock.now()` at
   * construction.
   *
   * A stall is a statement about **this daemon's own watch**: "I am here, I am
   * ticking, and this run has not moved". A run that was already quiet when the
   * daemon started was not being driven by anybody — the daemon was down — and
   * calling that a stall would put a `run.stalled` on every abandoned run in the
   * directory at every boot, including on the fixture ledgers `DeFlow replay`
   * serves. So such a run gets its window measured from the start instead, and
   * is reported once the daemon has genuinely watched it go nowhere.
   *
   * `idleMs` on the report is still measured from the run's own watermark, so
   * the operator reads "idle for six days" rather than "idle for ten minutes".
   */
  readonly startedAt?: number | undefined;
}

export interface TickReport {
  /** Runs whose framing wake was dispatched on this tick. */
  readonly dispatched: readonly RunId[];
  /** Runs that appended a `run.stalled` on this tick. */
  readonly stalled: readonly RunId[];
}

export interface RunDriver {
  /** One tick. Never throws for a run's own failure — see `tick`. */
  tick(now: number): Promise<TickReport>;
  /** Runs whose framing turn has not settled yet. */
  readonly inFlight: number;
}

/**
 * Builds the driver one daemon life uses.
 *
 * Stateful for exactly one reason: the set of runs whose framing turn is still
 * in flight. That set is per-process by construction — it is about promises
 * this process is holding — and putting it in a closure rather than in the
 * ledger is what keeps the durable record free of a fact that dies with the
 * process anyway.
 */
export function createRunDriver(ports: DriverPorts): RunDriver {
  const framing = new Set<RunId>();
  const startedAt = ports.startedAt ?? ports.clock.now();
  const appendOptions: AppendOptions =
    ports.spillTo === undefined ? {} : { spillTo: ports.spillTo };

  async function tick(now: number): Promise<TickReport> {
    const dispatched = await dispatchWakes(now);
    return { dispatched, stalled: reportStalls(now) };
  }

  /**
   * Every due wake, routed. Only the framing node is claimed here: a wake for a
   * plan node is `executeRun`'s to consume and belongs to KAR-19.4, and a
   * driver that consumed one now would be deleting a wait nothing is going to
   * act on.
   */
  async function dispatchWakes(now: number): Promise<RunId[]> {
    const dispatched: RunId[] = [];
    const turns: Promise<void>[] = [];

    for (const wake of dueWakes(ports.db, now)) {
      if (wake.nodeId !== FRAMING_NODE) continue;
      const runId = wake.runId as RunId;
      if (framing.has(runId)) continue;

      // Already framed — a wake left behind by a crash between `run.created`
      // and the delete. Clearing it is the whole repair: the event is the
      // record, and the row was only ever the reminder.
      if (readRunCreatedSpec(ports.db, runId) !== null) {
        clearWake(ports.db, { runId, nodeId: wake.nodeId });
        continue;
      }

      const runFraming = ports.runFraming;
      if (runFraming === undefined) {
        driver.warn(
          { runId },
          `run ${runId} is waiting to be framed and this daemon was started with no framing ` +
            'runner, so nothing will consume the wake; the run is accepted and stopped',
        );
        continue;
      }

      framing.add(runId);
      dispatched.push(runId);
      turns.push(runOneFraming(runFraming, wake, runId, now));
    }

    await Promise.all(turns);
    return dispatched;
  }

  async function runOneFraming(
    runFraming: FramingRunner,
    wake: NodeWakeRow,
    runId: RunId,
    now: number,
  ): Promise<void> {
    try {
      await runFraming({
        runId,
        nodeId: wake.nodeId as NodeId,
        now,
        db: ports.db,
        epoch: ports.epoch,
      });
    } catch (error) {
      // A framing turn that threw is this run's failure, not the daemon's: the
      // loop is what reconciles a run back to a sane state, so a tick that
      // stopped on the first error is how every *other* run wedges too.
      driver.error({ runId, err: error }, `the framing turn for ${runId} threw`);
    } finally {
      framing.delete(runId);
      settleFramingWake(wake, runId);
    }
  }

  /**
   * What becomes of the row the turn was dispatched from.
   *
   * Read back rather than assumed, because the interview may legitimately have
   * *rewritten* it: a clarifying question suspends onto the same `(runId,
   * framing)` key with `reason = 'human_gate'` and its own deadline, and
   * deleting that would delete the suspension. So the row is cleared only when
   * it is still the row that was dispatched, and pushed forward when framing
   * produced nothing — a failed turn that stayed due would be re-dispatched at
   * 1 Hz.
   */
  function settleFramingWake(dispatchedFrom: NodeWakeRow, runId: RunId): void {
    const current = readWake(ports.db, { runId, nodeId: dispatchedFrom.nodeId });
    if (current === null) return;
    if (current.wakeAt !== dispatchedFrom.wakeAt || current.reason !== dispatchedFrom.reason) {
      return;
    }

    if (readRunCreatedSpec(ports.db, runId) !== null) {
      clearWake(ports.db, { runId, nodeId: dispatchedFrom.nodeId });
      return;
    }

    scheduleWake(ports.db, {
      ...current,
      wakeAt: ports.clock.now() + FRAMING_RETRY_MS,
    });
  }

  /**
   * AC7 — one `run.stalled` per episode, for every run this directory holds.
   *
   * The detector is `@DeFlow/core`'s and the "once" is its own: `run.stalled` is
   * the one event reduced without advancing the watermark, so `stalledAtSeq ===
   * watermarkSeq` is what makes a four-hour silence one line rather than
   * fourteen thousand. Nothing here counts ticks.
   *
   * A run that has not reached `run.created` is not reported, and that is not an
   * oversight: it has a framing wake with an instant on it, so something *is*
   * expected to come back for it, and "waiting" is not "stalled".
   */
  function reportStalls(now: number): RunId[] {
    const stalled: RunId[] = [];
    const quietFor = ports.stallPrefilterMs ?? DEFAULT_NO_PROGRESS_POLICY.stallThresholdMs;

    for (const runId of listRunIds(ports.db)) {
      const head = runHeadSeq(ports.db, runId);
      if (head === 0) continue;
      const headTs = readEventTs(ports.db, head);
      if (headTs === null || now - headTs <= quietFor) continue;
      // @see DriverPorts.startedAt — a run that was already quiet when this
      // daemon started is given its window from the start rather than from a
      // watermark nobody was watching.
      if (headTs < startedAt && now - startedAt <= quietFor) continue;

      const state = replayRun(ports.db, runId).state;
      const report = noProgress(state, now).stall;
      if (report === null) continue;

      appendEvents(
        ports.db,
        [
          {
            runId,
            ts: now,
            kind: 'run.stalled',
            v: EVENT_CURRENT_VERSIONS['run.stalled'],
            epoch: ports.epoch,
            payload: {
              watermarkSeq: report.watermarkSeq as EventSeq,
              idleMs: report.idleMs,
              runningNodes: [...report.runningNodes],
            },
          },
        ],
        appendOptions,
      );

      driver.warn(
        { runId, idleMs: report.idleMs, watermarkSeq: report.watermarkSeq },
        `run ${runId} has not advanced for ${Math.round(report.idleMs / 1000)}s`,
      );
      ports.onStalled?.(runId, report);
      stalled.push(runId);
    }

    return stalled;
  }

  return {
    tick,
    get inFlight(): number {
      return framing.size;
    },
  };
}
