/**
 * KAR-17.8 AC10 — the frontend imports the arithmetic half of d3 and nothing
 * else.
 *
 * Verifies: EPIC-17-S30 · AC10 · test plan row 8
 *
 * > Only `d3-scale`, `d3-array`, `d3-shape`, `d3-axis` and `d3-time-format` are
 * > imported — never the `d3` metapackage — and no `d3-selection` call exists
 * > anywhere in the component.
 *
 * Two rules, and they are different rules.
 *
 * **The metapackage** is a bundle-size question with a correctness tail. `d3`
 * re-exports thirty modules including `d3-selection`, `d3-zoom`, `d3-drag` and
 * `d3-transition`, so one `import { scaleTime } from 'd3'` ships the DOM half
 * whether or not anybody calls it — and, worse, makes calling it a
 * one-character change that no reviewer would notice.
 *
 * **`d3-selection`** is an architecture question and the one that matters.
 * `select(el).append(…)` gives the subtree a second owner beside Vue's renderer
 * (docs/12-frontend-architecture.md §6.9), and the bugs that produces are not
 * fixable in the ordinary sense: the two disagree about what is in the DOM, and
 * which one wins depends on patch order. The Gantt is `<rect>`s in a template
 * with a `:x` and a `:width`; the scales are pure functions from data to
 * numbers. Neither needs a selection.
 *
 * `d3-axis` is inside AC10's allowed set and is deliberately *not installed*,
 * which is worth stating because its absence looks like an oversight. Its whole
 * API is `axisBottom(scale)(selection)` — a renderer that only knows how to
 * write through `d3-selection`. Importing it would put the banned package back
 * in the graph as a transitive dependency and put the second owner back on the
 * subtree. `scale.ticks()` and `scale.tickFormat()` are `d3-scale`'s, need no
 * selection, and are what the template iterates.
 *
 * The rule is a grep over the *source*, and it is one for the reason
 * `check-graph-facade.ts` gives: oxlint sees only the `<script>` block of an
 * SFC, and every file at risk here is an SFC. It is checked against the
 * dependency manifests too, because a package that is not installed cannot be
 * imported by accident, and that is the cheaper half of the guarantee.
 */
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import {
  type ScannedFile,
  stripComments,
  webSourceFiles,
} from '../packages/web/scripts/check-graph-facade.ts';

/**
 * The five modules AC10 permits.
 *
 * A list rather than a `d3-*` wildcard: the point is that reaching for another
 * one is a decision somebody makes on purpose, in this file, with the reason
 * written down — which is exactly what did not happen the last time a chart
 * needed a zoom behaviour.
 */
const ALLOWED = ['d3-scale', 'd3-array', 'd3-shape', 'd3-axis', 'd3-time-format'] as const;

/** Every `d3…` specifier `text` names, in any import spelling. */
export function d3Specifiers(text: string): string[] {
  const code = stripComments(text);
  const found = new Set<string>();
  // Matches the specifier inside any quoted string — which covers a static
  // import, a type-only import, a side-effect import, a re-export, a dynamic
  // `import()`, a `require` and a subpath, without caring which it was.
  for (const match of code.matchAll(/["'](d3(?:-[a-z-]+)?)(?:\/[^"']*)?["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  return [...found].toSorted();
}

const webFiles = (): readonly ScannedFile[] => webSourceFiles();

const manifest = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;

suite('AC10 — the grep catches every spelling', () => {
  it.each([
    ['a named import', "import { scaleTime } from 'd3-scale';"],
    ['a type-only import', "import type { ScaleTime } from 'd3-scale';"],
    ['a default import', "import scale from 'd3-scale';"],
    ['a side-effect import', "import 'd3-selection';"],
    ['a re-export', "export { select } from 'd3-selection';"],
    ['a star re-export', "export * from 'd3-selection';"],
    ['a dynamic import', "const d = await import('d3-selection');"],
    ['a require', "const d = require('d3-selection');"],
    ['a subpath', "import { select } from 'd3-selection/src/select.js';"],
    ['a double-quoted import', 'import { select } from "d3-selection";'],
    ['the metapackage', "import { scaleTime } from 'd3';"],
  ])('sees %s', (_what, line) => {
    expect(d3Specifiers(line).length).toBe(1);
  });

  it('does not count a mention inside a comment, so the reason can be written down', () => {
    expect(d3Specifiers("// never import 'd3-selection' here\n")).toEqual([]);
    expect(d3Specifiers("/* the 'd3' metapackage is banned */\n")).toEqual([]);
  });

  it('does not count an unrelated specifier that merely starts with the letters', () => {
    expect(d3Specifiers("import x from 'd3po-charts';")).toEqual([]);
  });
});

suite('AC10 — no file under packages/web/src reaches for the DOM half', () => {
  it('imports the d3 metapackage nowhere', () => {
    const offenders = webFiles()
      .filter((file) => d3Specifiers(file.text).includes('d3'))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('imports d3-selection nowhere, and therefore calls it nowhere', () => {
    const offenders = webFiles()
      .filter((file) => d3Specifiers(file.text).includes('d3-selection'))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('imports only the five modules AC10 allows', () => {
    const strays = webFiles().flatMap((file) =>
      d3Specifiers(file.text)
        .filter((specifier) => !ALLOWED.includes(specifier as (typeof ALLOWED)[number]))
        .map((specifier) => `${file.path} → ${specifier}`),
    );

    expect(strays).toEqual([]);
  });

  it('finds the ones that are used, so a passing audit is not an audit of nothing', () => {
    const used = new Set(webFiles().flatMap((file) => d3Specifiers(file.text)));

    expect(used).toContain('d3-scale');
    expect(used).toContain('d3-shape');
  });
});

suite('AC10 — what is not installed cannot be imported by accident', () => {
  it('lists neither the metapackage nor d3-selection in @DeFlow/web', () => {
    const web = manifest('../packages/web/package.json');
    const declared = Object.keys({
      ...(web.dependencies as Record<string, string>),
      ...(web.devDependencies as Record<string, string>),
    });

    expect(declared).not.toContain('d3');
    expect(declared).not.toContain('d3-selection');
  });

  it('pins every d3 module it does declare through the catalog', () => {
    const web = manifest('../packages/web/package.json');
    const deps = web.dependencies as Record<string, string>;
    const d3Deps = Object.entries(deps).filter(([name]) => name.startsWith('d3-'));

    expect(d3Deps.length).toBeGreaterThan(2);
    for (const [, range] of d3Deps) expect(range).toBe('catalog:');
  });
});
