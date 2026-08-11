/**
 * Browser-mode commands: the small set of things a spec has to ask the *browser
 * process* for, because they cannot be done from inside the page.
 *
 * `prefers-color-scheme` and `prefers-reduced-motion` are OS-level inputs. A
 * page cannot set them, and faking them by stubbing `window.matchMedia` would
 * test the stub: the CSS `@media (prefers-reduced-motion: reduce)` block that
 * AC8 is about is evaluated by the engine, not by JavaScript, and would carry
 * on being inert. Playwright's `emulateMedia` changes what the engine itself
 * believes, which is the only version of this that has teeth.
 *
 * Used by ../src/app/theme.test.ts (AC4, AC6) and
 * ../src/app/reduced-motion.test.ts (AC8).
 */
import type { BrowserCommand } from 'vitest/node';

export interface MediaPreferences {
  readonly colorScheme?: 'light' | 'dark' | 'no-preference';
  readonly reducedMotion?: 'reduce' | 'no-preference';
}

/**
 * Sets the emulated media preferences for the whole browser page, frames
 * included.
 *
 * Call it with `{}` to put everything back; a spec that emulates `reduce` and
 * leaves it on has changed the environment for whichever file the runner picks
 * up next, and that failure lands somewhere else entirely.
 */
export const emulateMedia: BrowserCommand<[MediaPreferences]> = async (context, preferences) => {
  await context.page.emulateMedia({
    colorScheme: preferences.colorScheme ?? null,
    reducedMotion: preferences.reducedMotion ?? null,
  });
};

/**
 * KAR-17.7 AC8 — grants the page's browser *context* clipboard read and write.
 *
 * `navigator.clipboard.writeText` from a real user gesture generally succeeds
 * in Chromium without this, but `navigator.clipboard.readText()` — the only
 * honest way for a spec to confirm what actually landed on the clipboard
 * rather than trusting the page's own account of what it wrote — is gated
 * behind the `clipboard-read` permission, and a page cannot grant that to
 * itself. `BrowserContext.grantPermissions` is the browser-process side of
 * that gate, exactly as `emulateMedia` above is for `prefers-*` media.
 */
export const grantClipboard: BrowserCommand<[]> = async (context) => {
  await context.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
};

/**
 * The commands are declared on `BrowserCommands` as well as registered in
 * `../vitest.config.ts`: the runtime lookup is by name, so without this
 * augmentation `commands.emulateMedia(...)` is a type error in every spec that
 * uses it — and casting it away in each of them is how a renamed command stops
 * being caught by the compiler.
 */
declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateMedia: (preferences: MediaPreferences) => Promise<void>;
    grantClipboard: () => Promise<void>;
  }
}
