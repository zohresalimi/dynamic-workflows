/**
 * KAR-21.1 AC2, AC5 / EPIC-21-S03, EPIC-21-S04 — the screen is an interface,
 * and a redraw erases what was there rather than what was expected.
 *
 * Two claims, and the second is the one that costs an afternoon if it is wrong.
 *
 * **A screen is observable without a terminal.** `createHeadlessScreen()`
 * keeps every frame it was handed and every byte it would have written, so the
 * whole of this epic's "what was on screen" can be asserted as a value. A
 * screen that could only be inspected by looking at a terminal would make every
 * later story in EPIC-21 a manual one.
 *
 * **The erase count is the number of rows the previous frame *occupied*, not
 * the number of entries it *contained*.** Those are the same number until the
 * first row is wider than the terminal, and then they are not: a wrapped row is
 * one entry and two rows, and a writer that erases `frame.length` strands a
 * line on screen for the rest of the run. The second case below is aimed
 * exactly there — it is the bug the epic's own notes name.
 *
 * The erase literal is imported rather than spelled, because
 * `../../test/render-guard.test.ts` makes `screen.ts` the one module allowed to
 * know it and a test that re-spelled it would be a second copy of the
 * vocabulary the guard exists to keep single. Every frame here is plain text,
 * so an erase sequence in a chunk can only have come from the screen.
 *
 * Verifies: EPIC-21-S03, EPIC-21-S04 · AC2, AC5 · test plan #3, #4
 */
import { expect, it, describe as suite } from 'vitest';
import { createHeadlessScreen, createScreen, ERASE_LINE } from './screen.ts';

/** A frame of `count` short lines, each distinguishable in a diff. */
const frame = (count: number, tag = 'a'): string[] =>
  Array.from({ length: count }, (_, index) => `${tag}${String(index)}`);

/** How many rows this chunk erased. */
const erasedRows = (chunk: string): number => chunk.split(ERASE_LINE).length - 1;

suite('EPIC-21-S03 — a frame that shrank leaves nothing of the old one behind', () => {
  it('erases exactly the number of lines the previous frame occupied', () => {
    const written: string[] = [];
    const screen = createScreen({ width: 80, write: (chunk) => written.push(chunk) });
    const headless = createHeadlessScreen({ width: 80 });

    for (const lines of [frame(5, 'a'), frame(7, 'b'), frame(5, 'a')]) {
      screen.render(lines);
      headless.render(lines);
    }

    // Nothing to erase before the first frame; then the 5 it drew, then the 7.
    expect(written.map(erasedRows)).toEqual([0, 5, 7]);
    expect(headless.frames).toEqual([frame(5, 'a'), frame(7, 'b'), frame(5, 'a')]);
    expect(headless.frames.at(-1)).toEqual(headless.frames[0]);
  });

  it('counts the rows a wrapped line occupied, not the entries it returned', () => {
    // Two entries; the second is three terminal rows wide on its own, so the
    // frame occupies four. A screen that erased `frame.length` would clear two
    // and strand two on screen for the rest of the run.
    const written: string[] = [];
    const screen = createScreen({ width: 20, write: (chunk) => written.push(chunk) });

    screen.render(['short', 'x'.repeat(60)]);
    screen.render(['short']);

    expect(erasedRows(written[1] ?? '')).toBe(4);
  });

  it('leaves nothing on screen when it closes, and closing twice writes nothing', () => {
    const written: string[] = [];
    const screen = createScreen({ width: 80, write: (chunk) => written.push(chunk) });

    screen.render(frame(3));
    screen.close();
    const afterClose = written.length;
    screen.close();

    expect(erasedRows(written[1] ?? '')).toBe(3);
    expect(written.length).toBe(afterClose);
  });
});

suite('EPIC-21-S04 — an unchanged frame writes no bytes at all', () => {
  it('writes nothing on a repaint that changes nothing', () => {
    const written: string[] = [];
    const screen = createScreen({ width: 80, write: (chunk) => written.push(chunk) });

    screen.render(frame(4));
    const after = written.join('');
    screen.render(frame(4));

    expect(written.join('')).toBe(after);
  });

  it('records the frame once, not twice', () => {
    const headless = createHeadlessScreen({ width: 80 });

    headless.render(frame(4));
    headless.render(frame(4));

    expect(headless.frames).toHaveLength(1);
  });

  it('an empty frame after an empty frame is also zero bytes', () => {
    // The transcript path renders `[]` before every event line, so this is the
    // hot path rather than a curiosity: a chatty run must not pay for it.
    const written: string[] = [];
    const screen = createScreen({ width: 80, write: (chunk) => written.push(chunk) });

    screen.render([]);
    screen.render([]);

    expect(written.join('')).toBe('');
  });
});

suite('EPIC-21-S40 — a resize erases the height the old frame actually took', () => {
  it('erases what the previous frame occupied at the width it was drawn at', () => {
    // The subtle failure the flow file names. A 60-character line is three rows
    // at 20 columns and six at 10, so a screen that recomputed the *previous*
    // frame's height at the *new* width would erase six rows where four were
    // drawn — debris on screen exactly once per resize, and a bug that gets
    // blamed on the terminal.
    const written: string[] = [];
    const screen = createScreen({ width: 20, write: (chunk) => written.push(chunk) });

    screen.render(['short', 'x'.repeat(60)]);
    screen.resize(10);
    screen.render(['short']);

    expect(erasedRows(written[1] ?? '')).toBe(4);
  });

  it('uses the new width for everything drawn after it', () => {
    const written: string[] = [];
    const screen = createScreen({ width: 20, write: (chunk) => written.push(chunk) });

    screen.resize(10);
    // Six rows at ten columns, where the same line was three at twenty.
    screen.render(['x'.repeat(60)]);
    screen.render(['short']);

    expect(erasedRows(written[1] ?? '')).toBe(6);
  });

  it('erases nothing extra when the resize arrives before anything was drawn', () => {
    const written: string[] = [];
    const screen = createScreen({ width: 80, write: (chunk) => written.push(chunk) });

    screen.resize(40);
    screen.render(['one']);

    expect(erasedRows(written[0] ?? '')).toBe(0);
  });
});

suite('AC2 — a headless screen is a recording, not a terminal', () => {
  it('records every frame it was given, in order, and writes to no stream', () => {
    const headless = createHeadlessScreen();

    headless.render(['one']);
    headless.render(['one', 'two']);
    headless.close();

    expect(headless.frames).toEqual([['one'], ['one', 'two']]);
    // The bytes are kept so a control stream can be asserted; they were never
    // written to anything.
    expect(headless.bytes()).toContain('two');
  });
});
