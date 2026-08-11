/**
 * KAR-17.6 AC9 — the alias that keeps a second syntax highlighter out of the
 * build.
 *
 * `@git-diff-view/core` statically imports `@git-diff-view/lowlight`, which
 * calls `createLowlight(all)` — every highlight.js grammar, about 900 KB raw —
 * to provide the renderer's *default* highlighter. This application always
 * registers its own (`../src/lib/highlighter.ts`, the one Shiki instance
 * docs/12-frontend-architecture.md §7 requires), so that default is never
 * selected and the grammars are dead weight in the diff route's chunk.
 *
 * Aliasing **`lowlight`** rather than `@git-diff-view/lowlight` is deliberate:
 * `processAST` is the one piece of that package this application genuinely uses
 * and it is a pre-1.0 internal contract with the renderer, so it stays the real
 * implementation. Only the grammar set is replaced. See
 * `../src/lib/lowlight-shim.ts` for what the fallback path does instead, and
 * `../test/integration/bundle-budget.test.ts` for the assertion that no built
 * chunk carries highlight.js.
 *
 * Used by the SPA build (`../vite.config.ts`) **and** by the browser test
 * config (`../vitest.config.ts`), so the specs exercise the module graph that
 * ships rather than a fatter one that happens to behave the same.
 */
import { fileURLToPath } from 'node:url';

export interface AliasEntry {
  readonly find: RegExp;
  readonly replacement: string;
}

export function diffSyntaxAlias(): AliasEntry[] {
  return [
    {
      // Anchored on the whole specifier: `lowlight/lib/core` and
      // `@git-diff-view/lowlight` must both go on resolving normally, and a
      // bare `/lowlight/` would swallow them.
      find: /^lowlight$/,
      replacement: fileURLToPath(new URL('../src/lib/lowlight-shim.ts', import.meta.url)),
    },
  ];
}
