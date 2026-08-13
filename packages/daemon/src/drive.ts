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
import type {
  CancelMode,
  Clock,
  Db,
  EventSeq,
  NodeId,
  Random,
  RunId,
  StallReport,
} from '@DeFlow/core';
import { DEFAULT_NO_PROGRESS_POLICY, EVENT_CURRENT_VERSIONS, noProgress } from '@DeFlow/core';
import type { AppendOptions, NodeWakeRow } from '@DeFlow/ledger';
import {
  appendEvents,
  clearWake,
  dueWakes,
  lastSeqOfKinds,
  listRunIds,
  readEventTs,
  readProcesses,
  readWake,
  replayRun,
  runHeadSeq,
  scheduleWake,
} from '@DeFlow/ledger';
import { FRAMING_WAKE_REASON } from './intake/intake.ts';
import { type KillRunOutcome, killRun } from './kill-switch.ts';
import { log } from './logging.ts';
import { framingCouldBePending, framingIsPending } from './pipeline/framing-schedule.ts';
import { attemptsSpent, recordTurnFailure } from './pipeline/turn-failure.ts';
import { daemonRandom } from './random.ts';
import { completeCancel, FRAMING_NODE } from './spec/gate.ts';

const driver = log.child({ mod: 'drive' });

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

/**
 * KAR-19.3 — what the driver hands the post-approval half of the chain.
 *
 * The same shape as `FramingWake` minus the node, because this half is not
 * dispatched from a `node_wake` row at all: it is derived from the ledger on
 * every tick, which is what makes a daemon killed between `spec.pinned` and
 * `plan.proposed` pick the run up again on the next boot with nothing
 * remembered (AC8, EPIC-19-S22). A wake row would work too and would be one
 * more thing that can be lost.
 */
export interface AdvanceInput {
  readonly runId: RunId;
  readonly now: number;
  readonly db: Db;
  readonly epoch: number;
}

/**
 * The port that carries an approved run from its pinned spec to `plan.proposed`.
 *
 * A port for the same reason `FramingRunner` is one: recon surveys a real
 * worktree and the planner opens a session on a provider resolved against the
 * operator's own `PATH`, neither of which DeFlowd's own environment knows.
 */
export type RunAdvancer = (input: AdvanceInput) => Promise<void> | void;

/**
 * KAR-19.4 — what the driver hands the executor.
 *
 * `AdvanceInput` plus the two facts `executeRun` needs and cannot derive: the
 * `Clock` every timeout inside a node is measured on, and the instant *this
 * daemon life* began, which is the effect journal's fourth branch (KAR-06.3) —
 * an effect row written before it belongs to a daemon that is gone.
 *
 * Derived from the ledger on every tick like `AdvanceInput`, and never from a
 * row this process wrote: a daemon killed mid-node comes back, reads the same
 * log, and picks the run up from the plan it already had (AC9).
 */
export interface ExecuteInput extends AdvanceInput {
  readonly clock: Clock;
  readonly daemonStartedAt: number;
}

/**
 * The port that carries a run with a compiled plan to a terminal state.
 *
 * A port for the same reason `RunAdvancer` is one: a performer spawns vendor
 * binaries resolved against the operator's own `PATH` and writes into the
 * run's own worktree, neither of which DeFlowd's own environment knows.
 */
export type RunNodeExecutor = (input: ExecuteInput) => Promise<void> | void;

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
   * KAR-19.3 — the port a run that has passed the F1.3 gate is carried on with.
   *
   * Omitted means an approved run stops at `spec.pinned`, which is what every
   * daemon did before this story and is deliberately logged rather than silent.
   */
  readonly advanceRun?: RunAdvancer | undefined;
  /**
   * KAR-19.4 — the port a run with a compiled plan is executed on.
   *
   * Omitted means a run stops at `plan.proposed`, which is what every daemon
   * did before this story: the graph was visible, valid and never run. That
   * state is deliberately logged rather than silent.
   */
  readonly executeNodes?: RunNodeExecutor | undefined;
  /**
   * When this daemon life began, for the effect journal's fourth branch. Passed
   * to the executor unchanged; defaults to `clock.now()` at construction, the
   * same instant `startedAt` defaults to.
   */
  readonly daemonStartedAt?: number | undefined;
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
  /**
   * KAR-19.6 AC8 — the kill switch, as a port.
   *
   * Injected only so a spec can watch which runs the ladder was walked for and
   * with which mode; the default is the shipped `killRun`, and there is no
   * second implementation of a ladder behind it.
   */
  readonly killRun?: KillRunner | undefined;
  /**
   * KAR-19.9 — the daemon life's jitter source, handed to the retry ladder when
   * a pre-execution turn fails.
   *
   * Injected only so a spec can pin the draw and assert on the *window* rather
   * than on a lucky number; the default is the shipped `daemonRandom()`, and
   * every backoff in one daemon life is drawn from one generator so that twenty
   * nodes failing at the same instant take twenty consecutive draws.
   */
  readonly random?: Random | undefined;
}

/** What the driver asks of the kill switch: one run, one mode, the outcome. */
export type KillRunner = (
  runId: RunId,
  mode: CancelMode,
) => Promise<{ readonly outcome: KillRunOutcome }>;

export interface TickReport {
  /** Runs whose framing wake was dispatched on this tick. */
  readonly dispatched: readonly RunId[];
  /** Runs that appended a `run.stalled` on this tick. */
  readonly stalled: readonly RunId[];
  /** KAR-19.6 AC8 — runs whose cancel this tick carried to `run.aborted`. */
  readonly cancelled: readonly RunId[];
  /** KAR-19.3 — runs this tick carried on from their pinned spec. */
  readonly advanced: readonly RunId[];
  /** KAR-19.4 — runs this tick drove `executeRun` over. */
  readonly executed: readonly RunId[];
}

export interface RunDriver {
  /** One tick. Never throws for a run's own failure — see `tick`. */
  tick(now: number): Promise<TickReport>;
  /**
   * KAR-19.4 — resolves once no execution turn this driver started is still
   * running.
   *
   * `shutdown()` waits on it before closing the ledger. Without that, a daemon
   * stopped while a node was part-way through appending its completion would
   * pull the connection out from under it, and the run would come back on the
   * next boot with an attempt nothing ever concluded.
   */
  settle(): Promise<void>;
  /** Runs whose framing turn has not settled yet. */
  readonly inFlight: number;
  /**
   * KAR-19.4 — runs this driver is currently inside `executeRun` for.
   *
   * Exposed because the turn outlives the tick that started it: a caller that
   * needs to know whether this daemon is still working — a spec, or a shutdown
   * that would rather not close the ledger underneath a node — has no other way
   * to ask.
   */
  readonly executing: number;
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
  /** Runs whose kill ladder this process is part-way through. Per-process by
   * construction, exactly like `framing`, and never the durable record. */
  const cancelling = new Set<RunId>();
  /** Runs whose recon-and-compile turn this process is part-way through. */
  const advancing = new Set<RunId>();
  /** Runs this process is currently inside `executeRun` for. */
  const executing = new Set<RunId>();
  /**
   * The turns themselves, so `settle()` can wait for them.
   *
   * Needed because the turn deliberately outlives the tick that started it: a
   * shutdown that closed the ledger while one was in flight would take the
   * connection out from under a node that is part-way through appending its
   * own completion.
   */
  const executingTurns = new Set<Promise<void>>();
  /**
   * KAR-19.4 — the head this run's log was at when the executor last returned
   * without ending it.
   *
   * A run halted on a budget ceiling or an open human gate is not finished and
   * must stay drivable, so it cannot be remembered as *done*; re-driving it on
   * every tick, on the other hand, is a fold a second for as long as nobody
   * answers. The head seq is the honest middle: nothing has happened to this
   * run since the executor last looked, so there is nothing new to decide. One
   * covering-index seek, and the moment the operator answers — a `run.resumed`,
   * a `human.responded` — the head moves and the run is picked up again.
   *
   * Per-process by construction, exactly like `executing`, and never the
   * durable record: a fresh daemon knows nothing and therefore drives every
   * unfinished run once, which is what recovery means.
   */
  const settledAtHead = new Map<RunId, number>();
  const kill: KillRunner =
    ports.killRun ??
    ((runId, mode) =>
      killRun(runId, { db: ports.db, clock: ports.clock, epoch: ports.epoch, mode, by: 'user' }));
  const startedAt = ports.startedAt ?? ports.clock.now();
  const daemonStartedAt = ports.daemonStartedAt ?? startedAt;
  const random = ports.random ?? daemonRandom();
  const appendOptions: AppendOptions =
    ports.spillTo === undefined ? {} : { spillTo: ports.spillTo };

  async function tick(now: number): Promise<TickReport> {
    // Cancels first. A run the operator has stopped must not have a framing
    // turn dispatched for it on the very tick that finishes stopping it.
    const cancelled = await finishCancels(now);
    // KAR-19.3 — a run whose framing was answered, or whose spec was rejected,
    // is owed a turn nothing is currently holding a row for. Re-armed before
    // the dispatch so the same tick performs it, rather than a tick later.
    rearmFraming(now);
    const dispatched = await dispatchWakes(now);
    const advanced = await advanceRuns(now);
    // KAR-19.4 — after the compile, so a run whose plan this very tick produced
    // starts executing on the same tick rather than a second later. Launched
    // rather than awaited; see `executeRuns`.
    const executed = executeRuns(now);
    return { dispatched, stalled: reportStalls(now), cancelled, advanced, executed };
  }

  /**
   * KAR-19.3 AC4 — the framing wake, put back for a run that is owed a turn and
   * has no row waiting.
   *
   * Two things consume a framing run's wake without finishing it. Answering a
   * clarifying question deletes the row in the same transaction as
   * `human.responded` — which is right, and is what makes the answer atomic —
   * and rejecting a spec appends a `node.scheduled` for the framing node with
   * no row at all (KAR-10.3 AC7). Both leave a run that is waiting for
   * something nobody is going to do, which is precisely the shape of the
   * failure this epic exists to remove.
   *
   * The row is re-armed rather than the turn being dispatched directly, so
   * there is exactly one path into framing and a crash between the two leaves
   * the durable record — not a promise — behind.
   */
  function rearmFraming(now: number): void {
    if (ports.runFraming === undefined) return;

    for (const runId of listRunIds(ports.db)) {
      if (framing.has(runId)) continue;
      if (lastSeqOfKinds(ports.db, runId, ['run.completed', 'run.aborted']) !== null) continue;
      if (readWake(ports.db, { runId, nodeId: FRAMING_NODE }) !== null) continue;
      // Two covering-index seeks before any fold, for the same reason the stall
      // detector has a pre-filter: this runs once a second for every run the
      // directory has ever held.
      if (!framingCouldBePending(ports.db, runId)) continue;
      if (!framingIsPending(ports.db, runId)) continue;

      scheduleWake(ports.db, {
        runId,
        nodeId: FRAMING_NODE,
        wakeAt: now,
        reason: FRAMING_WAKE_REASON,
      });
    }
  }

  /**
   * KAR-19.3 AC2, AC8 — every run that has passed the F1.3 gate and has no
   * plan, carried on.
   *
   * Derived from the ledger on every tick and never from a row this process
   * wrote, which is the whole of *"a `SIGKILL` between `spec.pinned` and
   * `plan.proposed` resumes without re-framing"*: a fresh daemon reads the same
   * log, reaches the same conclusion, and compiles against the spec the
   * operator already approved.
   */
  async function advanceRuns(now: number): Promise<RunId[]> {
    const advance = ports.advanceRun;
    if (advance === undefined) return [];

    const advanced: RunId[] = [];
    const turns: Promise<void>[] = [];

    for (const runId of listRunIds(ports.db)) {
      if (advancing.has(runId)) continue;
      if (lastSeqOfKinds(ports.db, runId, ['run.completed', 'run.aborted']) !== null) continue;

      const pinned = lastSeqOfKinds(ports.db, runId, ['spec.pinned']);
      if (pinned === null) continue;
      const planned = lastSeqOfKinds(ports.db, runId, ['plan.proposed']);
      if (planned !== null && planned > pinned) continue;
      // A run the compiler already escalated is a decision for the operator,
      // not a loop (06 §3.5 forbids a third automatic attempt).
      const escalated = lastSeqOfKinds(ports.db, runId, ['run.needs_human']);
      if (escalated !== null && escalated > pinned) continue;

      advancing.add(runId);
      advanced.push(runId);
      turns.push(advanceOneRun(advance, runId, now));
    }

    await Promise.all(turns);
    return advanced;
  }

  async function advanceOneRun(advance: RunAdvancer, runId: RunId, now: number): Promise<void> {
    try {
      await advance({ runId, now, db: ports.db, epoch: ports.epoch });
    } catch (error) {
      // One run's failure is not the daemon's — the same rule the framing
      // dispatch follows, and for the same reason.
      driver.error({ runId, err: error }, `carrying run ${runId} on from its spec threw`);
    } finally {
      advancing.delete(runId);
    }
  }

  /**
   * KAR-19.4 AC1, AC2 — every run with a compiled plan and no ending, driven.
   *
   * Derived from the ledger on every tick, which is what makes a `SIGKILL`
   * mid-node resumable without anything being remembered (AC9): a fresh daemon
   * reads the same log, finds the same plan, and the executor's own fold tells
   * it which nodes are already done.
   *
   * **The turn is launched, never awaited.** `startTicker` schedules the next
   * tick only once this one has settled, so a driver that waited for
   * `executeRun` would freeze the whole daemon for the length of a node — no
   * framing wake dispatched, no stall reported, and KAR-19.6's cancel never
   * carried out — on a run that can legitimately take hours. What stops a
   * second turn is `executing`, which is a set rather than an await, and what
   * stops a second *attempt* is the executor's own `admitted` set one level
   * down.
   */
  function executeRuns(now: number): RunId[] {
    const execute = ports.executeNodes;
    if (execute === undefined) return [];

    const executed: RunId[] = [];

    for (const runId of listRunIds(ports.db)) {
      if (executing.has(runId)) continue;
      // Three covering-index seeks before any fold, for the same reason the
      // stall detector has a pre-filter: this runs once a second for every run
      // the directory has ever held.
      if (lastSeqOfKinds(ports.db, runId, ['run.completed', 'run.aborted']) !== null) continue;
      if (lastSeqOfKinds(ports.db, runId, ['plan.proposed']) === null) continue;
      // A run the operator has asked to stop is the cancel ladder's, not the
      // executor's: starting a node on the tick that finishes stopping it would
      // be the driver arguing with itself.
      const requested = lastSeqOfKinds(ports.db, runId, ['run.cancel.requested']);
      if (requested !== null) continue;
      // @see settledAtHead — nothing has happened since the executor last
      // returned, so there is nothing new to decide.
      const head = runHeadSeq(ports.db, runId);
      if (settledAtHead.get(runId) === head) continue;

      executing.add(runId);
      executed.push(runId);
      const turn = executeOneRun(execute, runId, now);
      executingTurns.add(turn);
      void turn.finally(() => executingTurns.delete(turn));
    }

    return executed;
  }

  async function executeOneRun(execute: RunNodeExecutor, runId: RunId, now: number): Promise<void> {
    try {
      await execute({
        runId,
        now,
        db: ports.db,
        epoch: ports.epoch,
        clock: ports.clock,
        daemonStartedAt,
      });
    } catch (error) {
      // One run's failure is not the daemon's — the same rule the framing
      // dispatch follows, and for the same reason.
      driver.error({ runId, err: error }, `executing run ${runId} threw`);
    } finally {
      executing.delete(runId);
      settledAtHead.set(runId, runHeadSeq(ports.db, runId));
    }
  }

  /**
   * KAR-19.6 AC8 — every run that is `cancelling`, carried to its end.
   *
   * This is the half of a cancel that a crash interrupts. The request is an
   * event and the ladder is a sequence of timed signals, so the tempting
   * implementation is a timer held by the process that took the request — and a
   * daemon that died between the two would come back to a run parked at
   * `cancelling` for ever, with the operator no longer watching (05 §10.4).
   * Nothing is remembered here: the state is read from the ledger on every
   * tick, `killRun` is idempotent, and the run ends when there is nothing of it
   * left running.
   *
   * **Cooperative is never promoted.** A cooperative cancel whose agent has not
   * answered leaves live processes behind, and this loop leaves them alone: an
   * automatic escalation would make `--force` decorative and would truncate the
   * transcript the operator cancelled the run in order to read (EPIC-19-S38).
   */
  async function finishCancels(now: number): Promise<RunId[]> {
    const finished: RunId[] = [];

    for (const runId of listRunIds(ports.db)) {
      // Two covering-index seeks rather than a replay, for the same reason the
      // stall pre-filter exists: this runs once a second for every run the
      // directory has ever held.
      const requested = lastSeqOfKinds(ports.db, runId, ['run.cancel.requested']);
      if (requested === null) continue;
      const ended = lastSeqOfKinds(ports.db, runId, ['run.completed', 'run.aborted']);
      if (ended !== null && ended > requested) continue;
      if (cancelling.has(runId)) continue;

      const state = replayRun(ports.db, runId).state;
      if (state.status !== 'cancelling') continue;
      const mode: CancelMode = state.cancel?.mode ?? 'cooperative';

      cancelling.add(runId);
      try {
        if (mode === 'forceful') {
          const report = await kill(runId, mode);
          if (report.outcome === 'survived') {
            // `run.kill_failed` already names the survivors. Ending the run
            // here would claim a stop that demonstrably did not happen.
            driver.error(
              { runId },
              `the kill switch did not empty run ${runId}'s process groups; it stays cancelling`,
            );
            continue;
          }
        }

        const live = readProcesses(ports.db).filter(
          (row) => row.runId === runId && row.state === 'live',
        );
        if (live.length > 0) continue;

        completeCancel({ db: ports.db, runId, epoch: ports.epoch, ts: now });
        driver.info({ runId, mode }, `the cancel of run ${runId} is complete`);
        finished.push(runId);
      } finally {
        cancelling.delete(runId);
      }
    }

    return finished;
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

      // KAR-19.6 AC8 — a run that has ended admits no further work, whatever
      // rows it left behind. `terminateRun` consumes a stopped run's wakes in
      // the same transaction as the abort, so this is the second line of
      // defence rather than the first: a row that outlives its run by any other
      // route is cleared here rather than framed.
      if (lastSeqOfKinds(ports.db, runId, ['run.completed', 'run.aborted']) !== null) {
        clearWake(ports.db, { runId, nodeId: wake.nodeId });
        continue;
      }

      // Already framed — a wake left behind by a crash between `run.created`
      // and the delete. Clearing it is the whole repair: the event is the
      // record, and the row was only ever the reminder.
      //
      // KAR-19.3 widened this from *"a `run.created` exists"* to *"the newest
      // `run.created` is newer than the newest request for a framing turn"*. A
      // rejected spec and an answered clarifying question both ask for a second
      // turn on a run that already has a `run.created`, and the narrower test
      // deleted the row for both of them.
      if (!framingIsPending(ports.db, runId)) {
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
    const nodeId = wake.nodeId as NodeId;
    // Read before the turn: the turn itself may journal a `node.failed`, and
    // counting afterwards would read its own record as a previous attempt.
    const attempt = attemptsSpent(ports.db, runId, nodeId);
    try {
      await runFraming({ runId, nodeId, now, db: ports.db, epoch: ports.epoch });
    } catch (error) {
      // KAR-19.9 AC1, AC2 — a framing turn that threw is this run's failure,
      // not the daemon's: the loop is what reconciles a run back to a sane
      // state, so a tick that stopped on the first error is how every *other*
      // run wedges too. What it is *not* is a private matter between this
      // function and the daemon's log file, which is what it was until this
      // story: the failure is journalled, classified and bounded by the node's
      // own policy, and this file makes none of those three decisions.
      driver.error({ runId, err: error }, `the framing turn for ${runId} threw`);
      recordTurnFailure({
        db: ports.db,
        runId,
        nodeId,
        epoch: ports.epoch,
        ts: ports.clock.now(),
        error,
        attempt,
        random,
        ...(ports.spillTo === undefined ? {} : { dataDir: ports.spillTo }),
        appendOptions,
      });
    } finally {
      framing.delete(runId);
      settleFramingWake(wake, runId);
    }
  }

  /**
   * What becomes of the row the turn was dispatched from.
   *
   * Read back rather than assumed, because two other writers may legitimately
   * have *rewritten* it. A clarifying question suspends onto the same `(runId,
   * framing)` key with `reason = 'human_gate'` and its own deadline; a failed
   * attempt writes a `backoff` row at the instant the node's own `RetryPolicy`
   * chose. Deleting either would delete a wait somebody is relying on, so the
   * row is touched only when it is still, byte for byte, the row that was
   * dispatched.
   *
   * A row that survived a turn producing nothing at all is left exactly where
   * it is. That used to be the interesting case — it was pushed forward by a
   * flat `FRAMING_RETRY_MS`, which is the unbounded retry of 2026-08-13 — and
   * it is now unreachable: every way a framing turn can fail throws, and a
   * throw is bounded by `recordTurnFailure`. Leaving it rather than
   * rescheduling it is what keeps this file free of an interval it would have
   * to choose.
   */
  function settleFramingWake(dispatchedFrom: NodeWakeRow, runId: RunId): void {
    const current = readWake(ports.db, { runId, nodeId: dispatchedFrom.nodeId });
    if (current === null) return;
    if (current.wakeAt !== dispatchedFrom.wakeAt || current.reason !== dispatchedFrom.reason) {
      return;
    }

    if (!framingIsPending(ports.db, runId)) {
      clearWake(ports.db, { runId, nodeId: dispatchedFrom.nodeId });
    }
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
    async settle(): Promise<void> {
      // A loop rather than one `Promise.all`, because a turn that is settling
      // can legitimately be the reason another one starts — a repair node, a
      // gate's own follow-up — and a single snapshot would return while that
      // successor was still writing.
      while (executingTurns.size > 0) {
        await Promise.all(executingTurns);
      }
    },
    get inFlight(): number {
      return framing.size;
    },
    get executing(): number {
      return executing.size;
    },
  };
}
