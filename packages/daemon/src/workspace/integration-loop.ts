/**
 * KAR-07.7 — the integration branch and the ordered merge loop
 * (docs/09-workspace-and-safety.md §7; Decisions D13, D14).
 *
 * §7.1 is four steps, and every one of them is a decision that could have gone
 * the obvious way and been wrong:
 *
 * 1. **`DeFlow/int/<runId>` exists from run start**, created from the run's
 *    base ref before the first node is scheduled — which is the entire reason
 *    D13 flattened branch naming, because git's refs storage cannot hold both
 *    `refs/heads/DeFlow/<runId>` and `refs/heads/DeFlow/<runId>/<nodeId>` and
 *    the hierarchical scheme therefore forecloses a run-level branch for ever.
 * 2. **The order comes from `conflict_probe`**, ascending, ties on completion
 *    time (./merge-queue.ts).
 * 3. **Every remaining branch is re-probed and the queue re-sorted after every
 *    merge.** Not an optimisation: a merge changes every remaining branch's
 *    conflict count, so an order computed once is stale the instant the first
 *    branch lands, and the whole point of ordering is to reach the conflicts
 *    last — when the cheap branches are already banked. The `before`/`after`
 *    pair on `workspace.merge_queue_reordered` is what makes that decision
 *    visible in the run timeline instead of invisible inside the scheduler.
 * 4. **The gate runs against the integration branch between merges**, and a
 *    failure *halts* rather than continuing. Continuing would pile more
 *    branches on top of a state already known to be broken, which is how a
 *    two-minute repair becomes a five-way bisect.
 *
 * **A conflict is never merged into.** The probe is ground truth (D14), so a
 * branch whose current conflict count is non-zero is not attempted: the loop
 * stops and proposes a resolution node (./resolution-node.ts) at `worktree`
 * permission on the integration worktree, with a packet of the conflicted
 * hunks and the two sides' intents and nothing else. That keeps the
 * integration worktree clean — no half-merged state for the next attempt to
 * trip over — and it is why there is no `-X ours` anywhere in this package.
 *
 * **The recorded queue is a record of what is left, not of what order to
 * use.** `integrate` re-probes and re-sorts before its first merge, always,
 * including on a resume. Trusting the recorded order across a halt would
 * reintroduce exactly the staleness step 3 exists to remove — and a resume
 * happens precisely after something changed the integration branch.
 *
 * Verifies: EPIC-07-S26, EPIC-07-S27, EPIC-07-S28 · AC1-AC8
 */
import type { Clock, Db, EventSeq, NodeId, RunId, Verdict } from '@DeFlow/core';
import { contentHash } from '@DeFlow/core';
import { appendEvents, readRange } from '@DeFlow/ledger';
import { join } from 'node:path';
import type { EffectRunner } from '../effects/durable.ts';
import {
  gitIntegrationBranchEffect,
  gitMergeEffect,
  type MergeAttempt,
} from '../effects/git-effect.ts';
import { GitError } from '../git/git-error.ts';
import type { GitPort } from '../git/merge-tree.ts';
import { conflictedFiles } from './conflict-hunks.ts';
import type { ConflictProber } from './conflict-prober.ts';
import {
  type MergeCandidate,
  mergeQueue,
  type QueuedMerge,
  reorderPayload,
} from './merge-queue.ts';
import { type IntentSummary, type ResolutionNodeSpec, resolutionNode } from './resolution-node.ts';

export type { MergeCandidate, QueuedMerge } from './merge-queue.ts';

/**
 * The reserved node id the run-level integration work is journalled under.
 *
 * The effect journal's key is `(runId, nodeId, attempt, ordinal)` and creating
 * the integration branch belongs to no node, so it needs an id of its own. The
 * `deflow-` prefix is reserved for exactly this: a planner-authored `NodeId`
 * naming itself `deflow-integration` would be claiming DeFlow's own journal
 * position, and nothing else in the vocabulary uses the prefix.
 */
export const INTEGRATION_NODE_ID = 'deflow-integration';

/** `worktree add --reason`'s payload for the integration worktree, in the same
 * shape ../git/worktree-args.ts writes for a node worktree. */
export function integrationLockReason(runId: string): string {
  return `DeFlow run=${runId} node=${INTEGRATION_NODE_ID}`;
}

/** The run, as this loop needs to see it. */
export interface IntegrationRun {
  /** The ledger's `RunId`. */
  readonly runId: string;
  /**
   * The id the branch names were composed from (KAR-07.3's `BRANCH_SAFE`
   * vocabulary). Separate from `runId` because branch composition validates
   * its inputs and the caller owns that composition.
   */
  readonly shortRunId: string;
  /** `DeFlow/int/<runId>`, from KAR-07.3's `integrationBranch`. */
  readonly integrationBranch: string;
  /** What the integration branch starts from (AC1). */
  readonly baseRef: string;
  /**
   * Absolute path of the integration worktree — an input, exactly as it is for
   * a node worktree (../git/worktree-args.ts). `IntegrationLoop.worktreePathFor`
   * composes the conventional one; nothing here discovers it, because
   * `rev-parse --show-toplevel` answers with git's resolved path and the
   * caller's own path may run through a symlink (`/var` is `/private/var` on
   * macOS), so the two would disagree about one directory.
   */
  readonly worktree: string;
}

export interface GateRequest {
  readonly runId: string;
  readonly integrationBranch: string;
  /** The integration worktree the gate runs in. */
  readonly cwd: string;
  /** The node whose branch has just landed. */
  readonly mergedNode: string;
}

/** The run's verification gate ([verification gates](../../../../docs/10-verification-gates.md),
 * EPIC-12). Injected, because §7.1 says only *when* it runs. */
export interface GatePort {
  evaluate(request: GateRequest): Promise<Verdict>;
}

/** What ./resolution-node.ts needs that this layer does not know. */
export interface ResolutionConfig {
  readonly target: {
    readonly provider: string;
    readonly model: string;
    readonly maxContext: number;
  };
  readonly budgetLimitTokens: number;
  readonly estimate: { readonly costUsd: number; readonly wallClockMs: number };
  readonly replanDepth: number;
}

export interface IntegrationPorts {
  readonly git: GitPort;
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on every event appended here. */
  readonly epoch: number;
  readonly effects: EffectRunner;
  readonly prober: ConflictProber;
  readonly gate: GatePort;
  readonly resolution: ResolutionConfig;
}

/** One branch that landed. */
export interface MergeRecord {
  readonly nodeId: string;
  readonly branch: string;
  /** The `--no-ff` merge commit. */
  readonly commit: string;
}

export type IntegrationOutcome =
  | {
      readonly status: 'integrated';
      readonly merged: readonly MergeRecord[];
      readonly remaining: readonly QueuedMerge[];
    }
  | {
      readonly status: 'gate-failed';
      readonly merged: readonly MergeRecord[];
      readonly remaining: readonly QueuedMerge[];
      readonly verdict: Verdict;
    }
  | {
      readonly status: 'conflict';
      readonly merged: readonly MergeRecord[];
      readonly remaining: readonly QueuedMerge[];
      readonly resolution: ResolutionNodeSpec;
    };

/**
 * A conflict this loop cannot brief a resolver about, because no already-
 * merged branch touched the conflicted paths.
 *
 * Thrown rather than papered over: §7.2's node shape needs *both* sides'
 * intent, and a resolution node given one is the blind resolution the section
 * forbids. The honest fallback when this fires is the human gate named in
 * KAR-07.7's degradation path, which is a decision above this layer.
 */
export class NoMergedCounterpartError extends Error {
  readonly paths: readonly string[];
  readonly integrationBranch: string;

  constructor(paths: readonly string[], integrationBranch: string) {
    super(
      `the conflict on ${paths.join(', ')} is with ${integrationBranch} itself: no node branch ` +
        'already merged into it touched those paths, so there is no counterpart intent to brief ' +
        'a resolver with, and the honest next step is the human gate rather than a one-sided node',
    );
    this.name = 'NoMergedCounterpartError';
    this.paths = paths;
    this.integrationBranch = integrationBranch;
  }
}

/** A node branch already merged into the integration branch. */
export interface MergedNode {
  readonly nodeId: string;
  readonly branch: string;
}

/** AC6's merge subject: the provenance, in the repository, for ever. */
export function mergeSubject(shortRunId: string, nodeId: string, branch: string): string {
  return `DeFlow integrate run=${shortRunId} node=${nodeId} branch=${branch}`;
}

const MERGE_SUBJECT = /^DeFlow integrate run=\S+ node=(?<node>\S+) branch=(?<branch>\S+)$/;

/** The inverse of `mergeSubject`, or `null` for any other commit — an
 * operator's own merge, or the resolver's if it wrote its own message. */
export function parseMergeSubject(subject: string): MergedNode | null {
  const groups = MERGE_SUBJECT.exec(subject)?.groups;
  if (groups?.node === undefined || groups.branch === undefined) return null;
  return { nodeId: groups.node, branch: groups.branch };
}

/** A node whose intent the blackboard cannot supply. */
export class IntentUnavailableError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(
      `no intent summary for node ${nodeId}: the resolution packet's whole advantage over a text ` +
        'merge tool is that it carries what each side was trying to do',
    );
    this.name = 'IntentUnavailableError';
    this.nodeId = nodeId;
  }
}

const PAGE = 500;

/** Every event of a run, in `seq` order. */
function allEvents(db: Db, runId: string): { seq: EventSeq; kind: string; payload: unknown }[] {
  const events: { seq: EventSeq; kind: string; payload: unknown }[] = [];
  let after = 0;
  for (;;) {
    const page = readRange(db, runId as RunId, after, PAGE);
    for (const event of page.events) {
      events.push({ seq: event.seq, kind: event.kind, payload: event.payload });
      after = event.seq;
    }
    if (!page.hasMore || page.events.length === 0) return events;
  }
}

/**
 * AC4 / EPIC-07-S28 — what is left to merge, read back from the ledger.
 *
 * The newest `workspace.merge_queue_reordered` event's `after` list, because
 * that event is emitted after *every* merge, including the one that empties
 * the queue. An empty array from a run that has reordered at least once means
 * "nothing left"; an empty array from a run that never has means "nothing has
 * merged yet", and the caller that knows which it is holds the candidates.
 */
export function remainingMergeQueue(db: Db, runId: string): string[] {
  let remaining: string[] = [];
  for (const event of allEvents(db, runId)) {
    if (event.kind !== 'workspace.merge_queue_reordered') continue;
    remaining = [...(event.payload as { after: string[] }).after];
  }
  return remaining;
}

/**
 * The intent a node stated when it completed.
 *
 * The blackboard proper is EPIC-09; until then the retained intent is the
 * node's own structured output, which is exactly what §7.2 calls "the
 * structured node outputs already on the blackboard". Read from the newest
 * `node.completed` for the node, and the event's own `seq` becomes the
 * segment's `sourceEvent`, so "this reached the resolver because node X said
 * it at seq N" stays a field lookup.
 */
export function ledgerIntent(db: Db, runId: string, nodeId: string): IntentSummary | null {
  let found: IntentSummary | null = null;
  for (const event of allEvents(db, runId)) {
    if (event.kind !== 'node.completed') continue;
    const payload = event.payload as {
      node?: string;
      result?: { output?: { summary?: unknown } };
    };
    if (payload.node !== nodeId) continue;
    const summary = payload.result?.output?.summary;
    if (typeof summary !== 'string') continue;
    found = { nodeId, text: summary, sourceEvent: event.seq };
  }
  return found;
}

export class IntegrationLoop {
  readonly #ports: IntegrationPorts;

  constructor(ports: IntegrationPorts) {
    this.#ports = ports;
  }

  /**
   * `<repoRoot>/.DeFlow/wt/int__<shortRunId>` — the same flat scheme
   * ../git/worktree-args.ts uses for a node worktree.
   *
   * `int__<runId>` cannot collide with any node worktree for D13's own
   * argument: a node worktree is always `<runId>__<nodeId>`, and no `RunId`
   * can be the literal `int` (`RUN_ID_PATTERN` requires the `run_` prefix).
   */
  static worktreePathFor(root: string, shortRunId: string): string {
    return join(root, '.DeFlow', 'wt', `int__${shortRunId}`);
  }

  /**
   * AC1 — the integration branch and its locked worktree, created from the
   * run's base ref as one journalled git effect.
   *
   * Idempotent across daemon lives: the effect asks git what exists before it
   * asks git to create anything, so a run that crashes after the branch landed
   * comes back to the branch it has.
   */
  async start(run: IntegrationRun): Promise<string> {
    const path = run.worktree;
    const result = await this.#ports.effects.durable(
      gitIntegrationBranchEffect(
        {
          runId: run.runId as RunId,
          nodeId: INTEGRATION_NODE_ID as NodeId,
          attempt: 1,
          requestHash: await contentHash(
            `integration-branch:${run.runId}:${run.integrationBranch}:${run.baseRef}`,
          ),
          branch: run.integrationBranch,
          path,
          baseRef: run.baseRef,
          lockReason: integrationLockReason(run.shortRunId),
        },
        { run: (args) => this.#ports.git.run(args) },
      ),
    );

    if (result.outcome === 'created') {
      appendEvents(this.#ports.db, [
        {
          runId: run.runId as RunId,
          ts: this.#ports.clock.now(),
          kind: 'workspace.worktree_created',
          v: 1,
          epoch: this.#ports.epoch,
          nodeId: INTEGRATION_NODE_ID as NodeId,
          payload: {
            node: INTEGRATION_NODE_ID,
            path,
            branch: run.integrationBranch,
            baseRef: run.baseRef,
            detached: false,
            lockReason: integrationLockReason(run.shortRunId),
          },
        },
      ]);
    }
    return path;
  }

  /**
   * §7.1's loop: probe, sort, merge the cheapest, re-probe, re-sort, gate.
   *
   * Always begins by probing — a resumed loop re-derives its order rather than
   * replaying a recorded one, because the integration branch is precisely what
   * changed while it was stopped.
   */
  async integrate(
    run: IntegrationRun,
    candidates: readonly MergeCandidate[],
  ): Promise<IntegrationOutcome> {
    const worktree = run.worktree;
    const merged: MergeRecord[] = [];
    let queue = await this.#sorted(run, candidates);

    for (;;) {
      const head = queue[0];
      if (head === undefined) return { status: 'integrated', merged, remaining: [] };

      const attempt = await this.#merge(run, worktree, head);
      if (!attempt.merged) {
        // git is the authority on whether a merge applies, and the conflicted
        // worktree it has just left behind is the resolution node's workspace.
        const resolution = await this.#resolutionFor(run, worktree, head);
        return { status: 'conflict', merged, remaining: queue, resolution };
      }
      merged.push({ nodeId: head.nodeId, branch: head.branch, commit: attempt.commit });

      const rest = queue.slice(1);
      queue = await this.#sorted(run, rest);
      this.#appendReorder(run, head.nodeId, rest, queue);

      const verdict = await this.#gate(run, worktree, head.nodeId);
      if (verdict.outcome !== 'pass') {
        return { status: 'gate-failed', merged, remaining: queue, verdict };
      }
    }
  }

  /** AC2/AC3 — probe every candidate against the integration branch, then
   * order. The one place the queue is ever built. */
  async #sorted(
    run: IntegrationRun,
    candidates: readonly MergeCandidate[],
  ): Promise<QueuedMerge[]> {
    if (candidates.length === 0) return [];
    const probes = await this.#ports.prober.probeAgainst(
      run.runId,
      run.integrationBranch,
      candidates.map((candidate) => candidate.branch),
    );
    return mergeQueue(candidates, probes, run.integrationBranch);
  }

  /** AC6 — one `--no-ff` merge attempt, journalled, in the integration
   * worktree. A conflict comes back as a result, not as a throw. */
  async #merge(run: IntegrationRun, worktree: string, head: QueuedMerge): Promise<MergeAttempt> {
    const subject = mergeSubject(run.shortRunId, head.nodeId, head.branch);
    return this.#ports.effects.durable(
      gitMergeEffect(
        {
          runId: run.runId as RunId,
          nodeId: head.nodeId as NodeId,
          attempt: 1,
          requestHash: await contentHash(
            `integration-merge:${run.runId}:${run.integrationBranch}:${head.branch}`,
          ),
          branch: head.branch,
          subject,
        },
        { run: (args) => this.#ports.git.run(args, { cwd: worktree }) },
      ),
    );
  }

  #appendReorder(
    run: IntegrationRun,
    mergedNode: string,
    before: readonly MergeCandidate[],
    after: readonly MergeCandidate[],
  ): void {
    appendEvents(this.#ports.db, [
      {
        runId: run.runId as RunId,
        ts: this.#ports.clock.now(),
        kind: 'workspace.merge_queue_reordered',
        v: 1,
        epoch: this.#ports.epoch,
        nodeId: mergedNode as NodeId,
        payload: {
          branch: run.integrationBranch,
          mergedNode,
          ...reorderPayload(before, after),
        },
      },
    ]);
  }

  /** AC4 — the gate against the integration branch, and its verdict recorded
   * before the next merge begins. */
  async #gate(run: IntegrationRun, worktree: string, mergedNode: string): Promise<Verdict> {
    const verdict = await this.#ports.gate.evaluate({
      runId: run.runId,
      integrationBranch: run.integrationBranch,
      cwd: worktree,
      mergedNode,
    });
    appendEvents(this.#ports.db, [
      {
        runId: run.runId as RunId,
        ts: this.#ports.clock.now(),
        kind: 'gate.evaluated',
        v: 1,
        epoch: this.#ports.epoch,
        nodeId: mergedNode as NodeId,
        payload: { gate: verdict.gate, node: mergedNode, verdict },
      },
    ]);
    return verdict;
  }

  /**
   * AC5 — the resolution node for a branch that will not merge, plus the
   * `plan.patch.proposed` that puts it in front of the policy engine.
   */
  async #resolutionFor(
    run: IntegrationRun,
    worktree: string,
    head: QueuedMerge,
  ): Promise<ResolutionNodeSpec> {
    const conflicts = await conflictedFiles(this.#ports.git, run.integrationBranch, head.branch);
    const paths = conflicts.map((file) => file.path);
    const counterpart = await this.#counterpart(run, paths);

    const spec = await resolutionNode({
      runId: run.runId,
      nodeId: head.nodeId,
      branch: head.branch,
      integrationBranch: run.integrationBranch,
      cwd: worktree,
      conflicts,
      intents: [this.#intent(run, head.nodeId), this.#intent(run, counterpart.nodeId)],
      builtAtEvent: this.#nextSeq(run),
      target: this.#ports.resolution.target,
      budgetLimitTokens: this.#ports.resolution.budgetLimitTokens,
      estimate: this.#ports.resolution.estimate,
      replanDepth: this.#ports.resolution.replanDepth,
    });

    appendEvents(this.#ports.db, [
      {
        runId: run.runId as RunId,
        ts: this.#ports.clock.now(),
        kind: 'plan.patch.proposed',
        v: 1,
        epoch: this.#ports.epoch,
        payload: { patch: spec.patch },
      },
    ]);
    return spec;
  }

  /**
   * The already-integrated node whose changes this conflict is *with*: the most
   * recently merged one that touched any conflicted path.
   *
   * Read from the integration branch's own merge history rather than from this
   * call's merge list, because a resumed loop has an empty list and the
   * counterpart it needs landed in a previous daemon life. That is the whole
   * value of AC6's provenance subject: `run=…  node=…` on each merge commit
   * makes "who put this here" answerable from the repository, with no side
   * table to keep in step.
   *
   * Most recent first, because a path merged three branches ago has since been
   * overwritten by whoever touched it last, and it is that last writer whose
   * intent the resolver has to weigh.
   */
  async #counterpart(run: IntegrationRun, paths: readonly string[]): Promise<MergedNode> {
    for (const record of await this.#integrated(run)) {
      const changed = await this.#changedPaths(run, record.branch);
      if (paths.some((path) => changed.has(path))) return record;
    }
    throw new NoMergedCounterpartError(paths, run.integrationBranch);
  }

  /** Every node branch already merged into the integration branch, newest
   * first, read off the merge commits' own subjects. */
  async #integrated(run: IntegrationRun): Promise<MergedNode[]> {
    const args = ['log', '--merges', '--format=%s', run.integrationBranch];
    const result = await this.#ports.git.run(args);
    if (result.exitCode !== 0) throw new GitError('log --merges failed', args, result);

    const records: MergedNode[] = [];
    for (const subject of result.stdout.split('\n')) {
      const parsed = parseMergeSubject(subject);
      if (parsed !== null) records.push(parsed);
    }
    return records;
  }

  /** What a branch changed relative to the run's base ref. Three dots, so the
   * answer is the branch's own work rather than everything the base has
   * acquired since. */
  async #changedPaths(run: IntegrationRun, branch: string): Promise<Set<string>> {
    const args = ['diff', '--name-only', `${run.baseRef}...${branch}`];
    const result = await this.#ports.git.run(args);
    if (result.exitCode !== 0) throw new GitError('diff --name-only failed', args, result);
    return new Set(result.stdout.split('\n').filter((path) => path !== ''));
  }

  #intent(run: IntegrationRun, nodeId: string): IntentSummary {
    const intent = ledgerIntent(this.#ports.db, run.runId, nodeId);
    if (intent === null) throw new IntentUnavailableError(nodeId);
    return intent;
  }

  /** The `EventSeq` the packet is attributed to: the next one this run will
   * write, which is the `plan.patch.proposed` that carries the node. */
  #nextSeq(run: IntegrationRun): number {
    const events = allEvents(this.#ports.db, run.runId);
    return (events.at(-1)?.seq ?? 0) + 1;
  }
}
