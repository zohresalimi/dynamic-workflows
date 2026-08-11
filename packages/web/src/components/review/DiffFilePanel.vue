<script setup lang="ts">
/**
 * KAR-17.6 — one file of the patch, with its verdicts attached per line
 * (F10.7, F7.7).
 *
 * Verifies: EPIC-17-S24 (scenario 1), EPIC-17-S25, EPIC-17-S26 · AC2, AC4,
 * AC5, AC7, AC9
 *
 * ## Why `@git-diff-view/vue` and not `diff2html`
 *
 * The `#extend` slot. It renders a Vue component into a row of its own,
 * immediately under the line it belongs to, keyed by that line's number —
 * which is what F7.7's *"attached inline at file and line"* means, and what a
 * string → HTML generator can only be made to do by DOM surgery after the fact
 * (docs/12-frontend-architecture.md §6.7).
 *
 * ## Three things this panel refuses to do
 *
 * **Render a binary file as source.** `--binary` emits base85 `GIT binary
 * patch` blocks, and a diff viewer will happily colour them.
 *
 * **Render a 5,000-line file eagerly** (AC7). Over
 * `COLLAPSE_ABOVE_CHANGED_LINES` the panel opens collapsed with an explicit
 * expand, and once expanded it renders a *window* of the file rather than all
 * of it — `DiffFile.generateInstanceFromLineNumberRange` gives a sub-instance
 * that keeps the original line numbers, so the findings index still answers for
 * the lines on screen. The spacers above and below keep the scrollbar honest.
 *
 * **Colour a `needs-human` file red** (AC5). The tone comes from
 * `../../lib/review-index.ts`, which has three values and not two.
 */
import { DiffFile, type DiffFileHighlighter, getLang } from '@git-diff-view/core';
// `DiffModeEnum` is only *typed* by `@git-diff-view/core` — its bundled `.d.ts`
// covers the whole upstream monorepo — and exists at runtime in the Vue package
// alone. Importing it from `core` type-checks and is `undefined` in the browser.
import { DiffModeEnum, DiffView } from '@git-diff-view/vue';
import '@git-diff-view/vue/styles/diff-view.css';
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { PatchFileVM } from '../../lib/patch.ts';
import {
  type FileReviewVM,
  OUTCOME_STYLE,
  type ReviewFindingVM,
  SEVERITY_STYLE,
} from '../../lib/review-index.ts';
import ReviewFinding from './ReviewFinding.vue';

const props = defineProps<{
  readonly file: PatchFileVM;
  /** The findings that name this file, indexed by line. `undefined` if none. */
  readonly review?: FileReviewVM | undefined;
  /** The shared Shiki instance, wearing the renderer's face (AC9). */
  readonly highlighter?: DiffFileHighlighter | undefined;
  readonly dark?: boolean;
}>();

/**
 * The height one diff row is assumed to be, for the scrollbar arithmetic.
 *
 * An estimate on purpose. The window is chosen from `scrollTop / ROW_HEIGHT`
 * and the spacers are sized from the same number, so a row that renders a
 * little taller or shorter shifts the mapping slightly — it never loses a line,
 * because the overscan below is far larger than the error accumulates to.
 */
const ROW_HEIGHT = 20;

/** How many rows to render beyond the viewport, each way. */
const OVERSCAN = 40;

/** Above this many rendered lines the panel windows rather than drawing all. */
const VIRTUALISE_ABOVE_LINES = 200;

/** How tall the scroll container is when a file is being windowed. */
const VIEWPORT_HEIGHT = 480;

const expanded = ref(!props.file.collapsed);
const scrollTop = ref(0);
const viewport = ref<HTMLElement | null>(null);
const diffFile = shallowRef<DiffFile | null>(null);

const lang = computed(() => getLang(props.file.newPath ?? props.file.oldPath ?? ''));

const outcomes = computed(() => (props.review?.outcomes ?? []).map((one) => OUTCOME_STYLE[one]));

/**
 * The parsed file.
 *
 * Rebuilt when the patch, the theme or the highlighter changes, and **not**
 * built at all while the panel is collapsed — parsing is cheap next to
 * rendering, but a tab holding forty collapsed files should not be holding
 * forty parsed ones either.
 */
watch(
  [() => props.file, () => props.highlighter, () => props.dark, expanded],
  () => {
    if (!expanded.value || props.file.binary || props.file.hunks.length === 0) {
      diffFile.value = null;
      return;
    }

    const built = DiffFile.createInstance({
      oldFile: { fileName: props.file.oldPath, fileLang: lang.value },
      newFile: { fileName: props.file.newPath, fileLang: lang.value },
      hunks: [...props.file.hunks],
    });
    built.initTheme(props.dark === true ? 'dark' : 'light');
    built.initRaw();
    if (props.highlighter !== undefined)
      built.initSyntax({ registerHighlighter: props.highlighter });
    built.buildUnifiedDiffLines();
    diffFile.value = built;
  },
  { immediate: true },
);

const totalRows = computed(() => diffFile.value?.unifiedLineLength ?? 0);

const windowed = computed(() => totalRows.value > VIRTUALISE_ABOVE_LINES);

/** The slice of the file currently in the DOM, in new-side line numbers. */
const range = computed(() => {
  const first = Math.max(1, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    totalRows.value,
    Math.ceil((scrollTop.value + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN,
  );
  return { first, last: Math.max(first + 1, last) };
});

/**
 * What is handed to the renderer: the whole file, or a window of it.
 *
 * `generateInstanceFromLineNumberRange` copies the line items it selects, so
 * every line keeps the number it had in the file — which is what lets
 * `extendData` below stay keyed on absolute line numbers whatever is on screen.
 */
const rendered = shallowRef<DiffFile | null>(null);

watch(
  [diffFile, range, windowed],
  () => {
    const built = diffFile.value;
    if (built === null) {
      rendered.value = null;
      return;
    }
    if (!windowed.value) {
      rendered.value = built;
      return;
    }
    const side = props.file.newPath !== null ? undefined : 1;
    const slice =
      side === undefined
        ? built.generateInstanceFromLineNumberRange(range.value.first, range.value.last)
        : built.generateInstanceFromLineNumberRange(range.value.first, range.value.last, side);
    slice.buildUnifiedDiffLines();
    rendered.value = slice;
  },
  { immediate: true },
);

/** `line number` → the findings at it, in the shape `DiffView` reads. */
const extendData = computed(() => {
  const byLine: Record<string, { data: readonly ReviewFindingVM[] }> = {};
  for (const [line, findings] of props.review?.byLine ?? []) {
    byLine[String(line)] = { data: findings };
  }
  return { oldFile: {}, newFile: byLine };
});

const spacerAbove = computed(() =>
  windowed.value ? Math.max(0, (range.value.first - 1) * ROW_HEIGHT) : 0,
);
const spacerBelow = computed(() =>
  windowed.value ? Math.max(0, (totalRows.value - range.value.last) * ROW_HEIGHT) : 0,
);

function onScroll(event: Event): void {
  scrollTop.value = (event.target as HTMLElement).scrollTop;
}

onBeforeUnmount(() => {
  diffFile.value = null;
  rendered.value = null;
});

watch(
  () => props.file,
  () => {
    expanded.value = !props.file.collapsed;
    scrollTop.value = 0;
    if (viewport.value !== null) viewport.value.scrollTop = 0;
  },
);
</script>

<template>
  <section
    class="diff-panel"
    :data-diff-file="file.path"
    :data-tone="review?.tone ?? 'clean'"
    :data-collapsed="String(!expanded)"
    :data-binary="String(file.binary)"
    :aria-label="`Diff for ${file.path}`"
  >
    <header class="diff-panel__head">
      <span class="diff-panel__path" data-file-path>{{ file.path }}</span>
      <span class="diff-panel__kind" :data-kind="file.kind">{{ file.kind }}</span>
      <span
        v-if="file.kind === 'renamed' && file.oldPath !== null"
        class="diff-panel__from"
        data-renamed-from
      >
        from {{ file.oldPath }}
      </span>

      <span class="diff-panel__counts" :data-changed-lines="file.changedLines">
        {{ file.changedLines.toLocaleString('en-US') }}
        changed lines
      </span>

      <span
        v-for="outcome of outcomes"
        :key="outcome.outcome"
        class="diff-panel__outcome"
        :class="`diff-panel__outcome--${outcome.tone}`"
        :data-outcome="outcome.outcome"
      >
        <span data-outcome-glyph aria-hidden="true">{{ outcome.glyph }}</span>
        <span data-outcome-label>{{ outcome.label }}</span>
      </span>

      <span
        v-if="review?.worst != null"
        class="diff-panel__worst"
        :data-worst-severity="review.worst"
      >
        <span aria-hidden="true">{{ SEVERITY_STYLE[review.worst].glyph }}</span>
        {{ review.count }}
        finding{{ review.count === 1 ? '' : 's' }}
      </span>
    </header>

    <p v-if="file.binary" class="diff-panel__note" data-binary-note>
      Binary file — {{ file.changedLines }} lines of source to show, by definition. The patch
      carries its bytes; this surface does not pretend to review them.
    </p>

    <p v-else-if="file.hunks.length > 0 && file.changedLines === 0" class="diff-panel__note">
      No content change — git recorded this as a {{ file.kind }} with no hunk.
    </p>

    <div v-else-if="!expanded" class="diff-panel__collapsed">
      <p>
        {{ file.changedLines.toLocaleString('en-US') }}
        changed lines. Large enough to be worth asking for.
      </p>
      <button type="button" data-expand @click="expanded = true">Expand this file</button>
    </div>

    <div
      v-else
      ref="viewport"
      class="diff-panel__viewport"
      :class="{ 'diff-panel__viewport--windowed': windowed }"
      :style="windowed ? { blockSize: `${VIEWPORT_HEIGHT}px` } : undefined"
      @scroll="onScroll"
    >
      <div v-if="spacerAbove > 0" :style="{ blockSize: `${spacerAbove}px` }" data-spacer="above" />

      <DiffView
        v-if="rendered !== null"
        :diff-file="rendered"
        :extend-data="extendData"
        :diff-view-mode="DiffModeEnum.Unified"
        :diff-view-theme="dark === true ? 'dark' : 'light'"
        :diff-view-highlight="true"
        :diff-view-wrap="false"
        v-bind="highlighter === undefined ? {} : { registerHighlighter: highlighter }"
      >
        <template #extend="{ data }">
          <div class="diff-panel__widgets">
            <ReviewFinding
              v-for="finding of (data as ReviewFindingVM[])"
              :key="finding.id"
              :finding="finding"
              placement="line"
            />
          </div>
        </template>
      </DiffView>

      <div v-if="spacerBelow > 0" :style="{ blockSize: `${spacerBelow}px` }" data-spacer="below" />
    </div>
  </section>
</template>

<style scoped>
.diff-panel {
  border: 1px solid var(--edge);
  border-radius: 0.375rem;
  overflow: hidden;
}

.diff-panel[data-tone="failing"] {
  border-color: var(--state-failed);
}

/* AC5 — a judgement call is its own colour, and it is not red. */
.diff-panel[data-tone="judgement"] {
  border-color: var(--state-awaiting-human);
  border-style: dashed;
}

.diff-panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.4rem 0.6rem;
  background: var(--surface-raised);
  font-size: 0.8125rem;
}

.diff-panel__path {
  font-family: ui-monospace, monospace;
  font-weight: 600;
}

.diff-panel__kind,
.diff-panel__from,
.diff-panel__counts {
  color: var(--ink-muted);
}

.diff-panel__outcome {
  display: inline-flex;
  gap: 0.25rem;
}

.diff-panel__outcome--failing {
  color: var(--state-failed);
}
.diff-panel__outcome--judgement {
  color: var(--state-awaiting-human);
}
.diff-panel__outcome--clean {
  color: var(--state-passed);
}

.diff-panel__note,
.diff-panel__collapsed {
  margin: 0;
  padding: 0.75rem;
  color: var(--ink-muted);
}

.diff-panel__viewport--windowed {
  overflow-y: auto;
}

.diff-panel__widgets {
  display: grid;
  gap: 0.25rem;
}
</style>
