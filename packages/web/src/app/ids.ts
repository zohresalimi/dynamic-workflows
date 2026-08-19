/**
 * KAR-16.1 — the handful of DOM ids and overlay names the shell shares with the
 * keyboard map.
 *
 * They are constants in one module rather than string literals at both ends
 * because the keyboard map deliberately does **not** hold a component
 * reference: it lives on `document` for the life of the application (AC7's
 * "handlers bound to a component that is not always mounted" failure), so the
 * only thing it can hold onto is a name. A literal typed twice is a `/` that
 * silently stops focusing search.
 */

/** The `<main>` the skip-link jumps to. */
export const MAIN_CONTENT_ID = 'DeFlow-main';

/** The search field `/` focuses — everywhere except the composer, which has
 * its own field and outranks it (see `PROMPT_INPUT_ID`). */
export const SEARCH_INPUT_ID = 'DeFlow-search';

/**
 * KAR-25.5 AC5 — the composer's prompt box, the other thing `/` can focus.
 *
 * Only ever one of this and `SEARCH_INPUT_ID` is in the document at a time:
 * the composer is a route now (`/projects/:projectId/new-run`), so this id
 * exists exactly when that route is mounted. `../app/keyboard.ts`'s `/`
 * handler checks for it first for exactly that reason — on the composer's own
 * route, `/` should focus the prompt, not a search field the operator cannot
 * see filled in behind it.
 */
export const PROMPT_INPUT_ID = 'DeFlow-prompt';

/** The Cmd-K run/node jumper. */
export const JUMPER_OVERLAY = 'jumper';

/** The node inspector `Enter` opens for the selected node. */
export const INSPECTOR_OVERLAY = 'inspector';
