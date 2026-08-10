/**
 * KAR-16.1 — the claims about the UI that are properties of *this repository*
 * rather than of a running page.
 *
 * Verifies: EPIC-16-S3 (scenario 2), EPIC-16-S4 (scenario 2), EPIC-16-S5
 * (scenario 2) · AC5, AC7, AC10
 *
 * A browser spec can prove that the skip-link has a focus ring today. It cannot
 * prove that no file anywhere removes one, that no component has quietly
 * written a second definition of the state palette, or that the build config is
 * written for the bundler Vite 8 actually ships. Those are grep-shaped claims,
 * and the guard functions they run on are themselves exercised against
 * violating and clean fixtures in ./guards.test.ts — a guard that has only ever
 * seen a compliant repository is not known to detect anything.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkNoFocusOutlineNone,
  checkRolldownBuildOptions,
  checkStateColoursComeFromThePalette,
  describe as render,
} from './support/guards.ts';
import { readSources, readText, walk } from './support/workspace.ts';

/**
 * Every hand-written UI source: TypeScript, single-file components **and
 * stylesheets**.
 *
 * `allWorkspaceSources()` next door stops at `.ts` and `.vue`, and both of the
 * rules below are mostly about CSS — a guard over a file set that excludes the
 * stylesheets would be the vacuous kind.
 */
const webSources = () =>
  readSources(
    walk(
      'packages/web',
      (path) =>
        (path.endsWith('.ts') || path.endsWith('.vue') || path.endsWith('.css')) &&
        !path.endsWith('.test.ts'),
    ),
  );

suite('AC7 — the focus ring is never removed (EPIC-16-S4 scenario 2)', () => {
  it('has UI sources to check, so this is not vacuous', () => {
    const sources = webSources();

    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((file) => file.path.endsWith('.vue'))).toBe(true);
    expect(sources.some((file) => file.path.endsWith('.css'))).toBe(true);
  });

  it('contains "focus:outline-none" nowhere, in any spelling', () => {
    expect(render(checkNoFocusOutlineNone(webSources()))).toBe('');
  });

  it('does define a real ring, so there is something the guard is protecting', () => {
    const theme = readText('packages/web/src/styles/theme.css');

    expect(theme).toMatch(/:focus-visible\s*\{[^}]*outline:\s*\d/);
  });
});

suite('EPIC-16-S3 scenario 2 — the state palette has exactly one definition', () => {
  it('no component hardcodes a state colour as a hex value or a Tailwind class', () => {
    expect(render(checkStateColoursComeFromThePalette(webSources()))).toBe('');
  });

  it('the seven names are declared in the stylesheet and read as variables elsewhere', () => {
    const theme = readText('packages/web/src/styles/theme.css');
    const graph = readText('packages/web/src/views/PlanGraphView.vue');

    expect(theme).toContain('--state-failed:');
    // The view paints with the variable rather than with a colour, which is
    // what makes dark mode seven redefinitions instead of an audit.
    expect(graph).toContain('var(--state-');
    expect(graph).not.toContain('--state-failed:');
  });
});

suite('EPIC-16-S5 scenario 2 — the build config is written for Rolldown (AC10)', () => {
  it('uses build.rolldownOptions and not the compat name', () => {
    const config = {
      path: 'packages/web/vite.config.ts',
      text: readText('packages/web/vite.config.ts'),
    };

    expect(render(checkRolldownBuildOptions(config))).toBe('');
  });
});
