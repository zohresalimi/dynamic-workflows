/**
 * KAR-17.6 AC9 — the `lowlight` this build ships instead of the real one.
 *
 * Verifies: EPIC-17-S24 · AC9
 *
 * ## What this replaces, and why
 *
 * `@git-diff-view/core` statically imports `@git-diff-view/lowlight`, whose
 * first line is `createLowlight(all)` — **every** highlight.js grammar, about
 * 900 KB raw. It is the renderer's *default* highlighter, used when a caller
 * passes no `registerHighlighter`.
 *
 * This application always passes one: `./highlighter.ts`'s single Shiki
 * instance (docs/12-frontend-architecture.md §7, *"instantiate exactly one
 * highlighter for the whole app"*). So the default is never selected, and
 * without this shim the diff route's chunk would carry a second, complete,
 * unreachable syntax highlighter — which is both the thing AC9 forbids and,
 * measured, more than two thirds of that chunk.
 *
 * `scripts/diff-syntax-alias.ts` points the bundler at this file for the
 * `lowlight` specifier only. `@git-diff-view/lowlight` itself is untouched, so
 * `processAST` — the one piece of it this application genuinely uses, and a
 * pre-1.0 internal contract with the renderer that would be a poor thing to
 * re-implement — is still the real function.
 *
 * ## What happens if the fallback is ever reached
 *
 * `DiffFile.doSyntax` falls back to the default highlighter when the registered
 * one reports it has not loaded the file's language. With this shim that path
 * produces an empty AST, and the renderer draws the file as **plain text** —
 * which is exactly what `./highlighter.ts` already does for a language this
 * build does not carry, and is the honest rendering of *"nobody here knows this
 * grammar"*. It is not an error and it is not a blank panel.
 *
 * `packages/web/test/integration/bundle-budget.test.ts` asserts that no chunk
 * of the built application contains highlight.js, which is what keeps this
 * true if the alias is ever dropped.
 */
/**
 * The shape `lowlight`'s highlight functions return.
 *
 * Declared structurally rather than imported from `hast`: `hast` is a
 * transitive type-only dependency of `@git-diff-view/*` and not a dependency of
 * this package, and adding one to name a type nothing consumes would be a
 * manifest entry with no runtime meaning. The only property any caller reads
 * here is `children`, and it is always empty.
 */
export interface EmptySyntaxRoot {
  readonly type: 'root';
  readonly children: readonly never[];
}

/** The grammar set the real `lowlight` exports. Empty here, by construction. */
export const all: Record<string, never> = {};

/** The other named export the real package has; nothing in this tree uses it. */
export const common: Record<string, never> = {};

const empty = (): EmptySyntaxRoot => ({ type: 'root', children: [] });

export interface LowlightShim {
  highlight: (language: string, value: string) => EmptySyntaxRoot;
  highlightAuto: (value: string) => EmptySyntaxRoot;
  listLanguages: () => string[];
  register: (...args: unknown[]) => undefined;
  registerAlias: (...args: unknown[]) => undefined;
  registered: (aliasOrName: string) => boolean;
}

/**
 * A `lowlight` that knows no languages.
 *
 * Every method is the honest answer for an instance with no grammars
 * registered, rather than a throw: `registered()` is `false`, `listLanguages()`
 * is empty, and highlighting produces an empty tree. Throwing would turn a
 * fallback path nobody takes into a crash the first time somebody opened a
 * `.rb` file.
 */
export function createLowlight(_grammars?: unknown): LowlightShim {
  return {
    highlight: empty,
    highlightAuto: empty,
    listLanguages: () => [],
    register: () => undefined,
    registerAlias: () => undefined,
    registered: () => false,
  };
}

export default { all, common, createLowlight };
