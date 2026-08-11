/**
 * KAR-16.3 — `cost.ts`: per-node, per-provider and per-run accumulation, with
 * every figure labelled by how it was measured (F9.1).
 *
 * Verifies: EPIC-16-S20, EPIC-16-S23 · AC8, AC10, AC11
 *
 * ## There is no `total` field, and that is the design
 *
 * `TokenUsage.source` is `'vendor-reported' | 'estimated'` and the two *must
 * never be silently mixed* (docs/04 §8). Vendor-reported figures come from the
 * CLI's result envelope and are the billing truth; estimated ones come from
 * `gpt-tokenizer`'s `o200k_base` encoding and carry a known 15–20% undercount
 * on Claude prose and worse on code. A ceiling computed from a mixed number
 * fires at the wrong time in *both* directions — burning quota past the ceiling
 * when the estimate undercounts, pausing a healthy run when it does not.
 *
 * So this projection ships no field anybody can reach for in week three. Each
 * bucket carries a `vendorReported` and an `estimated` cell, and a `sources`
 * list saying which of them a displayed number could have come from.
 *
 * ## `null` is the only honest blank
 *
 * `budget.consumed.costUsd` is nullable, and a provider whose capability
 * manifest declares `tokenAccounting: 'none'` contributes `null`, never `0`.
 * *A blank cost cell, not a zero* (docs/08 §7): a zero is a claim that nothing
 * was spent, it is false, and it makes an F4.6 ceiling silently unenforceable.
 * The provider goes into `unaccounted` so a run total reads as "$0.21 plus one
 * provider that does not report" rather than as "$0.21".
 *
 * ## Money is added at six decimal places
 *
 * Floating-point addition is not associative, and a replay that visits the same
 * events in the same order has to produce the same bytes — otherwise a
 * reconnect changes a number the Operator is about to make a decision on.
 */
import type { Event } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

export type UsageSource = 'vendor-reported' | 'estimated';

export interface UsageTotal {
  readonly source: UsageSource;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface CostFigures {
  /** Spend the vendor itself billed and reported. `null` if none has landed. */
  vendorReported: number | null;
  /** Spend DeFlow's own Tier-2 count produced. `null` if none has landed. */
  estimated: number | null;
  /** Against a subscription's quota (F9.1). */
  subscription: number | null;
  /** In real currency, on the explicit API-key path (docs/07 §12). */
  apiKey: number | null;
}

export interface CostBucket {
  readonly costUsd: CostFigures;
  readonly usage: { vendorReported: UsageTotal | null; estimated: UsageTotal | null };
  /** Providers that spent something nobody could price. Named, not counted. */
  unaccounted: string[];
  /** Which measurement tiers contributed here at all. */
  sources: UsageSource[];
  events: number;
  /**
   * The `seq` of the newest event folded into this bucket; `0` for a bucket
   * nothing has been folded into.
   *
   * KAR-17.3 AC7 — *"clicking a cost figure selects the producing event in the
   * debug ring"*. A running total is produced by the last event that moved it,
   * so that event's `seq` is the link, and it has to be recorded here: the ring
   * holds 2,000 envelopes and a nine-hour run rolls the answer out of it.
   *
   * `0` rather than `null` because 0 is the one `seq` the ledger never mints
   * (docs/11 §4.2), so "no producing event" needs no second representation.
   */
  lastSeq: number;
}

export interface CeilingVM {
  readonly seq: number;
  readonly scope: 'node' | 'run';
  readonly node: string | null;
  readonly dimension: 'cost' | 'wallclock';
  readonly limit: number;
  readonly actual: number;
  readonly firedBy: 'deflow' | 'vendor';
  /** No vendor-reported figure contributed to the trip at all. */
  readonly estimateDriven: boolean;
  readonly unaccounted: readonly string[];
}

export interface RateLimitVM {
  readonly seq: number;
  readonly provider: string;
  /** ms epoch. `null` when the vendor named no reset. */
  readonly resetsAt: number | null;
}

/**
 * A ceiling the operator or the config *set*, as opposed to one a run tripped.
 *
 * Both dimensions travel together on one event and either may be `null`: a
 * ceiling on money that says nothing about wall clock is the common case, and a
 * `0` in the other cell would read as "no time at all".
 */
export interface CeilingSetVM {
  readonly seq: number;
  readonly scope: 'node' | 'run';
  readonly node: string | null;
  readonly costUsd: number | null;
  readonly wallclockMs: number | null;
  readonly source: string;
  readonly hash: string;
}

export interface CostProjection {
  appliedSeq: number;
  run: CostBucket;
  byNode: Map<string, CostBucket>;
  /**
   * `${nodeId}#${attempt}` → what *that attempt* consumed (KAR-17.3).
   *
   * The node inspector's attempt table shows a cost per attempt, and a per-node
   * total cannot answer that question. The obvious substitute — the node total
   * divided by the attempt count — reports three equal figures for three
   * attempts that consumed different amounts, which is worse than no figure at
   * all because it looks like a measurement.
   *
   * An **index**, never a second accounting: the same `budget.consumed` is
   * folded into the run, the provider, the node and the attempt, so the header
   * and the table can never disagree about the same money.
   */
  byAttempt: Map<string, CostBucket>;
  byProvider: Map<string, CostBucket>;
  ceilings: CeilingVM[];
  ceilingsSet: CeilingSetVM[];
  rateLimits: RateLimitVM[];
  /** A ceiling PAUSED the run. It did not fail it. */
  paused: boolean;
}

function emptyBucket(): CostBucket {
  return {
    costUsd: { vendorReported: null, estimated: null, subscription: null, apiKey: null },
    usage: { vendorReported: null, estimated: null },
    unaccounted: [],
    sources: [],
    events: 0,
    lastSeq: 0,
  };
}

/** The key `byAttempt` is indexed by. The same shape the ledger's ikey uses. */
export const attemptKey = (nodeId: string, attempt: number): string => `${nodeId}#${attempt}`;

export function emptyCost(): CostProjection {
  return {
    appliedSeq: 0,
    run: emptyBucket(),
    byNode: new Map(),
    byAttempt: new Map(),
    byProvider: new Map(),
    ceilings: [],
    ceilingsSet: [],
    rateLimits: [],
    paused: false,
  };
}

export function applyCost(state: CostProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'budget.consumed': {
      const buckets = [state.run, bucket(state.byProvider, event.payload.provider)];
      if (event.payload.node !== undefined) {
        buckets.push(bucket(state.byNode, event.payload.node));
        // `attempt` is documented as *"absent exactly when `node` is"*, but the
        // schema declares the two `.optional()` independently, so a node-scoped
        // payload naming no attempt parses. It is withheld from `byAttempt`
        // rather than folded in under `attempt ?? 0`: the inspector's attempt
        // table reads those buckets as measurements of a specific attempt, and
        // an unattributed spend merged into attempt 0 is a wrong measurement
        // rather than a missing one. The node total below still counts it.
        if (event.payload.attempt !== undefined) {
          buckets.push(
            bucket(state.byAttempt, attemptKey(event.payload.node, event.payload.attempt)),
          );
        }
      }
      for (const target of buckets) {
        absorb(
          target,
          event.payload.usage,
          event.payload.costUsd,
          event.payload.authMode,
          event.payload.provider,
          event.seq,
        );
      }
      return;
    }

    case 'budget.exceeded': {
      state.ceilings.push({
        seq: event.seq,
        scope: event.payload.scope,
        node: event.payload.node ?? null,
        dimension: event.payload.dimension,
        limit: event.payload.limit,
        actual: event.payload.actual,
        // Always present: DeFlow's own admission check or the vendor's ceiling
        // below it, and which fired is the difference between raising DeFlow's
        // limit and raising the vendor's.
        firedBy: event.payload.firedBy,
        // `basis` is absent for a wall-clock trip: there is no money to
        // attribute, and a `false` there would read as "a vendor figure was
        // involved" rather than as "no money was".
        estimateDriven:
          event.payload.basis === undefined ? false : event.payload.basis.estimateDriven,
        unaccounted: event.payload.basis === undefined ? [] : [...event.payload.basis.unaccounted],
      });
      // The run PAUSED. `failureClass: 'gate'` on the payload is the schema
      // refusing to let anything downstream retry into the same wall.
      state.paused = true;
      return;
    }

    case 'budget.ceiling.set': {
      state.ceilingsSet.push({
        seq: event.seq,
        scope: event.payload.scope,
        node: event.payload.node ?? null,
        costUsd: event.payload.costUsd,
        wallclockMs: event.payload.wallclockMs,
        source: event.payload.source,
        hash: event.payload.hash,
      });
      return;
    }

    case 'provider.rate_limited': {
      state.rateLimits.push({
        seq: event.seq,
        provider: event.payload.provider,
        resetsAt: event.payload.resetsAt ?? null,
      });
      return;
    }

    default:
      ignored<'cost'>(event as Ignorable<'cost'>);
      return;
  }
}

function bucket(map: Map<string, CostBucket>, key: string): CostBucket {
  const held = map.get(key);
  if (held !== undefined) return held;
  const fresh = emptyBucket();
  map.set(key, fresh);
  return fresh;
}

interface UsageShape {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number | undefined;
  readonly cacheCreationInputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
  readonly source: UsageSource;
}

function absorb(
  target: CostBucket,
  usage: UsageShape,
  costUsd: number | null,
  authMode: 'subscription' | 'api_key',
  provider: string,
  seq: number,
): void {
  target.events += 1;
  // Before the early return below, deliberately: a `costUsd: null` event still
  // moved this bucket — it is what put a provider in `unaccounted` — so it is
  // still the event that produced what the bucket now says.
  target.lastSeq = seq;
  if (!target.sources.includes(usage.source)) target.sources.push(usage.source);

  const key = usage.source === 'vendor-reported' ? 'vendorReported' : 'estimated';
  target.usage[key] = addUsage(target.usage[key], usage);

  if (costUsd === null) {
    // Not a zero. The provider is named so a run total can be read as "plus
    // gemini-cli, which does not report" rather than silently short.
    if (!target.unaccounted.includes(provider)) target.unaccounted.push(provider);
    return;
  }

  target.costUsd[key] = addMoney(target.costUsd[key], costUsd);
  const modeKey = authMode === 'subscription' ? 'subscription' : 'apiKey';
  target.costUsd[modeKey] = addMoney(target.costUsd[modeKey], costUsd);
}

function addUsage(held: UsageTotal | null, usage: UsageShape): UsageTotal {
  const base: UsageTotal = held ?? {
    source: usage.source,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    reasoningOutputTokens: null,
  };

  base.inputTokens += usage.inputTokens;
  base.outputTokens += usage.outputTokens;
  // The three optional counters are summed only when at least one contributing
  // usage reported them, so "not reported" survives instead of becoming a
  // confident zero (docs/04 §8).
  base.cacheReadInputTokens = addOptional(base.cacheReadInputTokens, usage.cacheReadInputTokens);
  base.cacheCreationInputTokens = addOptional(
    base.cacheCreationInputTokens,
    usage.cacheCreationInputTokens,
  );
  base.reasoningOutputTokens = addOptional(base.reasoningOutputTokens, usage.reasoningOutputTokens);
  return base;
}

const addOptional = (held: number | null, next: number | undefined): number | null =>
  next === undefined ? held : (held ?? 0) + next;

/** Six decimal places, so a replay produces the same bytes. */
const addMoney = (held: number | null, next: number): number =>
  Math.round(((held ?? 0) + next) * 1_000_000) / 1_000_000;
