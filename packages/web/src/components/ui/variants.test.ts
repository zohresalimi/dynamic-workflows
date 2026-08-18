/**
 * KAR-24.2 AC6, scenario EPIC-24-S06 — a variant is a promise about a token.
 *
 * Every `data-variant` / `tone` value this library exposes resolves, through
 * the live cascade, to the specific `--state-*` or `--surface-*` custom
 * property its row in `component-spec.md` claims. That promise is the thing
 * this file checks, not the pixel it happens to paint today: a token renamed
 * in `theme.css` — `--state-running` becoming `--state-active`, say — is a
 * change this suite catches at the source, rather than six screens later as a
 * colour that quietly stopped matching the legend.
 *
 * Mounting style follows `../StateChip.test.ts` and
 * `../CriterionStatusChip.test.ts`: `vitest-browser-vue`, `theme.css` imported
 * so custom properties actually resolve, and colours compared only after both
 * sides have been round-tripped through the browser's own serialiser — see
 * `paletteColour` below, lifted from `../../views/plan-graph.test.ts`'s helper
 * of the same name. Comparing a declared custom property's literal text
 * (`getPropertyValue`) against a computed style's normalised form
 * (`getComputedStyle(...).color`) fails for a formatting reason and teaches
 * nobody anything; this file never does that.
 */
import { expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { DISPLAY_STATES, STATE_LABELS } from '../../lib/state-palette.ts';
import '../../styles/theme.css';
import UiButton from './UiButton.vue';
import UiCard from './UiCard.vue';
import UiChip from './UiChip.vue';
import UiMeter from './UiMeter.vue';
import UiProgressSplit from './UiProgressSplit.vue';
import UiStateChip from './UiStateChip.vue';
import UiStatTile from './UiStatTile.vue';

/**
 * A custom property's resolved colour, round-tripped through a probe element
 * so it is comparable to a computed style rather than to its own source text.
 *
 * See the file header and `../../views/plan-graph.test.ts`'s identical helper
 * for why the round-trip — not the raw `getPropertyValue` string — is the
 * only fair comparison.
 */
function tokenColour(name: string): string {
  const probe = document.createElement('span');
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

/** The literal `transparent` keyword, resolved the same way a token is, so it compares fairly. */
function keywordColour(keyword: string): string {
  const probe = document.createElement('span');
  probe.style.color = keyword;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

suite('KAR-24.2 AC6 — UiButton variants resolve to the tokens they claim', () => {
  it('variant="primary" paints its background from --state-running', async () => {
    const screen = render(UiButton, { props: { variant: 'primary' } });
    const button = screen.container.querySelector('.ui-button') as HTMLElement;
    expect(getComputedStyle(button).backgroundColor).toBe(tokenColour('--state-running'));
  });

  it('variant="danger" paints its text colour from --state-failed', async () => {
    const screen = render(UiButton, { props: { variant: 'danger' } });
    const button = screen.container.querySelector('.ui-button') as HTMLElement;
    expect(getComputedStyle(button).color).toBe(tokenColour('--state-failed'));
  });

  it('variant="ghost" has a transparent background — no state token borrowed', async () => {
    const screen = render(UiButton, { props: { variant: 'ghost' } });
    const button = screen.container.querySelector('.ui-button') as HTMLElement;
    expect(getComputedStyle(button).backgroundColor).toBe(keywordColour('transparent'));
  });
});

suite('KAR-24.2 AC6 — UiCard variants resolve to the tokens they claim', () => {
  it('variant="inset" paints its background from --surface-inset', async () => {
    const screen = render(UiCard, { props: { variant: 'inset' } });
    const card = screen.container.querySelector('.ui-card') as HTMLElement;
    expect(getComputedStyle(card).backgroundColor).toBe(tokenColour('--surface-inset'));
  });

  it('variant="raised" paints its background from --surface', async () => {
    const screen = render(UiCard, { props: { variant: 'raised' } });
    const card = screen.container.querySelector('.ui-card') as HTMLElement;
    expect(getComputedStyle(card).backgroundColor).toBe(tokenColour('--surface'));
  });
});

suite('KAR-24.2 AC6 — UiChip variants resolve to the tokens they claim', () => {
  it('variant="ok" paints its text colour from --state-passed', async () => {
    const screen = render(UiChip, { props: { variant: 'ok' } });
    const chip = screen.container.querySelector('.ui-chip') as HTMLElement;
    expect(getComputedStyle(chip).color).toBe(tokenColour('--state-passed'));
  });

  it('variant="warn" paints its text colour from --state-blocked', async () => {
    const screen = render(UiChip, { props: { variant: 'warn' } });
    const chip = screen.container.querySelector('.ui-chip') as HTMLElement;
    expect(getComputedStyle(chip).color).toBe(tokenColour('--state-blocked'));
  });

  it('variant="error" paints its text colour from --state-failed', async () => {
    const screen = render(UiChip, { props: { variant: 'error' } });
    const chip = screen.container.querySelector('.ui-chip') as HTMLElement;
    expect(getComputedStyle(chip).color).toBe(tokenColour('--state-failed'));
  });
});

suite('KAR-24.2 AC6 — UiStatTile tone resolves to the token it claims', () => {
  it('tone="accent" paints the value from --state-running', async () => {
    const screen = render(UiStatTile, {
      props: { label: 'Running', value: 3, tone: 'accent' },
    });
    const value = screen.container.querySelector('.ui-stat-tile__value') as HTMLElement;
    expect(getComputedStyle(value).color).toBe(tokenColour('--state-running'));
  });
});

suite('KAR-24.2 AC6 — UiMeter fill resolves to the token it claims', () => {
  // FINDING (see this story's task notes): component-spec.md and this
  // story's own assertion table both say the *default* fill is
  // `--state-running`. `UiMeter.vue`'s `.ui-meter[data-tone='default']` rule
  // overrides that with `--ink-muted` whenever `tone` is left unset — which
  // it is by default — so a caller who never sets `tone` gets a muted grey
  // bar rather than the running-state colour the table promises. This
  // assertion states the token the table claims and is left red on purpose:
  // fixing `UiMeter.vue` belongs to whichever agent owns that file, not this
  // one.
  it('the default fill paints from --state-running', async () => {
    const screen = render(UiMeter, { props: { pct: 50, ariaLabel: 'progress' } });
    const fill = screen.container.querySelector('.ui-meter__fill') as HTMLElement;
    expect(getComputedStyle(fill).backgroundColor).toBe(tokenColour('--state-running'));
  });
});

suite('KAR-24.2 AC6 / EPIC-24-S10 — UiStateChip renders all seven states', () => {
  const cases = DISPLAY_STATES.map((state) => [state, STATE_LABELS[state]] as const);

  it.each(cases)(
    '"%s" carries colour, glyph and an accessible label "%s"',
    async (state, label) => {
      const screen = render(UiStateChip, { props: { state } });

      // Colour: resolved through the cascade to the state's own token.
      const chip = screen.container.querySelector('[data-state]') as HTMLElement;
      expect(getComputedStyle(chip).color).toBe(tokenColour(`--state-${state}`));

      // Glyph: present, laid out, and hidden from assistive tech — the label
      // beside it already carries the same information in text.
      const glyph = screen.container.querySelector('[data-slot="glyph"] svg');
      expect(
        glyph,
        'a chip with no glyph is a chip encoded by colour and text only',
      ).not.toBeNull();
      expect((glyph as SVGElement).getBoundingClientRect().width).toBeGreaterThan(0);
      expect(glyph?.closest('[aria-hidden="true"]')).not.toBeNull();

      // Label: real, visible text — never aria-hidden — and also the
      // accessible name a screen reader would announce.
      const text = screen.container.querySelector('[data-slot="label"]');
      expect(text?.textContent?.trim()).toBe(label);
      expect(text?.closest('[aria-hidden="true"]')).toBeNull();
      await expect.element(screen.getByRole('img', { name: label })).toBeVisible();
    },
  );
});

suite('KAR-24.2 AC6 — UiProgressSplit does not divide by zero', () => {
  it('total: 0 renders an empty track instead of NaN widths', async () => {
    const screen = render(UiProgressSplit, { props: { done: 0, running: 0, total: 0 } });

    const done = screen.container.querySelector('.ui-progress-split__done') as HTMLElement;
    const running = screen.container.querySelector('.ui-progress-split__running') as HTMLElement;
    expect(done.style.width).toBe('0%');
    expect(running.style.width).toBe('0%');

    const track = screen.container.querySelector('.ui-progress-split') as HTMLElement;
    expect(track.getAttribute('aria-valuenow')).toBe('0');
    expect(track.getAttribute('aria-valuetext')).toBe('0 of 0 done, 0 running');
  });
});

suite('KAR-24.2 AC6 — UiMeter clamps pct outside 0-100', () => {
  it('a negative pct clamps to 0', async () => {
    const screen = render(UiMeter, { props: { pct: -20, ariaLabel: 'progress' } });
    const fill = screen.container.querySelector('.ui-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('0%');
    const track = screen.container.querySelector('.ui-meter') as HTMLElement;
    expect(track.getAttribute('aria-valuenow')).toBe('0');
  });

  it('a pct over 100 clamps to 100', async () => {
    const screen = render(UiMeter, { props: { pct: 140, ariaLabel: 'progress' } });
    const fill = screen.container.querySelector('.ui-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    const track = screen.container.querySelector('.ui-meter') as HTMLElement;
    expect(track.getAttribute('aria-valuenow')).toBe('100');
  });
});
