<script setup lang="ts">
/**
 * KAR-24.2 AC1 — node progress and the execution-defaults sliders, both a
 * single filled track rather than a hand-rolled div-and-width pair repeated
 * per screen.
 *
 * `pct` is clamped rather than trusted, because a caller deriving it from a
 * ratio (`done / total`) is one off-by-one away from handing this component
 * 103 and a bar wider than its own track is a worse failure than a clamp.
 * `tone` reuses UiStatTile's vocabulary so a caller does not have to remember
 * a second name for the same five colours — but it defaults to `accent`, not
 * to `default`, and the two components differ there on purpose. A stat tile's
 * value is a *number*, so its unremarkable state is ink. A meter is a
 * *progress* bar, so its unremarkable state is the colour that means work is
 * happening. Defaulting it to `default` left the accent reachable only by
 * passing a prop, which is how the first run of ../ui/variants.test.ts caught
 * a fill that was muted grey everywhere it was used without one.
 *
 * AC4 — `role="progressbar"` with the value triad plus a caller-supplied
 * `aria-label`: a coloured div with no accessible name announces nothing to a
 * screen reader, and this component has no idea what the bar is *of* to make
 * that name up itself.
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    readonly pct: number;
    readonly tone?: 'default' | 'ok' | 'warn' | 'error' | 'accent';
    readonly ariaLabel: string;
  }>(),
  { tone: 'accent' },
);

const clamped = computed(() => Math.min(100, Math.max(0, props.pct)));
</script>

<template>
  <div
    class="ui-meter"
    :data-tone="tone"
    role="progressbar"
    :aria-valuenow="clamped"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="ariaLabel"
  >
    <div class="ui-meter__fill" :style="{ width: `${clamped}%` }" />
  </div>
</template>

<style scoped>
.ui-meter {
  height: 3px; /* geometry — the track's own thickness */
  border-radius: var(--radius-xs);
  background: var(--edge-strong);
  overflow: hidden;
}

.ui-meter__fill {
  height: 100%;
  background: var(--state-running);
  transition: width 0.4s ease;
}

.ui-meter[data-tone="ok"] .ui-meter__fill {
  background: var(--state-passed);
}

.ui-meter[data-tone="warn"] .ui-meter__fill {
  background: var(--state-blocked);
}

.ui-meter[data-tone="error"] .ui-meter__fill {
  background: var(--state-failed);
}

.ui-meter[data-tone="accent"] .ui-meter__fill {
  background: var(--state-running);
}

.ui-meter[data-tone="default"] .ui-meter__fill {
  background: var(--ink-muted);
}
</style>
