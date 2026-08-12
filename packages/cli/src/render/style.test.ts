/**
 * KAR-18.9 AC7, AC9, AC10 — the three decisions a stream forces on a renderer,
 * each made once and none of them re-derived at a call site.
 *
 * **Colour** is a property of the *stream*, not of a line: a pipe, `NO_COLOR`,
 * a dumb `TERM` and `--json` each strip it, and the standard way to get this
 * wrong is to let a colour library do its own detection at import time — at
 * which point `--json` still emits escapes because the library never heard of
 * it. So the decision is a pure function of an injected environment and the
 * parsed flags, and the table below is EPIC-18-S59 verbatim.
 *
 * **Width** and **charset** are the same failure twice: a value assumed to be
 * present. `stdout.columns` is `undefined` under a pipe and on several CI
 * runners, and `undefined` in an arithmetic is `NaN`, which a naive wrapper
 * turns into one character per line. A UTF-8 glyph on a Latin-1 terminal turns
 * the status column into replacement characters, which is AC2's failure
 * arriving through the locale instead of through colour.
 *
 * Verifies: EPIC-18-S59, EPIC-18-S64 · AC7, AC9, AC10 · test plan #1, #8, #9
 */
import { expect, it, describe as suite } from 'vitest';
import { ASCII_GLYPHS, UTF8_GLYPHS } from './glyphs.ts';
import {
  createStyle,
  DEFAULT_WIDTH,
  glyphCharset,
  MAX_WIDTH,
  shouldStyle,
  terminalWidth,
} from './style.ts';

/** The ESC that must never reach a pipe. */
const ESC = '\u001B';

suite('EPIC-18-S59 — one styling decision, made once per process (AC7)', () => {
  const rows = [
    { tty: true, env: {}, flags: {}, styling: true },
    { tty: false, env: {}, flags: {}, styling: false },
    { tty: true, env: { NO_COLOR: '' }, flags: {}, styling: false },
    { tty: true, env: { NO_COLOR: '1' }, flags: {}, styling: false },
    { tty: true, env: { TERM: 'dumb' }, flags: {}, styling: false },
    { tty: true, env: {}, flags: { json: true }, styling: false },
    { tty: true, env: {}, flags: { noColor: true }, styling: false },
    { tty: false, env: { FORCE_COLOR: '1' }, flags: {}, styling: true },
    { tty: false, env: { FORCE_COLOR: '1' }, flags: { json: true }, styling: false },
    { tty: false, env: { NO_COLOR: '1', FORCE_COLOR: '1' }, flags: {}, styling: false },
  ] as const;

  for (const row of rows) {
    const label =
      `tty=${row.tty} env=${JSON.stringify(row.env)} ` +
      `flags=${JSON.stringify(row.flags)} -> ${row.styling ? 'enabled' : 'disabled'}`;
    it(label, () => {
      expect(
        shouldStyle({ isTty: row.tty, env: { TERM: 'xterm', ...row.env }, ...row.flags }),
      ).toBe(row.styling);
    });
  }

  it('reads NO_COLOR by presence, never by truthiness', () => {
    // The empty string is the case a `if (env.NO_COLOR)` gets wrong, and it is
    // the one the convention singles out.
    expect(shouldStyle({ isTty: true, env: { NO_COLOR: '' } })).toBe(false);
    expect(shouldStyle({ isTty: true, env: { NO_COLOR: '0' } })).toBe(false);
    expect(shouldStyle({ isTty: true, env: {} })).toBe(true);
  });

  it('paints nothing at all when the decision was "disabled"', () => {
    const style = createStyle({ isTty: false, env: {} });
    expect(style.colour).toBe(false);
    expect(style.paint('agents', 'green')).toBe('agents');
    expect(style.paint('agents', 'green')).not.toContain(ESC);
  });

  it('paints, and resets, when the decision was "enabled"', () => {
    const style = createStyle({ isTty: true, env: { TERM: 'xterm' } });
    expect(style.colour).toBe(true);
    const painted = style.paint('agents', 'green');
    expect(painted).toContain(ESC);
    expect(painted).toContain('agents');
    expect(painted.endsWith(`${ESC}[0m`)).toBe(true);
  });
});

suite('EPIC-18-S64 — a width that cannot be determined (AC9)', () => {
  it('falls back to 80 when stdout reports no column count and COLUMNS is unset', () => {
    expect(terminalWidth(undefined, {})).toBe(DEFAULT_WIDTH);
    expect(DEFAULT_WIDTH).toBe(80);
  });

  it('never produces NaN, zero or a negative width', () => {
    for (const columns of [undefined, Number.NaN, 0, -1, -80]) {
      const width = terminalWidth(columns, {});
      expect(Number.isFinite(width)).toBe(true);
      expect(width).toBeGreaterThan(0);
    }
  });

  it('caps a very wide terminal at 100 columns (AC4)', () => {
    expect(terminalWidth(240, {})).toBe(MAX_WIDTH);
    expect(MAX_WIDTH).toBe(100);
    expect(terminalWidth(60, {})).toBe(60);
  });

  it('takes COLUMNS when stdout has no opinion, and stdout when it has one', () => {
    expect(terminalWidth(undefined, { COLUMNS: '72' })).toBe(72);
    expect(terminalWidth(64, { COLUMNS: '72' })).toBe(64);
    expect(terminalWidth(undefined, { COLUMNS: 'not-a-number' })).toBe(DEFAULT_WIDTH);
  });
});

suite('EPIC-18-S64 — a terminal that is not UTF-8 (AC10)', () => {
  it('degrades to the ASCII glyph set under LC_ALL=C and LANG=C', () => {
    expect(glyphCharset({ LC_ALL: 'C', LANG: 'C' })).toBe('ascii');
    expect(createStyle({ isTty: true, env: { LC_ALL: 'C', LANG: 'C' } }).glyphs).toEqual(
      ASCII_GLYPHS,
    );
  });

  it('uses the UTF-8 glyph set when the locale establishes it', () => {
    for (const env of [
      { LANG: 'en_US.UTF-8' },
      { LC_ALL: 'C.UTF-8' },
      { LC_CTYPE: 'en_GB.utf8' },
    ]) {
      expect(glyphCharset(env)).toBe('utf8');
      expect(createStyle({ isTty: false, env }).glyphs).toEqual(UTF8_GLYPHS);
    }
  });

  it('does not degrade when no locale variable says anything', () => {
    // AC10's trigger is a variable *naming a non-UTF-8 charset*, and an unset
    // locale names nothing. Reading silence as Latin-1 would put the ASCII set
    // on the overwhelming majority of terminals — and on every CI runner,
    // which is where the output gets snapshotted.
    expect(glyphCharset({})).toBe('utf8');
    expect(glyphCharset({ LANG: '' })).toBe('utf8');
  });

  it('degrades on a locale that names a non-UTF-8 charset', () => {
    for (const env of [{ LANG: 'C' }, { LC_ALL: 'POSIX' }, { LC_CTYPE: 'en_US.ISO8859-1' }]) {
      expect(glyphCharset(env)).toBe('ascii');
    }
    // POSIX precedence: LC_ALL wins over LC_CTYPE, which wins over LANG.
    expect(glyphCharset({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe('ascii');
    expect(glyphCharset({ LC_CTYPE: 'C', LANG: 'en_US.UTF-8' })).toBe('ascii');
  });

  it('keeps both glyph sets pairwise distinct and free of replacement characters', () => {
    for (const set of [UTF8_GLYPHS, ASCII_GLYPHS]) {
      const glyphs = Object.values(set);
      expect(new Set(glyphs).size).toBe(glyphs.length);
      for (const glyph of glyphs) {
        expect(glyph).not.toContain('�');
        expect(glyph.trim()).not.toBe('');
      }
    }
    // The ASCII set is ASCII, which is the whole of AC10.
    for (const glyph of Object.values(ASCII_GLYPHS)) {
      expect(/^[ -~]+$/.test(glyph)).toBe(true);
    }
  });
});
