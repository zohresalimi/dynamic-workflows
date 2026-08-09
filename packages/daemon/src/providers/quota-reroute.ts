/**
 * KAR-11.6 — the imperative half of F3.9: read the probed rows, propose the
 * swap, let the policy engine rule on it, and apply it as a plan version
 * (docs/06-planning-and-replanning.md §4.4).
 *
 * 06 §4.4's sentence is the whole design: *"the scheduler does not silently
 * swap providers"*. It proposes a `replace-provider` op through the same policy
 * engine as everything else and produces the same `plan.patched` event, *"so
 * the swap appears in the visualisation — which is the entire point of F3.9's
 * wording."* Two consequences follow, and both are shapes here rather than
 * conventions:
 *
 * 1. **Nothing in this module changes a node's provider.** `applyPatch`
 *    composes the successor graph and `commitPatchedPlan` revalidates and
 *    writes it, exactly as a planner-proposed patch is written. A code path
 *    that mutated `RunState` would be a swap with no version behind it, which
 *    the scrubber cannot render and no operator can explain.
 * 2. **The equivalence is computed, never claimed.** `capabilitySuperset` and
 *    `permissionUnchanged` come from `chooseQuotaRoute` over the
 *    `provider_capabilities` rows, and they are what `quota-reroute-equivalent`
 *    predicates on. A patch that could declare itself equivalent could
 *    auto-apply anything.
 *
 * **The wake is moved only after the patch commits.** The failure recorder
 * already suspended the node until the vendor's own `resetsAt` (KAR-14.4), and
 * that is the correct state for a node whose reroute is still waiting on a
 * human — retrying it two seconds later against the vendor that just refused it
 * is the storm full jitter exists to prevent. So the earlier wake is written
 * here, on the committed branch only, in one transaction with the
 * `node.retry.scheduled` that announces it.
 *
 * Verifies: EPIC-11-S29, EPIC-11-S30, EPIC-11-S31 · AC2, AC3, AC4, AC5, AC7
 */
import { chooseQuotaRoute, type NodeRequirement, type QuotaRoute } from '@DeFlow/adapters';
import type {
  Db,
  EstimatorInputs,
  NodeId,
  PatchPolicyDecision,
  PlanGraph,
  PlanNode,
  PlannerAttribution,
  PlanPatch,
  PlanTimeCapability,
  ProviderId,
  RunId,
  TaskSpec,
} from '@DeFlow/core';
import { applyPatch, EVENT_CURRENT_VERSIONS, isReroutePatch, QUOTA_CAUSE } from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  listProviderCapabilities,
  readLatestRateLimits,
  replayRun,
  scheduleWake,
} from '@DeFlow/ledger';
import { rulePatch } from '../budget/patch-gate.ts';
import {
  type CommitPatchedPlanOutcome,
  commitPatchedPlan,
  type NodeRefChecker,
} from '../plan/validate.ts';

export interface QuotaRouteQuery {
  /** The node's own `provider.requires`, in either vocabulary. */
  readonly requires: readonly NodeRequirement[];
  /** The adapter that was rate limited. */
  readonly current: ProviderId | null;
  /** `AgentNode.provider.prefer`. */
  readonly prefer: readonly ProviderId[];
  /** ms epoch from the injected `Clock`, never `Date.now()`. */
  readonly now: number;
}

/**
 * AC3, AC5 — where this node goes, answered from what is installed on this
 * machine and what each vendor last said about its quota.
 *
 * Both reads are of the whole data directory rather than of this run: a
 * capability row is a fact about a binary, and *"the limit that makes today's
 * plan unroutable was very likely tripped by yesterday's run"*.
 */
export function quotaRouteFor(db: Db, query: QuotaRouteQuery): QuotaRoute {
  return chooseQuotaRoute({
    requires: query.requires,
    current: query.current,
    prefer: query.prefer,
    rows: listProviderCapabilities(db),
    limits: readLatestRateLimits(db),
    now: query.now,
  });
}

/** The reroute half of a route — the only shape that has anything to apply. */
export type QuotaReroute = Extract<QuotaRoute, { readonly action: 'reroute' }>;

export interface QuotaRerouteRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** The proposal, as `recordNodeFailure` recorded it. */
  readonly patch: PlanPatch;
  /** The equivalence the policy engine rules on, from the probed rows. */
  readonly route: QuotaReroute;
  /** The plan version the ops were derived against. */
  readonly base: PlanGraph;
  /** The attempt the reroute will run at, from the retry plan. */
  readonly nextAttempt: number;
  /** When that attempt is due — the ordinary jittered backoff, because the
   * node is moving to a vendor that has not refused it. */
  readonly retryAt: number;
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  readonly spec: TaskSpec;
  readonly caps: readonly PlanTimeCapability[];
  readonly estimatePacketTokens: (node: PlanNode) => number;
  readonly refs: NodeRefChecker;
  readonly estimator: EstimatorInputs;
  readonly planner: PlannerAttribution;
  /** From the injected `Clock`. */
  readonly ts: number;
  readonly epoch: number;
  readonly configPolicyHash?: string | undefined;
  readonly touchesExecutionBoundary?: boolean | undefined;
}

export interface QuotaRerouteOutcome {
  readonly decision: PatchPolicyDecision;
  readonly ruleId: string;
  /** Whether the run is now executing the patched plan. `false` for a patch a
   * human still has to approve, and for one revalidation refused. */
  readonly applied: boolean;
  /** Present once the ruling was `auto` and the successor graph was composed. */
  readonly commit?: CommitPatchedPlanOutcome;
}

/** The rule a structurally impossible reroute is filed under. Reachable only
 * when the base graph moved under the proposal — the node the op names is gone
 * — and recorded rather than thrown, because NF10's question is *"what did the
 * run want to do and why did it not happen"*. */
export const REROUTE_NOT_APPLICABLE = 'reroute-not-applicable';

/**
 * AC4, AC7 — rules on the proposal and, if the table says `auto`, applies it.
 *
 * The ruling comes first and unconditionally, and `applied` is never `true`
 * without a committed plan version behind it: `commitPatchedPlan` revalidates
 * the successor graph and may still refuse it, and an `auto` that reported
 * success on the strength of the decision alone would claim a swap the run is
 * not executing.
 */
export async function applyQuotaReroute(
  db: Db,
  request: QuotaRerouteRequest,
): Promise<QuotaRerouteOutcome> {
  const ruling = rulePatch(db, {
    runId: request.runId,
    state: replayRun(db, request.runId).state,
    patch: request.patch,
    estimator: request.estimator,
    now: request.ts,
    touchesExecutionBoundary: request.touchesExecutionBoundary,
    configPolicyHash: request.configPolicyHash,
    reroute: {
      cause: QUOTA_CAUSE,
      // Structural, from the patch itself: a patch that swapped a provider and
      // inserted a node is not equivalent to the plan it replaces, whatever
      // cause its proposer gave.
      onlyReroutes: isReroutePatch(request.patch),
      capabilitySuperset: request.route.capabilitySuperset,
      permissionUnchanged: request.route.permissionUnchanged,
    },
  });

  if (ruling.decision !== 'auto') {
    return { decision: ruling.decision, ruleId: ruling.ruleId, applied: false };
  }

  const composed = await applyPatch(request.base, request.patch, {
    createdAt: new Date(request.ts).toISOString(),
  });
  if (!composed.ok) {
    appendEvents(db, [
      event(request, 'plan.patch.rejected', {
        patchId: request.patch.id,
        rule: REROUTE_NOT_APPLICABLE,
        by: 'validation',
      }),
    ]);
    return { decision: ruling.decision, ruleId: ruling.ruleId, applied: false };
  }

  const commit = await commitPatchedPlan({
    db,
    runDir: request.runDir,
    graph: composed.graph,
    spec: request.spec,
    caps: request.caps,
    estimatePacketTokens: request.estimatePacketTokens,
    refs: request.refs,
    plan: composed.graph,
    basePlanHash: request.base.planHash,
    patchId: request.patch.id,
    decision: {
      decision: 'auto',
      by: 'policy',
      rule: ruling.ruleId,
      at: new Date(request.ts).toISOString(),
    },
    by: request.patch.proposedBy,
    planner: request.planner,
    ts: request.ts,
    epoch: request.epoch,
  });

  if (commit.outcome === 'committed') rescheduleOnto(db, request);

  return {
    decision: ruling.decision,
    ruleId: ruling.ruleId,
    applied: commit.outcome === 'committed',
    commit,
  };
}

/**
 * AC7's last clause — the node is no longer waiting on the vendor that refused
 * it, so the wait it is under has to say so.
 *
 * One transaction, event and row together, for §10.3's reason: a restart
 * between them either loses the deadline — an immediate retry — or leaves the
 * node asleep until a reset that no longer applies to the provider it now runs
 * on. The reason returns to `backoff` because it is now DeFlow's own guess at
 * when to try again rather than a vendor's statement, which is the whole
 * distinction the four-value vocabulary exists to keep.
 */
function rescheduleOnto(db: Db, request: QuotaRerouteRequest): void {
  db.transaction(() => {
    appendEvents(db, [
      {
        ...event(request, 'node.retry.scheduled', {
          node: request.nodeId,
          nextAttempt: request.nextAttempt,
          wakeAt: request.retryAt,
        }),
        nodeId: request.nodeId,
        attempt: request.nextAttempt,
      },
    ]);
    scheduleWake(db, {
      runId: request.runId,
      nodeId: request.nodeId,
      wakeAt: request.retryAt,
      reason: 'backoff',
    });
  });
}

function event(request: QuotaRerouteRequest, kind: string, payload: unknown): EventDraft {
  return {
    runId: request.runId,
    ts: request.ts,
    kind,
    v: (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1,
    epoch: request.epoch,
    payload,
  };
}
