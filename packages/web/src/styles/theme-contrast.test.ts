/**
 * KAR-24.1 — contrast is a constraint, not an aspiration.
 *
 * Verifies: AC7, scenario EPIC-24-S03 — every ink-on-surface and every
 * state-on-surface pair, in both themes, meets WCAG AA, computed from the
 * stylesheet's own declarations rather than hoped for.
 *
 * theme.css's own comments already record two departures from direction A's
 * literal values (`--ink-dim`, `--ink-faint` and `--state-pending` under
 * `.dark`) because the prototype's own numbers failed 4.5:1 against
 * `--surface-control`. Those comments are a record of what this test found,
 * not a substitute for it: a comment does not re-run when a future edit
 * changes a hex value back, and nothing else in the file stops a fourth
 * literal from failing quietly. This test is what makes that regression a
 * red build instead of a design-review miss.
 */
import { expect, it, describe as suite } from 'vitest';
import themeCss from './theme.css?raw';

/**
 * The declarations inside the last top-level block whose selector list is
 * exactly `selector`.
 *
 * Copied from ../lib/state-palette.test.ts (KAR-16.1) rather than imported:
 * it is a deliberately blunt brace-matcher over the source text, not a CSS
 * parser, because the claim under test is what a human reading theme.css as
 * text would see — a computed style only tells you what one element resolved
 * to, and this is a claim about the tokens' own definitions. Twenty lines
 * duplicated with a note of their origin is cheaper than a shared test
 * helper two unrelated test files would have to agree to keep compatible.
 */
function declarationsUnder(css: string, selector: string): Record<string, string> {
  const open = css.indexOf(`${selector} {`);
  if (open === -1) return {};
  const start = css.indexOf('{', open) + 1;

  let depth = 1;
  let end = start;
  while (end < css.length && depth > 0) {
    if (css[end] === '{') depth += 1;
    if (css[end] === '}') depth -= 1;
    end += 1;
  }

  /*
   * Comments are stripped before the split, which is the one place this copy
   * has to diverge from its origin. `state-palette.test.ts` parses a block of
   * seven bare declarations; this one parses a block whose comments carry
   * both `;` and `:` — "…fails the 4.5:1 floor; #8E949E (5.93) replaces it."
   * is a real line in `theme.css`, and splitting on `;` through it strands the
   * comment's tail on the front of the *next* declaration, whose name then
   * starts with `/*` and is silently dropped. Every token that happened to
   * follow a commented one disappeared, which is how a first run of this file
   * found one ink token where there are five.
   */
  const body = css.slice(start, end - 1).replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const declarations: Record<string, string> = {};
  for (const line of body.split(';')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (!name.startsWith('--')) continue;
    declarations[name] = line.slice(colon + 1).trim();
  }
  return declarations;
}

const light = declarationsUnder(themeCss, ':root');
const dark = declarationsUnder(themeCss, '.dark');

/** Six-digit hex only: `#rrggbb`, case-insensitive. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Tokens whose value is not a 6-digit hex colour, named explicitly rather
 * than left for the hex filter to silently drop.
 *
 * `--surface-overlay` is an `rgb( / alpha)` value (a translucent scrim, not
 * an opaque surface a token is ever painted flat against) and `--shadow-panel`
 * / `--shadow-modal` are box-shadow shorthand, not colours at all. A filter
 * that just skips "whatever doesn't match `#rrggbb`" would also skip a
 * genuinely mistyped hex token and report the test green with one fewer
 * pair checked — naming the three exclusions here means anything else that
 * fails the hex match is a bug in the stylesheet, not an expected exclusion.
 */
const NON_HEX_TOKENS = new Set(['--surface-overlay', '--shadow-panel', '--shadow-modal']);

/**
 * WCAG 2.x relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
 */
function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (byte: number): number => {
    const c = byte / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.x contrast ratio (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio):
 * the lighter of the two relative luminances plus 0.05, over the darker plus
 * 0.05.
 */
function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `--surface*` tokens whose value is a hex colour, i.e. an opaque surface. */
function hexSurfaceTokens(declarations: Record<string, string>): [string, string][] {
  return Object.entries(declarations).filter(
    ([name, value]) =>
      name.startsWith('--surface') && !NON_HEX_TOKENS.has(name) && HEX_RE.test(value),
  );
}

function inkTokens(declarations: Record<string, string>): [string, string][] {
  return Object.entries(declarations).filter(([name]) => name.startsWith('--ink'));
}

function stateTokens(declarations: Record<string, string>): [string, string][] {
  return Object.entries(declarations).filter(([name]) => name.startsWith('--state-'));
}

const AA_NORMAL_TEXT = 4.5;

for (const [themeName, declarations] of [
  [':root', light],
  ['.dark', dark],
] as const) {
  suite(`EPIC-24-S03 — contrast in ${themeName}`, () => {
    const surfaces = hexSurfaceTokens(declarations);
    const inks = inkTokens(declarations);
    const states = stateTokens(declarations);

    it('parses something at all, so the pairs below are not vacuous', () => {
      // A guard whose selector or filter silently matched nothing would let
      // every loop below iterate zero times and report the whole suite
      // green — exactly the failure state-palette.test.ts's own "parses
      // something at all" guard exists to prevent, and just as easy to
      // reintroduce here with a renamed token.
      expect(inks.length).toBeGreaterThanOrEqual(5);
      expect(states.length).toBeGreaterThanOrEqual(7);
      expect(surfaces.length).toBeGreaterThanOrEqual(5);
    });

    it.each(inks)(
      'every ink token clears AA against every hex surface (%s)',
      (inkName, inkValue) => {
        for (const [surfaceName, surfaceValue] of surfaces) {
          const ratio = contrastRatio(inkValue, surfaceValue);
          expect(
            ratio >= AA_NORMAL_TEXT,
            `${inkName} on ${surfaceName} is ${ratio.toFixed(1)}:1 in ${themeName} (needs ${AA_NORMAL_TEXT})`,
          ).toBe(true);
        }
      },
    );

    // The epic's own floor for state colour is 3:1 (some state usage is
    // non-text — a node border, a Gantt bar). Every value here was chosen to
    // clear 4.5 instead, because a state chip also carries a text label
    // (../lib/state-palette.ts, STATE_LABELS) and that label has to be
    // readable on any surface it lands on. Asserting only the epic's 3:1
    // floor would let a future edit make the chip's *text* unreadable while
    // this test stayed green, since 3:1 says nothing about text at all.
    it.each(states)(
      'every state token clears AA against every hex surface (%s)',
      (stateName, stateValue) => {
        for (const [surfaceName, surfaceValue] of surfaces) {
          const ratio = contrastRatio(stateValue, surfaceValue);
          expect(
            ratio >= AA_NORMAL_TEXT,
            `${stateName} on ${surfaceName} is ${ratio.toFixed(1)}:1 in ${themeName} (needs ${AA_NORMAL_TEXT})`,
          ).toBe(true);
        }
      },
    );
  });
}
