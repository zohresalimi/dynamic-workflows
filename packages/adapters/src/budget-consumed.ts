/**
 * KAR-14.1 — one node attempt's spend, as the `budget.consumed` payload both
 * execution paths write.
 *
 * One function, shared by the ACP path and the exec-shim path, because the two
 * would otherwise answer the same question differently and the difference
 * would be invisible: an operator reading a cost chart cannot tell which
 * adapter produced a figure, so a discrepancy between them shows up as money
 * that does not add up rather than as a bug.
 *
 * **The manifest wins over the envelope.** A provider whose probed row says
 * `tokenAccounting: 'none'` may still emit something usage-shaped — the fake
 * agents do, and a vendor mid-release might — and believing it is how a
 * number nobody has verified becomes a cost. `@DeFlow/core`'s
 * `projectNodeCost` states the same rule for the projection; this is its
 * counterpart at the point of record.
 *
 * **`null`, never `0`.** An unpriceable turn contributes a blank cost cell and
 * puts its provider into the rollup's `unaccounted` list
 * (docs/08-context-and-memory.md §7). A zero would say the turn was free,
 * which is false, and would make an F4.6 cost ceiling silently unenforceable.
 *
 * Verifies: EPIC-14-S1, EPIC-14-S3 · KAR-14.1 AC1, AC4
 */
import type {
  NodeId,
  ProviderAuthMode,
  ProviderId,
  TokenAccounting,
  TokenUsage,
} from '@DeFlow/core';

/** What one finished attempt is known to have spent, before it is judged. */
export interface SpendInput {
  readonly node: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly provider: ProviderId;
  /** What the vendor's own probed row says it can count. */
  readonly accounting: TokenAccounting;
  /**
   * KAR-08.8's effective auth mode. Defaulting is the caller's job and the
   * default is `'subscription'`, because `'api_key'` is only ever reached by
   * an explicit opt-in — DeFlow never invents it.
   */
  readonly authMode: ProviderAuthMode;
  /** What the vendor reported, or `null` when its envelope carried nothing. */
  readonly reported: { readonly usage: TokenUsage; readonly costUsd: number | null } | null;
  /**
   * DeFlow's own Tier-2 count of the same turn, labelled `'estimated'`.
   *
   * Always available — it is arithmetic over text DeFlow rendered itself — and
   * it is what a turn nobody can price reports instead of a cost. A blank cost
   * cell is not a blank row: zero tokens would claim the turn read and wrote
   * nothing, which is false for any turn that ran at all, and it would make
   * KAR-14.2's ceiling and KAR-14.3's calibration factor both blind on every
   * provider whose fidelity is unverified (roadmap A4-3).
   *
   * `@DeFlow/core`'s `projectNodeCost` makes the same fallback for the
   * projection; this is its counterpart at the point of record.
   */
  readonly estimate: TokenUsage;
}

/** `budget.consumed`'s payload at v2. Structural, so @DeFlow/core stays the schema's home. */
export interface BudgetConsumedPayload {
  readonly node: NodeId;
  readonly attempt: number;
  readonly provider: ProviderId;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly authMode: ProviderAuthMode;
}

/**
 * The accounting record for one finished attempt — completed **or failed**.
 *
 * A failed attempt is included on purpose (AC5): the money is gone whether or
 * not the attempt produced value, and a repair loop capped at three attempts
 * can spend three times what a rollup that counted only the winner reports —
 * which is exactly the figure an F4.6 ceiling has to be evaluated against.
 */
export function budgetConsumed(input: SpendInput): BudgetConsumedPayload {
  const attribution = {
    node: input.node,
    attempt: input.attempt,
    provider: input.provider,
    authMode: input.authMode,
  };

  // The manifest decides which tier answers, and it answers for the tokens as
  // well as for the money: a count from a vendor nobody has measured is
  // exactly as unverified as the price beside it, so both are replaced by
  // DeFlow's own figure rather than one of them being kept. This is the same
  // branch `@DeFlow/core`'s `projectNodeCost` takes, spelled once per side.
  if (input.accounting !== 'exact' || input.reported === null) {
    return { ...attribution, usage: input.estimate, costUsd: null };
  }
  return { ...attribution, usage: input.reported.usage, costUsd: input.reported.costUsd };
}
