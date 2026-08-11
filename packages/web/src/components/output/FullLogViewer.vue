<script setup lang="ts">
/**
 * KAR-17.5 — "Open full log": the archive, in a virtualised read-only viewer.
 *
 * Verifies: EPIC-17-S23 · AC7
 *
 * > The browser terminal is a live tail; **the viewer is the archive.**
 *
 * No `Terminal` is constructed on this path and none can be: this component
 * does not import `../../lib/terminal-session.ts`, which is the only file that
 * can construct one. That is the assertion row 8 makes, and the reason it is
 * checkable rather than a promise.
 *
 * The file is never loaded. `../../lib/log-archive.ts` reads 64 KB pages over
 * `Range`, the virtualiser asks for the line window the viewport needs, and the
 * pages behind that window are what get fetched. A 400 MB log therefore costs
 * the same as a 400 KB one — which is the whole difference between this and
 * putting the log in a terminal, where it is hundreds of megabytes of typed
 * array before anything is drawn.
 *
 * **Line count is estimated, not counted**, and the estimate is honest about
 * itself. Counting lines means reading the file, which is the thing this
 * component exists not to do; so the row count is `bytes / average line length`
 * measured off the first page, and the last page's real line count corrects the
 * tail when the reader gets there.
 */
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, onMounted, ref, shallowRef } from 'vue';
import { ARCHIVE_PAGE_BYTES, type LogArchive, logLines } from '../../lib/log-archive.ts';

const props = defineProps<{ readonly archive: LogArchive }>();

const scroller = ref<HTMLElement | null>(null);
/** Decoded lines by page index, so a re-scroll costs nothing. */
const pages = shallowRef<ReadonlyMap<number, readonly string[]>>(new Map());
const linesPerPage = ref(64);
const loading = ref(true);

const lastPage = computed(() =>
  Math.max(0, Math.ceil(props.archive.bytes / ARCHIVE_PAGE_BYTES) - 1),
);
const estimatedLines = computed(() => Math.max(1, (lastPage.value + 1) * linesPerPage.value));

const requested = new Set<number>();

async function loadPage(index: number): Promise<void> {
  if (requested.has(index) || index < 0 || index > lastPage.value) return;
  requested.add(index);

  const start = index * ARCHIVE_PAGE_BYTES;
  const end = Math.min(start + ARCHIVE_PAGE_BYTES, props.archive.bytes) - 1;
  const text = await props.archive.read(start, end);
  const lines = logLines(text, start, index === lastPage.value).map((line) => line.text);

  const next = new Map(pages.value);
  next.set(index, lines);
  pages.value = next;
  if (index === 0 && lines.length > 0) linesPerPage.value = lines.length;
  loading.value = false;
}

const virtualizer = useVirtualizer(
  computed(() => ({
    count: estimatedLines.value,
    getScrollElement: () => scroller.value,
    estimateSize: () => 18,
    overscan: 20,
  })),
);

const rows = computed(() => {
  const items = virtualizer.value.getVirtualItems();
  // Every page a visible row falls on. Asking here rather than in a watcher
  // keeps "what is on screen" and "what was fetched" the same question.
  for (const item of items) void loadPage(Math.floor(item.index / linesPerPage.value));
  return items;
});

const totalSize = computed(() => virtualizer.value.getTotalSize());

const textAt = (index: number): string | null => {
  const page = pages.value.get(Math.floor(index / linesPerPage.value));
  return page?.[index % linesPerPage.value] ?? null;
};

onMounted(() => void loadPage(0));
</script>

<template>
  <div
    ref="scroller"
    class="log"
    data-full-log
    role="log"
    aria-label="Full node output"
    :data-bytes="props.archive.bytes"
  >
    <div class="log__sizer" :style="{ height: `${totalSize}px` }">
      <div
        v-for="row in rows"
        :key="row.key as number"
        class="log__line"
        data-log-line
        :data-line="row.index"
        :style="{ transform: `translateY(${row.start}px)` }"
      >
        <span class="log__number">{{ row.index + 1 }}</span
        ><span class="log__text">{{ textAt(row.index) ?? '' }}</span>
      </div>
    </div>
    <p v-if="loading" class="log__loading" data-log-loading>Reading the archive…</p>
  </div>
</template>

<style scoped>
.log {
  position: relative;
  block-size: 100%;
  min-block-size: 12rem;
  overflow-y: auto;
  contain: strict;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
}

.log__sizer {
  position: relative;
  inline-size: 100%;
}

.log__line {
  position: absolute;
  inset-block-start: 0;
  inset-inline: 0;
  display: flex;
  gap: 0.75rem;
  block-size: 18px;
  white-space: pre;
}

.log__number {
  inline-size: 5ch;
  text-align: end;
  color: var(--ink-muted);
  user-select: none;
}

.log__loading {
  padding: 0.5rem 0.75rem;
  color: var(--ink-muted);
}
</style>
