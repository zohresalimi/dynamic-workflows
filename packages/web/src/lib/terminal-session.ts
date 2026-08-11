/**
 * KAR-17.5 — the **only** file in `packages/web/src` that imports `@xterm/*`.
 *
 * Verifies: EPIC-17-S20 (scenario 2), EPIC-17-S22 · AC3, AC4, AC5, AC9
 *
 * A facade for the same reason `components/graph/GraphCanvas.vue` is one, and
 * `packages/web/scripts/check-terminal-facade.ts` enforces it: the four
 * disciplines docs/12-frontend-architecture.md §6.6 calls non-negotiable are
 * only true of a build if they are true of **every** terminal in it, and
 * "everybody remembers to pass `scrollback: 5000`" is not a property anybody
 * can hold across nine views and a year.
 *
 * ## The four disciplines, and where each one lives
 *
 * 1. **`scrollback: 5000` and never raise it.** From `./terminal-budget.ts`,
 *    which carries the arithmetic and the ceiling test. It is not an option on
 *    this function, because an option is a thing a caller sets.
 * 2. **One `Terminal` per *visible* terminal.** `open()` constructs, `close()`
 *    serialises and disposes, and `liveTerminalCount()` is what a spec asserts
 *    against the number of mounted panels. Browsers cap WebGL contexts at
 *    roughly 8–16 and the failure is **silent, in the oldest terminal**.
 * 3. **DOM or WebGL, never canvas.** `@xterm/addon-canvas` was removed in v6.
 *    The WebGL addon is loaded and its `onContextLoss` disposes it, which drops
 *    xterm back to its default DOM renderer with the buffer untouched — the
 *    buffer belongs to the `Terminal`, not to the renderer.
 * 4. **`markRaw` the `Terminal`.** Done at the boundary here rather than in the
 *    component, so a second component cannot forget. Vue's proxy over an object
 *    holding megabytes of typed arrays is a performance bug with no symptom
 *    except slowness.
 *
 * ## `screenReaderMode` (AC9)
 *
 * Off by default. It makes xterm maintain a parallel live-region representation
 * of the buffer, which is expensive on a stream that never stops — so it is a
 * setting the operator turns on, not a default everyone pays for. The panel's
 * a11y story without it is the **archive viewer**, which is ordinary DOM text.
 */
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { markRaw } from 'vue';
import { TERMINAL_SCROLLBACK } from './terminal-budget.ts';

export { SCROLLBACK_CEILING_BYTES, TERMINAL_SCROLLBACK } from './terminal-budget.ts';

/** Which renderer a session is currently painting with. */
export type TerminalRenderer = 'webgl' | 'dom';

export interface TerminalSessionOptions {
  /**
   * What the retained snapshot is filed under — the node, so re-opening the
   * same node's panel restores it and opening a different one does not.
   */
  readonly key: string;
  readonly element: HTMLElement;
  /** AC9. Off unless the operator turned it on. */
  readonly screenReaderMode?: boolean;
  /** Called when a real context loss drops this session to the DOM renderer. */
  readonly onRenderer?: (renderer: TerminalRenderer) => void;
}

/**
 * A live terminal.
 *
 * `dispose()` rather than `close()` so a session satisfies the run store's
 * `DisposableTerminal` (KAR-16.4) and is counted by the same leak assertion as
 * everything else Vue must not own — one accounting of live terminals, not two
 * that agree today.
 */
export interface TerminalSession {
  /** The raw `Terminal`, already `markRaw`'d. For assertions and for `write`. */
  readonly terminal: Terminal;
  readonly renderer: TerminalRenderer;
  /** True when this session opened over a retained snapshot. */
  readonly restored: boolean;
  write(data: string): void;
  /**
   * Serialises, remembers the string under `key`, and disposes.
   *
   * Idempotent: the component disposes on unmount and the store disposes what
   * it adopted, and which of the two runs first is not something either should
   * have to know.
   */
  dispose(): string;
}

/**
 * Live sessions.
 *
 * A `Set` of the sessions rather than a counter, because a counter that a
 * double-`close()` decremented twice would report a leak-free build while
 * leaking — and the number this is compared against is *"how many panels are
 * mounted"*, which is a set too.
 */
const live = new Set<TerminalSession>();

/** The retained strings — all that survives a closed panel. */
const snapshots = new Map<string, string>();

/** AC4 — how many `Terminal` instances exist right now. */
export const liveTerminalCount = (): number => live.size;

/** The retained snapshot for `key`, or `null`. */
export const terminalSnapshot = (key: string): string | null => snapshots.get(key) ?? null;

/** Test seam: drops the retained strings so one spec cannot seed the next. */
export const forgetTerminalSnapshots = (): void => snapshots.clear();

/**
 * Opens a terminal over `element`, restoring the retained snapshot if there is
 * one.
 *
 * The snapshot is written **before** `open()`, which is the addon's own
 * recommendation: writing into a terminal that is already attached spends CPU
 * rendering frames of a buffer that is about to be replaced by the next line of
 * it.
 */
export function openTerminalSession(options: TerminalSessionOptions): TerminalSession {
  const snapshot = snapshots.get(options.key) ?? null;

  const terminal = markRaw(
    new Terminal({
      // Discipline 1. Not an option, not a prop, not configurable.
      scrollback: TERMINAL_SCROLLBACK,
      // Discipline 4's companion: AC9's default, stated rather than inherited.
      screenReaderMode: options.screenReaderMode === true,
      convertEol: true,
      fontSize: 12,
      // The panel is read-only — the interactive PTY is KAR-15.8's socket, and
      // a cursor that blinks in a tail nobody can type into is a lie.
      cursorBlink: false,
      disableStdin: true,
    }),
  );

  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  const fit = new FitAddon();
  terminal.loadAddon(fit);

  if (snapshot !== null) terminal.write(snapshot);
  terminal.open(options.element);

  let renderer: TerminalRenderer = 'dom';
  let webgl: WebglAddon | null = null;

  try {
    webgl = new WebglAddon();
    // Discipline 3. Disposing the addon is the fallback: xterm reverts to its
    // own DOM renderer, and the buffer — which lives on the Terminal — is
    // untouched. There is no canvas addon to fall back to; v6 removed it.
    webgl.onContextLoss(() => {
      webgl?.dispose();
      webgl = null;
      renderer = 'dom';
      options.onRenderer?.('dom');
    });
    terminal.loadAddon(webgl);
    renderer = 'webgl';
  } catch {
    // A machine with no GL at all — a VM, a locked-down browser, a driver
    // blocklist. The DOM renderer is correct here and not a degradation worth
    // reporting as an error.
    webgl = null;
    renderer = 'dom';
  }

  try {
    fit.fit();
  } catch {
    // A panel that is not laid out yet. The next resize fits it.
  }

  const session: TerminalSession = {
    terminal,
    get renderer() {
      return renderer;
    },
    restored: snapshot !== null,
    write: (data: string) => terminal.write(data),
    dispose(): string {
      if (!live.has(session)) return snapshots.get(options.key) ?? '';

      // Discipline 2, in the only order that works: **serialise first**. After
      // `dispose()` the addon has no buffer to read and returns an empty
      // string, and the panel re-opens blank — which reads as "the node
      // produced nothing" rather than as a bug.
      let text = '';
      try {
        text = serializer.serialize();
      } catch {
        text = '';
      }
      snapshots.set(options.key, text);

      // Removed from the live set *before* the disposals, so a re-entrant call
      // from a store disposing what it adopted takes the branch above.
      live.delete(session);
      webgl?.dispose();
      webgl = null;
      terminal.dispose();
      return text;
    },
  };

  live.add(session);
  options.onRenderer?.(renderer);
  return session;
}
