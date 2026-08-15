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

/** The search field `/` focuses. */
export const SEARCH_INPUT_ID = 'DeFlow-search';

/** The Cmd-K run/node jumper. */
export const JUMPER_OVERLAY = 'jumper';

/** The node inspector `Enter` opens for the selected node. */
export const INSPECTOR_OVERLAY = 'inspector';

/**
 * KAR-22.2 AC7 — the run composer `c` opens.
 *
 * An overlay in the shell rather than a panel in a view, for the same reason
 * the jumper is one: *"reachable from anywhere in the project"* is not a
 * property a component mounted by one route can have.
 */
export const COMPOSER_OVERLAY = 'composer';
