/**
 * KAR-16.1 AC7 — the keyboard map (docs/12-frontend-architecture.md §9.5).
 *
 * | Key       | Action                                        |
 * | --------- | --------------------------------------------- |
 * | `j` / `k` | Move between nodes in the graph               |
 * | `Enter`   | Open the node inspector for the selected node |
 * | `←` / `→` | Step the plan-version scrubber                |
 * | `/`       | Search                                        |
 * | `c`       | Start a run — the composer (KAR-22.2 AC7)     |
 * | `Cmd-K`   | Run / node jumper                             |
 * | `Esc`     | Close the topmost overlay                     |
 *
 * **Installed once, on `document`, for the life of the application.** The
 * failure this shape exists to avoid is the one the epic's test plan names:
 * handlers bound to a component that is not always mounted, so the map works on
 * the landing route and quietly stops on every other one. `App.vue` installs it
 * and disposes it; no view ever binds a key.
 *
 * Two rules that are easy to get wrong and miserable to live with:
 *
 * 1. **A focused text field owns its keys.** `j` typed into the search box must
 *    insert a `j`. `Escape` and `Cmd-K` are the exceptions, because they are
 *    how an operator gets *out* of a field.
 * 2. **An open overlay owns the navigation keys.** While the jumper is up, `j`
 *    and `k` move through its list, not through the graph behind it. Only
 *    `Escape` and `Cmd-K` reach past it.
 */
import type { UiStore } from '../stores/useUiStore.ts';
import { COMPOSER_OVERLAY, INSPECTOR_OVERLAY, JUMPER_OVERLAY, SEARCH_INPUT_ID } from './ids.ts';

/** Text-entry contexts, where the map must keep its hands off. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;

  // Checkboxes, radios and buttons are `INPUT` too, and none of them swallows a
  // `j`. Only the ones that take text do.
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit'].includes(type);
}

/**
 * Binds the map to `target` and returns the disposer.
 *
 * `target` is passed in rather than reached for so the same function can be
 * driven against a document in a spec, and so nothing here needs a global.
 */
export function installKeyboardMap(target: Document, ui: UiStore): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    const modified = event.metaKey || event.ctrlKey;

    // Cmd-K / Ctrl-K, from anywhere at all — inside a text field, behind an
    // overlay, on any route.
    if (modified && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      ui.openOverlay(JUMPER_OVERLAY);
      return;
    }
    // Every other modified chord belongs to the browser: Cmd-R, Cmd-L, Cmd-W.
    if (modified || event.altKey) return;

    // Escape, likewise from anywhere — and it closes the topmost overlay only.
    if (event.key === 'Escape') {
      if (ui.overlays.length === 0) return;
      event.preventDefault();
      ui.closeTopOverlay();
      return;
    }

    if (isTyping(event.target)) return;
    // An open overlay owns j/k/Enter/arrows; its own list handles them.
    if (ui.overlays.length > 0) return;

    switch (event.key) {
      case 'j':
        event.preventDefault();
        ui.moveSelection(1);
        return;
      case 'k':
        event.preventDefault();
        ui.moveSelection(-1);
        return;
      case 'Enter':
        if (ui.inspectSelected(INSPECTOR_OVERLAY)) event.preventDefault();
        return;
      case 'ArrowLeft':
        event.preventDefault();
        ui.stepPlanVersion(-1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        ui.stepPlanVersion(1);
        return;
      // KAR-22.2 AC7 — the composer, from any route. Unmodified, like `/`, and
      // guarded by the same `isTyping` check above: a `c` typed into the search
      // box is a `c`, and a `c` typed into the composer's own prompt reaches
      // the prompt rather than reopening the composer on top of itself.
      case 'c':
        event.preventDefault();
        ui.openOverlay(COMPOSER_OVERLAY);
        return;
      case '/': {
        event.preventDefault();
        // By id rather than by a template ref: the map outlives every component
        // and must not hold one.
        target.getElementById(SEARCH_INPUT_ID)?.focus();
        return;
      }
      default:
        return;
    }
  }

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
