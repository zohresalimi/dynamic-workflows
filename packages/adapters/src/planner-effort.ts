/**
 * KAR-11.1 AC8 — the reasoning-effort control, where a vendor exposes one.
 *
 * 06 §6: *"'Strongest available' resolves against the probed capability rows,
 * not a constant. Where the adapter exposes a reasoning-effort control, use it:
 * Claude Code accepts `--effort low|medium|high|xhigh|max`."* **Verified
 * 2026-08-02** from the 2.1.220 flag table (docs/07 §8.1).
 *
 * The split between what is probed and what is registered is the same one
 * `structured-output.ts` makes, and for the same reason. **Whether** an adapter
 * can resume is in its `initialize` response; **which flag it takes an effort
 * on** is not in any adapter's response, and cannot be — no ACP field describes
 * one. So the row decides *which vendor is installed at which version*, and the
 * registry answers *what that vendor accepts*. Neither half is a capability
 * table: nothing here says what an agent can do.
 *
 * **A vendor with no ladder answers `null`, and that is a value.** The
 * alternative — picking the nearest-looking flag, or assuming every CLI honours
 * `--effort` — is a spawn that dies on an unknown option, four minutes into the
 * single highest-leverage inference in the system.
 *
 * This file names no vendor: the ladder is read from `provider-registry.ts`,
 * which `test/no-capability-table.test.ts` exempts from the vendor-name rule
 * precisely because invocation knowledge has to live somewhere.
 *
 * Verifies: EPIC-11-S1 (third scenario) · AC8
 */
import { providerSpec } from './provider-registry.ts';

/**
 * The effort ladder, weakest to strongest.
 *
 * Ordered, and the order is the contract: `strongestEffort` takes the last
 * member, so adding a stronger setting to a vendor's ladder is one edit at the
 * registry entry rather than a second constant that has to be kept in step.
 */
export const PLANNER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type PlannerEffort = (typeof PLANNER_EFFORTS)[number];

/** The flag and the value to put after it. */
export interface ResolvedEffort {
  readonly flag: string;
  readonly effort: string;
}

/**
 * The strongest reasoning effort `provider` exposes, or `null` where it exposes
 * none — including for a provider nobody has registered, which is the
 * conservative answer for the same reason `providerStructuredOutput` calls an
 * unknown vendor prompt-only.
 */
export function strongestEffort(provider: string): ResolvedEffort | null {
  const shim = providerSpec(provider)?.shim;
  const flag = shim?.effortFlag;
  const ladder = shim?.efforts ?? [];
  const strongest = ladder.at(-1);
  if (flag === undefined || strongest === undefined) return null;
  return { flag, effort: strongest };
}
