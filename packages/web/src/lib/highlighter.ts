/**
 * KAR-17.6 AC9 — the application's **one** Shiki highlighter, and the adapter
 * that lets `@git-diff-view/vue` use it (docs/12-frontend-architecture.md §7).
 *
 * Verifies: EPIC-17-S24 · AC9
 *
 * Two rules from §7, both enforced by `test/one-shiki-instance.test.ts`:
 *
 * > **Never import the bundled `shiki` entry.** It pulls every grammar —
 * > multiple megabytes.
 *
 * > **Instantiate exactly one highlighter for the whole app** and share it.
 *
 * So: `createHighlighterCore` from `@shikijs/core`, the **JavaScript** regex
 * engine (which is what removes the 500 KB Oniguruma `.wasm` fetch), themes and
 * grammars as individual deep imports, and one module-level promise everything
 * awaits. A grammar is loaded the first time a file needs it and never again;
 * a file in a language this tool does not carry renders as plain text, which is
 * the correct outcome and not an error.
 *
 * ## Why this file exists rather than `@git-diff-view/shiki`
 *
 * AC9 names that package. It calls `createHighlighter` from the bundled `shiki`
 * entry with 34 grammars of its own and keeps the result in a module-level
 * variable — the bundled entry §7 forbids, and a *second* highlighter beside
 * this one, which is the other half of what AC9 asks for. Its only real
 * contract with `@git-diff-view/vue` is the shape of the object passed to
 * `registerHighlighter`, and `processAST` — the one non-trivial piece — is
 * exported from `@git-diff-view/core` directly. `diffHighlighter()` below is
 * that shape over the shared instance, which is AC9's intent rather than its
 * spelling. The decision is recorded in `test/one-shiki-instance.test.ts` and
 * in `pnpm-workspace.yaml`'s catalog comment so nobody re-adds the package as a
 * correction.
 */
import { type DiffFileHighlighter, processAST } from '@git-diff-view/core';
import { createHighlighterCore, type HighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';

/** The name the renderer stamps onto every file it highlights. */
export const SHARED_HIGHLIGHTER_NAME = 'deflow-shiki';

/** Both themes, always loaded: the tab can switch without a second instance. */
export const HIGHLIGHTER_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/**
 * The grammars this tool carries, by the name Shiki knows them under.
 *
 * A static map of dynamic imports rather than a computed specifier, because
 * `import(\`@shikijs/langs/${name}\`)` is a specifier the bundler cannot see —
 * it would either fail to split or pull the whole two-hundred-grammar package
 * in to be safe. Fourteen, from docs/12 §7.
 */
const LANGS: Readonly<Record<string, () => Promise<unknown>>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  vue: () => import('@shikijs/langs/vue'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  bash: () => import('@shikijs/langs/bash'),
  diff: () => import('@shikijs/langs/diff'),
  markdown: () => import('@shikijs/langs/markdown'),
};

/** What `@git-diff-view/core`'s `getLang(fileName)` answers, mapped to ours. */
const ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
};

/** The grammar name for `lang`, or `null` when this build does not carry it. */
export function grammarFor(lang: string | null | undefined): string | null {
  if (lang === null || lang === undefined || lang === '') return null;
  const normalised = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return normalised in LANGS ? normalised : null;
}

let shared: Promise<HighlighterCore> | null = null;

/**
 * The one highlighter. Every caller awaits this promise; there is no second.
 *
 * Created with no grammars at all — `ensureGrammar` adds them on demand — so
 * opening the diff view on a TypeScript file costs one grammar rather than
 * fourteen.
 */
export function sharedHighlighter(): Promise<HighlighterCore> {
  shared ??= (async () =>
    await createHighlighterCore({
      themes: [
        (await import('@shikijs/themes/github-light')).default,
        (await import('@shikijs/themes/github-dark')).default,
      ],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }))();
  return shared;
}

const loaded = new Map<string, Promise<void>>();

/**
 * Registers `lang`'s grammar on the shared instance, once.
 *
 * Resolves to the grammar name that is now registered, or `null` for a language
 * this build does not carry — the caller renders those as plain text, which is
 * what an unknown extension should look like and not an error dialog.
 */
export async function ensureGrammar(lang: string | null | undefined): Promise<string | null> {
  const name = grammarFor(lang);
  if (name === null) return null;

  let pending = loaded.get(name);
  if (pending === undefined) {
    pending = (async () => {
      const highlighter = await sharedHighlighter();
      // `getLanguage` **throws** for a grammar that is not registered rather
      // than returning undefined, and the throw is an unhandled rejection in
      // whichever render pass happened to ask. `getLoadedLanguages` is the
      // question this is actually asking.
      if (highlighter.getLoadedLanguages().includes(name)) return;
      const grammar = await (LANGS[name] as () => Promise<{ default: unknown }>)();
      await highlighter.loadLanguage(grammar.default as never);
    })();
    loaded.set(name, pending);
  }
  await pending;
  return name;
}

/**
 * The shared instance, wearing `@git-diff-view`'s `DiffHighlighter` face.
 *
 * `type: 'class'` and `defaultColor: false` together are what make the two
 * themes coexist: Shiki emits `--diff-view-*` custom properties per token for
 * both, and the stylesheet picks one by media query, so switching the app's
 * theme does not re-tokenise anything.
 *
 * `getAST` is synchronous because the renderer calls it inside its own render
 * pass. It therefore cannot load a grammar for itself — `ensureGrammar` is
 * awaited by the caller *before* the file is handed over, and an unregistered
 * language returns `undefined` here, which the renderer reads as "no syntax
 * for this file" and draws as plain text.
 */
export async function diffHighlighter(): Promise<DiffFileHighlighter> {
  const highlighter = await sharedHighlighter();
  let maxLineToIgnoreSyntax = 2_000;
  const ignoreSyntaxHighlightList: (string | RegExp)[] = [];

  return {
    name: SHARED_HIGHLIGHTER_NAME,
    type: 'class',
    get maxLineToIgnoreSyntax() {
      return maxLineToIgnoreSyntax;
    },
    setMaxLineToIgnoreSyntax: (value: number) => {
      maxLineToIgnoreSyntax = value;
    },
    get ignoreSyntaxHighlightList() {
      return ignoreSyntaxHighlightList;
    },
    setIgnoreSyntaxHighlightList: (value: (string | RegExp)[]) => {
      ignoreSyntaxHighlightList.length = 0;
      ignoreSyntaxHighlightList.push(...value);
    },
    hasRegisteredCurrentLang: (lang: string) =>
      highlighter.getLoadedLanguages().includes(grammarFor(lang) ?? lang),
    processAST,
    getAST: ((raw: string, fileName?: string, lang?: string) => {
      const ignored = ignoreSyntaxHighlightList.some((one) =>
        one instanceof RegExp ? one.test(fileName ?? '') : fileName === one,
      );
      const name = grammarFor(lang);
      if (ignored || name === null || !highlighter.getLoadedLanguages().includes(name)) {
        return undefined;
      }

      try {
        return highlighter.codeToHast(raw, {
          lang: name,
          themes: HIGHLIGHTER_THEMES,
          cssVariablePrefix: '--diff-view-',
          defaultColor: false,
          mergeWhitespaces: false,
        });
      } catch {
        // A grammar can refuse a specific input. Plain text is a worse diff
        // than a coloured one and a far better diff than an empty panel.
        return undefined;
      }
    }) as DiffFileHighlighter['getAST'],
  };
}

/** Test seam: drops the shared instance so a spec can assert it is rebuilt. */
export function resetHighlighterForTest(): void {
  shared = null;
  loaded.clear();
}
