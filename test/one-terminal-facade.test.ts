/**
 * KAR-17.5 AC3/AC4 — exactly one place constructs a `Terminal`.
 *
 * Verifies: EPIC-17-S22 · AC3, AC4
 *
 * docs/12-frontend-architecture.md §6.6 states four disciplines and calls them
 * non-negotiable. Every one of them fails **silently**:
 *
 * | Missed                                | What happens                                        |
 * | ------------------------------------- | --------------------------------------------------- |
 * | `scrollback: 5000`                    | ≈ 13 MB per terminal becomes ≈ 260 MB. No error.     |
 * | Serialise + dispose on unmount        | WebGL contexts run out; the **oldest** stops drawing |
 * | DOM fallback on `onContextLoss`       | A driver hiccup blanks the panel, once, elsewhere    |
 * | `markRaw`                             | Vue proxies megabytes of typed arrays; it is "slow"  |
 *
 * None of those is visible in review, and all four are properties of *every*
 * terminal in the build rather than of any one of them. So the rule is
 * structural — one construction site — and this is what keeps it true. The
 * enforcing script is `packages/web/scripts/check-terminal-facade.ts`, run by
 * `pnpm lint`; this test is the same rule at the level that fails a suite, plus
 * the assertions about what the one allowed file actually does.
 */
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import { stripComments, webSourceFiles } from '../packages/web/scripts/check-graph-facade.ts';
import {
  TERMINAL_FACADE,
  terminalFacadeViolations,
} from '../packages/web/scripts/check-terminal-facade.ts';

const sources = webSourceFiles();

const facadeSource = stripComments(
  readFileSync(new URL(`../packages/web/${TERMINAL_FACADE}`, import.meta.url), 'utf8'),
);

suite('AC3/AC4 — the terminal facade', () => {
  it('has sources to check, so a passing rule is not a rule over nothing', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some((file) => file.path === TERMINAL_FACADE)).toBe(true);
  });

  it('lets no file but the facade name an @xterm/ package', () => {
    const violations = terminalFacadeViolations(sources);
    expect(violations.map((one) => one.where)).toEqual([]);
  });

  it('would catch a second construction site, so the rule above is not vacuous', () => {
    const planted = terminalFacadeViolations([
      ...sources,
      {
        path: 'src/components/output/SneakyTerminal.vue',
        text: "import { Terminal } from '@xterm/xterm';",
      },
    ]);

    expect(planted.map((one) => one.where)).toEqual(['src/components/output/SneakyTerminal.vue']);
    expect(planted[0]?.message).toContain('scrollback 5000');
  });
});

suite('AC3 — what the one allowed file does with the terminal it makes', () => {
  it('sets the scrollback from the budget module rather than from a literal', () => {
    // A literal here is how the cap and the arithmetic that justifies it drift
    // apart: `packages/web/src/lib/terminal-budget.ts` carries both, and its
    // spec fails on the *consequence* in bytes rather than on the number.
    expect(facadeSource).toContain('scrollback: TERMINAL_SCROLLBACK');
    expect(facadeSource).not.toMatch(/scrollback:\s*\d/);
  });

  it('markRaws the Terminal at construction, not at some call site', () => {
    expect(facadeSource).toMatch(/markRaw\(\s*new Terminal\(/);
  });

  it('wires the DOM fallback to onContextLoss', () => {
    expect(facadeSource).toContain('onContextLoss');
  });

  it('never loads the canvas addon, which v6 removed', () => {
    // `@xterm/addon-canvas` last published 0.7.0 on 2024-04-05 and is not
    // installable against v6. A build that reached for it would be reaching for
    // a renderer that does not exist.
    expect(facadeSource).not.toContain('addon-canvas');
    // Comments stripped, because several files *say* that v6 removed it — which
    // is the record of the decision and exactly what must not be deleted to
    // make a rule pass.
    expect(sources.some((file) => stripComments(file.text).includes('addon-canvas'))).toBe(false);
  });

  it('serialises before it disposes, in that order', () => {
    const serialise = facadeSource.indexOf('serializer.serialize()');
    const dispose = facadeSource.indexOf('terminal.dispose()');

    expect(serialise).toBeGreaterThan(-1);
    expect(dispose).toBeGreaterThan(-1);
    // The other order returns an empty string from a disposed addon, and the
    // panel re-opens blank — which reads as "the node produced nothing".
    expect(serialise).toBeLessThan(dispose);
  });
});
