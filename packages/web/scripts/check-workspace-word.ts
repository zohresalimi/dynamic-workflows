/**
 * KAR-25.1 AC6, EPIC-25-S05 — "Workspace" does not appear anywhere a person
 * can read it in `packages/web`.
 *
 * Run by `pnpm lint` (and therefore by the pre-push hook and by CI's `check`
 * job), for the same reason `./check-graph-facade.ts` and
 * `./check-terminal-facade.ts` are scripts: this is a rule about source text,
 * and the failure it exists to catch — a rename that missed a nav label, a
 * heading, or a route's display word — is invisible in review the same way a
 * second `Terminal` construction site is.
 *
 * ## Why `\bWorkspace\b`, case-sensitive, is narrow enough not to be blunt
 *
 * A whole-word, capital-`W` match, over comment-stripped source, turns out to
 * exclude every false positive this package actually has without having to
 * special-case a single one of them:
 *
 * - **`WorkspaceApi` / `WorkspaceConfigDocument`** — a TypeScript identifier
 *   has no word boundary between "Workspace" and the letters immediately
 *   after it ("Api", "ConfigDocument" both start with a word character), so
 *   `\b…\b` never matches inside them. `WorkspaceConfigDocument` in
 *   particular is a genuine daemon concept — the *config file* the workspace
 *   used to be named after — and has nothing to do with the renamed screen.
 * - **`workspace__*` classes, `data-workspace-*` hooks, `project-workspace`
 *   (the old route path segment, where it still appears in a comment)** —
 *   all lower-case `w`, which a case-sensitive match never touches. These are
 *   not user-visible strings; EPIC-25-S05 states the rename's scope as "a nav
 *   label, a heading, a breadcrumb or a page title", not an internal hook, and
 *   `ProjectWorkflowsView.vue`'s own header comment records the decision to
 *   leave them alone.
 * - **This file's own prose, and every other file's** — comments are stripped
 *   before matching, exactly as the two facades strip them: a rule that
 *   punished an explanation of the rename would get the explanation deleted.
 *
 * What is left, once those three are accounted for, is exactly what AC6 asks
 * about: a literal "Workspace" sitting in template text, an attribute value, a
 * label table, or any other string a reader — not a `grep` — would encounter.
 */
import { pathToFileURL } from 'node:url';
import {
  type FacadeViolation,
  type ScannedFile,
  stripComments,
  webSourceFiles,
} from './check-graph-facade.ts';

/** Whole-word, case-sensitive: see the header comment for why this is narrow
 * enough to be exact rather than merely lenient. */
const WORKSPACE_WORD = /\bWorkspace\b/;

/** Every violation in `files`, in the order the files were given. */
export function workspaceWordViolations(files: readonly ScannedFile[]): FacadeViolation[] {
  const violations: FacadeViolation[] = [];

  for (const file of files) {
    const code = stripComments(file.text);
    if (!WORKSPACE_WORD.test(code)) continue;

    violations.push({
      where: file.path,
      message:
        `${file.path} still says "Workspace" somewhere a person can read it. ` +
        'KAR-25.1 renamed the word to "Workflows" everywhere it is user-visible — the nav ' +
        "label, the route name, the breadcrumb, the view's own heading (EPIC-25-S05). If " +
        'this is a genuinely internal identifier or class name (lower-case, or part of a ' +
        "longer identifier the guard's word boundary already ignores), it does not belong " +
        'on this list — check `WORKSPACE_WORD` in check-workspace-word.ts before assuming ' +
        'the guard is wrong rather than the string.',
    });
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = workspaceWordViolations(webSourceFiles());
  for (const violation of violations) process.stderr.write(`${violation.message}\n\n`);
  if (violations.length > 0) {
    process.stderr.write(`${violations.length} file(s) still say "Workspace".\n`);
    process.exitCode = 1;
  }
}
