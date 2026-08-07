/**
 * The effect boundary KAR-06.9's specs run a real plan through: `reduce` the
 * log → `decide` → perform → append → repeat (docs/05-durable-execution.md §4).
 *
 * It is deliberately the same shape as
 * `packages/ledger/test/integration/support/faithful-runner.ts`, and it is
 * deliberately *dumber* than the daemon it stands in for: everything
 * interesting that happens here happened in `decide()`, in `recover()`, or in
 * `durable()` — all three of which are shipped code this loop only sequences.
 * Three rules keep that true:
 *
 * 1. **It performs commands; it does not invent events.** A lock is taken
 *    because an `AcquireLock` said so. A command kind it was not taught is a
 *    throw, never a shrug.
 * 2. **Every side effect goes through `durable()` and every side effect is a
 *    real child process** — the fake agent binary, appending its own line to
 *    its own log, which is what "performed twice" is checked against.
 * 3. **The only thing it decides for itself is when the run is over**, because
 *    `decide()` does not emit `run.completed` and no epic has given that job to
 *    anything yet. Nothing to do and nothing in flight means the run is over:
 *    every active node completed is `succeeded`, anything else is `failed`, and
 *    the failure that ended it is carried out of here so a spec can assert the
 *    run halted with a *typed* `NodeFailure` rather than wedging.
 *
 * `now` arrives through the injected `Clock`, so an integration spec drives the
 * scheduler's view of time by hand. Only the pause *between* ticks is a real
 * timer, and it has to be: there is a live child process, and a fake timer
 * around one deadlocks (docs/14-testing-strategy.md §8).
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
  NodeFailureError,
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
import { execa } from 'execa';
import {
  createEffectRunner,
  type Effect,
  type EffectCtx,
  type EffectRunner,
  type ReconcileProbe,
  recordNodeFailure,
} from '../../src/index.ts';

const AGENT_SHA256 = 'f'.repeat(64);

/**
 * The payload version this build writes for `kind`, read off the registry.
 *
 * A literal `1` at each call site is right until the first version bump and
 * then wrong silently: an event written at `v: 1` carrying a v2 payload is
 * refused at replay time, hours later, in a run nobody can repeat.
 */
const eventVersionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

export interface RunLoopOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly clock: Clock;
  readonly epoch: number;
  /** ms epoch this daemon life began at, for `durable()`'s fourth branch. */
  readonly daemonStartedAt: number;
  readonly random: Random;
  /** Absolute path to the linked fake agent binary. */
  readonly agent: string;
  /** Where every invocation appends `{runId,nodeId,attempt,idempotencyKey}`. */
  readonly sideEffects: string;
  /** Nodes whose attempt 0 exits non-zero, so a retry is a real window. */
  readonly failFirstAttempt?: ReadonlySet<string>;
  /** Called with every command the loop performs, in order. */
  readonly onCommand?: (command: Command) => void;
  /** Called after every committed event, with the projection it produced. */
  readonly onEvent?: (seq: number, state: RunState) => void;
  /** A marker the crash-fuzz harness aims its kill at. */
  readonly phase?: (marker: string) => void;
  /** How far the injected clock is advanced per tick. */
  readonly tickStepMs?: number;
  /** Real milliseconds between ticks. Never faked: children are alive. */
  readonly tickMs?: number;
  /** How long an effect stays *in doubt* — performed, not yet recorded. */
  readonly settleMs?: number;
  /** Real-time budget. Exceeding it is a wedge, and a wedge is a failure. */
  readonly budgetMs?: number;
  /**
   * KAR-14.2 — what each node's completion reports having spent, in USD.
   *
   * Opt-in, because most specs here are not about money and a run that
   * accounted for spend nobody asked about would move a rollup they assert
   * nothing about. When present, the `budget.consumed` it produces is appended
   * in the same transaction as the `node.completed`, which is where the real
   * adapter puts it.
   */
  readonly costUsdPerNode?: (node: NodeId) => number;
}

export interface RunLoopResult {
  readonly state: RunState;
  readonly ticks: number;
  /** Every `StartNode` the loop performed, in order. */
  readonly started: readonly { readonly node: NodeId; readonly attempt: number }[];
  /** The failure the run ended on, when it ended on one. */
  readonly failure: NodeFailure | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fold = (db: Db, runId: RunId): RunState =>
  foldEvents(drainEvents(db, runId), initialRunState()).state;

/**
 * The agent effect one attempt performs: a real invocation of the real fake
 * binary, which really appends a line naming the ikey it was given.
 *
 * Its `reconcile` probe reads that same log, because the log **is** the durable
 * trace this agent leaves in the world — the stand-in for the journalled
 * session id a real adapter would resume from. Asking the effect journal
 * instead would be asking the mechanism whether the mechanism worked.
 */
export function agentEffect(
  options: RunLoopOptions,
  node: NodeId,
  attempt: number,
  requestHash: string,
  alreadyRan: (ikey: string) => boolean,
): Effect<{ readonly ikey: string }> {
  return {
    runId: options.runId,
    nodeId: node,
    attempt,
    kind: 'agent',
    requestHash,
    async perform(ctx: EffectCtx): Promise<{ ikey: string }> {
      const fails = options.failFirstAttempt?.has(node) === true && attempt === 0;
      const run = await execa(options.agent, ['--print'], {
        reject: false,
        env: {
          DeFlow_SIDE_EFFECT_LOG: options.sideEffects,
          DeFlow_RUN_ID: options.runId,
          DeFlow_NODE_ID: node,
          DeFlow_ATTEMPT: String(attempt),
          DeFlow_IKEY: ctx.ikey,
          ...(fails ? { DeFlow_FAKE_EXIT_CODE: '1' } : {}),
        },
      });
      // Classified here, where what the exit code means is known. An agent
      // that exited non-zero is `transient`: the vendor CLI failing once is
      // the case the retry ladder exists for, and leaving it to
      // `toNodeFailure`'s fallback would record `internal`/`permanent` and end
      // the run on the first hiccup.
      if (run.exitCode !== 0) {
        throw new NodeFailureError(`the agent exited ${String(run.exitCode)}`, {
          reason: 'agent.nonzero-exit',
          class: 'transient',
          detail: { exitCode: run.exitCode, ikey: ctx.ikey },
        });
      }
      // The window: the effect has happened and the journal does not know yet.
      options.phase?.(`settling:${node}:${attempt}`);
      if (options.settleMs !== undefined && options.settleMs > 0) {
        await sleep(options.settleMs);
      }
      return { ikey: ctx.ikey };
    },
    reconcile(ctx: EffectCtx): Promise<ReconcileProbe<{ ikey: string }>> {
      return Promise.resolve(
        alreadyRan(ctx.ikey)
          ? { status: 'done', result: { ikey: ctx.ikey } }
          : { status: 'not-started' },
      );
    },
  };
}

const completedResult = (node: NodeId): Record<string, unknown> => ({
  status: 'completed',
  output: { summary: `${node} done` },
  outputSchemaId: 'DeFlow.finding.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [],
});

/**
 * The statuses that mean *deliberately stopped*, as opposed to finished.
 *
 * A run halted by F4.4's pause or by the circuit breaker has commands left to
 * issue and nodes left to run; it is waiting for a person. Concluding it as a
 * failed run — which is what "nothing to do and nothing in flight" would
 * otherwise mean — would turn every budget pause into an `run.aborted` and make
 * KAR-14.2's resume path untestable.
 */
const HALTED_STATUSES: readonly string[] = ['paused', 'needs-human'];

/**
 * Runs the loop until the run reaches a terminal status, or halts.
 *
 * "Nothing left to do" is `decide()` returning no commands with nothing in
 * flight, and it is the only termination condition other than the budget: a
 * loop that stopped after N ticks would pass on a run that wedged.
 */
export async function runUntilSettled(
  options: RunLoopOptions,
  alreadyRan: (ikey: string) => boolean,
): Promise<RunLoopResult> {
  const { db, runId, clock } = options;
  const runner = createEffectRunner({
    db,
    clock,
    daemonStartedAt: options.daemonStartedAt,
    epoch: options.epoch,
  });

  const started: { node: NodeId; attempt: number }[] = [];
  const inflight = new Set<Promise<void>>();
  const thrown: unknown[] = [];
  const deadline = Date.now() + (options.budgetMs ?? 60_000);
  const tickStep = options.tickStepMs ?? 1_000;
  let ticks = 0;

  const append = (...drafts: readonly Omit<EventDraft, 'runId' | 'ts' | 'epoch'>[]): void => {
    if (drafts.length === 0) return;
    const seqs = appendEvents(
      db,
      drafts.map((draft) => ({ runId, ts: clock.now(), epoch: options.epoch, ...draft })),
    );
    const last = seqs.at(-1);
    if (last !== undefined) options.onEvent?.(last, fold(db, runId));
  };

  for (;;) {
    const state = fold(db, runId);
    if (state.status === 'completed' || state.status === 'aborted') {
      return { state, ticks, started, failure: endingFailure(state) };
    }

    const commands = decide(state, clock.now());
    ticks += 1;

    // Consecutive `EmitEvent`s are appended as **one batch**, which is one
    // `BEGIN IMMEDIATE`. That is not a convenience: KAR-14.2 AC2 requires the
    // three events of a ceiling trip — `budget.exceeded`, `run.paused`,
    // `run.needs_human` — to land in one transaction, so no crash can leave a
    // ledger recording that a ceiling was crossed and not that the run stopped.
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
      perform(command);
    }
    flush();
    if (thrown.length > 0) throw thrown[0];

    if (commands.length === 0 && inflight.size === 0) {
      // A halted run is waiting for a person, not finished: leave it exactly as
      // it is, so a spec can raise the ceiling and resume it.
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
    await sleep(options.tickMs ?? 5);
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
  function perform(command: Command): void {
    switch (command.kind) {
      case 'StartNode':
        start(command);
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
            ...(command.reason === undefined ? {} : { reason: command.reason }),
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
        throw new Error('this loop was never taught to perform CancelNode');
    }
  }

  /** Appends `node.started`, then runs the attempt without awaiting it. */
  function start(command: StartNode): void {
    const key = makeIkey(runId, command.node, command.attempt, 0);
    started.push({ node: command.node, attempt: command.attempt });
    options.phase?.(`node:${command.node}:${command.attempt}`);

    append({
      kind: 'node.started',
      v: eventVersionOf('node.started'),
      nodeId: command.node,
      attempt: command.attempt,
      ikey: key,
      payload: {
        node: command.node,
        attempt: command.attempt,
        ikey: key,
        binary: { path: options.agent, version: '0.0.0-fake', sha256: AGENT_SHA256 },
      },
    });

    const finished = attemptOf(command).then(
      () => {
        append(
          {
            kind: 'node.completed',
            v: eventVersionOf('node.completed'),
            nodeId: command.node,
            attempt: command.attempt,
            payload: {
              node: command.node,
              attempt: command.attempt,
              result: completedResult(command.node),
            },
          },
          // KAR-14.1's pair, in the same transaction as the completion, exactly
          // as `runShimNode` writes it: a crash between a node finishing and the
          // run knowing what it cost is not a state the ledger can be in.
          ...(options.costUsdPerNode === undefined
            ? []
            : [
                {
                  kind: 'budget.consumed',
                  v: eventVersionOf('budget.consumed'),
                  nodeId: command.node,
                  attempt: command.attempt,
                  payload: {
                    node: command.node,
                    attempt: command.attempt,
                    provider: 'claude-code',
                    usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
                    costUsd: options.costUsdPerNode(command.node),
                    authMode: 'subscription',
                  },
                },
              ]),
        );
      },
      (error: unknown) => {
        const failure = toNodeFailure(error, {
          occurredAtEvent: Math.max(1, headSeq(db)) as EventSeq,
          attempt: command.attempt,
          // A valid `Handle`, because an event whose payload the schema
          // refuses is skipped by the reducer at *read* time — the node
          // would stay `running` for ever and the run would wedge with
          // nothing in the log to say why.
          captureEvidence: () => `artifact://${'0'.repeat(64)}` as Handle,
        });

        // KAR-14.1 AC5 — a failed attempt's spend counts. The money is gone
        // whether or not the attempt produced anything, and a rollup that
        // forgave it would let a repair loop spend three times what it reports.
        if (options.costUsdPerNode !== undefined) {
          append({
            kind: 'budget.consumed',
            v: eventVersionOf('budget.consumed'),
            nodeId: command.node,
            attempt: command.attempt,
            payload: {
              node: command.node,
              attempt: command.attempt,
              provider: 'claude-code',
              usage: { inputTokens: 900, outputTokens: 120, source: 'vendor-reported' },
              costUsd: options.costUsdPerNode(command.node),
              authMode: 'subscription',
            },
          });
        }

        // The row first. `durable()` deliberately does not classify a throw
        // from `perform()` — the layer that knows which situation it came from
        // is the one that must write the `failed` row (KAR-06.3) — and a row
        // left `pending` here is a row the next daemon life inherits and has
        // to reconcile for an effect nobody is confused about.
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

  async function attemptOf(command: StartNode): Promise<void> {
    await runner.durable(
      agentEffect(
        options,
        command.node,
        command.attempt,
        `sha256-${command.node.padEnd(64, '0').slice(0, 64)}`,
        alreadyRan,
      ),
    );
  }
}

/** The failure a halted run ended on, read off the projection. */
function endingFailure(state: RunState): NodeFailure | null {
  for (const node of Object.values(state.nodes)) {
    if (node.status === 'failed' && node.failure !== null) return node.failure;
  }
  return null;
}

/**
 * Moves an injected clock forward, when it is one that can be moved.
 *
 * A `TestClock` is advanced by hand; a system clock moves on its own and this
 * is a no-op for it. Written as a capability check rather than a type test
 * because the loop is handed the `Clock` port and nothing narrower.
 */
function advance(clock: Clock, ms: number): void {
  const advancer = (clock as { advance?: (ms: number) => void }).advance;
  if (typeof advancer === 'function') advancer.call(clock, ms);
}
