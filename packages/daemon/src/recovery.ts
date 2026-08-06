/**
 * KAR-06.9 — crash recovery: what a daemon does before it is allowed to start
 * anything (docs/05-durable-execution.md §12, §14 · EPIC-06-S29).
 *
 * F4.2 says a run resumes from the last completed boundary. That is one
 * sentence and eight steps, and the **order is the guarantee**:
 *
 * | # | step                | what it settles                                    |
 * | - | ------------------- | -------------------------------------------------- |
 * | 1 | `flock`             | only one daemon is doing any of this                |
 * | 2 | `bump-epoch`        | anything a previous life still writes is refused    |
 * | 3 | `rebuild-state`     | what the ledger says happened                       |
 * | 4 | `reconcile-effects` | what happened *out in the world* and was not recorded |
 * | 5 | `reclaim-locks`     | the attempts that died holding things               |
 * | 6 | `reap-orphans`      | the children that outlived their parent             |
 * | 7 | `load-wakes`        | the waits that came due while nothing was running   |
 * | 8 | `start-ticker`      | and only now may `decide()` run                     |
 *
 * Step 4 before step 8 is the whole point. An `effect` row left `pending` by a
 * dead daemon is the one state that cannot be interpreted from the ledger
 * alone: the intent was committed, and whether the side effect landed is a
 * question only the world can answer. A `StartNode` issued before that question
 * has been asked is a node re-run against a world nobody has looked at — and
 * for a `git commit`, a publish or a migration, that is the duplicate the
 * journal exists to prevent.
 *
 * Step 5 is the step that keeps the run from wedging, and it is worth being
 * precise about why it fails an attempt that may well still be alive out there.
 * A node whose reduced status is `running` at this point was started by a
 * daemon that is **gone**: this process has spawned nothing yet, so it holds no
 * handle on that child, cannot read its output and will never receive its
 * result. Whatever the pid table says, that attempt is over as far as this run
 * is concerned — the child itself is dealt with in step 6 — so it is concluded
 * with a `transient` failure and the retry ladder takes it from there. Left
 * `running`, it would hold the repository write lock for ever and `decide()`
 * would return nothing, for ever: a run that neither finishes nor fails.
 *
 * `recover()` performs steps 3–7. Steps 1, 2 and 8 belong to the caller —
 * `boot()` takes the lease and bumps the epoch before calling in, and starts the
 * ticker after — because they are the caller's resources rather than the
 * ledger's, and because a recovery that took its own lock could not be run by a
 * process that already holds one.
 *
 * Verifies: EPIC-06-S6, EPIC-06-S11, EPIC-06-S16, EPIC-06-S25, EPIC-06-S29,
 * EPIC-06-S30 · AC1–AC6
 */
import type {
  Clock,
  Db,
  EffectKind,
  EventSeq,
  IdempotencyKey,
  NodeFailure,
  NodeId,
  Random,
  RetryPlan,
  RunId,
  RunState,
} from '@DeFlow/core';
import { claimId } from '@DeFlow/core';
import type { AppendOptions, EffectRow, LedgerReplay, NodeWakeRow } from '@DeFlow/ledger';
import {
  appendEvents,
  dueWakes,
  headSeq,
  markEffectDone,
  markEffectFailed,
  readInheritedEffects,
  replayAll,
} from '@DeFlow/ledger';
import { systemClock } from './clock.ts';
import type { ReconcileProbe } from './effects/durable.ts';
import { escalateReconcileUnknown } from './effects/reconcile/escalate.ts';
import { Git } from './git/git.ts';
import type { WorkspaceGit } from './git/worktree-manager.ts';
import { log } from './logging.ts';
import { type ReapDecision, reapOrphans } from './reaper.ts';
import { recordNodeFailure } from './retry.ts';
import { reapWorktrees, type WorktreeReapReport } from './workspace/worktree-reaper.ts';

const recovery = log.child({ mod: 'recovery' });

/**
 * The sequence, as data. Order is the acceptance criterion, so it is a value a
 * test can read rather than a shape a reviewer has to notice.
 */
export const RECOVERY_STEPS = [
  'flock',
  'bump-epoch',
  'rebuild-state',
  'reconcile-effects',
  'reclaim-locks',
  'reap-orphans',
  'load-wakes',
  'start-ticker',
] as const;

export type RecoveryStep = (typeof RECOVERY_STEPS)[number];

/** The five `recover()` performs itself. @see RECOVERY_STEPS */
export const RECOVERED_STEPS = [
  'rebuild-state',
  'reconcile-effects',
  'reclaim-locks',
  'reap-orphans',
  'load-wakes',
] as const satisfies readonly RecoveryStep[];

/**
 * The probe that answers "did this already happen out there?" for one
 * inherited row.
 *
 * Supplied by the caller rather than looked up here, because the answer is
 * per-effect-kind and the inputs each kind needs — a repository to `git log
 * --grep` in, a worktree to re-hash, a session id to resume — are the caller's
 * (KAR-06.4). A caller that offers none is treated exactly as `durable()`
 * treats an effect that declares no `reconcile`: the row is *unknown*, and
 * unknown escalates.
 */
export type ReconcileInheritedEffect = (
  row: EffectRow,
) => Promise<ReconcileProbe<unknown>> | ReconcileProbe<unknown>;

export interface RecoveryPorts {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock?: Clock;
  /** This daemon life's epoch, stamped on everything recovery appends. */
  readonly epoch: number;
  /**
   * ms epoch at which **this** daemon life started.
   *
   * The whole of "inherited": a `pending` row stamped before this instant was
   * claimed by a life that is gone; one stamped at or after it belongs to a
   * caller inside this process.
   */
  readonly daemonStartedAt: number;
  /** The generator every reclaimed attempt's backoff is drawn from. */
  readonly random: Random;
  readonly reconcile?: ReconcileInheritedEffect;
  /** A replay the caller has already done, so boot does not fold twice. */
  readonly replayed?: LedgerReplay;
  /** Called as each step completes. The ordering assertion's only hook. */
  readonly onStep?: (step: RecoveryStep) => void;
  /** Every reap decision, for an operator log a spec can also read. */
  readonly onReapDecision?: (fields: Record<string, unknown>, message: string) => void;
  /**
   * The `Git` chokepoint for one repository, so KAR-07.8's worktree sweep can
   * be pointed at a fixture. Defaults to a real `Git` bound to that repository.
   */
  readonly gitFor?: (repoRoot: string) => WorkspaceGit;
  /** Data directory an oversized event payload spills into (KAR-03.9). */
  readonly spillTo?: string;
}

export type ReconcileVerdict = ReconcileProbe<unknown>['status'];

export interface ReconciledEffect {
  readonly row: EffectRow;
  readonly verdict: ReconcileVerdict;
}

export interface ConcludedAttempt {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  /** What the retry ladder decided: another attempt, a gate, or the end. */
  readonly action: RetryPlan['action'];
  /**
   * What the dead attempt was holding, all of it given back.
   *
   * Named `held` rather than `locks` on purpose: `packages/core/test/
   * lock-ownership.test.ts` fails any production source outside the reducer
   * that assigns a field called `locks`, because a second home for lock
   * ownership is exactly the bug that scan exists to catch. This is a report
   * of what was released, not a record of who holds what — and the guard is
   * worth more than the nicer word.
   */
  readonly held: readonly string[];
}

export interface ReclaimedLock {
  readonly runId: RunId;
  readonly node: NodeId;
  readonly lock: 'repo' | 'worktree';
  readonly key: string;
}

export interface Recovery {
  /** Every run in the data directory, as it stands *after* recovery. */
  readonly runs: ReadonlyMap<RunId, RunState>;
  readonly reconciled: readonly ReconciledEffect[];
  readonly concluded: readonly ConcludedAttempt[];
  readonly released: readonly ReclaimedLock[];
  readonly reaped: readonly ReapDecision[];
  /** What the boot worktree sweep found in every repository the ledger names
   * (KAR-07.8) — unlocked and reclaimed, adopted, or left to its owner. */
  readonly sweptWorktrees: WorktreeReapReport;
  /** The wakes already due at `clock.now()`. Loaded, never consumed here. */
  readonly due: readonly NodeWakeRow[];
  readonly headSeq: number;
}

/**
 * The failure an interrupted attempt is concluded with.
 *
 * `internal`, because no vocabulary entry describes "the supervising process
 * died" and inventing one would put a reason in the taxonomy that no classifier
 * ever produces. `transient`, because it is the one class that is *true* here:
 * nothing about the work was wrong, the daemon simply stopped, and the same
 * attempt run again is expected to succeed. That class is also what makes the
 * retry ladder — and therefore `maxAttempts` — the thing that decides how many
 * crashes a node survives before the run gives up, rather than an unbounded
 * loop of restarts.
 */
function interruptedFailure(db: Db, nodeId: NodeId, attempt: number): NodeFailure {
  return {
    reason: 'internal',
    class: 'transient',
    message:
      `the daemon that started attempt ${attempt} of ${nodeId} died before the attempt ` +
      'finished; this daemon holds no handle on it and cannot receive its result, so the ' +
      'attempt is concluded and the retry ladder decides what happens next',
    detail: { node: nodeId, attempt, cause: 'daemon-crash' },
    evidence: [],
    // A real seq: the last thing that genuinely happened before this daemon
    // started. Fabricating one points the inspector at the wrong row.
    occurredAtEvent: Math.max(1, headSeq(db)) as EventSeq,
    attempt,
  };
}

/**
 * The failure an inherited row is closed with when the probe proves the effect
 * never started (AC2).
 *
 * The row has to become terminal: left `pending`, it is re-probed by every
 * later restart for ever, and a probe that reaches into the world is not free.
 * `failed` is the journal's only non-success terminal state, and the value it
 * carries says exactly what happened — which is not "the effect went wrong" but
 * "it never ran, and the attempt that would have run it is over". `transient`
 * for the same reason the interrupted attempt's failure is.
 */
function abandonedFailure(db: Db, row: EffectRow): NodeFailure {
  return {
    reason: 'internal',
    class: 'transient',
    message:
      `effect ${row.ikey} was claimed by a daemon life that died, and its reconcile probe ` +
      'proved it never reached the world; the row is closed so nothing probes it again, and ' +
      'the work is redone by the next attempt of its node',
    detail: { ikey: row.ikey, kind: row.kind, cause: 'daemon-crash' },
    evidence: [],
    occurredAtEvent: Math.max(1, headSeq(db)) as EventSeq,
    attempt: row.attempt,
  };
}

/**
 * Runs steps 3–7 and reports what each of them found.
 *
 * Nothing here is optional or best-effort: every step runs on every start, and
 * a data directory with nothing to recover simply produces empty lists. A
 * recovery that only ran "when needed" would be a code path exercised once a
 * month, in production, at the worst possible moment.
 */
export async function recover(ports: RecoveryPorts): Promise<Recovery> {
  const { db, epoch } = ports;
  const clock = ports.clock ?? systemClock;
  const appendOptions: AppendOptions =
    ports.spillTo === undefined ? {} : { spillTo: ports.spillTo };
  const step = (name: RecoveryStep): void => ports.onStep?.(name);

  // ── 3. rebuild RunState ────────────────────────────────────────────────────
  let replayed = ports.replayed ?? replayAll(db);
  step('rebuild-state');

  // ── 4. reconcile every inherited pending effect ────────────────────────────
  const reconciled = await reconcileInherited(ports, clock, appendOptions);
  step('reconcile-effects');

  // The escalations and completions above are events, so the projection the
  // reclaim reads has to include them. Re-folded only when something was
  // actually written: a clean start pays nothing for this.
  if (reconciled.length > 0) replayed = replayAll(db);

  // ── 5. conclude the attempts that died, and give back what they held ───────
  const { concluded, released } = reclaimInterrupted(
    replayed.runs,
    ports,
    clock,
    appendOptions,
    db,
  );
  step('reclaim-locks');
  if (concluded.length > 0 || released.length > 0) replayed = replayAll(db);

  // ── 6. whatever the previous daemon left running, and what it was holding ──
  //
  // Reap, then unlock, then prune — §4.5's order, and it is load-bearing rather
  // than tidy: **locked worktrees are immune to `prune`**, so a sweep that
  // pruned before the locks of dead processes were released would exit 0 and do
  // nothing (KAR-07.8 AC1). Both halves are inside the one `reap-orphans` step
  // because between them the repository is in the state neither of them wants
  // to be interrupted in: processes killed, worktrees still locked.
  const reaped = await reapOrphans(db, {
    clock,
    epoch,
    ...(ports.onReapDecision === undefined ? {} : { onDecision: ports.onReapDecision }),
  });
  const sweptWorktrees = await reapWorktrees({
    db,
    clock,
    epoch,
    repos: repositoriesOf(replayed.runs, ports.gitFor ?? ((root) => new Git(root))),
    ...(ports.onReapDecision === undefined ? {} : { onDecision: ports.onReapDecision }),
  });
  step('reap-orphans');

  // ── 7. the waits that came due while nothing was running ───────────────────
  // Read, not consumed: a wake is consumed by the event that acts on it, in the
  // same transaction as the delete (KAR-06.6). Consuming one here would fire a
  // wait whose event this daemon has not decided to append yet.
  const due = dueWakes(db, clock.now());
  step('load-wakes');

  recovery.info(
    {
      epoch,
      runs: replayed.runs.size,
      reconciled: reconciled.length,
      concluded: concluded.length,
      released: released.length,
      reaped: reaped.filter((decision) => decision.outcome === 'reaped').length,
      worktrees: sweptWorktrees.decisions.filter((one) => one.action === 'reaped').length,
      due: due.length,
    },
    'recovery complete; the ticker may start',
  );

  return {
    runs: replayed.runs,
    reconciled,
    concluded,
    released,
    reaped,
    sweptWorktrees,
    due,
    headSeq: headSeq(db),
  };
}

/**
 * Every repository the ledger knows about, once each (KAR-07.8).
 *
 * From `RunState.repoRoot` — folded out of `run.created.cwd` — rather than from
 * this process's own working directory, for the reason NF9 gives everywhere
 * else: a daemon supervises whatever repositories its ledger names, and asking
 * the process where it happens to be running would sweep the wrong one, or
 * none. Deduplicated, because several runs share one repository and a second
 * sweep of it would be a second `prune`.
 */
function repositoriesOf(
  runs: ReadonlyMap<RunId, RunState>,
  gitFor: (repoRoot: string) => WorkspaceGit,
): { readonly repoRoot: string; readonly git: WorkspaceGit }[] {
  const roots = new Set<string>();
  for (const state of runs.values()) {
    if (state.repoRoot !== null) roots.add(state.repoRoot);
  }
  return [...roots].toSorted().map((repoRoot) => ({ repoRoot, git: gitFor(repoRoot) }));
}

/**
 * Step 4 (AC2). Every inherited `pending` row, probed **exactly once**, with
 * its outcome recorded as an event before the next row is touched.
 *
 * The three verdicts are three different claims about the world and each
 * leaves the journal in a different state:
 *
 * - `done` — it landed. The row is memoised with the result the probe found,
 *   and `effect.completed` carries `reconciled: true` so the timeline
 *   distinguishes "this daemon did it" from "this daemon found it done".
 * - `not-started` — it provably never reached the world. The row is closed so
 *   nothing probes it again.
 * - `unknown` — nobody can tell, which for a mutating shell command is the
 *   *common* answer. There is no correct automatic action, so the run halts at
 *   a human gate with the evidence attached, and the row is deliberately left
 *   `pending`: moving it would be a claim about the world nobody has made yet.
 */
async function reconcileInherited(
  ports: RecoveryPorts,
  clock: Clock,
  appendOptions: AppendOptions,
): Promise<readonly ReconciledEffect[]> {
  const { db, epoch } = ports;
  const outcomes: ReconciledEffect[] = [];

  for (const row of readInheritedEffects(db, ports.daemonStartedAt)) {
    const probe =
      ports.reconcile === undefined
        ? ({ status: 'unknown', detail: NO_PROBE } as const)
        : await ports.reconcile(row);

    if (probe.status === 'done') {
      const ts = clock.now();
      markEffectDone(
        db,
        row.ikey,
        probe.result,
        ts,
        envelope(row, 'effect.completed', ts, epoch, {
          ikey: row.ikey,
          result: probe.result,
          reconciled: true,
        }),
        appendOptions,
      );
    } else if (probe.status === 'not-started') {
      const ts = clock.now();
      const failure = abandonedFailure(db, row);
      markEffectFailed(
        db,
        row.ikey,
        failure,
        ts,
        envelope(row, 'effect.failed', ts, epoch, { ikey: row.ikey, failure }),
        appendOptions,
      );
    } else {
      escalateReconcileUnknown(db, {
        runId: row.runId as RunId,
        nodeId: row.nodeId as NodeId,
        attempt: row.attempt,
        epoch,
        ts: clock.now(),
        evidence: {
          ikey: row.ikey as IdempotencyKey,
          kind: row.kind as EffectKind,
          requestHash: row.requestHash,
          before: probe.evidence?.before ?? null,
          after: probe.evidence?.after ?? null,
          observed: probe.evidence?.observed ?? null,
          note: probe.detail ?? 'the probe returned unknown',
        },
        appendOptions,
      });
    }

    recovery.info(
      { ikey: row.ikey, kind: row.kind, verdict: probe.status },
      `reconciled inherited effect ${row.ikey}: ${probe.status}`,
    );
    outcomes.push({ row, verdict: probe.status });
  }

  return outcomes;
}

const NO_PROBE =
  'no reconcile probe is registered for this effect kind, so whether it landed cannot be ' +
  'established; re-performing it might apply it twice';

/**
 * Step 5 (AC5, AC6, EPIC-06-S6). Concludes every attempt this daemon inherited
 * `running`, then releases every lock whose holder is not running.
 *
 * The two halves are one step because they are one fact: a lock is released
 * *because* its holder is over, and a release appended without the failure that
 * explains it produces a timeline in which a node loses the repository for no
 * stated reason. The releases are appended here rather than left to
 * `decide()`'s own reclaim sweep — which would also find them — so that no tick
 * ever runs against a projection in which a dead node still owns a lock
 * (EPIC-06-S6: "appended before the first `decide()`").
 */
function reclaimInterrupted(
  runs: ReadonlyMap<RunId, RunState>,
  ports: RecoveryPorts,
  clock: Clock,
  appendOptions: AppendOptions,
  db: Db,
): { concluded: ConcludedAttempt[]; released: ReclaimedLock[] } {
  const concluded: ConcludedAttempt[] = [];
  const released: ReclaimedLock[] = [];

  for (const [runId, state] of runs) {
    const interrupted = Object.entries(state.nodes)
      .filter(([, node]) => node.status === 'running')
      .map(([id]) => id as NodeId)
      // By node id, so two daemons recovering the same directory conclude the
      // same attempts in the same order — and so the events a spec reads back
      // are not in whatever order `state.nodes` happens to enumerate.
      .toSorted();

    for (const nodeId of interrupted) {
      const node = state.nodes[nodeId];
      if (node === undefined) continue;
      const planned = state.plan?.nodes.find((entry) => entry.id === nodeId);
      const held = Object.values(state.locks)
        .filter((lock) => lock.node === nodeId)
        .map((lock) => claimId(lock));

      const failure = interruptedFailure(db, nodeId, node.attempt);
      const recorded = recordNodeFailure(db, {
        runId,
        nodeId,
        failure,
        retry: planned?.retry ?? DEFAULT_RECOVERY_RETRY,
        epoch: ports.epoch,
        ts: clock.now(),
        random: ports.random,
        appendOptions,
      });

      recovery.warn(
        { runId, nodeId, attempt: node.attempt, action: recorded.plan.action, held },
        `attempt ${node.attempt} of ${nodeId} was interrupted by a daemon crash and was concluded`,
      );
      concluded.push({
        runId,
        nodeId,
        attempt: node.attempt,
        action: recorded.plan.action,
        held,
      });
    }

    // Every lock whose holder is no longer running — the ones just concluded,
    // and any whose holder had already reached a terminal status before the
    // crash and never got its release appended.
    for (const lock of Object.values(state.locks)) {
      const holder = state.nodes[lock.node];
      const stillRunning = holder?.status === 'running' && !interrupted.includes(lock.node);
      if (stillRunning) continue;

      appendEvents(
        db,
        [
          {
            runId,
            ts: clock.now(),
            kind: 'node.lock.released',
            v: 1,
            epoch: ports.epoch,
            nodeId: lock.node,
            payload: {
              node: lock.node,
              lock: lock.lock,
              key: lock.key,
              reason: 'reclaimed',
            },
          },
        ],
        appendOptions,
      );
      released.push({ runId, node: lock.node, lock: lock.lock, key: lock.key });
    }
  }

  return { concluded, released };
}

/**
 * The policy used when the plan cannot be read for a node that is running —
 * a ledger whose `plan.proposed` is unreadable by this build, say.
 *
 * One attempt, so an unreadable plan cannot become an unbounded restart loop.
 * It is a floor, not a default: every node the plan *can* be read for uses its
 * own policy.
 */
const DEFAULT_RECOVERY_RETRY = {
  maxAttempts: 1,
  backoff: { base: 2_000, cap: 300_000, jitter: 'full' },
} as const;

const envelope = (
  row: EffectRow,
  kind: string,
  ts: number,
  epoch: number,
  payload: unknown,
): Parameters<typeof appendEvents>[1][number] => ({
  runId: row.runId as RunId,
  ts,
  kind,
  v: 1,
  epoch,
  nodeId: row.nodeId as NodeId,
  attempt: row.attempt,
  ikey: row.ikey as IdempotencyKey,
  payload,
});
