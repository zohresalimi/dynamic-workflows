/**
 * KAR-24.3 AC6 — the gallery mounts, in both themes, without error.
 *
 * This is the spec the story is written to be honest about: a component whose
 * props changed under it fails a test rather than a person's memory. It does
 * not re-assert what `ui/variants.test.ts` and `ui/a11y.test.ts` already prove
 * about the primitives — it asserts that GalleryView actually reaches every
 * one of them, that the token layer resolves to a real value rather than an
 * empty string, and that toggling the theme is visible in what it resolves to.
 *
 * `mountShell` rather than a bare `mount()`: the gallery route is registered
 * on the real router table, behind the real shell (skip-link, session gate,
 * overlays), and `../router/index.ts`'s dev-only guard is exactly what this
 * spec exercises by navigating there at all — `import.meta.env.DEV` is true
 * under vitest, which is what makes the route reachable here the same way it
 * is reachable from `pnpm dev`.
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { DARK_CLASS, THEME_STORAGE_KEY } from '../app/theme.ts';
import { DISPLAY_STATES } from '../lib/state-palette.ts';

let shell: MountedShell;

/**
 * `useTheme()` persists an explicit override to localStorage
 * (`../app/theme.ts`) so it survives the tab that chose it — which, inside a
 * shared browser page, is every other spec run before or after this file
 * unless it is cleared on both sides of each test. Left in place, the
 * theme-toggle assertions below would pass or fail depending on what a
 * neighbouring spec left the class as, rather than on what this file clicks
 * itself.
 */
function resetTheme(): void {
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove(DARK_CLASS);
}

beforeEach(resetTheme);

afterEach(() => {
  shell?.unmount();
  resetTheme();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await shell.router.isReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;

suite('KAR-24.3 — the gallery route', () => {
  it('mounts, in the light theme, with every state chip and every button variant present', async () => {
    shell = await mountShell({ at: '/gallery' });
    await settle();

    expect(shell.container.querySelector('[data-gallery]')).not.toBeNull();

    for (const state of DISPLAY_STATES) {
      const chip = shell.container.querySelector(`[data-gallery-state-chip="${state}"]`);
      expect(chip, `no UiStateChip rendered for state "${state}"`).not.toBeNull();
    }

    const buttons = [...shell.container.querySelectorAll('button[data-variant]')].map((button) =>
      button.getAttribute('data-variant'),
    );
    for (const variant of BUTTON_VARIANTS) {
      expect(buttons, `no UiButton rendered with variant "${variant}"`).toContain(variant);
    }
  });

  it('renders a non-empty computed value for a token swatch', async () => {
    shell = await mountShell({ at: '/gallery' });
    await settle();

    const swatches = shell.container.querySelectorAll('[data-gallery-token-swatch]');
    expect(swatches.length).toBeGreaterThan(0);

    const firstValue = swatches[0]?.querySelector('[data-gallery-token-value]');
    expect(firstValue?.textContent?.trim()).not.toBe('');
  });

  it('changes at least one swatch value when the theme is toggled', async () => {
    shell = await mountShell({ at: '/gallery' });
    await settle();

    const valueFor = (name: string): string | undefined =>
      shell.container
        .querySelector(
          `[data-gallery-token-swatch][data-token-name="${name}"] [data-gallery-token-value]`,
        )
        ?.textContent?.trim();

    // `--surface-canvas` is one of the two named exceptions in theme.css's
    // `.dark` block only for --ink/--state entries; --surface-canvas itself
    // is a plain light/dark pair (#f4f2ee vs #0a0b0d), which is what makes it
    // a safe token to assert a literal change on rather than one theme.css
    // happens to leave equal between the two.
    const before = valueFor('--surface-canvas');
    expect(before).not.toBe('');

    shell.container.querySelector<HTMLElement>('[data-gallery-theme-toggle]')?.click();

    await expect.poll(() => valueFor('--surface-canvas')).not.toBe(before);
    const after = valueFor('--surface-canvas');
    expect(after).not.toBe('');
  });

  it('renders cleanly after switching into the dark theme, with nothing missing', async () => {
    shell = await mountShell({ at: '/gallery' });
    await settle();

    shell.container.querySelector<HTMLElement>('[data-gallery-theme-toggle]')?.click();
    await settle();
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    expect(shell.container.querySelector('[data-gallery]')).not.toBeNull();
    expect(shell.container.querySelectorAll('[data-gallery-token-swatch]').length).toBeGreaterThan(
      0,
    );
    for (const state of DISPLAY_STATES) {
      expect(
        shell.container.querySelector(`[data-gallery-state-chip="${state}"]`),
        `no UiStateChip rendered for state "${state}" in the dark theme`,
      ).not.toBeNull();
    }
  });
});
