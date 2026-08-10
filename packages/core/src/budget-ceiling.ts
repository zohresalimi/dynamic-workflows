/**
 * KAR-14.2 — F4.6's ceilings, and the one question `decide()` asks of them.
 *
 * [05 §10.3](../../../docs/05-durable-execution.md) is explicit and the wording
 * is the design: *"Hitting a budget ceiling (F4.6) is deliberately a `gate`, not
 * a `permanent` failure: the run **pauses for a human decision** rather than
 * dying with hours of work half-done."* Three properties follow from that
 * sentence, and every line below serves one of them.
 *
 * **Admission is the lever.** A ceiling withholds *new* work; it never tears
 * down an attempt that is in flight. A node ninety per cent of the way through
 * a build, killed to save a few cents, turns a pause into a partial failure and
 * breaks the promise the resume path is for. So a node whose own attempt is
 * running is never tripped here — its spend is counted, and the trip happens at
 * the next admission, which is the only moment withholding costs nothing.
 *
 * **The ceiling is reduced state, not config.** It arrives as
 * `budget.ceiling.set`, appended beside `run.created` from `POST /api/runs`'s
 * `budget` block and `.DeFlow/config.yaml`'s defaults, and raised later by the
 * same event with `source: 'operator'`. That is what makes a mid-run edit to
 * the config file unable to move a ceiling silently — the effective values are
 * pinned in the log with a hash of the document they came from — and it is also
 * what makes a raised ceiling survive the restart that follows the pause.
 *
 * **Two substances are never summed.** `docs/07-provider-adapter-layer.md` §12:
 * subscription-quota spend and real currency *"must not be summed into one
 * number"*. So a cost ceiling is evaluated against **each** partition cell in
 * turn, and the figure that trips is the one that crossed — never a total this
 * module invented by adding them. The measurement partition (vendor-reported
 * against estimated) travels with the trip as its `basis`, because an operator
 * looking at a paused run has to be able to see whether a real bill or DeFlow's
 * own estimate stopped it (AC7).
 *
 * Verifies: EPIC-14-S8, EPIC-14-S10, EPIC-14-S11 · KAR-14.2 AC1, AC3, AC6, AC7
 */
import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';
import type { CostRollup } from './cost-rollup.ts';
import type { DeFlowConfig } from './deflow-config.ts';
import type { BudgetBasis, ProviderAuthMode } from './event-payloads.ts';
import { contentHash } from './hash.ts';
import type { EventSeq, NodeId, ProviderId } from './ids.ts';
import {
  type BudgetBreach,
  budgetExceededFailure,
  type NodeFailure,
  type ToNodeFailureContext,
} from './node-failure.ts';
import type { PlanNode } from './plan-graph.ts';
import type { RunState } from './run-state.ts';
import type { TokenAccounting } from './token-accounting.ts';

/**
 * One scope's ceiling, in both dimensions.
 *
 * `null` is "no ceiling", never `0`: a zero ceiling would pause every run on
 * its first tick, and the difference between "unbounded" and "bounded at
 * nothing" is exactly the difference an operator who left the field blank
 * meant.
 */
export interface Ceiling {
  /** USD, per auth-mode substance. */
  readonly costUsd: number | null;
  readonly wallclockMs: number | null;
}

/**
 * Every ceiling in force, as the ledger has pinned them.
 *
 * `node` is the default each node inherits; `nodes` holds the explicit
 * per-node ones an operator set or raised. A node's own `budget` block in the
 * plan sits between the two — see `nodeCeiling`.
 */
export interface RunCeilings {
  readonly run: Ceiling;
  readonly node: Ceiling;
  readonly nodes: Readonly<Record<string, Ceiling>>;
  /**
   * The sha256 of the effective ceiling document at run creation (AC1).
   *
   * Kept so a later reader can tell a run whose ceilings came from a config
   * file that has since been edited from one whose have not. `null` before any
   * ceiling has been set.
   */
  readonly hash: string | null;
  /**
   * KAR-13.2 AC8 — the `seq` of the last `budget.ceiling.set`, or `null` when
   * nobody has set one.
   *
   * It is how a ceiling breach *leaves* the approval queue. F4.6's decision is
   * *"raise the ceiling or stop"*, and raising one is a `budget.ceiling.set`
   * after the breach — so the queue asks whether the answer came after the
   * question rather than keeping a second "resolved" flag that a restart would
   * have to reconstruct. A run that was stopped instead leaves the queue with
   * the run, because a finished run waits on nobody.
   */
  readonly setSeq: number | null;
}

const NO_CEILING: Ceiling = Object.freeze({ costUsd: null, wallclockMs: null });

/** A run nobody has set a ceiling on. A factory, never a shared constant. */
export function initialCeilings(): RunCeilings {
  return { run: { ...NO_CEILING }, node: { ...NO_CEILING }, nodes: {}, hash: null, setSeq: null };
}

const ceilingValue = z.number().nonnegative().nullable();

const CeilingSchema = z.strictObject({
  costUsd: ceilingValue,
  wallclockMs: ceilingValue,
});

export const RunCeilingsSchema: z.ZodType<RunCeilings, unknown> = z.strictObject({
  run: CeilingSchema,
  node: CeilingSchema,
  nodes: z.record(z.string(), CeilingSchema),
  hash: z.string().min(1).nullable(),
  /** The seq of the last `budget.ceiling.set`; no event has seq 0. */
  setSeq: z.number().int().positive().nullable(),
});

/**
 * What `POST /api/runs` may ask for (docs/11-api-and-realtime.md §6's
 * `budget: { costUsd, wallclockMs }`).
 */
export interface RequestedBudget {
  readonly costUsd?: number | undefined;
  readonly wallclockMs?: number | undefined;
}

/** The two scopes a ceiling is resolved for, before any per-node override. */
export interface EffectiveCeilings {
  readonly run: Ceiling;
  readonly node: Ceiling;
}

/**
 * AC1 — the ceiling a run is created with: the request over the workspace
 * default, resolved **once**.
 *
 * Per dimension rather than per object, so a request that names only a cost
 * ceiling does not silently drop the wall-clock one `.DeFlow/config.yaml` set.
 * The answer is what gets appended as `budget.ceiling.set` and hashed into the
 * log; nothing downstream reads the config file again, which is the whole of
 * "a mid-run config edit does not silently change them".
 */
export function resolveCeilings(input: {
  readonly requested?: RequestedBudget | undefined;
  readonly config?: DeFlowConfig | undefined;
}): EffectiveCeilings {
  const requested = input.requested ?? {};
  const configured = input.config?.budget ?? {};
  return {
    run: {
      costUsd: requested.costUsd ?? configured.run?.costUsd ?? null,
      wallclockMs: requested.wallclockMs ?? configured.run?.wallclockMs ?? null,
    },
    // A request budget is about the run; a per-node default is a workspace
    // policy, and there is deliberately no way to set it per request — a
    // ceiling on "every node of this run" is a run ceiling divided by a number
    // nobody knows yet.
    node: {
      costUsd: configured.node?.costUsd ?? null,
      wallclockMs: configured.node?.wallclockMs ?? null,
    },
  };
}

/**
 * AC1 — the sha256 of the effective ceiling document, pinned into the log.
 *
 * Over `canonicalJson`, so the digest is a function of the *values* and not of
 * the order somebody wrote them in: a config file whose keys were reordered has
 * not changed the ceiling, and a hash that said otherwise would report drift
 * every time the file was formatted.
 */
export function ceilingHash(ceilings: EffectiveCeilings): Promise<string> {
  return contentHash(canonicalJson(ceilings));
}

/**
 * The ceiling `node` actually runs under, most specific first.
 *
 * The order is a claim about who knows best: an operator who raised *this*
 * node's ceiling beats the planner's own `budget` block, which beats the
 * run-wide default every other node inherits. Resolved per dimension rather
 * than per object, so raising a node's cost ceiling does not silently drop the
 * wall-clock one the plan set.
 */
export function nodeCeiling(state: RunState, node: NodeId | string): Ceiling {
  const explicit = state.ceilings.nodes[node];
  const planned = planBudgetOf(state, node);
  const fallback = state.ceilings.node;

  return {
    costUsd: explicit?.costUsd ?? planned.costUsd ?? fallback.costUsd,
    wallclockMs: explicit?.wallclockMs ?? planned.wallclockMs ?? fallback.wallclockMs,
  };
}

function planBudgetOf(state: RunState, node: NodeId | string): Ceiling {
  const planned = state.plan?.nodes.find((candidate) => candidate.id === node);
  return {
    costUsd: planned?.budget.maxCostUsd ?? null,
    wallclockMs: planned?.budget.maxWallClockMs ?? null,
  };
}

/** One ceiling that has been crossed, and everything a reader needs about it. */
export interface BudgetTrip {
  readonly breach: BudgetBreach;
  /** Absent for a wall-clock trip: there is no money to attribute. */
  readonly basis: BudgetBasis | null;
}

/** The auth-mode cells, in the order a trip reports them. */
const AUTH_MODES: readonly ProviderAuthMode[] = ['subscription', 'api_key'];

const cellOf = (rollup: CostRollup, mode: ProviderAuthMode): number | null =>
  mode === 'subscription' ? rollup.costUsd.subscription : rollup.costUsd.apiKey;

/**
 * The cost trip this rollup implies against `limit`, or `null`.
 *
 * Each substance is compared on its own, and the first that crosses is the one
 * reported. There is deliberately no arm that adds them: a run that spent $15
 * of quota and $15 of real money has not spent $30 of anything, and a ceiling
 * that fired as though it had would be a ceiling the operator cannot reason
 * about.
 */
function costTrip(
  rollup: CostRollup,
  limit: number,
): { actual: number; basis: BudgetBasis } | null {
  for (const authMode of AUTH_MODES) {
    const spent = cellOf(rollup, authMode);
    if (spent === null || spent <= limit) continue;
    return {
      actual: spent,
      basis: {
        authMode,
        vendorReported: rollup.costUsd.vendorReported,
        estimated: rollup.costUsd.estimated,
        estimateDriven: rollup.costUsd.vendorReported === null && rollup.costUsd.estimated !== null,
        unaccounted: [...rollup.unaccounted],
      },
    };
  }
  return null;
}

/** The statuses a node can be tripped in: work that has not been admitted yet. */
const WITHHOLDABLE = ['scheduled', 'awaiting-retry'] as const;

/**
 * Every ceiling this state has crossed, at this instant.
 *
 * Pure and total, like `decide()` itself, and for the same reason: it is
 * evaluated on every tick and after every restart, and an answer that depended
 * on anything but `(state, now)` would make a paused run un-reconstructable
 * from the log.
 *
 * Returns nothing at all unless the run is `running`. A paused run has already
 * tripped — restating it every tick would append one `budget.exceeded` per
 * second for as long as nobody is awake to answer it — and a completed one
 * cannot spend anything more.
 */
export function budgetTrips(state: RunState, now: number): readonly BudgetTrip[] {
  if (state.runId === null || state.status !== 'running') return [];

  const trips: BudgetTrip[] = [];
  const runCeiling = state.ceilings.run;

  const runCost =
    runCeiling.costUsd === null ? null : costTrip(state.budget.run, runCeiling.costUsd);
  if (runCeiling.costUsd !== null && runCost !== null) {
    trips.push({
      breach: {
        scope: 'run',
        dimension: 'cost',
        limit: runCeiling.costUsd,
        actual: runCost.actual,
        firedBy: 'deflow',
      },
      basis: runCost.basis,
    });
  }

  const elapsed = state.startedTs === 0 ? null : now - state.startedTs;
  if (runCeiling.wallclockMs !== null && elapsed !== null && elapsed > runCeiling.wallclockMs) {
    trips.push({
      breach: {
        scope: 'run',
        dimension: 'wallclock',
        limit: runCeiling.wallclockMs,
        actual: elapsed,
        firedBy: 'deflow',
      },
      basis: null,
    });
  }

  // A run-scope trip stops admission everywhere, so there is nothing a node
  // trip could add on the same tick but noise in the timeline.
  if (trips.length > 0) return trips;

  for (const node of withholdableNodes(state)) {
    trips.push(...nodeTrips(state, node, now));
  }
  return trips;
}

function withholdableNodes(state: RunState): readonly PlanNode[] {
  const withholdable: readonly string[] = WITHHOLDABLE;
  // A node the plan names and no event has touched has no record at all, and
  // that is `scheduled` — exactly how `decide()` reads it. Requiring a record
  // would leave the very first admission of a node with a ceiling untested.
  //
  // The import is deliberately `type`-only in both directions with
  // ./run-state.ts: that module folds this one's `initialCeilings` into its own
  // initial value, and a value import back would close the cycle — which
  // Node's ESM loader answers with a TDZ `ReferenceError` at *daemon start*,
  // not at compile time.
  return (state.plan?.nodes ?? []).filter((node) => {
    const status = state.nodes[node.id]?.status;
    return node.lifecycle === 'active' && (status === undefined || withholdable.includes(status));
  });
}

function nodeTrips(state: RunState, node: PlanNode, now: number): BudgetTrip[] {
  const ceiling = nodeCeiling(state, node.id);
  const trips: BudgetTrip[] = [];

  const rollup = state.budget.nodes[node.id];
  const cost =
    ceiling.costUsd === null || rollup === undefined ? null : costTrip(rollup, ceiling.costUsd);
  if (ceiling.costUsd !== null && cost !== null) {
    trips.push({
      breach: {
        scope: 'node',
        node: node.id,
        dimension: 'cost',
        limit: ceiling.costUsd,
        actual: cost.actual,
        firedBy: 'deflow',
      },
      basis: cost.basis,
    });
  }

  // Measured from the node's *first* start, across attempts: a repair loop that
  // burned ten minutes over three attempts has burned ten minutes, and a
  // per-attempt measure would never notice.
  const startedTs = state.nodes[node.id]?.startedTs ?? 0;
  const elapsed = startedTs === 0 ? null : now - startedTs;
  if (ceiling.wallclockMs !== null && elapsed !== null && elapsed > ceiling.wallclockMs) {
    trips.push({
      breach: {
        scope: 'node',
        node: node.id,
        dimension: 'wallclock',
        limit: ceiling.wallclockMs,
        actual: elapsed,
        firedBy: 'deflow',
      },
      basis: null,
    });
  }

  return trips;
}

// ── what a ceiling can actually measure ──────────────────────────────────────

/**
 * One provider DeFlow cannot price, and the nodes routed at it.
 *
 * Named rather than counted: "plus two providers" is not something an operator
 * can act on, and "plus gemini, on n-x0" is.
 */
export interface UnmeasurableProvider {
  readonly provider: ProviderId;
  readonly nodes: readonly NodeId[];
}

/** Which of a run's ceilings can actually be enforced (AC8). */
export interface BudgetEnforceability {
  /** `false` when a cost ceiling exists that no rollup will ever reach. */
  readonly cost: boolean;
  /** Always `true`: wall-clock is measured on DeFlow's own injected clock. */
  readonly wallclock: boolean;
  readonly unmeasurable: readonly UnmeasurableProvider[];
}

/**
 * AC8 — whether the ceilings in force can be measured, and by whom they cannot.
 *
 * A provider whose manifest says `tokenAccounting: 'none'` contributes a blank
 * cost cell rather than a zero (KAR-14.1), so a `costUsd` ceiling over it never
 * fires: the figure it is compared against never moves. Refusing to run would
 * be over-strict — the operator may not care — so this is what makes the honest
 * alternative possible, which is to say so loudly, before approval, while a
 * different provider is still one edit away.
 *
 * The wall-clock ceiling stays enforceable regardless, because DeFlow measures
 * it itself.
 *
 * `accounting` is a parameter rather than a lookup because @DeFlow/core owns no
 * registry and reads no database: the caller passes the capability manifest's
 * answer, and a test passes a map.
 */
export function budgetEnforceability(
  state: RunState,
  accounting: (provider: ProviderId) => TokenAccounting,
): BudgetEnforceability {
  const nodes = plannedNodes(state);
  const hasCostCeiling =
    state.ceilings.run.costUsd !== null ||
    state.ceilings.node.costUsd !== null ||
    Object.values(state.ceilings.nodes).some((ceiling) => ceiling.costUsd !== null) ||
    nodes.some((node) => node.budget.maxCostUsd !== undefined);

  const byProvider = new Map<ProviderId, NodeId[]>();
  for (const node of nodes) {
    if (node.lifecycle !== 'active') continue;
    const provider = providerOf(state, node);
    if (provider === null || accounting(provider) !== 'none') continue;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), node.id]);
  }

  const unmeasurable = [...byProvider]
    .map(([provider, nodes]) => ({ provider, nodes }))
    .toSorted((left, right) => (left.provider < right.provider ? -1 : 1));

  return {
    cost: !hasCostCeiling || unmeasurable.length === 0,
    wallclock: true,
    unmeasurable,
  };
}

/**
 * The nodes this answer is about: the executing plan, or — **before**
 * `run.started` — the proposal waiting for approval.
 *
 * The second half is the whole point of AC8. The marker has to be on the
 * spec-approval surface, and at that moment the run has a `plan.proposed` and
 * no adopted plan at all; a check that read only `state.plan` would go quiet
 * until the first node had already spent money on a ceiling that will never
 * fire.
 *
 * KAR-14.3's pre-flight estimate is the second caller and needs exactly the
 * same set for exactly the same reason, which is why this is exported rather
 * than spelled twice: two answers to "which nodes is this run about" would
 * disagree the first time one of them learned about a lifecycle.
 *
 * Deduplicated by id, because two proposals can name the same node.
 */
export function plannedNodes(state: RunState): readonly PlanNode[] {
  const planned = state.plan?.nodes ?? Object.values(state.proposedPlans).flatMap((g) => g.nodes);
  const seen = new Set<string>();
  return planned.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

/**
 * The provider a node will actually run on: what the ledger already resolved
 * for it, or — before it has been scheduled — the plan's first preference.
 *
 * The ledger wins for the reason `decide()`'s `startNode` gives: a
 * `node.scheduled` means the resolution against probed capabilities has already
 * happened, and re-deriving it from `prefer[0]` would silently undo it.
 */
function providerOf(state: RunState, node: PlanNode): ProviderId | null {
  const resolved = state.nodes[node.id]?.provider;
  if (resolved !== undefined && resolved !== null) return resolved;
  return node.type === 'agent' ? (node.provider.prefer[0] ?? null) : null;
}

/**
 * A breach as a `NodeFailure`, which is where its **class** comes from (AC2).
 *
 * A thin wrapper over the taxonomy's own constructor, and deliberately not a
 * second one: `budget.cost-exceeded` and `budget.wallclock-exceeded` are two of
 * the three reasons `NodeFailureSchema` refuses to classify as anything but
 * `gate`, so the class on the ledger is the schema's answer rather than this
 * module's opinion.
 */
export function budgetTripFailure(
  breach: BudgetBreach,
  context: Pick<ToNodeFailureContext, 'occurredAtEvent' | 'attempt'>,
): NodeFailure {
  return budgetExceededFailure(breach, context);
}

/** The class every breach is recorded under, read off the taxonomy once. */
export const BUDGET_FAILURE_CLASS = budgetTripFailure(
  { scope: 'run', dimension: 'cost', limit: 0, actual: 0 },
  { occurredAtEvent: 1 as EventSeq, attempt: 0 },
).class;
