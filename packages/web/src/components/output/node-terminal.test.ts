/**
 * KAR-17.5 test plan rows 3, 4 and 5 — the dispose discipline, in a real
 * Chromium with a real WebGL context.
 *
 * Verifies: EPIC-17-S20 (scenario 2), EPIC-17-S22 · AC3, AC4, AC5, AC9
 *
 * Every claim here is about a resource the browser owns, which is why none of
 * it can be asserted anywhere but in a browser. `Terminal` holds large typed
 * arrays; `WebglAddon` holds a GL context; and browsers cap GL contexts at
 * roughly 8–16 with a failure mode that is **silent and in the oldest
 * terminal** — no error, no warning, no obvious cause. A spec against a fake
 * terminal would pass for a build that leaks every one of them.
 *
 * Row 5 loses the context **for real**: `WEBGL_lose_context.loseContext()` on
 * the addon's own canvas fires a genuine `webglcontextlost`, which is what the
 * addon's `onContextLoss` is wired to. Calling the fallback directly would
 * assert that a function works, which was never in doubt — the row's red is
 * *"the fallback was assumed and never wired"*, and only a real loss can tell
 * those apart.
 */

import { afterEach, expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { isProxy } from 'vue';
import {
  forgetTerminalSnapshots,
  liveTerminalCount,
  TERMINAL_SCROLLBACK,
  terminalSnapshot,
} from '../../lib/terminal-session.ts';
import NodeTerminal from './NodeTerminal.vue';

/** Every mounted component this file opened, so a failure cannot leak one. */
const open: { unmount: () => void }[] = [];

function mount(nodeId: string, text: string) {
  const screen = render(NodeTerminal, { props: { nodeId, text } });
  open.push(screen);
  return screen;
}

afterEach(() => {
  for (const screen of open.splice(0)) screen.unmount();
  forgetTerminalSnapshots();
  expect(liveTerminalCount()).toBe(0);
});

/**
 * The addon's own GL context, found by asking every canvas in the terminal for
 * one.
 *
 * `getContext('webgl2')` on a canvas that already has a WebGL2 context returns
 * **that** context rather than a second one, so this is the real context the
 * addon is painting with and not a lookalike. A canvas holding a 2d context
 * answers `null`, which is how the wrong ones are skipped.
 */
function glContext(root: ParentNode): WebGL2RenderingContext | WebGLRenderingContext | null {
  for (const canvas of root.querySelectorAll('canvas')) {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl !== null) return gl;
  }
  return null;
}

/**
 * What the terminal is actually holding, read off the buffer rather than the
 * DOM.
 *
 * With the WebGL renderer the glyphs are on a canvas and `textContent` is
 * empty — so a DOM assertion would report "the buffer was lost" for a terminal
 * that is painting the text perfectly. The buffer is the claim; the renderer is
 * not.
 */
function bufferText(root: ParentNode): string {
  const host = root.querySelector('[data-terminal]') as HTMLElement & {
    __terminal?: {
      buffer: { active: { length: number; getLine(i: number): { translateToString(): string } } };
    };
  };
  const buffer = host.__terminal?.buffer.active;
  if (buffer === undefined) return '';

  let text = '';
  for (let line = 0; line < buffer.length; line += 1) {
    text += `${buffer.getLine(line)?.translateToString() ?? ''}\n`;
  }
  return text;
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

suite('EPIC-17-S22 — twenty terminals opened, and the contexts that were not leaked', () => {
  it('keeps the live Terminal count equal to the visible count, over twenty', async () => {
    // The row's red — one `Terminal` per *opened* terminal — passes every
    // rendering assertion in this file and kills the tab on the twentieth.
    for (let index = 0; index < 20; index += 1) {
      const screen = mount(`n_impl_${index}`, `attempt ${index}\r\n`);
      await settle();
      expect(liveTerminalCount(), `after opening terminal ${index}`).toBe(1);

      screen.unmount();
      open.pop();
      expect(liveTerminalCount(), `after closing terminal ${index}`).toBe(0);
    }
  });

  it('holds one Terminal per visible panel when several are visible at once', async () => {
    mount('n_a', 'a\r\n');
    mount('n_b', 'b\r\n');
    mount('n_c', 'c\r\n');
    await settle();

    expect(liveTerminalCount()).toBe(3);
  });

  it('never lets Vue’s proxy touch the Terminal (S22 scenario 4)', async () => {
    const screen = mount('n_raw', 'raw\r\n');
    await settle();

    const terminal = (
      screen.container.querySelector('[data-terminal]') as HTMLElement & {
        __terminal?: unknown;
      }
    ).__terminal;

    expect(terminal).toBeDefined();
    expect(isProxy(terminal)).toBe(false);
  });
});

suite('AC3 — how the terminal is configured', () => {
  it('sets scrollback to 5,000 and does not take it from a prop', async () => {
    const screen = mount('n_scroll', 'x\r\n');
    await settle();

    const host = screen.container.querySelector('[data-terminal]') as HTMLElement;
    expect(host.getAttribute('data-scrollback')).toBe(String(TERMINAL_SCROLLBACK));
    expect(TERMINAL_SCROLLBACK).toBe(5_000);
  });

  it('loads the WebGL addon, with no canvas addon anywhere (removed in v6)', async () => {
    const screen = mount('n_gl', 'x\r\n');
    await settle();

    const host = screen.container.querySelector('[data-terminal]') as HTMLElement;
    expect(host.getAttribute('data-renderer')).toBe('webgl');
    expect(glContext(screen.container)).not.toBeNull();
  });

  it('leaves screenReaderMode off, because it is expensive (AC9)', async () => {
    const screen = mount('n_sr', 'x\r\n');
    await settle();

    const host = screen.container.querySelector('[data-terminal]') as HTMLElement;
    expect(host.getAttribute('data-screen-reader')).toBe('off');
  });

  it('turns screenReaderMode on when the setting asks for it (AC9)', async () => {
    const screen = render(NodeTerminal, {
      props: { nodeId: 'n_sr_on', text: 'x\r\n', screenReaderMode: true },
    });
    open.push(screen);
    await settle();

    const host = screen.container.querySelector('[data-terminal]') as HTMLElement;
    expect(host.getAttribute('data-screen-reader')).toBe('on');
  });
});

suite('EPIC-17-S20 scenario 2 / row 4 — serialise, dispose, re-show', () => {
  it('takes the snapshot before disposal, not after', async () => {
    // The row's red. `dispose()` first and the serialize addon returns an empty
    // string, so the panel re-opens blank and the operator concludes the node
    // produced nothing.
    const screen = mount('n_impl_3', 'installing dependencies\r\ndone\r\n');
    await settle();

    screen.unmount();
    open.pop();

    const snapshot = terminalSnapshot('n_impl_3');
    expect(snapshot).not.toBeNull();
    expect(snapshot).toContain('installing dependencies');
    expect(liveTerminalCount()).toBe(0);
  });

  it('restores the buffer from the snapshot string on re-show, with no refetch', async () => {
    const first = mount('n_impl_3', 'installing dependencies\r\ndone\r\n');
    await settle();
    first.unmount();
    open.pop();

    // Re-shown with **no text at all**: everything visible has to have come out
    // of the retained string, which is what "keep only the string" means.
    const second = mount('n_impl_3', '');
    await settle();

    const host = second.container.querySelector('[data-terminal]') as HTMLElement;
    expect(bufferText(second.container)).toContain('installing dependencies');
    expect(host.getAttribute('data-restored')).toBe('true');
  });

  it('keeps only the string — the disposed Terminal is gone, not hidden', async () => {
    const screen = mount('n_impl_9', 'first\r\n');
    await settle();
    screen.unmount();
    open.pop();

    expect(liveTerminalCount()).toBe(0);
    expect(terminalSnapshot('n_impl_9')).toContain('first');
  });
});

suite('row 5 — a real context loss falls back to DOM without losing the buffer', () => {
  it('drops to the DOM renderer and keeps every line', async () => {
    const screen = mount('n_loss', 'line one\r\nline two\r\n');
    await settle();

    const host = screen.container.querySelector('[data-terminal]') as HTMLElement;
    expect(host.getAttribute('data-renderer')).toBe('webgl');

    const gl = glContext(screen.container);
    expect(gl, 'the WebGL addon is painting with a real context').not.toBeNull();
    const lose = gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null;
    expect(lose, 'headless Chromium exposes WEBGL_lose_context').not.toBeNull();

    lose?.loseContext();

    // The addon does **not** fire `onContextLoss` on the `webglcontextlost`
    // event. It calls `preventDefault()` and waits 3,000 ms for a
    // `webglcontextrestored` that a driver hiccup would produce, and only then
    // gives up (`WebglRenderer.ts`, `_contextRestorationTimeout`). So the
    // fallback is genuinely three seconds away, and a spec polling for two
    // would fail against a perfectly wired build — which is worth knowing about
    // the real thing, and is exactly what a hand-fired callback would hide.
    await expect.poll(() => host.getAttribute('data-renderer'), { timeout: 10_000 }).toBe('dom');

    // The buffer is the terminal's, not the renderer's — losing the context
    // must not lose a single line of what the operator was reading.
    const text = bufferText(screen.container);
    expect(text).toContain('line one');
    expect(text).toContain('line two');
    expect(liveTerminalCount()).toBe(1);
  });
});
