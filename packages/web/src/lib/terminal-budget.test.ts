/**
 * KAR-17.5 test plan row 1 — the scrollback ceiling is arithmetic, not
 * preference.
 *
 * Verifies: EPIC-17-S20 (notes), EPIC-17-S22 · AC3
 *
 * The row's red is *"someone raises scrollback 'just for debugging'"*, and that
 * change has no symptom anybody would connect to it: the tab gets slower, then
 * one terminal stops painting, and there is no error. So the ceiling is
 * asserted as a **number of bytes** rather than as a configuration value — the
 * assertion has to fail on the consequence, not on the constant, or raising the
 * constant and the assertion together would look like a legitimate edit.
 *
 * The 12 bytes per cell is read out of the v6 source and not out of a blog:
 * `src/common/buffer/BufferLine.ts` line 68 is
 * `this._data = new Uint32Array(cols * CELL_SIZE)` with `const CELL_SIZE = 3`
 * on line 22. Re-verified against the real `@xterm/xterm@6.0.0` tarball on
 * 2026-08-11, because A3-8 records that the v6 changelog was previously read
 * through a summarizer that got its release date wrong.
 *
 * Nothing here imports `@xterm/xterm`: this is arithmetic, and a spec that
 * pulled a terminal in to do sums would be the slowest way to multiply.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  BYTES_PER_CELL,
  SCROLLBACK_CEILING_BYTES,
  TERMINAL_BUDGET_COLUMNS,
  TERMINAL_SCROLLBACK,
  terminalBufferBytes,
} from './terminal-budget.ts';

suite('KAR-17.5 row 1 — 12 bytes a cell, and what that buys', () => {
  it('multiplies columns by lines by the cell size, and nothing else', () => {
    expect(BYTES_PER_CELL).toBe(12);
    expect(terminalBufferBytes(200, 5_000)).toBe(200 * 5_000 * 12);
    expect(terminalBufferBytes(80, 1_000)).toBe(80 * 1_000 * 12);
    // A terminal with no columns holds no bytes, which is the degenerate case a
    // formula written the other way round (per-line overhead plus cells) gets
    // wrong and nobody notices.
    expect(terminalBufferBytes(0, 5_000)).toBe(0);
  });

  it('holds the configured scrollback at 5,000 and the reference width at 200', () => {
    expect(TERMINAL_SCROLLBACK).toBe(5_000);
    expect(TERMINAL_BUDGET_COLUMNS).toBe(200);
  });

  it('costs about 13 MB per terminal at the configured cap, and says so in bytes', () => {
    expect(SCROLLBACK_CEILING_BYTES).toBe(
      terminalBufferBytes(TERMINAL_BUDGET_COLUMNS, TERMINAL_SCROLLBACK),
    );

    const mb = SCROLLBACK_CEILING_BYTES / (1024 * 1024);
    expect(mb).toBeGreaterThan(11);
    expect(mb).toBeLessThan(12.5);
  });

  it('fails the moment the cap is raised, which is the whole point of the row', () => {
    // 10,000 lines is ≈ 26 MB and 100,000 is ≈ 260 MB — **per terminal**, with
    // several open. This is the assertion that has to break when somebody
    // raises the number for one debugging session and forgets.
    expect(SCROLLBACK_CEILING_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(terminalBufferBytes(TERMINAL_BUDGET_COLUMNS, 100_000)).toBeGreaterThan(
      200 * 1024 * 1024,
    );
  });
});
