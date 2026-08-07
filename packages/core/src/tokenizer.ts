/**
 * KAR-09.7 — the `Tokenizer` port (docs/08-context-and-memory.md §7, Tier 2).
 *
 * Declared here and implemented in @DeFlow/daemon, in the same style as `Clock`
 * and `Db`, for the reason repo-layout R1 exists: `@DeFlow/core` depends on
 * nothing capable of I/O and on nothing beyond `zod`, which is what makes NF9's
 * deterministic core structural rather than aspirational. A BPE table is two
 * megabytes of data with a resolution story; it does not belong in the package
 * every other package imports.
 *
 * **`method` is part of the port, not part of the caller's bookkeeping.** §7's
 * rule is that the tiers are never silently mixed, and the only way to keep
 * that true at the edges is for the thing that produced a figure to say what
 * produced it. An implementation that returned a bare `number` would push the
 * label onto every call site, and the first call site to forget would produce a
 * number that looks exactly like a measured one.
 *
 * Verifies: EPIC-09-S37 · KAR-09.7 AC1
 */
import type { TokenCount, TokenCountMethod } from './context-packet.ts';

export interface Tokenizer {
  /**
   * What this implementation labels its output with. Read by callers that
   * need to state the tier without counting anything — a projection deciding
   * whether a figure is comparable to another, for instance.
   */
  readonly method: TokenCountMethod;
  /** Counts `text`, labelled with `method`. Pure and synchronous: Tier 2 is
   * arithmetic over a table already in memory, and an async signature here
   * would put an await inside the packet builder's inner loop for nothing. */
  count(text: string): TokenCount;
}

/**
 * True fill percentage against the window **the vendor reported**, or `null`
 * when it reported none.
 *
 * `contextWindow` comes off `modelUsage[m]` at runtime, which is the entire
 * reason no window-size table exists anywhere in this repository: Claude Code's
 * result envelope hands the window back on every turn, and a table of
 * per-model window sizes is wrong within a month of the next model release —
 * silently, and in the direction that overfills.
 *
 * `null` rather than 0 for an unreported window, for the same reason a blank
 * cost cell is not a zero: "we do not know how full this is" and "this is
 * empty" are different claims, and only one of them is ever true here.
 */
export function contextFillPercent(
  packetTokens: number,
  contextWindow: number | null,
): number | null {
  if (contextWindow === null || contextWindow <= 0) return null;
  return (packetTokens / contextWindow) * 100;
}
