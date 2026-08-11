/**
 * KAR-16.6 AC1 — the lint rule behind the graph facade.
 *
 * > `GraphCanvas.vue` is the only file in `packages/web/src` that imports
 * > `@vue-flow/core`; a lint rule fails the build otherwise.
 *
 * Run by `pnpm lint` (and therefore by the pre-push hook and by CI's `check`
 * job). It exits non-zero naming every offending file, because a facade is only
 * a facade while nothing reaches past it — and "nothing reaches past it" is not
 * a property anybody can hold in their head across nine views and a year.
 *
 * ## Why a script and not an ESLint/oxlint rule
 *
 * oxlint sees only the `<script>` block of an SFC (docs/CONTRIBUTING.md, and
 * `.oxlintrc.json` excludes `packages/web/**` for exactly that reason), and
 * every file at risk here *is* an SFC — a view that wants a minimap, a node
 * type, `useVueFlow()` for a viewport transform. A `no-restricted-imports`
 * entry aimed at this would be inert against the files it is meant to cover,
 * and inert-but-configured reads as protection that is not there.
 *
 * ## What counts as reaching past the facade
 *
 * Any mention of the package specifier in code: a default import, a named
 * import, a type-only import, a side-effect import of its stylesheet, a
 * re-export, a dynamic `import()`, a `require`, a subpath, and a CSS `@import`
 * inside a `<style>` block. The test plan's red for this rule is *"the rule
 * matches only the default export"*, so the match is on the **specifier**
 * rather than on any import syntax, and the exemptions are two: the facade
 * itself, and comments.
 *
 * Comments are stripped before matching for the same reason
 * `test/no-replay-branch-in-web.test.ts` strips them: the views explain why
 * they render through `GraphCanvas`, and a rule that punished the explanation
 * would get the explanation deleted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The one file allowed to import Vue Flow, package-relative. */
export const FACADE = 'src/components/graph/GraphCanvas.vue';

/** The package this rule is about. Sub-paths of it count too. */
const SPECIFIER = '@vue-flow/core';

/**
 * The one stylesheet the renderer's own sheet may be `@import`ed from, and the
 * exact line that is allowed.
 *
 * Not a hole in the rule so much as the second half of the swap's checklist.
 * The sheet is pulled in from the global stylesheet rather than from the facade
 * because two rules below it override it — the reduced-motion block and the
 * node border colour — and an override only wins at equal specificity if it
 * comes *later* in the cascade, which the module graph's import order does not
 * guarantee (KAR-16.1, `src/styles/theme.css`). So it is one line, in one file,
 * named here, and every other mention of the package in that same file is
 * refused exactly as it is anywhere else.
 */
export const CASCADE_OWNER = 'src/styles/theme.css';
export const RENDERER_STYLESHEET = '@vue-flow/core/dist/style.css';

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC_ROOT = join(WEB_ROOT, 'src');

export interface ScannedFile {
  /** Package-relative, always with forward slashes. */
  readonly path: string;
  readonly text: string;
}

export interface FacadeViolation {
  readonly where: string;
  readonly message: string;
}

/**
 * `text` with its comments removed.
 *
 * Naive on purpose — a grep, not a parser — and the direction of its error is
 * the safe one: the worst it can do is strip too much of a string literal, and
 * a specifier inside a string literal that is not an import is not a thing this
 * codebase contains. HTML comments are stripped too, because a `<template>` can
 * carry one.
 */
export function stripComments(text: string): string {
  return text
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every violation in `files`, in the order the files were given. */
export function graphFacadeViolations(files: readonly ScannedFile[]): FacadeViolation[] {
  const violations: FacadeViolation[] = [];

  for (const file of files) {
    if (file.path === FACADE) continue;

    const code =
      file.path === CASCADE_OWNER
        ? stripComments(file.text).replaceAll(
            new RegExp(`@import\\s+["']${RENDERER_STYLESHEET}["']\\s*;`, 'g'),
            ' ',
          )
        : stripComments(file.text);
    if (!code.includes(SPECIFIER)) continue;

    violations.push({
      where: file.path,
      message:
        `${file.path} reaches past the graph facade: it names ${SPECIFIER} itself. ` +
        `${FACADE} is the only file allowed to (KAR-16.6 AC1). Vue Flow is the largest ` +
        'third-party risk in this frontend — one maintainer, no announced v2 — and the ' +
        'facade is what keeps replacing it a one-file change. Whatever this file needs ' +
        'from Vue Flow belongs on GraphCanvas as a DeFlow-typed prop, event or slot.',
    });
  }

  return violations;
}

/** Every `.ts`/`.vue`/`.css` source under `packages/web/src`, specs included. */
export function webSourceFiles(root: string = SRC_ROOT): ScannedFile[] {
  const found: ScannedFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__snapshots__' || entry.name === '__screenshots__') continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|vue|css)$/.test(entry.name)) continue;
      found.push({
        path: relative(WEB_ROOT, path).split(sep).join('/'),
        text: readFileSync(path, 'utf8'),
      });
    }
  };

  walk(root);
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = graphFacadeViolations(webSourceFiles());
  for (const violation of violations) process.stderr.write(`${violation.message}\n\n`);
  if (violations.length > 0) {
    process.stderr.write(`${violations.length} file(s) reach past ${FACADE}.\n`);
    process.exitCode = 1;
  }
}
