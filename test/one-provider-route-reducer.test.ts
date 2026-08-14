/**
 * KAR-19.10 AC6, AC9 — one route reducer, one announcement, and no vendor name
 * in either.
 *
 * On 2026-08-13 `doctor` said `claude`'s adapter was missing and a run selected
 * `claude` anyway. Neither half was lying: they were two reductions of the same
 * machine, written months apart, and *"usable"* meant something slightly
 * different in each. The fix is not a comment reminding the next person to keep
 * them in step — it is that there is only one of them, and this file is what
 * makes a second one a failing test rather than an afternoon.
 *
 * Three guards, for the three ways it could quietly come apart again.
 *
 *  1. **One route reducer.** Exactly one shipped module turns a resolution into
 *     `{ acp, shim }`. `doctor`'s Agents section, `admitRun` and the chain's
 *     selection call it; none of them re-derives a route from `adapterPath !==
 *     null` on its own, which is precisely the two-line shortcut that reads as
 *     obviously correct in review and is how the divergence started.
 *  2. **One announcement.** Exactly one module composes the sentence naming the
 *     provider, the binary and the route — in `@DeFlow/core`, because the CLI,
 *     the run API and the browser bundle all have to say it and the browser
 *     takes no dependency on `@DeFlow/adapters`.
 *  3. **No vendor name in any of it.** The flag's validation list, the
 *     announcement renderer and the route reducer all read `PROVIDER_SPECS`.
 *     `packages/adapters/test/no-capability-table.test.ts` holds this rule for
 *     `packages/adapters/src`; the modules this story added are in three other
 *     packages, so the same rule is applied to them here rather than by adding
 *     a second exemption over there (AC9).
 *
 * Verifies: EPIC-19-S67, EPIC-19-S69 · AC4, AC6, AC9 · test plan #9
 */
import { expect, it, describe as suite } from 'vitest';
import { allWorkspaceSources } from './support/workspace.ts';

/** The one module allowed to answer "which routes can this machine open". */
const ROUTE_REDUCER = 'packages/adapters/src/provider-install.ts';

/** The one module allowed to compose the sentence a run says about its agent. */
const ANNOUNCEMENT = 'packages/core/src/provider-choice.ts';

/**
 * The readers that name the reducer directly.
 *
 * `agent-install.ts` is `doctor`'s one door onto `@DeFlow/adapters` and
 * re-exports it; `agents.ts` is the Agents section itself. Admission lives in
 * the reducer's own module, and selection (`live-chain.ts`) reaches it through
 * `usableProviders` — which is asserted separately below, because *that* is the
 * function the two views have to share for AC6 to mean anything.
 */
const ROUTE_READERS = [
  'packages/cli/src/doctor/agents.ts',
  'packages/cli/src/doctor/agent-install.ts',
] as const;

/**
 * The post-install re-resolution, which asks a different question with the same
 * field and is documented here rather than silently excluded.
 */
const INSTALL_VERIFICATION = 'packages/cli/src/doctor/agent-install.ts';

/** The three surfaces that render the announcement (AC4). */
const ANNOUNCEMENT_CALLERS = [
  'packages/cli/src/run/run.ts',
  'packages/daemon/src/http/run-provider.ts',
  'packages/web/src/components/RunProviderBanner.vue',
] as const;

/** Every module KAR-19.10 added or rewrote outside the registry's own package. */
const NEW_MODULES = [
  ANNOUNCEMENT,
  'packages/cli/src/run/args.ts',
  'packages/daemon/src/http/run-provider.ts',
  'packages/daemon/src/intake/request-schema.ts',
] as const;

// `.vue` as well as `.ts`: one of the three surfaces that renders the
// announcement is a component, and a guard that could not see it would be
// asserting "three callers" over two.
const sources = allWorkspaceSources().filter(
  (file) =>
    file.path.startsWith('packages/') &&
    // Authored source only. `packages/cli/dist/` holds a bundled copy of half
    // the workspace, and a guard that counted it would fail on every build
    // while proving nothing about what anybody wrote.
    file.path.includes('/src/') &&
    !file.path.endsWith('.test.ts'),
);

/** Whole-line comments blanked, so the doc comment explaining a rule is not
 * that rule's first violation. Line count is preserved. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

const sourceOf = (path: string): string => {
  const found = sources.find((file) => file.path === path);
  if (found === undefined) throw new Error(`${path} is not in the scanned tree`);
  return codeOnly(found.text);
};

/** Files whose executable half contains `phrase`. */
const spelling = (phrase: string): string[] =>
  sources.filter((file) => codeOnly(file.text).includes(phrase)).map((file) => file.path);

suite('AC6 — one route reducer, three readers', () => {
  it('scans a tree that actually has sources in it', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.map((file) => file.path)).toContain(ROUTE_REDUCER);
  });

  it('defines the reducer in exactly one module', () => {
    expect(spelling('export function providerRoutes')).toEqual([ROUTE_REDUCER]);
  });

  it('holds the turn-to-route table in one place, and it is beside the reducer', () => {
    // `TURN_ROUTES` is the thing a second copy of would be most damaging: it is
    // what decides that a pre-execution turn needs the exec shim and an agent
    // node needs the ACP session, and a stale duplicate would admit a machine
    // for a turn it cannot serve — the 2026-08-13 failure, one table over.
    expect(spelling('export const TURN_ROUTES')).toEqual([ROUTE_REDUCER]);
    expect(spelling('export function turnsServedBy')).toEqual([ROUTE_REDUCER]);
    expect(spelling('export function unservedTurns')).toEqual([ROUTE_REDUCER]);
    expect(spelling('export function routeForNextTurn')).toEqual([ROUTE_REDUCER]);
  });

  it('routes are answered from the reducer, never re-derived from adapterPath', () => {
    // The shortcut this forbids: `adapterPath !== null` read as "the ACP route
    // is open". It is wrong in exactly one direction the reducer is right in —
    // a bridge with no vendor CLI underneath it bridges to nothing — and it is
    // two lines that read as obviously correct in review.
    //
    // One documented exception, and it is not a route question: after an
    // `npm install -g`, `agent-install.ts` re-resolves and asks whether the
    // binary the install claimed to produce is actually there. An npm that
    // exits 0 without writing anything is a real outcome, and that check is the
    // only thing standing between it and a `doctor` reporting a fix it did not
    // make.
    expect(spelling('adapterPath !== null').toSorted()).toEqual(
      [ROUTE_REDUCER, INSTALL_VERIFICATION].toSorted(),
    );
  });

  it('has every reader in the scanned tree, reading the one reducer', () => {
    for (const path of ROUTE_READERS) {
      expect(sourceOf(path), `${path} does not read the route reducer`).toContain('providerRoutes');
    }
  });

  it('keeps admission and selection on the same reduction as doctor', () => {
    // `usableProviders` is what admission and the chain both filter with, and
    // it is defined beside the reducer and derived from it. A second
    // definition anywhere is the divergence under a new name.
    expect(spelling('export function usableProviders')).toEqual([ROUTE_REDUCER]);
    expect(sourceOf('packages/daemon/src/pipeline/live-chain.ts')).toContain('usableProviders');
  });
});

suite('AC4 — one announcement, three callers', () => {
  it('composes the sentence in exactly one module', () => {
    expect(spelling('export function announceProviderChoice')).toEqual([ANNOUNCEMENT]);
  });

  it('spells the route labels only there', () => {
    // "ACP adapter" and "exec shim" are the words an operator compares between
    // `doctor` and a run. A second spelling of either is a second vocabulary.
    for (const label of ["'ACP adapter'", "'exec shim'"]) {
      expect(spelling(label)).toEqual([ANNOUNCEMENT]);
    }
  });

  it('is rendered by three callers and composed by none of them', () => {
    for (const path of ANNOUNCEMENT_CALLERS) {
      const code = sourceOf(path);
      expect(code, `${path} does not render the announcement`).toContain('announceProviderChoice');
    }
  });
});

suite('AC9 — no provider is named outside the registry', () => {
  /** The five verified adapters and the two names their npm packages use —
   * the same list `packages/adapters/test/no-capability-table.test.ts` uses,
   * applied to the modules this story added in other packages. */
  const VENDORS = ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'anthropic', 'openai'];

  it.each(NEW_MODULES)('%s names no vendor in executable code', (path) => {
    const code = sourceOf(path).toLowerCase();
    const named = VENDORS.filter((vendor) => code.includes(vendor));
    expect(
      named,
      `${path} names ${named.join(', ')} in executable code. The registry is the one file ` +
        'allowed to; everything else reads PROVIDER_SPECS.',
    ).toHaveLength(0);
  });

  it('is not vacuous: it would catch a hand-kept list of ids', () => {
    const tempting = codeOnly("const PROVIDERS = ['claude', 'codex', 'mock'];").toLowerCase();
    expect(VENDORS.filter((vendor) => tempting.includes(vendor))).toEqual(['claude', 'codex']);
  });
});
