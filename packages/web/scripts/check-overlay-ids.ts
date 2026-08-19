/**
 * KAR-25.5 AC7, EPIC-25-S37 — the composer's overlay id is gone, not
 * dangling.
 *
 * Run by `pnpm lint` (and therefore by the pre-push hook and by CI's `check`
 * job), on the same model as `./check-workspace-word.ts`: a rule about source
 * text, because the failure it exists to catch — a call site that survived a
 * removal and now opens or checks an overlay id nothing renders — is
 * invisible in review the way a second `Terminal` construction site is.
 *
 * `RunComposer.vue` used to be the third overlay host beside `CommandJumper`
 * (`JUMPER_OVERLAY`) and `NodeInspector` (`INSPECTOR_OVERLAY`); KAR-25.5 made
 * it a route instead, and `COMPOSER_OVERLAY` and its store entry went with it
 * — see `../src/app/ids.ts`'s history and `../src/App.vue`'s `openComposer()`.
 * The store's `overlays` stack itself is generic and stays (`CommandJumper`
 * and `NodeInspector` still use it); what must not survive is a call naming
 * an id that has no mounted host.
 *
 * Two checks, both narrow:
 *
 * 1. **No `openOverlay(X)` / `isOverlayOpen(X)` names an id outside the
 *    hosted set** (`jumper`, `inspector`). A third id here is either a typo
 *    for one of the two, or a new overlay whose host was never wired up —
 *    both are bugs this rule is written to catch before review has to.
 * 2. **`COMPOSER_OVERLAY` is not exported from `ids.ts` at all.** Removing
 *    every call site but leaving the constant behind is how a "removed"
 *    overlay comes back the next time somebody reaches for a composer id and
 *    finds one sitting right there.
 */
import { pathToFileURL } from 'node:url';
import {
  type FacadeViolation,
  type ScannedFile,
  stripComments,
  webSourceFiles,
} from './check-graph-facade.ts';

/** The overlay ids that have a mounted host — the only ones any call site may
 * name. Update this set, not the regex, the day a third overlay host ships. */
export const HOSTED_OVERLAY_IDS: ReadonlySet<string> = new Set(['jumper', 'inspector']);

/** `openOverlay('x')` / `isOverlayOpen('x')`, single- or double-quoted. */
const OVERLAY_CALL = /\b(?:openOverlay|isOverlayOpen)\(\s*['"]([^'"]+)['"]/g;

/** Every violation in `files`, in the order the files were given. */
export function overlayIdViolations(files: readonly ScannedFile[]): FacadeViolation[] {
  const violations: FacadeViolation[] = [];

  for (const file of files) {
    const code = stripComments(file.text);

    for (const match of code.matchAll(OVERLAY_CALL)) {
      const id = match[1];
      if (id === undefined || HOSTED_OVERLAY_IDS.has(id)) continue;
      violations.push({
        where: file.path,
        message:
          `${file.path} calls an overlay function with "${id}", which names no mounted ` +
          `overlay host (only ${[...HOSTED_OVERLAY_IDS].join(', ')} do). KAR-25.5 removed ` +
          'the composer overlay — this call site is either a leftover reference to it or a ' +
          'new overlay whose host was never wired up.',
      });
    }

    if (/\bexport\s+const\s+COMPOSER_OVERLAY\b/.test(code)) {
      violations.push({
        where: file.path,
        message:
          `${file.path} still exports COMPOSER_OVERLAY. KAR-25.5 AC7 removed the composer's ` +
          'overlay id along with the overlay itself — the run composer is a route now ' +
          '(`/projects/:projectId/new-run`), and a constant left behind is how it comes back.',
      });
    }
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = overlayIdViolations(webSourceFiles());
  for (const violation of violations) process.stderr.write(`${violation.message}\n\n`);
  if (violations.length > 0) {
    process.stderr.write(`${violations.length} violation(s) of the overlay-id rule.\n`);
    process.exitCode = 1;
  }
}
