/**
 * KAR-26.4 — contrast *computed* on the surfaces the density pass actually
 * paints, in both themes.
 *
 * Verifies: EPIC-26-S30 · AC5
 *
 * `../../styles/theme-contrast.test.ts` is deliberately token-level: it pairs
 * `--ink*`/`--state-*` against the `--surface*` tokens as declared in
 * theme.css's own text. The one surface that file can never see is a derived
 * one — `UiChip`'s tinted variants paint
 * `color-mix(in oklab, var(--state-*) 10%, var(--surface))` (UiChip.vue), a
 * background that exists only in the live cascade. Every settings status chip
 * KAR-26.4 added (`ready`/`partial`/`unusable`/…, `connected`/`missing
 * scope`/…) puts its text and its `currentcolor` dot on exactly that mix, so
 * a token edit that pulls the mixed background toward its own state colour
 * would fail nowhere at all without this file: the token-level suite checks
 * the state colour against `--surface`, not against the blend.
 *
 * So this file measures, rather than trusts: mount the chip, read the
 * *computed* text colour and background, resolve both to sRGB bytes through a
 * canvas (Chromium serialises `color-mix(in oklab, …)` results in `oklab()`
 * notation, which no hand parser here should pretend to understand), and run
 * the same WCAG 2.x ratio theme-contrast.test.ts uses. The 4.5:1 floor is
 * that file's own: chips carry text, and the epic's 3:1 non-text floor says
 * nothing about text.
 */
import { expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { h } from 'vue';
import '../../styles/theme.css';
import UiChip from './UiChip.vue';

const VARIANTS = ['neutral', 'accent', 'ok', 'warn', 'error', 'info'] as const;
const THEMES = ['light', 'dark'] as const;
const AA_NORMAL_TEXT = 4.5;

/**
 * A CSS colour — in whatever notation the browser serialised it — resolved to
 * opaque sRGB bytes by the browser's own canvas rasteriser, painted over the
 * given base so a translucent value resolves the way the screen would show it.
 */
function rgbBytes(cssColor: string, base = '#ffffff'): [number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d canvas context in this browser');
  context.fillStyle = base;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = cssColor;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  return [data[0] as number, data[1] as number, data[2] as number];
}

/** WCAG 2.x relative luminance — same maths as theme-contrast.test.ts, over
 *  bytes rather than hex text. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (byte: number): number => {
    const c = byte / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** The page's own opaque ground in the current theme, for compositing. */
function pageSurface(): string {
  const probe = document.createElement('div');
  probe.style.background = 'var(--surface)';
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

suite('EPIC-26-S30 — the chip’s painted (mixed) background holds AA against its own text', () => {
  it.each(VARIANTS.map((variant) => ({ variant })))(
    'variant "$variant" clears 4.5:1 in both themes, measured on the live blend',
    ({ variant }) => {
      const screen = render(UiChip, {
        props: { variant, mono: true },
        slots: { default: () => [h('span', 'ready')] },
      });
      const chip = screen.container.querySelector('.ui-chip') as HTMLElement;

      try {
        for (const theme of THEMES) {
          document.documentElement.classList.toggle('dark', theme === 'dark');
          const style = getComputedStyle(chip);
          const surface = pageSurface();
          // The neutral chip's background is `transparent` — what shows
          // through is the page surface, so that is the honest base either way.
          const background = rgbBytes(style.backgroundColor, surface);
          const text = rgbBytes(style.color, surface);
          const ratio = contrastRatio(text, background);
          expect(
            ratio >= AA_NORMAL_TEXT,
            `UiChip[${variant}] text on its painted background is ${ratio.toFixed(2)}:1 in ${theme} (needs ${AA_NORMAL_TEXT})`,
          ).toBe(true);
        }
      } finally {
        document.documentElement.classList.remove('dark');
      }
    },
  );
});
