<script setup lang="ts">
/**
 * KAR-24.2 AC1 — the raised panel with a header, standing in for every
 * "Providers & runtimes" / "Issue tracker" / inspector-section box direction A
 * draws. It has no variant prop at all, on purpose: a panel is one shape, and
 * the moment two shapes were wanted this would grow a `variant` named after
 * whichever screen wanted the second one, which is exactly the failure the
 * epic's "one rule" is written against.
 *
 * The header is omitted **entirely**, not collapsed to an empty bar, when
 * there is neither a `title` nor an `action` slot filled — an empty header bar
 * still spends a border-bottom and 12px of padding on nothing, so this checks
 * both before rendering one at all.
 */
import { useSlots } from 'vue';

const props = defineProps<{
  readonly title?: string;
}>();

const slots = useSlots();
const hasHeader = () => Boolean(props.title) || Boolean(slots.action);
</script>

<template>
  <div class="ui-panel">
    <div v-if="hasHeader()" class="ui-panel__header">
      <span v-if="title" class="ui-panel__title">{{ title }}</span>
      <div v-if="$slots.action" class="ui-panel__action">
        <slot name="action" />
      </div>
    </div>
    <div class="ui-panel__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ui-panel {
  background: var(--surface);
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-xl);
  overflow: hidden;
}

.ui-panel__header {
  display: flex;
  align-items: center;
  padding: 12px 14px; /* geometry — the header bar's padding */
  border-bottom: 1px solid var(--edge-strong);
}

.ui-panel__title {
  font-size: var(--text-lg);
  font-weight: 600;
}

.ui-panel__action {
  margin-left: auto;
}
</style>
