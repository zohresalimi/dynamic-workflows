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
  EVENT_CURRENT_VERSIONS,
  ikey as makeIkey,
  type NodeFailure,
  NodeFailureError,
  type NodeId,
  type Random,
  type RunId,
  type RunState,
} from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { execa } from 'execa';
import {
  createEffectRunner,
  type Effect,
  type EffectCtx,
  executeRun,
  type NodePerformer,
  type ReconcileProbe,
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
 * Runs the loop until the run reaches a terminal status, or halts.
 *
 * The loop itself is `executeRun` in `../../src/exec/run-executor.ts` — shipped
 * code, not a second implementation. What lives here is the *performer*: the
 * fake agent binary, its side-effect log, its scripted first-attempt failure
 * and KAR-14.2's per-node spend. Everything the specs around this file assert
 * about scheduling, batching, retry and termination is therefore an assertion
 * about the daemon's own loop.
 */
export async function runUntilSettled(
  options: RunLoopOptions,
  alreadyRan: (ikey: string) => boolean,
): Promise<RunLoopResult> {
  const { db, runId, clock } = options;
  const effects = createEffectRunner({
    db,
    clock,
    daemonStartedAt: options.daemonStartedAt,
    epoch: options.epoch,
  });

  const append = (...drafts: readonly Omit<EventDraft, 'runId' | 'ts' | 'epoch'>[]): void => {
    if (drafts.length === 0) return;
    appendEvents(
      db,
      drafts.map((draft) => ({ runId, ts: clock.now(), epoch: options.epoch, ...draft })),
    );
  };

  /** KAR-14.1's pair, in the same transaction as the completion. */
  const spend = (
    node: NodeId,
    attempt: number,
    usage: { inputTokens: number; outputTokens: number },
  ): Omit<EventDraft, 'runId' | 'ts' | 'epoch'>[] =>
    options.costUsdPerNode === undefined
      ? []
      : [
          {
            kind: 'budget.consumed',
            v: eventVersionOf('budget.consumed'),
            nodeId: node,
            attempt,
            payload: {
              node,
              attempt,
              provider: 'claude-code',
              usage: { ...usage, source: 'vendor-reported' },
              costUsd: options.costUsdPerNode(node),
              authMode: 'subscription',
            },
          },
        ];

  const perform: NodePerformer = async (command, ctx) => {
    const key = makeIkey(runId, command.node, command.attempt, 0);

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

    try {
      await ctx.effects.durable(
        agentEffect(
          options,
          command.node,
          command.attempt,
          `sha256-${command.node.padEnd(64, '0').slice(0, 64)}`,
          alreadyRan,
        ),
      );
    } catch (error) {
      // KAR-14.1 AC5 — a failed attempt's spend counts. The money is gone
      // whether or not the attempt produced anything, and a rollup that forgave
      // it would let a repair loop spend three times what it reports.
      append(...spend(command.node, command.attempt, { inputTokens: 900, outputTokens: 120 }));
      throw error;
    }

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
      ...spend(command.node, command.attempt, { inputTokens: 1200, outputTokens: 340 }),
    );
  };

  const result = await executeRun({
    db,
    runId,
    clock,
    epoch: options.epoch,
    daemonStartedAt: options.daemonStartedAt,
    random: options.random,
    effects,
    perform,
    ...(options.onCommand === undefined ? {} : { onCommand: options.onCommand }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    ...(options.tickStepMs === undefined ? {} : { tickStepMs: options.tickStepMs }),
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    // A ref'd timer, deliberately: in this harness the loop *is* the process's
    // only work, and `systemClock`'s unref'd default would let Node decide the
    // run had finished and exit between two ticks.
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });

  return {
    state: result.state,
    ticks: result.ticks,
    started: result.started,
    failure: result.failure,
  };
}
