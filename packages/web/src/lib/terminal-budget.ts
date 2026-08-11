/**
 * KAR-17.5 — the scrollback ceiling, as arithmetic.
 *
 * Verifies: EPIC-17-S20 (notes), EPIC-17-S22 · AC3
 *
 * This file deliberately imports nothing. It is the terminal's memory budget
 * expressed as numbers, so `./terminal-session.ts` can configure a `Terminal`
 * from it and `./terminal-budget.test.ts` can assert the consequence without
 * loading a terminal to do sums.
 *
 * **12 bytes per cell, read out of the v6 source.** `@xterm/xterm@6.0.0`,
 * `src/common/buffer/BufferLine.ts`:
 *
 * ```ts
 * const CELL_SIZE = 3;                              // line 22
 * this._data = new Uint32Array(cols * CELL_SIZE);   // line 68
 * ```
 *
 * Three `Uint32Array` slots per cell — content, fg, bg — at four bytes each.
 * Re-verified against the published 6.0.0 tarball on **2026-08-11**, and stated
 * with that date because A3-8 records that the v6 breaking-change list was
 * previously read through a summarizer that got the release date wrong; the
 * number below is the one thing in that list that could not be allowed to be
 * second-hand.
 *
 * | Columns | 5,000 lines | 10,000 lines | 100,000 lines |
 * | ------- | ----------- | ------------ | ------------- |
 * | 200     | ≈ 13 MB     | ≈ 26 MB      | ≈ 260 MB      |
 *
 * That is **per terminal**. xterm's own default is `scrollback: 1000` and its
 * `MAX_BUFFER_SIZE` is 4294967295, so nothing in the library stops a number
 * that kills the tab — which is why the rule is stated here as a value with a
 * test against its consequence rather than as advice in a comment.
 *
 * > **Set `scrollback: 5000` and never raise it.**
 * > — docs/12-frontend-architecture.md §6.6
 *
 * The archive is not the reason to raise it: the complete output is on disk at
 * `runs/<runId>/nodes/<nodeId>/stdout.log` (NF8) and opens in a virtualised
 * viewer. The terminal is a live tail.
 */

/** `Uint32Array(cols * 3)` — three 32-bit slots per cell. */
export const BYTES_PER_CELL = 12;

/** The configured scrollback, and the number this module exists to hold down. */
export const TERMINAL_SCROLLBACK = 5_000;

/**
 * The width the ceiling is quoted at.
 *
 * 200 columns rather than 80: agent output is full-width diffs and stack
 * traces, and a budget computed at a comfortable width is a budget that is
 * wrong in the direction that hurts.
 */
export const TERMINAL_BUDGET_COLUMNS = 200;

/** What a terminal's buffer costs, before any renderer or object overhead. */
export function terminalBufferBytes(cols: number, lines: number): number {
  return cols * lines * BYTES_PER_CELL;
}

/** ≈ 13 MB: what one terminal costs at the configured cap and reference width. */
export const SCROLLBACK_CEILING_BYTES = terminalBufferBytes(
  TERMINAL_BUDGET_COLUMNS,
  TERMINAL_SCROLLBACK,
);
