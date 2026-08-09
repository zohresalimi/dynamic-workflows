/**
 * KAR-11.6 — where a rate-limited node goes next, and whether it goes anywhere
 * at all (docs/06-planning-and-replanning.md §4.4).
 *
 * 06 §4.4 is emphatic that *"the scheduler does not silently swap providers"*:
 * the swap is proposed as a `replace-provider` patch and ruled on by the same
 * policy engine as everything else, so it appears in the plan-evolution
 * scrubber. This module is the half of that sentence the policy engine cannot
 * answer for itself — *which* adapter, and *is it equivalent* — and every
 * answer comes from a probed `provider_capabilities` row.
 *
 * Three decisions, each a bug if reversed.
 *
 * 1. **A question the handshake cannot answer is not asked.** Four of the
 *    domain's requirement kinds have no ACP field behind them (§7.1):
 *    `structuredOutput`, `streaming` and `mcp` are not advertised anywhere, and
 *    `minContext` is a model property. Turning them into refusals would make
 *    every agent node unroutable, since they all return a schema. Turning them
 *    into *grants* would be worse only if a field existed to check — it does
 *    not, and `capabilityQuestions` drops them for that reason rather than out
 *    of leniency.
 * 2. **No healthy provider that satisfies the node means suspend, not "move it
 *    anyway".** A reroute onto an adapter the probed row says cannot run the
 *    node spends an attempt to re-learn what the row already said, and then the
 *    node is *both* rerouted and failing. NF7's degradation is a durable
 *    `node_wake` row, and the row costs nothing while it waits.
 * 3. **An unknown reset is not a permanent disqualification.** Half the paths
 *    that reach `provider.rate_limited` carry no `resetsAt`, and the ledger
 *    keeps the last limit for ever — so "unusable until it says otherwise"
 *    would retire an adapter across every future run on the strength of one
 *    silent vendor. The honest reading is the one the blind retry already uses:
 *    wait the capped backoff and look again. `RATE_LIMIT_BACKOFF.cap` is
 *    therefore imported rather than restated, so the two waits cannot drift.
 *
 * There is no provider name in this file, and there cannot be:
 * `test/no-capability-table.test.ts` greps this directory for exactly that.
 *
 * Verifies: EPIC-11-S29, EPIC-11-S30, EPIC-11-S31 · AC3, AC4, AC5
 */
import type { AdapterRequirement, ProviderId } from '@DeFlow/core';
import { RATE_LIMIT_BACKOFF } from '@DeFlow/core';
import {
  ADAPTER_REQUIREMENT_CAPABILITIES,
  CAPABILITY_REQUIREMENTS,
  type CapabilityRequirement,
} from './admission.ts';
import {
  type CapabilityKey,
  type CapabilityRow,
  mediationUnchanged,
  missingCapabilities,
} from './capabilities.ts';
import type { ProbedRow } from './planner-capabilities.ts';

/**
 * What a node may declare it needs, in either of the two vocabularies DeFlow
 * writes it in.
 *
 * `AgentNode.provider.requires` is the plan's (`resumableSessions`), and
 * `AdmissionRequest.requires` is the spawn-time one (`session.resume`). Both
 * reach this module — the plan supplies the first, and a runner that already
 * translated supplies the second — and translating both here is what keeps a
 * caller from having to know which one it holds.
 */
export type NodeRequirement = AdapterRequirement | CapabilityRequirement;

/**
 * The capability questions `requires` reduces to, de-duplicated and in the
 * order they were asked for.
 *
 * A requirement no probed row can answer contributes nothing rather than a
 * `false`: see decision 1 in the module note. `{ minContext }` and
 * `{ permission }` are structural rather than advertised — the first is checked
 * against the packet budget at plan time (`validatePlan`), the second against
 * the ladder at admission — and neither is a handshake question.
 */
export function capabilityQuestions(
  requires: readonly NodeRequirement[],
): readonly CapabilityKey[] {
  const keys: CapabilityKey[] = [];
  for (const requirement of requires) {
    const key = questionOf(requirement);
    if (key !== null && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function questionOf(requirement: NodeRequirement): CapabilityKey | null {
  if (typeof requirement !== 'string') return null;

  const domain = ADAPTER_REQUIREMENT_CAPABILITIES[requirement];
  if (domain !== undefined) return domain === null ? null : CAPABILITY_REQUIREMENTS[domain];

  const spawnTime: CapabilityKey | undefined = (
    CAPABILITY_REQUIREMENTS as Readonly<Record<string, CapabilityKey | undefined>>
  )[requirement];
  return spawnTime ?? null;
}

export interface RerouteEquivalenceInput {
  readonly requires: readonly NodeRequirement[];
  /**
   * The row for the adapter the node is running on, or `null` when it was never
   * probed. `null` cannot support a claim that the swap changes nothing, so it
   * reads as "changed" — the patch then falls through to a human rather than
   * auto-applying on a guess.
   */
  readonly from: CapabilityRow | null;
  readonly to: CapabilityRow;
}

/** The two conditions `quota-reroute-equivalent` predicates on, and the
 * evidence for the first when it is `false`. */
export interface RerouteEquivalenceAnswer {
  readonly capabilitySuperset: boolean;
  readonly permissionUnchanged: boolean;
  /** What the target does not advertise, in the order it was asked for. Empty
   * when the target is a superset — and it is what a rejection renders, because
   * *"cannot reroute onto that adapter"* is not something an operator can act
   * on and *"it does not advertise session.fork"* is. */
  readonly missing: readonly CapabilityKey[];
}

/**
 * AC3, AC4 — whether moving a node from `from` to `to` is the same node
 * running somewhere else, or a different node.
 *
 * Both halves are computed from the rows every time. A constant would be
 * wrong within a month (06 §2.2), and wrong here does not fail loudly: it
 * routes a node onto an adapter that cannot honour it, hours into a run.
 */
export function rerouteEquivalence(input: RerouteEquivalenceInput): RerouteEquivalenceAnswer {
  const missing = missingCapabilities(capabilityQuestions(input.requires), input.to);
  return {
    capabilitySuperset: missing.length === 0,
    permissionUnchanged: input.from !== null && mediationUnchanged(input.from, input.to),
    missing,
  };
}

/** One provider's current rate-limit state, as the ledger last recorded it —
 * structurally `@DeFlow/ledger`'s `StoredRateLimit`, declared here because this
 * package depends on `@DeFlow/core` alone (docs/16-repo-layout.md R2). */
export interface ProviderLimit {
  readonly provider: string;
  /** ms epoch, or `null` when the vendor said it was limited and not when it
   * lifts. Never inferred. */
  readonly resetsAt: number | null;
  /** When the limit was observed, from the event envelope. */
  readonly at: number;
}

/**
 * Whether a provider is usable right now.
 *
 * The `null` arm is decision 3 in the module note: a limit that named no reset
 * is respected for `RATE_LIMIT_BACKOFF.cap` and then treated as lifted, because
 * the alternative is an adapter that is unusable for ever after one silent
 * refusal.
 */
export function providerIsHealthy(limit: ProviderLimit | undefined, now: number): boolean {
  if (limit === undefined) return true;
  if (limit.resetsAt !== null) return now >= limit.resetsAt;
  return now >= limit.at + RATE_LIMIT_BACKOFF.cap;
}

export interface QuotaRouteInput {
  /** The node's own `provider.requires`. */
  readonly requires: readonly NodeRequirement[];
  /** The adapter that just refused it, which is never a candidate. */
  readonly current: ProviderId | null;
  /** `AgentNode.provider.prefer`, which orders the candidates the plan named. */
  readonly prefer: readonly ProviderId[];
  /**
   * The latest probed row per provider — "what is installed now", as the
   * ledger hands it over, with `provider` left a plain string: the table holds
   * whatever was probed, including a binary this build has never registered.
   */
  readonly rows: readonly ProbedRow[];
  /** The latest rate limit per provider, across every run on this machine. */
  readonly limits: readonly ProviderLimit[];
  /** From the injected `Clock`, never `Date.now()`. */
  readonly now: number;
}

/**
 * Where the node goes: onto a named adapter, or to sleep on a durable row.
 *
 * `suspend` carries `because` rather than a code, because it is what the
 * `node.suspended` timeline entry and the doctor line both render — and *"every
 * probed adapter that can fork is rate limited"* is a sentence an operator can
 * act on in a minute.
 */
export type QuotaRoute =
  | {
      readonly action: 'reroute';
      readonly provider: ProviderId;
      readonly capabilitySuperset: boolean;
      readonly permissionUnchanged: boolean;
    }
  | { readonly action: 'suspend'; readonly because: string };

/**
 * AC3, AC5 — the choice, from the probed rows and the recorded limits.
 *
 * Candidates are ordered by the plan's `prefer` list first and by probe order
 * afterwards, and an adapter the plan never named is still a candidate: a run
 * that suspended for four hours with a capable adapter sitting installed is
 * exactly the degradation NF7 says must not happen. Only a **superset** is
 * chosen, which is what makes the `suspend` arm mean what AC5 says it means.
 *
 * A target that is a superset but changes what DeFlow can mediate is still
 * returned, with `permissionUnchanged: false`. That is deliberate: the swap is
 * proposed and the policy engine sends it to a human (AC4), rather than the
 * scheduler quietly deciding on its own that a human would have said no.
 */
export function chooseQuotaRoute(input: QuotaRouteInput): QuotaRoute {
  const limits = new Map(input.limits.map((limit) => [limit.provider, limit]));
  // A row for the adapter that just refused the node, when it was probed at
  // all. `capability()` reads the stored response, so the widened `provider`
  // the table allows makes no difference to any answer asked of it.
  const from = (input.rows.find((row) => row.provider === input.current) ??
    null) as CapabilityRow | null;

  const candidates = orderedCandidates(input);
  const healthy = candidates.filter((row) =>
    providerIsHealthy(limits.get(row.provider), input.now),
  );

  for (const row of healthy) {
    const answer = rerouteEquivalence({
      requires: input.requires,
      from,
      to: row as CapabilityRow,
    });
    if (!answer.capabilitySuperset) continue;
    return {
      action: 'reroute',
      provider: row.provider as ProviderId,
      capabilitySuperset: true,
      permissionUnchanged: answer.permissionUnchanged,
    };
  }

  return { action: 'suspend', because: suspensionReason(candidates, healthy) };
}

/** Every probed adapter but the one that just refused the node, the plan's
 * preferences first. */
function orderedCandidates(input: QuotaRouteInput): readonly ProbedRow[] {
  const others = input.rows.filter((row) => row.provider !== input.current);
  const rank = (row: ProbedRow): number => {
    const index = (input.prefer as readonly string[]).indexOf(row.provider);
    return index === -1 ? input.prefer.length : index;
  };
  return others
    .map((row, index) => ({ row, index }))
    .toSorted((left, right) => rank(left.row) - rank(right.row) || left.index - right.index)
    .map((entry) => entry.row);
}

function suspensionReason(candidates: readonly ProbedRow[], healthy: readonly ProbedRow[]): string {
  if (candidates.length === 0) return 'no other adapter has been probed on this machine';
  if (healthy.length === 0) return 'every other probed adapter is itself rate limited';
  return 'no healthy adapter advertises everything this node requires';
}
