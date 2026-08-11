/**
 * KAR-17.5 — the lint rule behind the terminal facade.
 *
 * > `src/lib/terminal-session.ts` is the only file in `packages/web/src` that
 * > names an `@xterm/` package; a lint rule fails the build otherwise.
 *
 * Run by `pnpm lint` (and therefore by the pre-push hook and by CI's `check`
 * job), for the same reason `./check-graph-facade.ts` is a script rather than
 * an oxlint rule: oxlint sees only the `<script>` block of an SFC, and the
 * files most at risk here are SFCs — a panel that wants a `FitAddon` on resize,
 * a view that wants a `SearchAddon`, an inspector tab that wants "just one
 * more terminal".
 *
 * ## What this facade is protecting, which is not tidiness
 *
 * Four disciplines from docs/12-frontend-architecture.md §6.6, and each one
 * fails **silently** when it is missed:
 *
 * - `scrollback: 5000`. At 12 bytes a cell and 200 columns that is ≈ 13 MB per
 *   terminal; 100,000 lines is ≈ 260 MB. Nothing errors. The tab gets slow.
 * - One `Terminal` per *visible* terminal, serialised and disposed on unmount.
 *   Browsers cap WebGL contexts at roughly 8–16, and going over kills rendering
 *   **in the oldest terminal**, with no error, no warning and no obvious cause.
 * - WebGL with a DOM fallback wired to `onContextLoss`. A missing fallback is
 *   invisible until a driver hiccups on somebody else's machine.
 * - `markRaw`. A Vue proxy over megabytes of typed arrays is a performance bug
 *   whose only symptom is slowness.
 *
 * A second `new Terminal(...)` anywhere in this package would satisfy none of
 * those and look completely reasonable in review. That is what this refuses.
 *
 * Comments are stripped before matching, exactly as the graph facade does it:
 * the panel, the router and the budget module all *explain* the xterm rules at
 * length, and a check that punished the explanation would get the explanation
 * deleted.
 */
import { pathToFileURL } from 'node:url';
import {
  type FacadeViolation,
  type ScannedFile,
  stripComments,
  webSourceFiles,
} from './check-graph-facade.ts';

/** The one file allowed to name an xterm package, package-relative. */
export const TERMINAL_FACADE = 'src/lib/terminal-session.ts';

/**
 * The **scope**, not one package.
 *
 * `@xterm/xterm` is the terminal; `@xterm/addon-webgl`, `@xterm/addon-serialize`
 * and `@xterm/addon-fit` are the three the facade loads. A rule naming only the
 * core package would leave a component free to load a fourth addon onto a
 * terminal it reached through some other route — and `@xterm/addon-canvas` is
 * the one that matters most, because it was **removed in v6** and an install of
 * it would be a renderer nobody can support.
 */
const SPECIFIER = '@xterm/';

/** Every violation in `files`, in the order the files were given. */
export function terminalFacadeViolations(files: readonly ScannedFile[]): FacadeViolation[] {
  const violations: FacadeViolation[] = [];

  for (const file of files) {
    if (file.path === TERMINAL_FACADE) continue;
    if (!stripComments(file.text).includes(SPECIFIER)) continue;

    violations.push({
      where: file.path,
      message:
        `${file.path} reaches past the terminal facade: it names an ${SPECIFIER} package ` +
        `itself. ${TERMINAL_FACADE} is the only file allowed to (KAR-17.5 AC3, AC4). ` +
        'The four xterm disciplines — scrollback 5000, one Terminal per *visible* panel, ' +
        'a DOM fallback wired to onContextLoss, and markRaw — all fail silently when they ' +
        'are missed, so they are enforced by there being one construction site rather than ' +
        'by everybody remembering. Whatever this file needs belongs on the session ' +
        'returned by openTerminalSession().',
    });
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = terminalFacadeViolations(webSourceFiles());
  for (const violation of violations) process.stderr.write(`${violation.message}\n\n`);
  if (violations.length > 0) {
    process.stderr.write(`${violations.length} file(s) reach past ${TERMINAL_FACADE}.\n`);
    process.exitCode = 1;
  }
}
