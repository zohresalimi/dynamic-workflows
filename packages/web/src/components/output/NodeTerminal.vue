<script setup lang="ts">
/**
 * KAR-17.5 — the CLI-shim path: a live tail in xterm.
 *
 * Verifies: EPIC-17-S20 (scenarios 1 and 2), EPIC-17-S22 · AC3, AC4, AC5, AC9
 *
 * This component is deliberately thin. Every rule that matters — the scrollback
 * cap, the serialise-then-dispose order, the WebGL fallback, the `markRaw` —
 * belongs to `../../lib/terminal-session.ts`, because a rule that lives in a
 * component is a rule the second component does not have.
 *
 * What is here is the **lifecycle**: one `Terminal` per *visible* panel. It is
 * constructed on mount and closed on unmount, and "closed" means serialised to
 * a string and disposed. Tab-hiding is the same event as unmounting as far as
 * this component is concerned, because a hidden panel is `v-if`'d away rather
 * than left mounted behind a `display: none` — which is the shape that makes
 * "live equals visible" checkable rather than aspirational.
 *
 * `__terminal` on the host element looks like a test hook and is one, but it is
 * also the honest way to assert `isProxy(terminal) === false` from outside: the
 * whole claim is about the object Vue is holding, and exposing a `ref` to it
 * would wrap it in the proxy the claim is about.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  openTerminalSession,
  TERMINAL_SCROLLBACK,
  type TerminalRenderer,
  type TerminalSession,
} from '../../lib/terminal-session.ts';

const props = defineProps<{
  /** What the retained snapshot is filed under. */
  readonly nodeId: string;
  /** The backfill plus everything streamed since, as bytes to write. */
  readonly text: string;
  /** AC9 — off unless the operator turned it on. */
  readonly screenReaderMode?: boolean;
}>();

/**
 * The session, handed up so the panel can adopt it into the run store's
 * terminal registry (KAR-16.4).
 *
 * Handed up rather than registered here, because this component is mounted in
 * specs that have no pinia — a component reaching for a store it does not need
 * is a component that cannot be tested on its own.
 */
const emit = defineEmits<{ opened: [session: TerminalSession]; closed: [] }>();

const host = ref<HTMLElement | null>(null);
const session = shallowRef<TerminalSession | null>(null);
const renderer = ref<TerminalRenderer>('dom');
const restored = ref(false);
/** How much of `text` has been written, so a re-render never rewrites it all. */
let written = 0;

onMounted(() => {
  const element = host.value;
  if (element === null) return;

  const opened = openTerminalSession({
    key: props.nodeId,
    element,
    screenReaderMode: props.screenReaderMode === true,
    onRenderer: (next) => {
      renderer.value = next;
    },
  });

  session.value = opened;
  restored.value = opened.restored;
  (element as HTMLElement & { __terminal?: unknown }).__terminal = opened.terminal;
  if (props.text !== '') {
    opened.write(props.text);
    written = props.text.length;
  }
  emit('opened', opened);
});

/**
 * Append-only. `text` grows as chunks arrive, and writing the whole of it again
 * would replay the entire tail into the buffer on every frame — which is both a
 * duplicate transcript and the single easiest way to make a live panel unusable.
 * A shorter `text` means a different stream, so the terminal starts over.
 */
watch(
  () => props.text,
  (next) => {
    const open = session.value;
    if (open === null) return;
    if (next.length < written) {
      open.terminal.clear();
      written = 0;
    }
    if (next.length > written) {
      open.write(next.slice(written));
      written = next.length;
    }
  },
);

onBeforeUnmount(() => {
  session.value?.dispose();
  session.value = null;
  emit('closed');
});
</script>

<template>
  <div
    ref="host"
    class="terminal"
    data-terminal
    :data-scrollback="TERMINAL_SCROLLBACK"
    :data-renderer="renderer"
    :data-restored="String(restored)"
    :data-screen-reader="props.screenReaderMode === true ? 'on' : 'off'"
  />
</template>

<style scoped>
.terminal {
  block-size: 100%;
  min-block-size: 12rem;
  inline-size: 100%;
  overflow: hidden;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-sunken, var(--surface-raised));
}
</style>
