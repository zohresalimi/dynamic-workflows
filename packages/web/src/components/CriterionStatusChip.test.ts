/**
 * KAR-17.7 test plan row 3 — the three-state render matrix: glyph, label and
 * colour, and `unverifiable` distinct from both `satisfied` and `unsatisfied`.
 *
 * Verifies: EPIC-17-S28 (scenario 1), EPIC-17-S29 (scenario 1) · AC2
 *
 * The component-level sibling of `./StateChip.test.ts`, built to the identical
 * rule for the identical reason (WCAG 1.4.1): the assertions are on the
 * accessible name and on the resolved custom property, never on a hardcoded
 * fill, so a chip that rendered a coloured square and nothing else would fail
 * here exactly as it would there.
 *
 * `Red when: unverifiable is styled as a muted failure.` That is EPIC-17-S29's
 * own wording, and the test for it is literal: `unverifiable`'s resolved
 * colour, glyph and label must each differ from `unsatisfied`'s.
 */
import { expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { CRITERION_STATUS_STYLE, type CriterionStatus } from '../lib/criteria-board.ts';
import '../styles/theme.css';
import CriterionStatusChip from './CriterionStatusChip.vue';

const STATUSES = Object.keys(CRITERION_STATUS_STYLE) as readonly CriterionStatus[];
const cases = STATUSES.map((status) => [status, CRITERION_STATUS_STYLE[status].label] as const);

suite('KAR-17.7 test 3 — every status carries a colour, a glyph and a text label (AC2)', () => {
  it.each(cases)('renders "%s" with the accessible name "%s"', async (status, label) => {
    const screen = render(CriterionStatusChip, { props: { status } });

    await expect.element(screen.getByRole('img', { name: label })).toBeVisible();
  });

  it.each(cases)(
    'shows "%s" as visible text as well, not only as a name',
    async (status, label) => {
      const screen = render(CriterionStatusChip, { props: { status } });

      const text = screen.container.querySelector('[data-status-label]');
      expect(text?.textContent?.trim()).toBe(label);
      expect((text as HTMLElement).getBoundingClientRect().width).toBeGreaterThan(0);
    },
  );

  it.each(cases)('draws a glyph for "%s" that is hidden from assistive tech', async (status) => {
    const screen = render(CriterionStatusChip, { props: { status } });

    const glyph = screen.container.querySelector('[data-status-glyph]');
    expect(glyph?.textContent?.trim()).not.toBe('');
    expect(glyph?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('gives the three statuses three different glyphs and three different labels', async () => {
    const glyphs = new Set<string>();
    const labels = new Set<string>();
    for (const status of STATUSES) {
      const screen = render(CriterionStatusChip, { props: { status } });
      glyphs.add(screen.container.querySelector('[data-status-glyph]')?.textContent?.trim() ?? '');
      labels.add(screen.container.querySelector('[data-status-label]')?.textContent?.trim() ?? '');
    }
    expect(glyphs.size).toBe(STATUSES.length);
    expect(labels.size).toBe(STATUSES.length);
  });
});

suite('KAR-17.7 test 3 — unverifiable is not a muted failure (AC2, EPIC-17-S29)', () => {
  it('resolves three different colours through the cascade', async () => {
    const colours = new Set<string>();
    for (const status of STATUSES) {
      const screen = render(CriterionStatusChip, { props: { status } });
      const chip = screen.container.querySelector('[data-status]') as HTMLElement;
      const colour = getComputedStyle(chip).getPropertyValue('color');
      expect(colour).not.toBe('');
      colours.add(colour);
    }
    expect(colours.size).toBe(STATUSES.length);
  });

  it("unverifiable's colour is distinct from both satisfied's and unsatisfied's", async () => {
    const colourOf = async (status: CriterionStatus): Promise<string> => {
      const screen = render(CriterionStatusChip, { props: { status } });
      const chip = screen.container.querySelector('[data-status]') as HTMLElement;
      return getComputedStyle(chip).getPropertyValue('color');
    };

    const satisfied = await colourOf('satisfied');
    const unsatisfied = await colourOf('unsatisfied');
    const unverifiable = await colourOf('unverifiable');

    expect(unverifiable).not.toBe(unsatisfied);
    expect(unverifiable).not.toBe(satisfied);
  });

  it('hardcodes no colour of its own', async () => {
    const screen = render(CriterionStatusChip, { props: { status: 'unverifiable' } });
    const chip = screen.container.querySelector('[data-status]') as HTMLElement;

    expect(chip.getAttribute('style')).toContain('var(--state-awaiting-human)');
    expect(chip.getAttribute('style')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
