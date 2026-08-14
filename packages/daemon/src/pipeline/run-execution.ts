/**
 * KAR-19.4 — the live executor: the plan KAR-19.3 compiled, actually run.
 *
 * **This file executes nothing itself.** `executeRun`
 * (`../exec/run-executor.ts`) has been a complete, tested loop since KAR-06.9:
 * it folds the ledger, calls `decide()`, admits attempts, tracks what is in
 * flight so one node is never started twice, and terminates on a real condition
 * rather than a tick count. Its only callers were
 * `packages/daemon/test/support/run-loop.ts` and two fixture-building scripts,
 * which is why an operator's run compiled a plan on 2026-08-12 and then did
 * nothing at all. What this module adds is a **shipped caller**, dispatched off
 * the ticker, and one event.
 *
 * That one event is the whole of the missing wiring, and it is worth naming.
 * `plan.proposed` files a graph under `state.proposedPlans`; it is
 * `run.started { planHash }` that promotes one of them to `state.plan`
 * (`@DeFlow/core`'s `withActivePlan`), and **nothing in the shipped tree has
 * ever appended one**. Every fixture in this repository writes it by hand,
 * which is exactly how a missing production write hides behind ten thousand
 * green tests. Adoption happens here, once, in front of the loop that needs it.
 *
 * Three properties are load-bearing.
 *
 * **The run ends saying which end it reached (AC2).** `executeRun` concludes a
 * run with `run.completed` or `run.aborted`, and returns *without* concluding
 * one that is deliberately halted — `paused` or `needs-human` — because those
 * are waiting for a person and have commands left to issue. A fourth shape,
 * stopping without a statement, is what happened on 2026-08-12 and is what this
 * module must never reintroduce: every path out of `executeNodes` either left a
 * terminal event, left a halt with a reason already in the ledger, or logged
 * why it did neither.
 *
 * **Admission is the executor's, never a second copy (AC1).** A node is started
 * because `decide()` returned a `StartNode` and `executeRun`'s own `admitted`
 * set had not seen the attempt. This module holds no per-node state of any
 * kind; the only thing it remembers is which *runs* it is currently inside, and
 * that is a fact about promises this process is holding rather than about the
 * run.
 *
 * **A halted run is not re-driven for ever.** The driver skips a run whose head
 * has not moved since the last time the executor returned without ending it, so
 * a run parked on a budget ceiling costs one covering-index seek per tick
 * rather than a fold. The moment the operator answers — a `run.resumed`, a
 * `human.responded` — the head moves and the run is picked up again, which is
 * what makes AC8's *"the run is resumable"* true without anything remembering
 * that it was paused.
 *
 * The one seam is `RunExecutionResolver`: the performer, the effect runner and
 * the retry ladder's jitter source. It is a port for the same reason
 * `RunChainResolver` is one — a performer spawns vendor binaries resolved
 * against the operator's own `PATH`, which DeFlowd's environment is not
 * (docs/03-local-development.md §4.3) — and `DeFlow up` is the production
 * caller that supplies it.
 *
 * Verifies: EPIC-19-S24, EPIC-19-S27, EPIC-19-S29, EPIC-19-S30, EPIC-19-S31,
 * EPIC-19-S32 · AC1, AC2, AC5, AC7, AC8, AC9
 */
import type { Db, Event, PlanHash, Random, RunId } from '@DeFlow/core';
import { EVENT_CURRENT_VERSIONS, parseEvent } from '@DeFlow/core';
import { appendEvents, readRange, replayRun } from '@DeFlow/ledger';
import type { ExecuteInput } from '../drive.ts';
import type { EffectRunner } from '../effects/durable.ts';
import { executeRun, type NodePerformer } from '../exec/run-executor.ts';
import { log } from '../logging.ts';
import { daemonRandom } from '../random.ts';

const runner = log.child({ mod: 'exec' });

/** A pre-execution run's whole log fits far inside this. */
const EVENT_PAGE = 5_000;

/**
 * Everything one run's execution needs that cannot be read out of its ledger.
 *
 * Resolved per run rather than once per daemon, because the answer genuinely
 * differs per run: the performer is bound to the run's own worktree, its own
 * provider and its own data directory.
 */
export interface RunExecutionContext {
  /**
   * What a node *does*, as `../exec/run-executor.ts` defines it.
   *
   * The performer owns `node.started`, the agent's bytes on the `io_chunk`
   * data plane and the event that ends the attempt, because only the performer
   * knows what the node was.
   */
  readonly perform: NodePerformer;
  readonly effects: EffectRunner;
  /** Seeds the retry ladder's jitter, so a backoff is reproducible. */
  readonly random?: Random | undefined;
  /** How far the injected clock is advanced per tick of the executor's loop.
   * Zero for a run on the system clock, which moves on its own. */
  readonly tickStepMs?: number | undefined;
  /** Real milliseconds between ticks. Never faked: children are alive. */
  readonly tickMs?: number | undefined;
  /** Real-time budget for one dispatch. Exceeding it is a wedge. */
  readonly budgetMs?: number | undefined;
}

export type RunExecutionResolver = (input: {
  readonly runId: RunId;
  readonly db: Db;
  /** The repository the run was submitted against, as `run.created` recorded
   * it. */
  readonly cwd: string;
  /**
   * This daemon life's epoch, and the instant it began.
   *
   * Both are properties of the *dispatch* rather than of the resolver, which is
   * why they arrive here rather than being closed over at construction: a
   * production resolver builds the effect journal's runner, and a runner
   * stamped with the epoch of a previous daemon life would journal this life's
   * effects under the last one's — the fourth branch of the journal's
   * reconciliation, silently taken.
   */
  readonly epoch: number;
  readonly daemonStartedAt: number;
}) => Promise<RunExecutionContext | null>;

export interface RunExecutionPorts {
  readonly resolve: RunExecutionResolver;
}

export interface RunExecution {
  /** The port `boot()` hands the driver: one run with a plan, driven. */
  executeNodes: (input: ExecuteInput) => Promise<void>;
}

/** The run's events, skipping any this build cannot read. */
function ledger(db: Db, runId: RunId): readonly Event[] {
  return readRange(db, runId, 0, EVENT_PAGE).events.flatMap((stored) => {
    const parsed = parseEvent(stored);
    return parsed.status === 'ok' ? [parsed.event] : [];
  });
}

/** The newest proposed plan's hash, or `null` before there is one. */
function newestPlanHash(events: readonly Event[]): PlanHash | null {
  let hash: PlanHash | null = null;
  for (const event of events) {
    if (event.kind === 'plan.proposed') hash = event.payload.planHash;
  }
  return hash;
}

/** The repository the run was created against. */
function createdCwd(events: readonly Event[]): string | null {
  let cwd: string | null = null;
  for (const event of events) {
    if (event.kind === 'run.created') cwd = event.payload.cwd;
  }
  return cwd;
}

/**
 * Builds the executor one daemon life uses.
 *
 * Stateless: every decision below is re-derived from the ledger on every call,
 * which is what lets a second daemon pick up a run this one was half way
 * through without inheriting anything from it (AC9).
 */
export function createRunExecution(ports: RunExecutionPorts): RunExecution {
  async function executeNodes(input: ExecuteInput): Promise<void> {
    const { db, runId, epoch, clock, daemonStartedAt } = input;
    const events = ledger(db, runId);

    const planHash = newestPlanHash(events);
    if (planHash === null) return;

    const cwd = createdCwd(events);
    if (cwd === null) {
      runner.error(
        { runId },
        `run ${runId} has a plan and no repository on its run.created, so this build cannot ` +
          'execute it',
      );
      return;
    }

    const context = await ports.resolve({ runId, db, cwd, epoch, daemonStartedAt });
    if (context === null) {
      runner.warn(
        { runId },
        `no performer could be resolved for run ${runId}, so its plan was not executed`,
      );
      return;
    }

    // ── adoption: the one event that turns a proposal into the run's plan ────
    //
    // Idempotent by comparison rather than by a flag: the reducer answers
    // `null` for a `run.started` that changes nothing, so the guard is here to
    // keep the *ledger* free of a row that says nothing, not to keep the
    // projection correct.
    const state = replayRun(db, runId).state;
    if (state.plan === null || state.planHash !== planHash) {
      appendEvents(db, [
        {
          runId,
          ts: clock.now(),
          kind: 'run.started',
          v: EVENT_CURRENT_VERSIONS['run.started'],
          epoch,
          payload: { planHash },
        },
      ]);
    }

    await executeRun({
      db,
      runId,
      clock,
      epoch,
      daemonStartedAt,
      random: context.random ?? daemonRandom(),
      effects: context.effects,
      perform: context.perform,
      ...(context.tickStepMs === undefined ? {} : { tickStepMs: context.tickStepMs }),
      ...(context.tickMs === undefined ? {} : { tickMs: context.tickMs }),
      ...(context.budgetMs === undefined ? {} : { budgetMs: context.budgetMs }),
    });
  }

  return { executeNodes };
}
