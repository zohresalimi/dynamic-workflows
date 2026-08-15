/**
 * KAR-14.4 AC10 — the rate-limit section of `deflow doctor`.
 *
 * The command itself is EPIC-18 (KAR-18.4); this module holds the policy ahead
 * of it existing, the same split `../budget/doctor.ts` uses for the ceiling
 * section and `../tokens/doctor.ts` for the calibration one.
 *
 * The question it answers is *"why is this provider unusable right now?"*, and
 * the point of answering it here is that the operator does not have to open a
 * run to find out. A quota is a fact about a binary on this machine: the limit
 * that makes today's plan unroutable was very likely tripped by yesterday's.
 *
 * Two wordings carry the whole of the story.
 *
 * **"reset time unknown"** rather than a plausible instant. Half the paths that
 * reach `provider.rate_limited` have no `resetsAt` — an adapter that signals a
 * limit only through an exit code, or a vendor that reports the limit and not
 * the lift — and a fabricated reset is worse than an honest gap for exactly the
 * reason a fabricated compaction "after" number is: the operator schedules
 * their afternoon around it.
 *
 * **"the reset has passed"** rather than a negative countdown. The ledger keeps
 * the last limit for ever, so most readings of this section are of a limit that
 * has already lifted, and `-3h 12m from now` is a number nobody should have to
 * parse into "this is fine".
 */
import type { StoredRateLimit } from '@DeFlow/ledger';

export interface RateLimitReportInput {
  /** One row per provider, as `readLatestRateLimits` returns them. */
  readonly limits: readonly StoredRateLimit[];
  /** The instant the report is rendered at, from the `Clock` port (NF9). */
  readonly now: number;
}

/** `5h 0m`, `12m`, `0m` — coarse on purpose: this is a planning aid, and a
 * second-level figure invites a precision the vendor never promised. */
function humanise(deltaMs: number): string {
  const minutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
}

/** One provider, one claim. */
function limitLine(limit: StoredRateLimit, now: number): string {
  if (limit.resetsAt === null) {
    return `${limit.provider}: rate limited, reset time unknown`;
  }
  const at = new Date(limit.resetsAt).toISOString();
  return limit.resetsAt <= now
    ? `${limit.provider}: was rate limited until ${at} (the reset has passed)`
    : `${limit.provider}: rate limited until ${at} (${humanise(limit.resetsAt - now)} from now)`;
}

/** The section's lines, one claim each. */
export function rateLimitLines(input: RateLimitReportInput): readonly string[] {
  if (input.limits.length === 0) {
    // Said out loud rather than left blank: an empty section reads as a section
    // that failed to load, and this one is consulted precisely when something
    // is wrong.
    return ['no provider has reported a rate limit on this machine'];
  }
  return input.limits.map((limit) => limitLine(limit, input.now));
}

/** The whole section, as `deflow doctor` will print it. */
export function renderRateLimitReport(input: RateLimitReportInput): string {
  return ['provider rate limits:', ...rateLimitLines(input).map((line) => `  ${line}`)].join('\n');
}
