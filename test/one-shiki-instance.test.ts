/**
 * KAR-17.6 AC9 — one highlighter for the whole application, and never the
 * bundled `shiki` entry.
 *
 * Verifies: EPIC-17-S24 · AC9
 *
 * docs/12-frontend-architecture.md §7 states both halves as rules:
 *
 * > **Never import the bundled `shiki` entry.** It pulls every grammar —
 * > multiple megabytes.
 *
 * > **Instantiate exactly one highlighter for the whole app** and share it —
 * > the node inspector, the diff view, the plan JSON view and the streaming
 * > output view all use the same instance.
 *
 * Both are easy to break by accident and impossible to notice by reading. A
 * second `createHighlighterCore` does not fail, does not warn, and does not
 * even look wrong in review — it costs a second grammar registry, a second
 * theme set and a second few hundred kilobytes in whichever chunk it landed in,
 * and the first symptom is a bundle budget moving for no reason anybody can
 * name.
 *
 * ## Why `@git-diff-view/shiki` is not installed
 *
 * KAR-17.6's acceptance criterion names it, and the epic's own dependency note
 * pins it at `0.1.7`. Read what it does: it calls `createHighlighter` from the
 * **bundled `shiki` entry** with a list of 34 grammars of its own, keeps that
 * instance in a module-level variable, and exposes it as a `DiffHighlighter`.
 * That is both things the rules above forbid — the bundled entry, and a second
 * instance beside this application's own.
 *
 * The only contract `@git-diff-view/vue` actually has with it is the shape of
 * the object handed to `registerHighlighter`, which is a plain
 * `DiffHighlighter` — `getAST`, `processAST` and four accessors — and
 * `processAST` is exported from `@git-diff-view/core` directly. So
 * `packages/web/src/lib/highlighter.ts` implements that shape over the shared
 * `createHighlighterCore` instance, and the diff view gets Shiki highlighting
 * from the app's one highlighter, which is what AC9 is for. This test is the
 * record of that decision, and what stops somebody "correcting" it back.
 */
import { expect, it, describe as suite } from 'vitest';
import { webSourceFiles } from '../packages/web/scripts/check-graph-facade.ts';

/** The one file allowed to construct a highlighter, package-relative. */
const HIGHLIGHTER = 'src/lib/highlighter.ts';

/** Comments explain the rules above; only code may break them. */
const code = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

const sources = () => webSourceFiles().map((file) => ({ ...file, text: code(file.text) }));

suite('AC9 — exactly one Shiki instance', () => {
  it('constructs a highlighter in one file and nowhere else', () => {
    const constructors = sources()
      .filter((file) => file.text.includes('createHighlighterCore'))
      .map((file) => file.path);

    expect(constructors).toEqual([HIGHLIGHTER]);
  });

  it('has that file, so the assertion above is not vacuously true', () => {
    const highlighter = sources().find((file) => file.path === HIGHLIGHTER);

    expect(highlighter, `${HIGHLIGHTER} is missing`).toBeDefined();
    expect(highlighter?.text).toContain('@shikijs/core');
  });

  it('never imports the bundled shiki entry, which pulls every grammar', () => {
    const offenders = sources()
      .filter((file) => /from\s+['"]shiki(?:\/[^'"]*)?['"]|import\(['"]shiki\//.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('never reaches @git-diff-view/shiki, which is a second highlighter in a trench coat', () => {
    const offenders = sources()
      .filter((file) => file.text.includes('@git-diff-view/shiki'))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('registers that one instance with the diff renderer rather than letting it default', () => {
    // `@git-diff-view/vue` falls back to `lowlight` + `highlight.js` when no
    // `registerHighlighter` is passed, which is a second highlighter arriving
    // by omission rather than by decision.
    const registrars = sources()
      .filter((file) => file.text.includes('registerHighlighter'))
      .map((file) => file.path);

    expect(registrars.length).toBeGreaterThan(0);
  });
});
