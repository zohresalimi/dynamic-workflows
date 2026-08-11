/**
 * KAR-16.1 — no state is ever encoded by colour alone.
 *
 * Verifies: EPIC-16-S3 (scenario 1, the rendering half) · AC5
 *
 * WCAG 1.4.1, and the reason docs/12-frontend-architecture.md §9.2 states it
 * as a rule rather than a preference: *"roughly 8% of male engineers will
 * otherwise misread the graph"*. Colour + glyph + text label, every time.
 *
 * **The assertions are on the accessible name, never on the fill.** A test that
 * checked the computed colour would pass on a chip that renders a coloured
 * square and nothing else — which is precisely the failure this rule exists to
 * prevent. So the chip is located by role and name, the way an assistive
 * technology would find it, and the colour is only checked for having resolved
 * to *something* through its custom property.
 *
 * Real Chromium rather than jsdom, because two of the three signals are only
 * observable in a real one: `getComputedStyle` has to resolve `var(--state-…)`
 * against a cascade, and the glyph has to have actually laid out rather than
 * merely be present in the DOM.
 */
import { expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { DISPLAY_STATES, type DisplayState, STATE_LABELS } from '../lib/state-palette.ts';
import '../styles/theme.css';
import StateChip from './StateChip.vue';

const cases = DISPLAY_STATES.map((state) => [state, STATE_LABELS[state]] as const);

suite('EPIC-16-S3 — every chip carries a colour, a glyph and a text label (AC5)', () => {
  it.each(cases)('renders "%s" with the accessible name "%s"', async (state, label) => {
    const screen = render(StateChip, { props: { state } });

    // Located exactly as a screen reader would: by role and by name. Nothing
    // here knows what colour the chip is.
    await expect.element(screen.getByRole('img', { name: label })).toBeVisible();
  });

  it.each(cases)('shows "%s" as visible text as well, not only as a name', async (state, label) => {
    const screen = render(StateChip, { props: { state } });

    const text = screen.container.querySelector('[data-slot="label"]');
    expect(text?.textContent?.trim()).toBe(label);
    expect((text as HTMLElement).getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it.each(cases)('draws a glyph for "%s" that is hidden from assistive tech', async (state) => {
    const screen = render(StateChip, { props: { state } });

    const glyph = screen.container.querySelector('[data-slot="glyph"] svg');
    expect(glyph, 'a chip with no glyph is a chip encoded by colour and text only').not.toBeNull();
    // Laid out, not merely present — jsdom would report a zero-size <svg> as
    // rendered, which is the reason this file is in the browser project.
    expect((glyph as SVGElement).getBoundingClientRect().width).toBeGreaterThan(0);
    // Hidden, because the label beside it already says the same thing and a
    // screen reader announcing "image, Failed, Failed" is worse than either.
    expect(glyph?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('gives the seven states seven different glyphs', async () => {
    const glyphs = new Set<string>();
    for (const state of DISPLAY_STATES) {
      const screen = render(StateChip, { props: { state } });
      const glyph = screen.container.querySelector('[data-slot="glyph"] svg');
      glyphs.add(glyph?.innerHTML ?? '');
    }

    // Seven colours and one glyph would satisfy "renders a glyph" and still be
    // colour-only in every way that matters.
    expect(glyphs.size).toBe(DISPLAY_STATES.length);
  });
});

suite('EPIC-16-S3 — the colour comes from the palette, not from the component', () => {
  it.each(DISPLAY_STATES)('paints "%s" through its custom property', async (state) => {
    const screen = render(StateChip, { props: { state } });

    const chip = screen.container.querySelector('[data-state]') as HTMLElement;
    expect(chip.dataset['state']).toBe(state);

    // Resolved through the cascade, so an undefined `--state-…` shows up here
    // as an empty computed colour rather than as a chip that silently inherits.
    const colour = getComputedStyle(chip).getPropertyValue('color');
    expect(colour).not.toBe('');
    expect(colour).toMatch(/^(rgb|oklch|color)/);
  });

  it('gives the seven states seven different colours', async () => {
    const colours = new Set<string>();
    for (const state of DISPLAY_STATES) {
      const screen = render(StateChip, { props: { state } });
      const chip = screen.container.querySelector('[data-state]') as HTMLElement;
      colours.add(getComputedStyle(chip).getPropertyValue('color'));
    }

    expect(colours.size).toBe(DISPLAY_STATES.length);
  });

  it('hardcodes no colour of its own', async () => {
    const screen = render(StateChip, { props: { state: 'failed' satisfies DisplayState } });
    const chip = screen.container.querySelector('[data-state]') as HTMLElement;

    // The inline style is the variable reference and nothing else: a component
    // that resolved the colour itself would be a second definition of the
    // palette, and dark mode would then be an audit rather than seven lines.
    expect(chip.getAttribute('style')).toContain('var(--state-failed)');
    expect(chip.getAttribute('style')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
