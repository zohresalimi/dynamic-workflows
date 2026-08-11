<script setup lang="ts">
/**
 * KAR-17.5 AC2 — one message's body, coloured as it grows.
 *
 * Verifies: EPIC-17-S21 (scenario 4) · AC2
 *
 * The incremental property is `../../lib/stream-highlight.ts`'s and is measured
 * there against a control. What this component adds is the half a measurement
 * cannot cover: that the **component** feeds the tokenizer the *delta* and not
 * the buffer. Pushing `text` in full on every update would use the incremental
 * API to do the quadratic thing, which is the failure mode that survives a
 * green library test.
 *
 * Tokens are rendered as spans carrying Shiki's `htmlStyle`, which with
 * `defaultColor: false` is a pair of custom properties — one per theme — so the
 * tab can switch light and dark without re-tokenising anything.
 *
 * A body still awaiting its first tokens renders as **plain text**, not as
 * nothing: colour arriving a frame late is invisible, and a blank pane while a
 * highlighter warms up is the panel appearing broken at the exact moment
 * somebody opened it to find out whether something was broken.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { createStreamHighlighter, type StreamHighlighter } from '../../lib/stream-highlight.ts';

const props = withDefaults(
  defineProps<{
    readonly text: string;
    /** The grammar to colour with; `text` for prose. */
    readonly lang?: string;
  }>(),
  { lang: 'text' },
);

interface Span {
  readonly content: string;
  readonly style: string;
}

const spans = shallowRef<readonly Span[]>([]);
const ready = ref(false);

let highlighter: StreamHighlighter | null = null;
/** How much of `text` has been pushed — the delta, never the buffer. */
let pushed = 0;
/** Serialises pushes: `enqueue` is async and order is the whole grammar state. */
let queue: Promise<void> = Promise.resolve();
let alive = true;

const paint = (): void => {
  spans.value = (highlighter?.tokens() ?? []).map((token) => ({
    content: token.content,
    style: token.htmlStyle === undefined ? '' : String(token.htmlStyle),
  }));
};

function pump(): void {
  queue = queue.then(async () => {
    const current = props.text;
    if (!alive || highlighter === null) return;
    if (current.length < pushed) {
      // A shorter body means a different message in this slot; the tokenizer's
      // grammar state belongs to the old one.
      highlighter = await createStreamHighlighter(props.lang);
      pushed = 0;
    }
    if (current.length === pushed) return;
    await highlighter.push(current.slice(pushed));
    pushed = current.length;
    if (alive) paint();
  });
}

onMounted(async () => {
  highlighter = await createStreamHighlighter(props.lang);
  if (!alive) return;
  ready.value = true;
  pump();
});

watch(() => props.text, pump);

onBeforeUnmount(() => {
  alive = false;
  highlighter?.close();
  highlighter = null;
});
</script>

<template>
  <pre class="streamed" data-streamed><code v-if="spans.length > 0"><span
      v-for="(span, index) in spans"
      :key="index"
      :style="span.style"
    >{{ span.content }}</span></code><code v-else data-plain>{{ props.text }}</code></pre>
</template>

<style scoped>
.streamed {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
