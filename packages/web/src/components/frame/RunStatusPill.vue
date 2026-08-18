<script setup lang="ts">
/**
 * KAR-24.4 AC5 — the topbar's status pill: the open run's status word, and a
 * dot in the run's state colour.
 *
 * It reads `useRunStore()` directly rather than taking props, for the reason
 * `RunProviderBanner.vue` and `RunTaskBanner.vue` already read it directly:
 * this is a fact about the *run*, not about one panel of it, so a prop chain
 * threaded down from `App.vue` would be a second wiring of something the
 * store already carries. It renders nothing at all when no run is open.
 *
 * **The status it reads is the run's live one, not the scrubber's.**
 * `useRunStore.runState` is `@DeFlow/core`'s `RunState` and is filled by
 * `scrubTo()` alone, so on an ordinary tab following a run — the case this
 * pill exists for — it stays `null` for the whole run. Building this component
 * is what found that, and the store now folds the four run-lifecycle kinds
 * into `lifecycleStatus` off `useRunListStore`'s own `LIFECYCLE_STATUS` table.
 * That is the single view-model addition EPIC-24 makes, and it is recorded on
 * the story rather than slipped in: without it the pill is honestly empty on
 * every live tab, which is a frame that does not do the one thing AC5 asks.
 *
 * `runState` is still preferred when it is there, because a *scrubbed* tab is
 * looking at a moment in the past and its pill should say what was true then.
 *
 * The dot's colour comes from `RUN_STATUS_DISPLAY` in
 * `../../lib/state-palette.ts`, beside `NODE_STATUS_DISPLAY` — the same mapping
 * one domain over. It lives there rather than here so that the second surface
 * to paint a run's status cannot start a second table.
 */
import type { RunStatus } from '@DeFlow/core';
import { RUN_STATUS_LABELS } from '@DeFlow/core';
import { computed } from 'vue';
import { type DisplayState, RUN_STATUS_DISPLAY, stateVar } from '../../lib/state-palette.ts';
import { useRunStore } from '../../stores/useRunStore.ts';

const run = useRunStore();

const status = computed<RunStatus | null>(() => run.runState?.status ?? run.lifecycleStatus);
const label = computed<string | null>(() =>
  status.value === null ? null : RUN_STATUS_LABELS[status.value],
);
const displayState = computed<DisplayState | null>(() =>
  status.value === null ? null : RUN_STATUS_DISPLAY[status.value],
);
// Never actually `''` on screen: the wrapper below only renders once `label`
// is non-null, and `displayState` is non-null in exactly the same cases. The
// fallback exists only so the `:style` binding's type is a plain
// `Record<string, string>` rather than one Vue's `StyleValue` rejects.
const colour = computed<string>(() =>
  displayState.value === null ? '' : stateVar(displayState.value),
);
const isRunning = computed<boolean>(() => status.value === 'running');
</script>

<template>
  <div
    v-if="label !== null"
    class="run-status-pill"
    data-run-status-pill
    :style="{ '--run-status-pill-colour': colour }"
  >
    <span
      class="run-status-pill__dot"
      :class="{ 'run-status-pill__dot--running': isRunning }"
      data-motion-token
      aria-hidden="true"
    />
    <span class="run-status-pill__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.run-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px; /* geometry, not type */
  padding: 5px 9px; /* geometry, not type */
  border-radius: var(--radius-md);
  border: 1px solid var(--edge-control);
  background: var(--surface-control);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--ink-muted);
}

.run-status-pill__dot {
  width: 6px; /* geometry, not type */
  height: 6px; /* geometry, not type */
  flex: none;
  border-radius: 50%;
  background: var(--run-status-pill-colour);
}

/*
 * `pulsering` is theme.css's own keyframe (KAR-24.1); this is its first
 * caller. `data-motion-token` is what lets the reduced-motion rule there
 * switch it off without this component knowing that rule exists.
 */
.run-status-pill__dot--running {
  animation: pulsering 1.8s ease-out infinite;
}

.run-status-pill__label {
  white-space: nowrap;
}
</style>
