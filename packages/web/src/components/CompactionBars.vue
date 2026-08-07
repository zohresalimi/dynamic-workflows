<script setup lang="ts">
/**
 * KAR-09.6 AC5 — the two-bar compaction chart, rendered honestly.
 *
 * The component decides **nothing**. Which bar is solid, which is hatched, what
 * the label says and whether there is an explanatory sentence at all are
 * `compactionChart()` in `@DeFlow/core`, and this file is the DOM those
 * decisions produce. That split is the point of AC5: the rule "a partial event
 * never renders as a solid two-bar chart" has to be checkable without a
 * browser, and re-deriving any of it here would give the view a second opinion.
 *
 * The `gap` case is the one to read carefully. An `after` nobody reported is
 * drawn as an outlined, empty slot with the words *not reported* in it — not as
 * a zero-height bar, and not as `0`. A zero is a claim the vendor never made,
 * and *"a chart with a fabricated 'after' number is worse than an honest gap."*
 *
 * This component is EPIC-17's to grow. It lives here now because KAR-09.6 owns
 * the contract and the fixture that proves it (EPIC-09-S33).
 */
import type { CompactionChart } from '@DeFlow/core';

defineProps<{ readonly chart: CompactionChart }>();

/** Bars are drawn against the larger of the two, so `before` and `after` are
 * comparable at a glance. A gap has no value and is drawn at full width as an
 * outline, because the space is the message. */
function widthPercent(chart: CompactionChart, value: number | null): number {
  if (value === null) return 100;
  const largest = Math.max(...chart.bars.map((bar) => bar.value ?? 0), 1);
  return Math.max(2, Math.round((value / largest) * 100));
}
</script>

<template>
  <figure class="compaction">
    <div
      v-for="bar in chart.bars"
      :key="bar.slot"
      class="row"
      data-bar
      :data-slot="bar.slot"
      :data-style="bar.style"
    >
      <span class="slot">{{ bar.slot }}</span>
      <span
        class="bar"
        :class="bar.style"
        :style="{ width: `${widthPercent(chart, bar.value)}%` }"
        :title="bar.style === 'hatched' ? (chart.tooltip ?? undefined) : undefined"
      >
        <span v-if="bar.value !== null" class="value" :data-value="String(bar.value)">
          {{ bar.value.toLocaleString('en-US') }}
        </span>
        <span v-if="bar.label !== null" class="label">{{ bar.label }}</span>
      </span>
    </div>

    <ul v-if="chart.dropped.length > 0" class="dropped" data-dropped>
      <li v-for="entry in chart.dropped" :key="entry.segment">
        <!-- The handle is what makes the id *resolvable*: EPIC-17 wires the
             click to `DeFlow_read_artifact`, and until then it is on the
             element rather than nowhere. -->
        <button type="button" data-segment :data-handle="entry.handle ?? ''">
          {{ entry.segment }}
        </button>
      </li>
    </ul>

    <figcaption v-if="chart.note !== null" data-note>{{ chart.note }}</figcaption>
  </figure>
</template>

<style scoped>
.compaction {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  inline-size: 32rem;
  max-inline-size: 100%;
  margin: 0;
  font:
    0.875rem / 1.4 system-ui,
    sans-serif;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.slot {
  inline-size: 4rem;
  flex: none;
  color: #555;
}

.bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  block-size: 1.5rem;
  padding-inline: 0.5rem;
  border-radius: 2px;
  white-space: nowrap;
}

/* A measured figure: filled, opaque, no qualification. */
.bar.solid {
  background: #3b6ea5;
  color: #fff;
}

/* An inferred figure: the same length, visibly not the same kind of thing. */
.bar.hatched {
  color: #1c3350;
  background: repeating-linear-gradient(
    45deg,
    #b8cde3,
    #b8cde3 4px,
    transparent 4px,
    transparent 8px
  );
  outline: 1px dashed #3b6ea5;
}

/* No figure at all: an outline with a sentence in it, and no number. */
.bar.gap {
  color: #6b6b6b;
  background: none;
  outline: 1px dashed #b0b0b0;
  font-style: italic;
}

.label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

figcaption {
  color: #555;
}

.dropped {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.dropped button {
  font: inherit;
  padding: 0.1rem 0.4rem;
  border: 1px solid #b8cde3;
  border-radius: 2px;
  background: #f2f6fa;
  cursor: pointer;
}
</style>
