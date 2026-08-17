/**
 * KAR-16.1 — the state palette, enumerated against the stylesheet that defines
 * it.
 *
 * Verifies: EPIC-16-S3 (scenarios 1 and 3, the stylesheet half) · AC4
 *
 * The load-bearing decision this file protects is small and easy to skip: the
 * **entire** node-state palette is CSS custom properties rather than Tailwind
 * classes (docs/12-frontend-architecture.md §9.1). Seven views — Vue Flow node
 * borders, Gantt bars, context-budget segments, gate chips, criteria rows, the
 * version rail and the memory graph — read the same seven variables, so both
 * themes work because you redefine seven values and not because somebody
 * audited nine views.
 *
 * Two claims, and they fail for different reasons:
 *
 * 1. **Every display state is declared under both `:root` and `.dark`.** Read
 *    out of the stylesheet's own text rather than out of a browser, because a
 *    computed value tells you what one element resolved to and this is a claim
 *    about the definition. The computed-value half — that the two themes
 *    actually resolve to *different* colours — is `../app/theme.test.ts`.
 * 2. **The mapping from the domain's `NodeStatus` is total.** The palette has
 *    seven display states and `@DeFlow/core` has eight statuses, so there is a
 *    map, and a map is exactly where a new domain status goes missing in
 *    silence. Enumerating `NODE_STATUSES` from core — rather than the palette's
 *    own key list, which would agree with itself forever — is what makes
 *    EPIC-16-S3's third scenario ("an eighth state cannot be introduced
 *    silently") a test rather than a hope.
 */
import { NODE_STATUSES } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import themeCss from '../styles/theme.css?raw';
import {
  DISPLAY_STATES,
  type DisplayState,
  displayStateOf,
  STATE_LABELS,
  stateVar,
} from './state-palette.ts';

/**
 * The declarations inside the last top-level block whose selector list is
 * exactly `selector`.
 *
 * Deliberately a blunt brace-matcher over the source text rather than a CSS
 * parser: the thing under test is that a human can open one file and see seven
 * names twice, and a parser that normalised `:root` and `html:root` into the
 * same rule would hide the file drifting away from that.
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
   * KAR-24.1 — comments are stripped before the split.
   *
   * The rest of this function is unchanged and so is every assertion below;
   * this line fixes a fragility in the *reader*, not a change to the claim.
   * Splitting on `;` treats a comment as part of whatever follows it, so a
   * commented declaration silently took the **next** one down with it: the
   * chunk after `--ink: #e9eaee; /*` … `*` + `/` begins with `/*`, its name
   * does not start with `--`, and the token is dropped. When theme.css's
   * token blocks held nothing but bare declarations that never came up.
   * KAR-24.1 annotates each value with the contrast ratio that chose it,
   * which is exactly the kind of comment this parser could not see, and
   * seven state tokens read as zero.
   *
   * Blanking comments is the smaller fix than forbidding them, and the
   * annotations are worth more than the fragility: a ratio recorded beside
   * the hex it justifies is how the next reader knows why direction A's own
   * literal is not the value in the file.
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

suite('EPIC-16-S3 — all seven state tokens are defined for both themes (AC4)', () => {
  it('parses something at all, so the enumeration below is not vacuous', () => {
    // A guard whose parser silently returned {} would report every assertion
    // green while protecting nothing.
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(DISPLAY_STATES.length);
    expect(Object.keys(dark).length).toBeGreaterThanOrEqual(DISPLAY_STATES.length);
  });

  it.each(DISPLAY_STATES)('defines --state-%s under :root and under .dark', (state) => {
    const name = `--state-${state}`;

    expect(light[name] ?? '').not.toBe('');
    expect(dark[name] ?? '').not.toBe('');
  });

  it('redefines the same seven names under .dark, not a different set', () => {
    const stateTokens = (declarations: Record<string, string>) =>
      Object.keys(declarations)
        .filter((name) => name.startsWith('--state-'))
        .sort();

    const expected = DISPLAY_STATES.map((state) => `--state-${state}`).sort();
    expect(stateTokens(light)).toEqual(expected);
    expect(stateTokens(dark)).toEqual(expected);
  });

  it('gives every state a human label, because colour is never the only signal', () => {
    for (const state of DISPLAY_STATES) {
      expect(STATE_LABELS[state]).not.toBe('');
    }
    expect(STATE_LABELS['awaiting-human']).toBe('Awaiting human');
  });

  it('hands every surface the variable rather than a colour', () => {
    // `stateVar` is what a Vue Flow node border, a Gantt bar and a gate chip
    // are all given. If it ever returned a literal, the two themes would stop
    // being seven redefinitions and start being an audit.
    expect(stateVar('failed')).toBe('var(--state-failed)');
    for (const state of DISPLAY_STATES) {
      expect(stateVar(state)).toBe(`var(--state-${state})`);
    }
  });
});

suite('EPIC-16-S3 — an eighth state cannot be introduced silently', () => {
  it.each(NODE_STATUSES)('maps the domain status "%s" onto a state with a token', (status) => {
    const state = displayStateOf(status);

    // Enumerated from @DeFlow/core, so adding a ninth `NodeStatus` fails here
    // rather than rendering as an unstyled chip six views later.
    expect(DISPLAY_STATES).toContain(state);
    expect(light[`--state-${state}`] ?? '').not.toBe('');
    expect(dark[`--state-${state}`] ?? '').not.toBe('');
  });

  it('covers every display state from some domain status, so none is dead', () => {
    const reached = new Set<DisplayState>(NODE_STATUSES.map(displayStateOf));

    // 'awaiting-human' and 'blocked' are the two that are easy to define and
    // never reach: a palette entry nothing can produce is a colour nobody has
    // ever seen and therefore has never checked the contrast of.
    expect([...reached].sort()).toEqual([...DISPLAY_STATES].sort());
  });
});
