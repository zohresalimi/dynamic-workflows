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
 * is what found that, and the store folds the run's own lifecycle frames for
 * it. That is the single view-model addition EPIC-24 makes, and it is recorded
 * on the story rather than slipped in: without it the pill is honestly empty on
 * every live tab, which is a frame that does not do the one thing AC5 asks.
 *
 * **KAR-28.7 — the status word and the sentence both come from
 * `useRunStore.statusView`, and this component derives neither.** It used to
 * look `RUN_STATUS_LABELS[status]` up itself, which had two consequences: the
 * best it could print for a run in `spec-approved` was the bare word
 * `planning`, so KAR-27.3's composed *"planner — running · attempt 1 of 3 ·
 * since <instant>"* could never appear here at all; and the status it looked up
 * came from a sticky client table on which an answered gate left the run
 * reading *needs a decision* for the rest of its life. `statusView` is one
 * derivation, shared with the run-list row, and it goes through
 * `@DeFlow/core`'s `runStatusLabel` — see `../../lib/run-status.ts`.
 *
 * The dot's colour comes from `RUN_STATUS_DISPLAY` in
 * `../../lib/state-palette.ts`, beside `NODE_STATUS_DISPLAY` — the same mapping
 * one domain over. It lives there rather than here so that the second surface
 * to paint a run's status cannot start a second table.
 *
 * **KAR-26.5 (audit item: the running indicator's elapsed time) — the pill
 * now shows how long the run's work has been going**, which KAR-24.4 AC5
 * asked for ("its elapsed time") and the first cut never shipped. It is a
 * pure function of the timeline projection's own span facts, not a new fold:
 * the run's work started at the earliest span's `startTs`, and it is still
 * going while any span is open — so the figure ticks against the tab's clock
 * (one shared 1s interval, paused whenever nothing is open — the same
 * honesty rule `useNodeBodies`' ticker keeps) and freezes at the latest
 * `endTs` once every span has closed. No span, no figure: a run that has not
 * executed anything has no elapsed time to claim. Formatted with
 * `node-body.ts`'s own `formatElapsed`, because a second duration vocabulary
 * on the same screen is the drift that module exists to prevent. One honest
 * caveat, recorded rather than hidden: on a *scrubbed* tab an open span at
 * the scrubbed position is still measured to now — the tab's clock is the
 * only end the facts offer for an open span.
 */
import type { RunStatus } from '@DeFlow/core';
import { useIntervalFn } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { type DisplayState, RUN_STATUS_DISPLAY, stateVar } from '../../lib/state-palette.ts';
import { useRunStore } from '../../stores/useRunStore.ts';
import { formatElapsed } from '../graph/node-body.ts';

const run = useRunStore();

const status = computed<RunStatus | null>(() => run.statusView?.status ?? null);
const label = computed<string | null>(() => run.statusView?.label ?? null);
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

// ── KAR-26.5: elapsed time, off span facts alone ──────────────────────────

/** When the run's work first started — the earliest span's own `startTs`. */
const startTs = computed<number | null>(() => {
  let earliest: number | null = null;
  for (const span of run.timelineSpans) {
    if (earliest === null || span.startTs < earliest) earliest = span.startTs;
  }
  return earliest;
});

/** Whether anything is still executing — the only case the clock may move. */
const hasOpenSpan = computed<boolean>(() => run.timelineSpans.some((span) => span.open));

/** Where the work stopped, once nothing is open. */
const latestEndTs = computed<number | null>(() => {
  let latest: number | null = null;
  for (const span of run.timelineSpans) {
    if (span.endTs !== null && (latest === null || span.endTs > latest)) latest = span.endTs;
  }
  return latest;
});

const now = ref(Date.now());
// `immediate: false` and paused whenever no span is open: a pill on a tab
// with no live work must not wake once a second for a figure that cannot
// change. Component-scoped, so unmounting the frame disposes the interval.
const ticker = useIntervalFn(
  () => {
    now.value = Date.now();
  },
  1000,
  { immediate: false },
);

watch(
  hasOpenSpan,
  (open) => {
    if (open) {
      now.value = Date.now();
      ticker.resume();
    } else {
      ticker.pause();
    }
  },
  { immediate: true },
);

/** The figure, or `null` while there is no span to measure. Clamped at zero
 * for the same reason `elapsedMsOf` clamps: the ledger's `ts` is the
 * daemon's clock and `now` is the tab's. */
const elapsed = computed<string | null>(() => {
  const start = startTs.value;
  if (start === null) return null;
  const end = hasOpenSpan.value ? now.value : latestEndTs.value;
  if (end === null) return null;
  return formatElapsed(Math.max(0, end - start));
});
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
    <!-- KAR-26.5 — elapsed time from span facts; absent, not blank, while no
         node has started. See the header comment. -->
    <span v-if="elapsed !== null" class="run-status-pill__elapsed" data-run-status-elapsed
      >{{ elapsed }}</span
    >
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

/* KAR-26.5 — the same mono voice and ink as the status word: a second, dimmer
   ink on `--surface-control` would be a new colour pair for the contrast bar
   to hold, and the separator the blueprint draws between word and time is
   carried by the pill's own gap instead. */
.run-status-pill__elapsed {
  white-space: nowrap;
}
</style>
