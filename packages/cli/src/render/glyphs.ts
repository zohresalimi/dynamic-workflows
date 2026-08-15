/**
 * KAR-18.9 AC2, AC10 — the glyph vocabulary, in one place and in two charsets.
 *
 * Two rules, and both of them are the same rule seen from different ends.
 *
 * **A glyph is never the only carrier.** `docs/12-frontend-architecture.md`
 * §9.2 — *"colour + glyph + text label, every time"* — is WCAG 1.4.1 written
 * for the UI, and a terminal is the easier place to get it wrong: colour
 * disappears under a pipe, under `NO_COLOR` and on a dumb terminal, so any
 * meaning carried by colour alone is meaning that is routinely absent. Every
 * glyph below therefore travels with `STATE_LABELS`, and the two are asserted
 * pairwise distinct.
 *
 * **A glyph a terminal cannot encode is worse than no glyph.** `✓` on a
 * Latin-1 terminal is a replacement character, which is AC2's failure arriving
 * through the locale instead of through colour — so there is an ASCII set, it
 * is pairwise distinct on its own, and `style.ts` picks between them from the
 * locale rather than from a hope.
 *
 * The transcript set is here for the same reason the status set is: `DeFlow
 * run`'s per-event glyphs are the other place a non-ASCII literal was spelled
 * by hand, and `test/render-guard.test.ts` scans for both.
 */

/** The four states, in severity order — the order a summary counts them in. */
export const REPORT_STATES = ['ok', 'warn', 'fail', 'skipped'] as const;

export type ReportState = (typeof REPORT_STATES)[number];

export type Charset = 'utf8' | 'ascii';

/** Never abbreviated: the label is what survives when the glyph cannot. */
export const STATE_LABELS: Readonly<Record<ReportState, string>> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  skipped: 'skipped',
};

export const UTF8_GLYPHS: Readonly<Record<ReportState, string>> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  skipped: '–',
};

/**
 * The degraded set. `+`, `!`, `x` and `-` rather than `[ok]`-style words,
 * because the label already carries the word and a two-column glyph would put
 * every status out of alignment with the UTF-8 rendering of the same report.
 */
export const ASCII_GLYPHS: Readonly<Record<ReportState, string>> = {
  ok: '+',
  warn: '!',
  fail: 'x',
  skipped: '-',
};

export const GLYPH_SETS: Readonly<Record<Charset, Readonly<Record<ReportState, string>>>> = {
  utf8: UTF8_GLYPHS,
  ascii: ASCII_GLYPHS,
};

/**
 * What separates the parts of a one-line detail (`claude · worktree · …`).
 *
 * Here rather than inline for the same reason the glyphs are: a middle dot is
 * a non-ASCII literal, and on a C-locale terminal it is a replacement
 * character in the middle of the one line an operator is reading.
 */
export const PART_SEPARATORS: Readonly<Record<Charset, string>> = {
  utf8: ' · ',
  ascii: ' | ',
};

/** What `deflow run`'s transcript marks each event kind with. */
export type TranscriptGlyph = 'note' | 'pending' | 'active' | 'asking' | 'paused' | 'done' | 'gone';

export const TRANSCRIPT_GLYPHS: Readonly<
  Record<Charset, Readonly<Record<TranscriptGlyph, string>>>
> = {
  utf8: {
    note: '·',
    pending: '◦',
    active: '▸',
    asking: '?',
    paused: '‖',
    done: UTF8_GLYPHS.ok,
    gone: UTF8_GLYPHS.fail,
  },
  ascii: {
    note: '.',
    pending: 'o',
    active: '>',
    asking: '?',
    paused: '=',
    done: ASCII_GLYPHS.ok,
    gone: ASCII_GLYPHS.fail,
  },
};
