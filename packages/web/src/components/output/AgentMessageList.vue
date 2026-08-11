<script setup lang="ts">
/**
 * KAR-17.5 — the ACP path: a virtualised list of typed message components.
 *
 * Verifies: EPIC-17-S21 · AC1, AC2
 *
 * ACP streaming updates are typed JSON, not a TTY byte stream. Rendering them
 * as components rather than as terminal text is what keeps everything they
 * already are — a `tool_call` has an id, a status and a title, and in a
 * terminal all three become characters. The list is *faster, searchable,
 * selectable, diffable, themeable and accessible*, and every one of those is a
 * property of it being **DOM** (docs/12-frontend-architecture.md §6.6).
 *
 * **Virtualised, because a chatty agent produces thousands of these.** A
 * `v-for` over the whole array renders identically in a screenshot and stalls
 * the tab; `@tanstack/vue-virtual` is headless — it computes offsets and hands
 * back a window, and the DOM stays Vue's, which is the same rule that keeps
 * `d3-selection` out of this package.
 *
 * **Every row is an anchor.** `id="seq-<n>"` and an `href="#seq-<n>"` beside
 * it, where `<n>` is the `io_chunk.seq` the message began at. That is what
 * makes a position in a transcript shareable, which is half of what makes a
 * five-minute diagnosis something one person can hand to another (PRD §12).
 *
 * `role="listbox"` with `aria-selected` per option rather than a list of
 * buttons: the semantics are *"one of these is the current one"*, and reka-ui's
 * roving-tabindex machinery is not needed for a flat single-select list whose
 * rows are already focusable.
 */
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, ref } from 'vue';
import type { AcpMessage } from '../../lib/acp-stream.ts';
import StreamedText from './StreamedText.vue';

const props = defineProps<{
  readonly messages: readonly AcpMessage[];
  /** The `seq` currently selected, or `null`. */
  readonly selectedSeq?: number | null;
}>();

const emit = defineEmits<{ select: [seq: number] }>();

const scroller = ref<HTMLElement | null>(null);

/**
 * The estimate only has to be the right order of magnitude — the virtualiser
 * measures each rendered row and corrects itself. It is deliberately generous:
 * an under-estimate renders more rows than the viewport needs, which is the
 * cheap direction to be wrong in.
 */
const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.messages.length,
    getScrollElement: () => scroller.value,
    estimateSize: () => 72,
    overscan: 8,
  })),
);

const rows = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

/** Prose is prose; a tool call's captured output is usually a shell log. */
const langOf = (message: AcpMessage): string =>
  message.kind === 'tool_call' || message.kind === 'tool_call_update' ? 'bash' : 'text';
</script>

<template>
  <div ref="scroller" class="messages" data-acp-list role="listbox" aria-label="Agent output">
    <div class="messages__sizer" :style="{ height: `${totalSize}px` }">
      <article
        v-for="row in rows"
        :id="`seq-${props.messages[row.index]?.seq}`"
        :key="row.key as number"
        :ref="(element) => virtualizer.measureElement(element as Element | null)"
        :data-index="row.index"
        class="message"
        data-acp-message
        role="option"
        tabindex="0"
        :data-seq="props.messages[row.index]?.seq"
        :data-kind="props.messages[row.index]?.kind"
        :data-tool-call-id="props.messages[row.index]?.toolCallId ?? undefined"
        :data-status="props.messages[row.index]?.status ?? undefined"
        :aria-selected="props.messages[row.index]?.seq === props.selectedSeq"
        :style="{ transform: `translateY(${row.start}px)` }"
        @click="emit('select', props.messages[row.index]?.seq ?? 0)"
        @keydown.enter="emit('select', props.messages[row.index]?.seq ?? 0)"
      >
        <header class="message__head">
          <span class="message__kind">{{ props.messages[row.index]?.kind }}</span>
          <span class="message__title">{{ props.messages[row.index]?.title }}</span>
          <span v-if="props.messages[row.index]?.status" class="message__status">
            {{ props.messages[row.index]?.status }}
          </span>
          <a
            class="message__link"
            data-permalink
            :href="`#seq-${props.messages[row.index]?.seq}`"
            @click.stop
            >#{{ props.messages[row.index]?.seq }}</a
          >
        </header>
        <StreamedText
          v-if="props.messages[row.index]?.text"
          :text="props.messages[row.index]?.text ?? ''"
          :lang="langOf(props.messages[row.index] as AcpMessage)"
        />
      </article>
    </div>
  </div>
</template>

<style scoped>
.messages {
  position: relative;
  block-size: 100%;
  min-block-size: 12rem;
  overflow-y: auto;
  contain: strict;
}

.messages__sizer {
  position: relative;
  inline-size: 100%;
}

.message {
  position: absolute;
  inset-block-start: 0;
  inset-inline: 0;
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem 0.75rem;
  border-block-end: 1px solid var(--edge);
}

.message[aria-selected="true"] {
  background: var(--surface-raised);
}

.message__head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--ink-muted);
}

.message__kind {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.message__title {
  color: var(--ink);
  font-weight: 600;
}

.message__link {
  margin-inline-start: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ink-muted);
}
</style>
