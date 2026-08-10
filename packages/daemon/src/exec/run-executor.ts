/**
 * The effect boundary, as DeFlowd runs it: `reduce` the log → `decide` →
 * perform → append → repeat (docs/05-durable-execution.md §4).
 *
 * This is the loop and **only** the loop. It owns no policy: which node is
 * ready is `decide()`'s answer, what a failure means is `planRetry`'s, whether
 * an effect already happened is the journal's, and what a node *does* belongs
 * to the `NodePerformer` it is handed. Three rules keep it that thin:
 *
 * 1. **It performs commands; it does not invent events.** A lock is taken
 *    because an `AcquireLock` said so. A command kind it was not taught is a
 *    throw, never a shrug.
 * 2. **Consecutive `EmitEvent`s are appended as one batch**, which is one
 *    `BEGIN IMMEDIATE`. That is not a convenience: KAR-14.2 AC2 requires the
 *    three events of a ceiling trip to land in one transaction, so no crash can
 *    leave a ledger recording that a ceiling was crossed and not that the run
 *    stopped.
 * 3. **The only thing it decides for itself is when the run is over**, because
 *    `decide()` does not emit `run.completed` and no epic has given that job to
 *    anything else yet. Nothing to do and nothing in flight means the run is
 *    over: every active node completed is `succeeded`, anything else is
 *    `failed`.
 *
 * `now` arrives through the injected `Clock`, so a spec drives the scheduler's
 * view of time by hand and a six-hour gate is exercised in microseconds. Only
 * the pause *between* ticks is a real timer, and it has to be: there are live
 * child processes, and a fake timer around one deadlocks
 * (docs/14-testing-strategy.md §8).
 */
import {
  type Clock,
  type Command,
  type Db,
  decide,
  EVENT_CURRENT_VERSIONS,
  type EventSeq,
  foldEvents,
  type Handle,
  initialRunState,
  ikey as makeIkey,
  type NodeFailure,
  type NodeId,
  type Random,
  type RunId,
  type RunState,
  type StartNode,
  toNodeFailure,
} from '@DeFlow/core';
import {
  appendEvents,
  drainEvents,
  type EventDraft,
  headSeq,
  markEffectFailed,
  readEffect,
  scheduleWakeIfChanged,
} from '@DeFlow/ledger';
import { systemClock } from '../clock.ts';
import type { EffectRunner } from '../effects/durable.ts';
import { recordNodeFailure } from '../retry.ts';

/**
 * What a performer is given: the command `decide()` returned, plus everything
 * about the run it would otherwise have to re-derive.
 */
export interface ExecContext {
  readonly db: Db;
  readonly runId: RunId;
  readonly clock: Clock;
  readonly epoch: number;
  readonly daemonStartedAt: number;
  readonly effects: EffectRunner;
  /** The projection the command was decided from. */
  readonly state: RunState;
}

/**
 * Performs one node attempt, appending every event it produces — including
 * `node.started` and the terminal one.
 *
 * The events are the performer's because only the performer knows what the node
 * *was*: a gate's `node.started` carries the gate command's provenance and an
 * agent's carries the session id, and a loop that wrote a generic one for both
 * would be writing a record neither layer could stand behind.
 *
 * Throwing hands the failure to the retry ladder. Returning normally means the
 * performer has already recorded the outcome, whatever it was.
 */
export type NodePerformer = (command: StartNode, ctx: ExecContext) => Promise<void>;

export interface RunExecutorOptions {
  readonly db: Db;
  readonly runId: RunId;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on every event appended here. */
  readonly epoch: number;
  /** ms epoch this daemon life began at, for the journal's fourth branch. */
  readonly daemonStartedAt: number;
  /** Seeds the retry ladder's jitter, so a backoff is reproducible. */
  readonly random: Random;
  readonly effects: EffectRunner;
  readonly perform: NodePerformer;
  /** Called with every command performed, in order. */
  readonly onCommand?: (command: Command) => void;
  /** Called after every committed batch, with the projection it produced. */
  readonly onEvent?: (seq: number, state: RunState) => void;
  /** A marker a crash harness aims its kill at. */
  readonly phase?: (marker: string) => void;
  /**
   * How far the injected clock is advanced per tick. Zero for a run on the
   * system clock, which moves on its own.
   *
   * **Never non-zero while a real child process is in flight.** Timeouts inside
   * a node — a gate's `timeout:` above all — are measured on the same injected
   * clock, so a loop advancing it a simulated second per tick reaches a
   * two-minute budget in two minutes' worth of *ticks* while the command is
   * still working, and the node fails on a timeout that happened in simulated
   * time only.
   */
  readonly tickStepMs?: number;
  /** Real milliseconds between ticks. Never faked: children are alive. */
  readonly tickMs?: number;
  /**
   * How the pause *between* ticks is taken. Defaults to `systemClock.sleep`.
   *
   * A seam rather than a hard-coded timer, and the reason is `systemClock`'s
   * `unref()`: a pending timer must never be what keeps DeFlowd alive, which is
   * right for a daemon holding a listening socket and wrong for a process whose
   * only work *is* this loop — there, an unref'd pause lets Node decide the run
   * is over and exit mid-flight. A caller with no other handle open supplies a
   * sleep that holds the event loop; everything else takes the default.
   *
   * Never the injected `Clock`'s: a spec drives the scheduler's view of time by
   * hand, and a tick that waited on that clock would never end. It is also why
   * fake timers are forbidden here — there are live child processes, and a fake
   * timer around one deadlocks (docs/14-testing-strategy.md §8).
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Real-time budget. Exceeding it is a wedge, and a wedge is a failure. */
  readonly budgetMs?: number;
}

export interface RunExecutionResult {
  readonly state: RunState;
  readonly ticks: number;
  /** Every `StartNode` performed, in order. */
  readonly started: readonly { readonly node: NodeId; readonly attempt: number }[];
  /** The failure the run ended on, when it ended on one. */
  readonly failure: NodeFailure | null;
}

const ENDED = ['completed', 'aborted'];

/**
 * The statuses that mean *deliberately stopped*, as opposed to finished.
 *
 * A run halted by F4.4's pause or by the circuit breaker has commands left to
 * issue and nodes left to run; it is waiting for a person. Concluding it as a
 * failed run — which is what "nothing to do and nothing in flight" would
 * otherwise mean — would turn every budget pause into an abort.
 */
const HALTED_STATUSES: readonly string[] = ['paused', 'needs-human'];

const eventVersionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

const fold = (db: Db, runId: RunId): RunState =>
  foldEvents(drainEvents(db, runId), initialRunState()).state;

/**
 * Advances an injected clock when it can be advanced, and never a real one.
 *
 * A `TestClock` is advanced by hand; a system clock moves on its own and this
 * is a no-op for it. The `typeof` check rather than a narrower parameter type,
 * because the loop is handed the `Clock` port and nothing narrower.
 */
function advance(clock: Clock, ms: number): void {
  const advancer = (clock as { advance?: (ms: number) => void }).advance;
  if (typeof advancer === 'function') advancer.call(clock, ms);
}

/** The failure a finished run ended on, when it ended on one. */
function endingFailure(state: RunState): NodeFailure | null {
  for (const node of Object.values(state.nodes)) {
    if (node.status === 'failed' && node.failure !== null) return node.failure;
  }
  return null;
}

/**
 * Runs the loop until the run reaches a terminal status, or halts.
 *
 * "Nothing left to do" is `decide()` returning no commands with nothing in
 * flight, and it is the only termination condition other than the budget: a
 * loop that stopped after N ticks would pass on a run that wedged.
 */
export async function executeRun(options: RunExecutorOptions): Promise<RunExecutionResult> {
  const { db, runId, clock } = options;
  const started: { node: NodeId; attempt: number }[] = [];
  const inflight = new Set<Promise<void>>();
  /**
   * The attempts this loop has already handed to the performer.
   *
   * `decide()` withholds a node that is `running`, and what makes it running is
   * the performer's own `node.started` — which is appended *asynchronously*,
   * because a gate has to resolve and hash the command it is about to run
   * first. Between the tick that started an attempt and that append, the fold
   * still shows the node as ready, so the next tick would start it again: one
   * node, two attempts, two verdicts, and only the effect journal's ikey
   * standing between that and paying for the work twice. Remembering what is in
   * flight closes the window here, where it belongs, rather than requiring
   * every performer to write its first event before its first await.
   */
  const admitted = new Set<string>();
  const thrown: unknown[] = [];
  const pause = options.sleep ?? ((ms: number): Promise<void> => systemClock.sleep(ms));
  const deadline = Date.now() + (options.budgetMs ?? 60_000);
  const tickStep = options.tickStepMs ?? 1_000;
  let ticks = 0;

  const append = (...drafts: readonly Omit<EventDraft, 'runId' | 'ts' | 'epoch'>[]): void => {
    if (drafts.length === 0) return;
    const seqs = appendEvents(
      db,
      drafts.map((d) => ({ runId, ts: clock.now(), epoch: options.epoch, ...d })),
    );
    const last = seqs.at(-1);
    if (last !== undefined) options.onEvent?.(last, fold(db, runId));
  };

  for (;;) {
    const state = fold(db, runId);
    if (ENDED.includes(state.status)) {
      return { state, ticks, started, failure: endingFailure(state) };
    }

    const commands = decide(state, clock.now());
    ticks += 1;

    let batch: Omit<EventDraft, 'runId' | 'ts' | 'epoch'>[] = [];
    const flush = (): void => {
      append(...batch);
      batch = [];
    };

    for (const command of commands) {
      options.onCommand?.(command);
      if (command.kind === 'EmitEvent') {
        batch.push({
          kind: command.event.kind,
          v: eventVersionOf(command.event.kind),
          ...(command.node === null ? {} : { nodeId: command.node }),
          ...(command.attempt === null ? {} : { attempt: command.attempt }),
          payload: command.event.payload,
        });
        continue;
      }
      flush();
      performCommand(command, state);
    }
    flush();
    if (thrown.length > 0) throw thrown[0];

    if (commands.length === 0 && inflight.size === 0) {
      // A halted run is waiting for a person, not finished: leave it exactly as
      // it is, so a caller can answer the question and resume it.
      if (HALTED_STATUSES.includes(state.status)) {
        return { state, ticks, started, failure: endingFailure(state) };
      }
      concludeRun(state);
      continue;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `the run wedged: ${ticks} ticks, ${inflight.size} in flight, last commands ` +
          JSON.stringify(commands),
      );
    }

    advance(clock, tickStep);
    await pause(options.tickMs ?? 5);
  }

  function concludeRun(state: RunState): void {
    const active = (state.plan?.nodes ?? []).filter((node) => node.lifecycle === 'active');
    const done = active.every((node) => state.nodes[node.id]?.status === 'completed');
    append({
      kind: done ? 'run.completed' : 'run.aborted',
      v: eventVersionOf(done ? 'run.completed' : 'run.aborted'),
      payload: { outcome: done ? 'succeeded' : 'failed', criteriaSatisfied: [] },
    });
  }

  /** Performs one command. Exhaustive on purpose. */
  function performCommand(command: Command, state: RunState): void {
    switch (command.kind) {
      case 'StartNode':
        start(command, state);
        return;

      case 'AcquireLock':
        append({
          kind: 'node.lock.acquired',
          v: eventVersionOf('node.lock.acquired'),
          nodeId: command.node,
          payload: { node: command.node, lock: command.lock, key: command.key },
        });
        return;

      case 'ReleaseLock':
        append({
          kind: 'node.lock.released',
          v: eventVersionOf('node.lock.released'),
          nodeId: command.node,
          payload: {
            node: command.node,
            lock: command.lock,
            key: command.key,
            reason: command.reason,
          },
        });
        return;

      case 'EmitEvent':
        // Batched by the tick loop above, so that a group of events `decide()`
        // emitted together commits together. Reaching here would mean a caller
        // performed one out of band.
        throw new Error('EmitEvent is appended in a batch by the tick loop, never one at a time');

      case 'ScheduleWake':
        scheduleWakeIfChanged(db, {
          runId,
          nodeId: command.node,
          wakeAt: command.wakeAt,
          reason: command.reason,
        });
        return;

      case 'CancelNode':
        // Cancellation is `cancelNode`'s ladder (KAR-06.7), which owns a
        // process group and a verification step this loop has no business
        // reimplementing.
        throw new Error('this executor was never taught to perform CancelNode');
    }
  }

  /** Hands one attempt to the performer without awaiting it. */
  function start(command: StartNode, state: RunState): void {
    const attemptKey = `${command.node}/${String(command.attempt)}`;
    if (admitted.has(attemptKey)) return;
    admitted.add(attemptKey);
    started.push({ node: command.node, attempt: command.attempt });
    options.phase?.(`node:${command.node}:${command.attempt}`);

    const ctx: ExecContext = {
      db,
      runId,
      clock,
      epoch: options.epoch,
      daemonStartedAt: options.daemonStartedAt,
      effects: options.effects,
      state,
    };

    const finished = options.perform(command, ctx).then(
      () => {
        options.onEvent?.(headSeq(db), fold(db, runId));
      },
      (error: unknown) => {
        const failure = toNodeFailure(error, {
          occurredAtEvent: Math.max(1, headSeq(db)) as EventSeq,
          attempt: command.attempt,
          // A valid `Handle`, because an event whose payload the schema refuses
          // is skipped by the reducer at *read* time — the node would stay
          // `running` for ever and the run would wedge with nothing in the log
          // to say why.
          captureEvidence: () => `artifact://${'0'.repeat(64)}` as Handle,
        });

        // The row first. `durable()` deliberately does not classify a throw
        // from `perform()` — the layer that knows which situation it came from
        // is the one that must write the `failed` row (KAR-06.3) — and a row
        // left `pending` here is one the next daemon life inherits and has to
        // reconcile for an effect nobody is confused about.
        closeEffect(command, failure);

        recordNodeFailure(db, {
          runId,
          nodeId: command.node,
          failure,
          retry: command.retry,
          epoch: options.epoch,
          ts: clock.now(),
          random: options.random,
        });
        options.onEvent?.(headSeq(db), fold(db, runId));
      },
    );

    inflight.add(finished);
    void finished
      .catch((error: unknown) => {
        thrown.push(error);
      })
      .finally(() => inflight.delete(finished));
  }

  /** Moves this attempt's journalled row to `failed`, when it is still open. */
  function closeEffect(command: StartNode, failure: NodeFailure): void {
    const key = makeIkey(runId, command.node, command.attempt, 0);
    if (readEffect(db, key)?.state !== 'pending') return;
    const ts = clock.now();
    markEffectFailed(db, key, failure, ts, {
      runId,
      ts,
      kind: 'effect.failed',
      v: 1,
      epoch: options.epoch,
      nodeId: command.node,
      attempt: command.attempt,
      ikey: key,
      payload: { ikey: key, failure },
    });
  }
}
