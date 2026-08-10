/**
 * KAR-16.1 — dark mode is one class and seven redefinitions.
 *
 * Verifies: EPIC-16-S3 (scenario 1, the "both themes" half) · AC4, AC6
 *
 * Two things are under test and they fail independently:
 *
 * 1. **The mechanism.** `useDark()` from @vueuse/core flips `.dark` on `<html>`,
 *    seeds itself from the OS `prefers-color-scheme` on first load, and
 *    persists an explicit override so the next load does not silently revert to
 *    whatever the OS says.
 * 2. **The payload.** Flipping that class actually changes what
 *    `var(--state-failed)` resolves to. A `.dark` class with no token
 *    redefinition behind it is the failure the epic's test plan names in so
 *    many words — *"dark mode is a class with no token redefinition"* — and it
 *    passes every test that only asserts on the class.
 *
 * The OS preference is emulated in the browser process (../../test/commands.ts)
 * rather than by stubbing `window.matchMedia`, because a stub would leave the
 * engine's own idea of the media query untouched and this file would then be
 * asserting on the stub.
 */

import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { commands } from 'vitest/browser';
import { DISPLAY_STATES } from '../lib/state-palette.ts';
import '../styles/theme.css';
import { DARK_CLASS, THEME_STORAGE_KEY, useTheme } from './theme.ts';

const root = () => document.documentElement;
const isDarkClassOn = () => root().classList.contains(DARK_CLASS);

/** What `--state-<state>` resolves to right now, through the real cascade. */
const resolved = (state: string): string =>
  getComputedStyle(root()).getPropertyValue(`--state-${state}`).trim();

beforeEach(async () => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  root().classList.remove(DARK_CLASS);
  await commands.emulateMedia({ colorScheme: 'light' });
});

afterEach(async () => {
  // Emulation is per page, not per file: leaving it on moves the failure into
  // whichever spec the runner picks up next.
  await commands.emulateMedia({});
  localStorage.removeItem(THEME_STORAGE_KEY);
  root().classList.remove(DARK_CLASS);
});

suite('AC6 — the OS preference is the default, and only the default', () => {
  it('starts light when the OS says light, with no class on <html>', async () => {
    const { isDark } = useTheme();

    expect(isDark.value).toBe(false);
    expect(isDarkClassOn()).toBe(false);
  });

  it('starts dark when the OS says dark, with no stored preference', async () => {
    await commands.emulateMedia({ colorScheme: 'dark' });

    const { isDark } = useTheme();

    expect(isDark.value).toBe(true);
    expect(isDarkClassOn()).toBe(true);
  });

  it('flips the class on <html> rather than on a wrapper element', async () => {
    const { toggleTheme } = useTheme();

    toggleTheme();
    await Promise.resolve();

    // On <html> specifically: the seven tokens are redefined under `.dark`, and
    // a class on a mounted wrapper would leave everything teleported outside it
    // — every Reka UI overlay, which portals to <body> — on the light palette.
    expect(root().tagName).toBe('HTML');
    expect(isDarkClassOn()).toBe(true);
  });
});

suite('AC6 — an explicit override outlives the tab', () => {
  it('persists the choice under this app’s own storage key', async () => {
    const { toggleTheme } = useTheme();

    toggleTheme();
    await Promise.resolve();

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('honours the stored override over the OS preference on the next load', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    // The OS still says light. An override that loses to it is not an override.
    await commands.emulateMedia({ colorScheme: 'light' });

    const { isDark } = useTheme();

    expect(isDark.value).toBe(true);
    expect(isDarkClassOn()).toBe(true);
  });
});

suite('AC4 — the class carries seven redefinitions, not just a name', () => {
  it('resolves --state-failed to a different value in each theme', async () => {
    const { toggleTheme } = useTheme();
    const light = resolved('failed');

    toggleTheme();
    await Promise.resolve();
    const dark = resolved('failed');

    expect(light).not.toBe('');
    expect(dark).not.toBe('');
    expect(dark).not.toBe(light);
  });

  it.each(DISPLAY_STATES)('resolves --state-%s in both themes, to two values', async (state) => {
    const { toggleTheme } = useTheme();
    const light = resolved(state);

    toggleTheme();
    await Promise.resolve();
    const dark = resolved(state);

    expect(light).not.toBe('');
    expect(dark).not.toBe('');
    // All seven, not just the one somebody remembered: a palette where six
    // moved and one did not is a contrast failure nobody notices until the
    // screenshot.
    expect(dark).not.toBe(light);
  });
});
