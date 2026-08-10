/**
 * KAR-16.1 AC6 — dark mode, which is one class and nothing else.
 *
 * `useDark()` from @vueuse/core does the three things this app needs and none
 * it does not: it seeds from the OS `prefers-color-scheme` on first load, it
 * writes `.dark` onto `<html>`, and it persists an explicit override so the
 * next load does not quietly revert to whatever the OS says. Everything
 * downstream of that is the seven `--state-*` tokens being redefined under the
 * class (../styles/theme.css) — no component reads the theme, and no view has a
 * light and a dark variant.
 *
 * `<html>` and not a wrapper element, deliberately: every Reka UI overlay
 * portals to `<body>`, so a class on a mounted component would leave the
 * dialogs, popovers and the Cmd-K jumper on the light palette while the page
 * behind them went dark.
 *
 * The storage key is this app's own rather than @vueuse's default
 * `vueuse-color-scheme`, because it is a key in the operator's browser
 * alongside every other tool's and a generic name is somebody else's collision.
 */
import { useDark, useToggle } from '@vueuse/core';
import type { Ref } from 'vue';

/** The class the palette redefines its seven tokens under. */
export const DARK_CLASS = 'dark';

/** Where an explicit override is remembered, across tabs and restarts. */
export const THEME_STORAGE_KEY = 'DeFlow.theme';

export interface Theme {
  /** Two-way: assigning it is an explicit override and is persisted. */
  readonly isDark: Ref<boolean>;
  /** Flips it, for the toolbar button and the tests. */
  readonly toggleTheme: () => boolean;
}

/**
 * The app's theme.
 *
 * `localStorage` rather than `sessionStorage` — unlike the daemon token next
 * door, which is per tab on purpose, a theme the operator chose should survive
 * the tab that chose it.
 */
export function useTheme(): Theme {
  const isDark = useDark({
    selector: 'html',
    attribute: 'class',
    valueDark: DARK_CLASS,
    // Empty rather than `'light'`: the light theme is `:root` with no class on
    // it, so naming one would put a class on <html> that nothing styles.
    valueLight: '',
    storageKey: THEME_STORAGE_KEY,
  });

  return { isDark, toggleTheme: useToggle(isDark) };
}
