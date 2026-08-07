/**
 * KAR-14.3 — what a plan, or a patch, is about to cost
 * (docs/06-planning-and-replanning.md §4.1, docs/08-context-and-memory.md §7).
 *
 * KAR-14.1 answers "what has this run spent". This module answers the question
 * that has to be asked *first*, because it is the only one whose answer can
 * still change anything: **what will it spend if I say yes.** A figure produced
 * after the money is gone is a report; a figure produced before it is a
 * decision, and F1.3's spec-approval surface and F2.5's patch policy engine are
 * both decisions.
 *
 * Four properties hold the whole file up.
 *
 * **It is pure, and structurally so.** No clock, no network, no filesystem —
 * the tokenizer, the capability manifest and the learned calibration all arrive
 * as inputs, which is what makes an estimate reproducible from the ledger
 * months later and golden-file testable per archetype today. `packages/core`
 * has no dependency capable of impurity and `test/purity.test.ts` proves it.
 *
 * **Every figure says how it was made.** The `method` is the tokenizer's own
 * label rather than a constant written here — a caller that counted with the
 * heuristic gets a figure that says `heuristic`, and one that counted with
 * Tier 2 gets `gpt-tokenizer/o200k_base`. Beside it travels the
 * `tokenEstimateFactor` that was applied and the sample count `n` behind it,
 * because below five samples the number is a family seed standing in for a
 * measurement nobody has taken and a surface has to be able to say so (AC2).
 *
 * **An unknown cost is `null`, and the whole story turns on it.** A provider
 * with no rate in the table, or whose manifest says `tokenAccounting: 'none'`,
 * produces `costUsd: null` — never `0`. The failure chain is one coercion long:
 * `null → 0` makes `costDeltaUsd <= 5.00` true, which matches
 * `read-only-analysis`, which is `auto` — so the most expensive class of patch
 * would auto-apply on exactly the providers DeFlow cannot meter (AC7,
 * EPIC-14-S18). For the same reason a patch delta with *any* unpriceable node
 * in it is `null` rather than the sum of the rest: a partial sum reads as cheap.
 *
 * **The price table is static data with a version, not a lookup.** DeFlow holds
 * no model credential, so it cannot ask a vendor what a model costs. Rates go
 * stale; the version is recorded on every figure so an estimate can be
 * re-derived later against the table that produced it, and a model with no
 * entry is `null` rather than a guess. Where a vendor reports `costUSD`
 * directly, that is billing truth and KAR-14.1's rollup carries it — this
 * module is only ever consulted for *estimates*.
 *
 * Verifies: EPIC-14-S15, EPIC-14-S18, EPIC-14-S19 · KAR-14.3 AC1, AC2, AC7
 */
import type { TokenCountMethod } from './context-packet.ts';
import type { NodeId, ProviderId } from './ids.ts';
import {
  type NodeType,
  PERMISSION_LEVELS,
  type PermissionLevel,
  type PlanNode,
} from './plan-graph.ts';
import type { PlanPatch } from './plan-patch.ts';
import type { TokenAccounting } from './token-accounting.ts';
import {
  appliedFactor,
  CALIBRATION_MIN_SAMPLES,
  type Calibration,
  calibratedEstimate,
} from './token-calibration.ts';
import type { Tokenizer } from './tokenizer.ts';

// ── the price table ──────────────────────────────────────────────────────────

/** One model's list price, in USD per million tokens. */
export interface ModelRate {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

/**
 * A dated set of rates.
 *
 * The version is a date rather than a semver because that is what the staleness
 * question actually is — *how old is this price* — and it is recorded on every
 * figure the table produces so a figure can be re-derived later against the
 * table that made it.
 */
export interface PriceTable {
  readonly version: string;
  /** Keyed by `priceKey(provider, model)`. */
  readonly rates: Readonly<Record<string, ModelRate>>;
}

export const PRICE_TABLE_VERSION = '2026-08-07';

/** The one spelling of a rate key, so a writer and a reader cannot disagree. */
export function priceKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * The rates DeFlow ships with, as published list prices on
 * {@link PRICE_TABLE_VERSION}.
 *
 * Deliberately short. Every entry is a claim that goes stale, and a table that
 * guessed at models it had never seen would answer with a number instead of
 * with `null` — which is the one answer that keeps an unpriceable patch away
 * from the `auto` arm. An operator whose model is missing supplies their own
 * table; they do not get a wrong number by default.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = Object.freeze({
  version: PRICE_TABLE_VERSION,
  rates: Object.freeze({
    [priceKey('claude', 'claude-opus-4-1')]: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
    [priceKey('claude', 'claude-sonnet-4-5')]: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    [priceKey('claude', 'claude-haiku-4-5')]: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
    [priceKey('codex', 'gpt-5')]: { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
    [priceKey('codex', 'gpt-5-mini')]: { inputUsdPerMTok: 0.25, outputUsdPerMTok: 2 },
  }),
});

// ── what an estimate is ──────────────────────────────────────────────────────

/**
 * Why a figure is `null`.
 *
 * Four reasons rather than one boolean, because they are four different things
 * to do about it: route elsewhere, name a model, extend the table, or accept
 * that this provider is unmeterable.
 */
export const UNPRICEABLE_REASONS = [
  /** The node names no provider and none was resolved for it. */
  'no-provider',
  /** No model was named, and a default would be a price nobody chose. */
  'no-model',
  /** The price table has no entry for this (provider, model). */
  'no-rate',
  /** The capability manifest says this provider reports nothing (`'none'`). */
  'no-accounting',
] as const;

export type UnpriceableReason = (typeof UNPRICEABLE_REASONS)[number];

/** The correction that was applied, and how much measurement is behind it. */
export interface AppliedCalibration {
  readonly provider: ProviderId;
  readonly model: string;
  /** The seed below five samples, the learned ratio from the fifth on. */
  readonly tokenEstimateFactor: number;
  /** `n` — how many (estimate, actual) pairs produced the factor. */
  readonly samples: number;
  /** `true` while the factor is a family seed standing in for a measurement. */
  readonly seedBased: boolean;
}

/** One node, priced. */
export interface NodeEstimate {
  readonly node: NodeId;
  readonly type: NodeType;
  /** `null` for a node that runs no model at all — a script, or a person. */
  readonly provider: ProviderId | null;
  readonly model: string | null;
  /** Tier-2 count of the prompt, **after** the calibration factor. */
  readonly inputTokens: number;
  /** The node's declared return budget: the only pre-flight signal there is. */
  readonly outputTokens: number;
  /** `null` when nothing could price it — never `0` (AC7). */
  readonly costUsd: number | null;
  /** The tokenizer's own label, never a constant from this module (AC2). */
  readonly method: TokenCountMethod;
  readonly calibration: AppliedCalibration | null;
  readonly unpriceable: UnpriceableReason | null;
  readonly priceTableVersion: string;
}

/** A node whose cost is unknown, and why. */
export interface UnpriceableNode {
  readonly node: NodeId;
  readonly provider: ProviderId | null;
  readonly reason: UnpriceableReason;
}

/** The whole-plan figure the spec-approval surface renders (AC3). */
export interface PlanEstimate {
  /**
   * The plan's cost, or `null` when any node in it could not be priced.
   *
   * `null` rather than the sum of the rest, for the reason the module note
   * gives: a partial sum presented as a total reads as cheap, and this figure
   * is looked at by somebody deciding whether to spend. What *is* known sits
   * beside it in `pricedCostUsd` with the unpriceable nodes named, which is
   * KAR-14.1's "$4.10 plus two providers that do not report" in estimate form.
   */
  readonly costUsd: number | null;
  readonly pricedCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly method: TokenCountMethod;
  /** One entry per distinct (provider, model), in first-seen order. */
  readonly calibrations: readonly AppliedCalibration[];
  readonly unpriceable: readonly UnpriceableNode[];
  readonly priceTableVersion: string;
  readonly nodes: readonly NodeEstimate[];
}

/**
 * The `estimate` block 06 §4.1 puts on every `PlanPatch`, plus 04's
 * `estimatedWallClockDeltaMs`.
 *
 * These five fields are exactly the inputs the F2.5 rule table predicates over
 * — see ./patch-policy.ts — which is why they are a type of their own rather
 * than a projection of `PlanEstimate`: a patch is judged, a plan is read.
 */
export interface PatchEstimate {
  /** Signed: a patch that removes work is negative. `null` when unknown. */
  readonly costUsdDelta: number | null;
  /**
   * The sum of the declared per-node wall-clock ceilings the patch adds, or
   * `null` when it adds none.
   *
   * DeFlow does not guess how long an agent will take. A node with no declared
   * ceiling contributes nothing rather than an invented duration, and a patch
   * where none declares one is `null` rather than `0` — zero would say "this
   * patch takes no time", which is never true.
   */
  readonly estimatedWallClockDeltaMs: number | null;
  readonly nodesAdded: number;
  readonly blastRadiusFiles: number;
  /** The most capable permission any node the patch introduces asks for. */
  readonly maxPermission: PermissionLevel;
  /** Distance from `PlanGraph` v1: the version this patch is proposed against. */
  readonly replanDepth: number;
  readonly method: TokenCountMethod;
  readonly calibrations: readonly AppliedCalibration[];
  readonly unpriceable: readonly UnpriceableNode[];
  readonly priceTableVersion: string;
}

/**
 * Everything the estimator needs from the world, as data.
 *
 * A parameter per question rather than a registry, because @DeFlow/core owns no
 * registry and reads no database — and because an estimator that looked
 * anything up itself would answer differently in a test than in production,
 * which is the one thing a golden file cannot catch.
 */
export interface EstimatorInputs {
  /** Tier 2, as a port. Its `method` is what every figure is labelled with. */
  readonly tokenizer: Tokenizer;
  /** The probed capability manifest's answer for this provider. */
  readonly accounting: (provider: ProviderId) => TokenAccounting;
  /** Which seed family a provider belongs to (`anthropic`, `openai`, …). */
  readonly family: (provider: ProviderId) => string;
  /** What has been learned for this (provider, model), or a seeded zero. */
  readonly calibration: (provider: ProviderId, model: string) => Calibration;
  /** Defaults to {@link DEFAULT_PRICE_TABLE}. */
  readonly prices?: PriceTable | undefined;
  /**
   * What the scheduler actually resolved for a node, when it has.
   *
   * The plan states a *preference* (`provider.prefer`) and an adversarial gate
   * states nothing at all, so before scheduling this is the only way a gate is
   * priceable — and after it, the resolved answer beats re-deriving `prefer[0]`
   * for the same reason `budgetEnforceability` prefers the ledger's answer.
   */
  readonly routing?:
    | ((node: PlanNode) => { provider: ProviderId | null; model: string | null } | null)
    | undefined;
  /**
   * Every text this node's prompt will contain.
   *
   * Defaults to the node's own brief, which is a **floor**: the assembled
   * packet also carries pinned spec segments and inherited facts. A caller that
   * has built the packet should pass its parts, and the honest alternative to
   * that — multiplying the brief by a guessed constant — would be an invented
   * number wearing a measured one's clothes.
   */
  readonly promptTexts?: ((node: PlanNode) => readonly string[]) | undefined;
}

// ── pricing one node ─────────────────────────────────────────────────────────

/**
 * Money, to six decimal places — the same rounding KAR-14.1's rollup applies,
 * and for the same reason: floating-point addition is not associative, and two
 * callers that added the same figures in a different order must still agree.
 */
const money = (amount: number): number => Math.round(amount * 1_000_000) / 1_000_000;

/** The texts a node's prompt is built from, per archetype. */
function promptTextsOf(node: PlanNode): readonly string[] {
  if (node.type === 'agent') return [node.brief];
  if (node.type === 'gate' && node.gate.kind === 'adversarial') return [node.gate.brief];
  // Everything else sends no prompt to a model: a script runs, a person reads.
  return [];
}

/** Whether this archetype spends model money at all. */
const sendsAPrompt = (node: PlanNode): boolean => promptTextsOf(node).length > 0;

function routeOf(
  node: PlanNode,
  inputs: EstimatorInputs,
): { provider: ProviderId | null; model: string | null } {
  const resolved = inputs.routing?.(node) ?? null;
  if (resolved !== null && resolved.provider !== null) return resolved;
  if (node.type === 'agent') {
    return { provider: node.provider.prefer[0] ?? null, model: node.model ?? null };
  }
  return { provider: null, model: null };
}

/**
 * One node's pre-flight figure.
 *
 * The order of the `null` arms is the order a reader would ask the questions
 * in, and each is reported as itself: "nothing routes this node" and "the table
 * has no rate for the model it routes to" are different problems with different
 * fixes, and a single `unpriceable: true` would collapse them.
 */
export function estimateNode(node: PlanNode, inputs: EstimatorInputs): NodeEstimate {
  const table = inputs.prices ?? DEFAULT_PRICE_TABLE;
  const texts = inputs.promptTexts?.(node) ?? promptTextsOf(node);
  const raw = texts.reduce((total, text) => total + inputs.tokenizer.count(text).estimated, 0);
  const { provider, model } = routeOf(node, inputs);

  const base = {
    node: node.id,
    type: node.type,
    provider,
    model,
    method: inputs.tokenizer.method,
    priceTableVersion: table.version,
  } as const;

  // A node that sends no prompt costs no model money, and that is a measured
  // zero rather than an unknown one: a `pnpm lint` node spends nothing on a
  // model because it never speaks to one.
  if (!sendsAPrompt(node)) {
    return {
      ...base,
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      calibration: null,
      unpriceable: null,
    };
  }

  if (provider === null) {
    return {
      ...base,
      inputTokens: raw,
      outputTokens: node.returns.maxTokens,
      costUsd: null,
      calibration: null,
      unpriceable: 'no-provider',
    };
  }

  const family = inputs.family(provider);
  const learned = model === null ? { n: 0, ratio: 1 } : inputs.calibration(provider, model);
  const factor = appliedFactor(learned, family);
  const calibration: AppliedCalibration | null =
    model === null
      ? null
      : {
          provider,
          model,
          tokenEstimateFactor: factor,
          samples: learned.n,
          seedBased: learned.n < CALIBRATION_MIN_SAMPLES,
        };

  // Counted whatever happens: a blank cost cell is not a blank row, and the
  // tokens are arithmetic over text DeFlow rendered itself.
  const inputTokens = calibratedEstimate(raw, factor);
  const outputTokens = node.returns.maxTokens;
  const blank = (reason: UnpriceableReason): NodeEstimate => ({
    ...base,
    inputTokens,
    outputTokens,
    costUsd: null,
    calibration,
    unpriceable: reason,
  });

  if (inputs.accounting(provider) === 'none') return blank('no-accounting');
  if (model === null) return blank('no-model');
  const rate = table.rates[priceKey(provider, model)];
  if (rate === undefined) return blank('no-rate');

  return {
    ...base,
    inputTokens,
    outputTokens,
    costUsd: money(
      (inputTokens / 1_000_000) * rate.inputUsdPerMTok +
        (outputTokens / 1_000_000) * rate.outputUsdPerMTok,
    ),
    calibration,
    unpriceable: null,
  };
}

// ── the whole plan ───────────────────────────────────────────────────────────

/** Deduplicates the calibrations a set of estimates applied, first seen first. */
function calibrationsOf(estimates: readonly NodeEstimate[]): readonly AppliedCalibration[] {
  const seen = new Map<string, AppliedCalibration>();
  for (const estimate of estimates) {
    if (estimate.calibration === null) continue;
    const key = priceKey(estimate.calibration.provider, estimate.calibration.model);
    if (!seen.has(key)) seen.set(key, estimate.calibration);
  }
  return [...seen.values()];
}

function unpriceableOf(estimates: readonly NodeEstimate[]): readonly UnpriceableNode[] {
  return estimates
    .filter((estimate) => estimate.unpriceable !== null)
    .map((estimate) => ({
      node: estimate.node,
      provider: estimate.provider,
      reason: estimate.unpriceable as UnpriceableReason,
    }));
}

/**
 * AC3 — the figure `GET /api/runs/:id` carries before `run.started`, so
 * `POST /runs/:id/spec/approve` is an informed decision.
 *
 * Retired nodes are skipped: a superseded or abandoned node is not work this
 * plan is about to do, and counting it would make every replan look more
 * expensive than the run it replaced.
 */
export function estimatePlan(
  plan: { readonly nodes: readonly PlanNode[] },
  inputs: EstimatorInputs,
): PlanEstimate {
  const nodes = plan.nodes
    .filter((node) => node.lifecycle === 'active')
    .map((node) => estimateNode(node, inputs));

  const unpriceable = unpriceableOf(nodes);
  const priced = money(nodes.reduce((total, estimate) => total + (estimate.costUsd ?? 0), 0));

  return {
    costUsd: unpriceable.length === 0 ? priced : null,
    pricedCostUsd: priced,
    inputTokens: nodes.reduce((total, estimate) => total + estimate.inputTokens, 0),
    outputTokens: nodes.reduce((total, estimate) => total + estimate.outputTokens, 0),
    method: inputs.tokenizer.method,
    calibrations: calibrationsOf(nodes),
    unpriceable,
    priceTableVersion: (inputs.prices ?? DEFAULT_PRICE_TABLE).version,
    nodes,
  };
}

// ── the patch ────────────────────────────────────────────────────────────────

export interface PatchEstimatorInputs extends EstimatorInputs {
  /** The plan version the patch is proposed against: its replan depth. */
  readonly planVersion: number;
  /**
   * How many files the patch's write scopes expand to in the worktree.
   *
   * A port because expansion is a filesystem question and this module has no
   * filesystem. The default counts the declared scopes themselves, which is a
   * floor and is labelled as one by being replaceable.
   */
  readonly countFiles?: ((paths: readonly string[]) => number) | undefined;
}

const permissionRank = (level: PermissionLevel): number => PERMISSION_LEVELS.indexOf(level);

/** The nodes a patch brings into existence, in op order. */
function introducedNodes(patch: PlanPatch): readonly PlanNode[] {
  const introduced: PlanNode[] = [];
  for (const op of patch.ops) {
    if (op.op === 'insert-nodes') introduced.push(...op.nodes);
    else if (op.op === 'split-node') introduced.push(...op.into);
  }
  return introduced;
}

/** `root` and everything that transitively depends on it, among active nodes. */
function branchFrom(
  base: { readonly nodes: readonly PlanNode[] },
  root: string,
): readonly PlanNode[] {
  const active = base.nodes.filter((node) => node.lifecycle === 'active');
  const inBranch = new Set<string>([root]);
  // Repeated passes rather than a graph build: a plan is hundreds of nodes, the
  // relation is `deps`, and a fixpoint over it is easier to read than an index.
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of active) {
      if (inBranch.has(node.id)) continue;
      if (node.deps.some((dep) => inBranch.has(dep))) {
        inBranch.add(node.id);
        grew = true;
      }
    }
  }
  return active.filter((node) => inBranch.has(node.id));
}

/**
 * AC1, AC7 — the `estimate` block the policy engine rules on.
 *
 * Signed, because a patch that abandons a branch *removes* cost and clamping
 * that to zero would hide the one case where the rules should relax rather than
 * tighten. `null` the moment any node it touches cannot be priced, because a
 * partial sum is what makes an unmeterable provider read as a cheap one.
 */
export function estimatePatch(
  patch: PlanPatch,
  base: { readonly nodes: readonly PlanNode[] },
  inputs: PatchEstimatorInputs,
): PatchEstimate {
  const byId = new Map(base.nodes.map((node) => [node.id as string, node]));
  const touched: NodeEstimate[] = [];
  let delta = 0;
  let added = 0;
  let wallclock: number | null = null;
  const paths: string[] = [];

  /** Adds one estimate, in `sign`'s direction, and keeps it for reporting. */
  const contribute = (node: PlanNode, sign: 1 | -1): NodeEstimate => {
    const estimate = estimateNode(node, inputs);
    touched.push(estimate);
    delta += sign * (estimate.costUsd ?? 0);
    return estimate;
  };

  for (const op of patch.ops) {
    switch (op.op) {
      case 'insert-nodes':
      case 'split-node': {
        const introduced = op.op === 'insert-nodes' ? op.nodes : op.into;
        for (const node of introduced) {
          contribute(node, 1);
          if (node.budget.maxWallClockMs !== undefined) {
            wallclock = (wallclock ?? 0) + node.budget.maxWallClockMs;
          }
          paths.push(...node.pathScopes.write);
        }
        // A split retires the node it replaces, so its own cost stops being
        // spent: the net addition is the successors minus the ancestor.
        added += introduced.length;
        if (op.op === 'split-node') {
          const superseded = byId.get(op.node);
          if (superseded !== undefined) contribute(superseded, -1);
          added -= 1;
        }
        break;
      }
      case 'replace-provider': {
        const before = byId.get(op.node);
        if (before === undefined) break;
        contribute(before, -1);
        contribute(before, 1);
        break;
      }
      case 'extend-loop': {
        const loop = byId.get(op.node);
        if (loop === undefined || loop.type !== 'loop') break;
        const body = byId.get(loop.body);
        if (body === undefined) break;
        const rounds = op.maxRounds - loop.maxRounds;
        const perRound = contribute(body, 1);
        // `contribute` counted one round; the op adds `rounds` of them.
        delta += (rounds - 1) * (perRound.costUsd ?? 0);
        break;
      }
      case 'abandon-branch': {
        for (const node of branchFrom(base, op.root)) contribute(node, -1);
        break;
      }
    }
  }

  // `replace-provider` re-prices the same node under a new route, which is what
  // `routing` is for; without one the two contributions cancel, which is the
  // honest answer to "we do not know what the new provider costs".
  const introduced = introducedNodes(patch);
  const maxPermission = introduced.reduce<PermissionLevel>(
    (highest, node) =>
      permissionRank(node.permission) > permissionRank(highest) ? node.permission : highest,
    'read',
  );

  const unpriceable = unpriceableOf(touched);
  return {
    costUsdDelta: unpriceable.length === 0 ? money(delta) : null,
    estimatedWallClockDeltaMs: wallclock,
    nodesAdded: added,
    blastRadiusFiles: (inputs.countFiles ?? ((scopes) => new Set(scopes).size))(paths),
    maxPermission,
    replanDepth: inputs.planVersion,
    method: inputs.tokenizer.method,
    calibrations: calibrationsOf(touched),
    unpriceable,
    priceTableVersion: (inputs.prices ?? DEFAULT_PRICE_TABLE).version,
  };
}
