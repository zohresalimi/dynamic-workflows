/**
 * KAR-09.7 — what a provider claims to be able to count, which tier is allowed
 * to answer, and what the cost cell says when nothing can
 * (docs/08-context-and-memory.md §7).
 *
 * Only Claude Code and Codex were ever verified to report machine-readable
 * usage. Whether Copilot, Gemini/Antigravity, Cursor and OpenCode do at all is
 * **Unverified** (roadmap A4-3), and whether ACP surfaces usage at all is
 * **Unverified** and rated High (A0-3). Making that a *manifest field* rather
 * than a code branch per vendor is what keeps the degradation data-driven — a
 * provider that turns out to report nothing is one column in a probed row, not
 * a release.
 *
 * **`null` is the only honest blank.** `costUsd` is `number | null` and never
 * `0`, because a cost chart and an F4.6 budget ceiling both act on the number:
 * a zero says "this node was free", which is a claim, and it is false. §7 says
 * it in one line — *a blank cost cell, not a zero*.
 *
 * **Tier 3 is a policy, not a call-site convention.** Anthropic's exact
 * `POST /v1/messages/count_tokens` needs a credential, and under AR-1 there is
 * no code path in DeFlowd that reads a token file or sets an auth env var to
 * make one appear. So the selection lives here, where "the operator supplied
 * their own key **and** a direct-API counter is wired" is a single expression
 * that a test can exhaust, rather than a condition each caller re-derives.
 *
 * **Note, 2026-08-06:** F3.3 (the direct-API adapter) moved to M2, so at M1
 * nothing constructs an exact counter and `'exact-api'` is unreachable in a
 * shipped configuration. The branch is built and unit-tested because it is what
 * makes the three-tier design honest; its *positive* path stays unverified
 * against a real endpoint until the M2 adapter lands.
 *
 * Verifies: EPIC-09-S40, EPIC-09-S41 · KAR-09.7 AC8, AC9
 */
import { z } from 'zod';
import type { TokenCount } from './context-packet.ts';
import type { ProviderAuthMode } from './event-payloads.ts';
import type { TokenUsage } from './token-usage.ts';

/**
 * What a probed capability manifest says about this provider's counting.
 *
 * `'estimated'` is not a weaker `'exact'` — it means the provider reports
 * nothing machine-readable and DeFlow's own Tier-2 count is the only figure
 * there is. `'none'` means even that is not meaningful for this provider, and
 * the UI blanks rather than charts it.
 */
export const TOKEN_ACCOUNTING_MODES = ['exact', 'estimated', 'none'] as const;

export type TokenAccounting = (typeof TOKEN_ACCOUNTING_MODES)[number];

export const TokenAccountingSchema: z.ZodType<TokenAccounting> = z.enum(TOKEN_ACCOUNTING_MODES);

/** Which tier produced, or is allowed to produce, a figure. */
export const TOKEN_TIERS = ['vendor-reported', 'estimated', 'exact-api'] as const;

export type TokenTier = (typeof TOKEN_TIERS)[number];

export interface TokenTierInput {
  /** `'pre-flight'` is budgeting a packet nobody has sent yet; `'post-hoc'` is
   * reading what the vendor billed. The vendor cannot answer the first and
   * DeFlow should never guess at the second. */
  readonly phase: 'pre-flight' | 'post-hoc';
  readonly accounting: TokenAccounting;
  /** From KAR-08.8: `'api_key'` only ever appears because a plan explicitly
   * selected it. DeFlow never invents it. */
  readonly authMode: ProviderAuthMode;
  /** Whether an exact counter is actually wired behind a direct-API adapter.
   * `false` for every configuration that ships at M1. */
  readonly exactCounter: boolean;
}

/**
 * The one place the three tiers are chosen between (AC8).
 *
 * The subscription arm is deliberately unconditional: an exact counter wired
 * into a subscription-path run is still refused, because AR-1 is about *whose
 * credential pays*, not about whether a counter object exists.
 */
export function selectTokenTier(input: TokenTierInput): TokenTier {
  if (input.phase === 'post-hoc') {
    return input.accounting === 'exact' ? 'vendor-reported' : 'estimated';
  }
  if (input.authMode === 'api_key' && input.exactCounter) return 'exact-api';
  return 'estimated';
}

export interface NodeCostInput {
  readonly accounting: TokenAccounting;
  /** What the vendor's own envelope said, when it said anything. */
  readonly reported: { readonly costUsd: number; readonly usage: TokenUsage } | null;
  /** DeFlow's own Tier-2 count of the same node. Always available — it is
   * arithmetic over text DeFlow rendered itself. */
  readonly estimate: TokenCount;
}

/**
 * What the projected payload shows for one node.
 *
 * `costUsd: number | null` is the type the whole story turns on. There is no
 * `0` arm and no `unknown` sentinel, so a consumer that wants to render a
 * number has to deal with the blank.
 */
export interface ProjectedNodeCost {
  readonly costUsd: number | null;
  readonly tokens: TokenCount;
}

export function projectNodeCost(input: NodeCostInput): ProjectedNodeCost {
  // The manifest wins over the envelope. A provider whose probed row says it
  // reports nothing, but whose output happened to carry a usage-shaped object,
  // is a provider whose numbers nobody has verified — believing them here is
  // how a zero becomes a cost.
  if (input.accounting !== 'exact' || input.reported === null) {
    return { costUsd: null, tokens: input.estimate };
  }
  return {
    costUsd: input.reported.costUsd,
    tokens: {
      estimated: input.reported.usage.inputTokens + input.reported.usage.outputTokens,
      method: 'vendor-reported',
    },
  };
}
