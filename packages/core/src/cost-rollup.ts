/**
 * KAR-14.1 — what a run has spent, per node, per provider and per run, with
 * every figure labelled by how it was measured
 * (docs/08-context-and-memory.md §7, docs/07-provider-adapter-layer.md §12).
 *
 * The whole file is one idea: **a cost figure is a cell in two partitions, and
 * there is no field for their sum.** Money is partitioned by auth mode —
 * subscription quota and real currency are different substances and §12 says
 * so in one sentence, *"the two must not be summed into one number"* — and
 * independently by measurement tier, because a vendor-reported figure is
 * billing truth while an estimated one carries a known 15–20% undercount on
 * Claude prose and worse on code. Both partitions describe the same spend from
 * two angles. Neither may be flattened, and the way to guarantee that is to
 * ship no `total` field for someone to reach for in week three.
 *
 * **`null` is the only honest blank.** A provider whose capability manifest
 * says it reports nothing contributes `null`, never `0`: a zero is a claim
 * that nothing was spent, it is false, and it makes an F4.6 cost ceiling
 * silently unenforceable. §7 says it in four words — *a blank cost cell, not a
 * zero* — and the rollup carries `unaccounted: ProviderId[]` so a run total can
 * be read as "$4.10 plus two providers that do not report" rather than as
 * "$4.10".
 *
 * Everything here is pure and total, because it is folded by `reduce()` and a
 * projection that cannot be replayed identically after a crash is not a
 * projection. That is also why money is added through `addMoney`, which rounds
 * to six decimal places: floating-point addition is not associative, and a
 * replay that visits the same events in the same order must produce the same
 * bytes.
 *
 * Verifies: EPIC-14-S2, EPIC-14-S3, EPIC-14-S4 · KAR-14.1 AC3, AC4, AC5
 */
import { z } from 'zod';
import type { ProviderAuthMode } from './event-payloads.ts';
import {
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  RunIdSchema,
} from './ids.ts';
import { type BudgetBreach, BudgetBreachSchema } from './node-failure.ts';
import { sumUsage, type TokenUsage, type UsageTotals, UsageTotalsSchema } from './token-usage.ts';

/**
 * The same spend, cut two ways.
 *
 * `subscription` + `apiKey` is one partition of it; `vendorReported` +
 * `estimated` is another. A cell is `null` when nothing has landed in it —
 * which is the same value an unmeasurable provider contributes, and
 * deliberately so: "nobody has spent this way" and "we cannot say what was
 * spent" are both *not a number*, and neither is zero.
 */
export interface CostFigures {
  /** Spend against a subscription's quota (F9.1). */
  readonly subscription: number | null;
  /** Spend in real currency, on the explicit API-key path (§12). */
  readonly apiKey: number | null;
  /** The share of it the vendor itself billed and reported. */
  readonly vendorReported: number | null;
  /** The share of it DeFlow's own Tier-2 count produced. */
  readonly estimated: number | null;
}

/** One keying of the accounting record: money, tokens, and what is missing. */
export interface CostRollup {
  readonly costUsd: CostFigures;
  /** Token totals, per source, never added across sources (§8). */
  readonly usage: UsageTotals;
  /**
   * Providers that contributed spend nobody could price — `tokenAccounting`
   * `'none'`, or any provider whose turn produced no cost figure. Named rather
   * than counted, because "plus two providers" is not an answer an operator
   * can act on and "plus gemini and copilot" is.
   */
  readonly unaccounted: readonly ProviderId[];
}

/** One attempt's own figures. A retry does not refund the attempt it replaced. */
export interface AttemptCostRollup extends CostRollup {
  /** 0-based, as the event envelope spells it. */
  readonly attempt: number;
}

/**
 * A node's cumulative figures, with the attempts that produced them.
 *
 * Both, not either: the cumulative number is what an F4.6 ceiling is evaluated
 * against, and the per-attempt breakdown is the only way an operator can see
 * that a repair loop capped at three attempts spent three times what the
 * successful attempt reports.
 */
export interface NodeCostRollup extends CostRollup {
  readonly attempts: readonly AttemptCostRollup[];
}

/** The accounting projection, in the three keyings KAR-14.1 asks for. */
export interface BudgetRollup {
  readonly run: CostRollup;
  readonly nodes: Readonly<Record<string, NodeCostRollup>>;
  readonly providers: Readonly<Record<string, CostRollup>>;
  /** F4.6 ceiling breaches, kept here because they pause the run rather than failing it. */
  readonly breaches: readonly BudgetBreach[];
}

/**
 * One `budget.consumed` event, as the fold needs it.
 *
 * `node` and `attempt` are `null` together, for run-level consumption no
 * single node owns; `costUsd` is `null` for a provider that cannot be priced.
 */
export interface Consumption {
  readonly node: NodeId | null;
  readonly attempt: number | null;
  readonly provider: ProviderId;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly authMode: ProviderAuthMode;
}

/**
 * Money, to six decimal places.
 *
 * Not cosmetic: `0.1 + 0.2` is `0.30000000000000004`, floating-point addition
 * is not associative, and a rollup that has to be **byte-identical** after a
 * replay cannot inherit that. Six places is well under a hundredth of a cent
 * and well above anything a vendor reports.
 */
const addMoney = (total: number, amount: number): number =>
  Math.round((total + amount) * 1_000_000) / 1_000_000;

/** Adds into a cell, or leaves it alone. `null` stays `null` until something real lands. */
const into = (cell: number | null, amount: number | null): number | null =>
  amount === null ? cell : addMoney(cell ?? 0, amount);

const EMPTY_FIGURES: CostFigures = Object.freeze({
  subscription: null,
  apiKey: null,
  vendorReported: null,
  estimated: null,
});

/** A keying nothing has been spent under yet. A factory, never a shared constant. */
export function emptyCostRollup(): CostRollup {
  return {
    costUsd: { ...EMPTY_FIGURES },
    usage: { vendorReported: null, estimated: null },
    unaccounted: [],
  };
}

/** The projection before the first `budget.consumed`. */
export function initialBudgetRollup(): BudgetRollup {
  return { run: emptyCostRollup(), nodes: {}, providers: {}, breaches: [] };
}

/**
 * Folds one contribution into one keying.
 *
 * The four cost cells are written by two independent questions — which
 * credential paid, and which tier measured — so a single contribution lands in
 * exactly two of them. A contribution with no cost figure lands in none, and
 * names its provider instead.
 */
function addTo(rollup: CostRollup, entry: Consumption): CostRollup {
  const { costUsd, authMode, usage, provider } = entry;
  const contributions: TokenUsage[] = [];
  if (rollup.usage.vendorReported !== null) contributions.push(rollup.usage.vendorReported);
  if (rollup.usage.estimated !== null) contributions.push(rollup.usage.estimated);
  contributions.push(usage);

  return {
    costUsd: {
      subscription: into(rollup.costUsd.subscription, authMode === 'subscription' ? costUsd : null),
      apiKey: into(rollup.costUsd.apiKey, authMode === 'api_key' ? costUsd : null),
      vendorReported: into(
        rollup.costUsd.vendorReported,
        usage.source === 'vendor-reported' ? costUsd : null,
      ),
      estimated: into(rollup.costUsd.estimated, usage.source === 'estimated' ? costUsd : null),
    },
    // Tokens are counted even when the money cannot be: DeFlow rendered the
    // prompt itself, so a blank cost cell is not a blank row.
    usage: sumUsage(contributions),
    unaccounted:
      costUsd !== null || rollup.unaccounted.includes(provider)
        ? rollup.unaccounted
        : [...rollup.unaccounted, provider],
  };
}

/** Appends or updates this attempt's own entry, keeping attempt order. */
function addAttempt(
  attempts: readonly AttemptCostRollup[],
  entry: Consumption,
): readonly AttemptCostRollup[] {
  if (entry.attempt === null) return attempts;
  const attempt = entry.attempt;
  const existing = attempts.find((row) => row.attempt === attempt);
  const updated: AttemptCostRollup = {
    attempt,
    ...addTo(existing ?? emptyCostRollup(), entry),
  };
  return existing === undefined
    ? [...attempts, updated]
    : attempts.map((row) => (row.attempt === attempt ? updated : row));
}

/**
 * Folds one `budget.consumed` into all three keyings at once.
 *
 * Pure: the argument is read and never mutated, which is what lets `reduce()`
 * be replayed over the same ledger and produce the same bytes.
 */
export function addConsumption(rollup: BudgetRollup, entry: Consumption): BudgetRollup {
  const node =
    entry.node === null
      ? rollup.nodes
      : {
          ...rollup.nodes,
          [entry.node]: {
            ...addTo(rollup.nodes[entry.node] ?? emptyCostRollup(), entry),
            attempts: addAttempt(rollup.nodes[entry.node]?.attempts ?? [], entry),
          },
        };

  return {
    ...rollup,
    run: addTo(rollup.run, entry),
    nodes: node,
    providers: {
      ...rollup.providers,
      [entry.provider]: addTo(rollup.providers[entry.provider] ?? emptyCostRollup(), entry),
    },
  };
}

// ── decoding a checkpoint ────────────────────────────────────────────────────

/**
 * A cost cell. `nullable` and never defaulted: a checkpoint written by an
 * earlier binary whose cell was blank must decode as blank, and a `.default(0)`
 * here would turn every unmeasurable provider into a free one on the first
 * restart.
 */
const cell = z.number().nonnegative().nullable();

const CostFiguresSchema = z.strictObject({
  subscription: cell,
  apiKey: cell,
  vendorReported: cell,
  estimated: cell,
});

const CostRollupShape = {
  costUsd: CostFiguresSchema,
  usage: UsageTotalsSchema,
  unaccounted: z.array(ProviderIdSchema),
};

export const CostRollupSchema: z.ZodType<CostRollup, unknown> = z.strictObject(CostRollupShape);

export const BudgetRollupSchema: z.ZodType<BudgetRollup, unknown> = z.strictObject({
  run: CostRollupSchema,
  nodes: z.record(
    z.string(),
    z.strictObject({
      ...CostRollupShape,
      attempts: z.array(
        z.strictObject({ ...CostRollupShape, attempt: z.number().int().nonnegative() }),
      ),
    }),
  ),
  providers: z.record(z.string(), CostRollupSchema),
  breaches: z.array(BudgetBreachSchema),
});

/**
 * The `(runId, nodeId, attempt)` a `budget.consumed` belongs to, spelled once.
 *
 * AC6's de-duplication is the effect journal's idempotency key doing its job,
 * not a uniqueness check on this projection — asserting it here would hide a
 * genuine double execution behind a silent dedup. What this function is for is
 * the *assertion*: a spec that wants to prove nothing was double-counted needs
 * one spelling of the triple, and two spellings would disagree.
 */
export function consumptionKey(runId: string, node: string | null, attempt: number | null): string {
  return `${RunIdSchema.parse(runId)}/${node === null ? '-' : NodeIdSchema.parse(node)}/${attempt ?? '-'}`;
}
