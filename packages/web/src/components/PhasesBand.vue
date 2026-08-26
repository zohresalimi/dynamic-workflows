<script setup lang="ts">
/**
 * KAR-28.6 — the phases band: this run's shape, and the work in the phase you
 * are looking at.
 *
 * Verifies: EPIC-28-S23, EPIC-28-S24, EPIC-28-S25 · AC1, AC2, AC3, AC4
 *
 * The band under the primary panel used to be **other runs' history** — a table
 * of the project's previous runs, on the screen whose entire subject is the run
 * in front of you. The blueprint has phases there, KAR-26.5's frame audit
 * recorded the band as *"out of scope: facts the daemon does not have"*, and
 * KAR-28.5 created the fact. This draws it.
 *
 * ## It reduces nothing
 *
 * Two props and both are objects somebody else owns: the phases are the
 * daemon's answer (`../app/useRunPhases.ts`), and the bodies are the very map
 * `useNodeBodies()` hands the agent list and the canvas. `../lib/phases-band.ts`
 * does the arithmetic — including the counts, folded through **core's own**
 * `foldPhaseItems`, so the `2/4` here and the four rows above it are one
 * calculation rather than two that agree today.
 *
 * ## Selecting a phase (AC2)
 *
 * `chosen` is `null` until the operator presses one, and `null` means *the phase
 * the run is in* — recomputed from the stream, so a band nobody has touched
 * follows the run as it moves. Pressing a phase pins it, because an operator
 * reading a finished phase's work while the next one starts should not have the
 * page move under them. Opening another run clears the pin.
 *
 * ## Nothing here is invented (AC4)
 *
 * A phase's title is the plan node's own; its counts are node ids that exist;
 * the work rows carry the shared body's own state and its own formatted
 * duration. There is no percentage, no estimate of what remains, and no token
 * or throughput figure — the blueprint's `12k tok/s` is not a fact DeFlow holds
 * and `test/no-context-window-table.test.ts` is the standing rule about
 * inventing one.
 *
 * ## History is one click away (AC3)
 *
 * The header carries a link to `/projects/:id/runs`, which is the Runs view —
 * project-scoped since KAR-25.1 and the surface run history is *for*. It is
 * stated here rather than left to the rail because the operator looking for the
 * history is looking at this band, where it used to be.
 */

import type { NodeStatus } from '@DeFlow/core';
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { currentPhaseId, type PhaseShape, phaseRows, phaseWork } from '../lib/phases-band.ts';
import type { NodeBodyVM } from './graph/node-body.ts';
import StateChip from './StateChip.vue';

const props = defineProps<{
  /** The daemon's phases for this run, in its own order. */
  readonly phases: readonly PhaseShape[];
  /**
   * The plan projection's nodes — `useRunStore().planNodes`.
   *
   * The *domain* status, which `NodeBodyVM` deliberately does not carry (it
   * holds the display state, which folds eight statuses into seven colours).
   * The phase fold is a domain calculation and reads the domain word.
   */
  readonly nodes: readonly { readonly id: string; readonly status: NodeStatus }[];
  /** The shared bodies, for the work rows. Never a copy. */
  readonly bodies: ReadonlyMap<string, NodeBodyVM>;
  /** For the Runs link, and for clearing the pin when the run changes. */
  readonly projectId: string;
  readonly runId: string;
}>();

const rows = computed(() => phaseRows(props.phases, props.nodes));

/** The phase the operator pinned, or `null` for "wherever the run is". */
const chosen = ref<string | null>(null);

watch(
  () => props.runId,
  () => {
    chosen.value = null;
  },
);

const selected = computed<string | null>(() => {
  const pinned = chosen.value;
  // A pin that no longer names a phase — the plan was patched under it — falls
  // back to the run's own position rather than selecting nothing.
  if (pinned !== null && rows.value.some((row) => row.id === pinned)) return pinned;
  return currentPhaseId(rows.value);
});

const work = computed(() => {
  const row = rows.value.find((each) => each.id === selected.value);
  return row === undefined ? [] : phaseWork(row.nodes, props.bodies);
});

const selectedTitle = computed(
  () => rows.value.find((row) => row.id === selected.value)?.title ?? null,
);
</script>

<template>
  <section class="phases" data-phases-band aria-labelledby="DeFlow-phases-title">
    <header class="phases__head">
      <h2 id="DeFlow-phases-title" class="phases__title">Phases</h2>
      <!--
        AC3 — moved, not removed. The history this band replaced lives on the
        Runs view, and this is the click that gets there.
      -->
      <RouterLink
        class="phases__runs"
        data-runs-link
        :to="{ name: 'project-runs', params: { projectId } }"
        >Run history</RouterLink
      >
    </header>

    <div class="phases__split">
      <!--
        The phases themselves. Real buttons with `aria-pressed`, the same
        language the panel toggle above uses: which one the screen is showing is
        a fact a screen reader has to be able to read, and a highlighted `<li>`
        does not say it.
      -->
      <ul class="phases__list" role="group" aria-label="This run's phases">
        <li v-for="row in rows" :key="row.id" class="phases__item">
          <button
            type="button"
            class="phases__phase"
            :data-phase-row="row.id"
            :data-phase-state="row.state"
            :aria-pressed="row.id === selected"
            @click="chosen = row.id"
          >
            <StateChip :state="row.display" />
            <span class="phases__phase-title">{{ row.title }}</span>
            <!--
              AC4 — two counts of node ids, printed as counts. Not a percentage,
              which would be an estimate of a denominator nobody measured, and
              nothing beside them that the ledger does not carry.
            -->
            <span class="phases__counts" data-phase-counts>{{ row.counts }}</span>
          </button>
        </li>
      </ul>

      <!--
        AC1 — and the work happening in the selected one, off the shared bodies.
      -->
      <div class="phases__work">
        <p v-if="selectedTitle !== null" class="phases__work-head" data-phase-work-head>
          {{ selectedTitle }}
        </p>
        <ul class="phases__work-list">
          <li
            v-for="item in work"
            :key="item.id"
            class="phases__work-row"
            :data-phase-work-row="item.id"
          >
            <StateChip :state="item.state" />
            <span class="phases__work-title">{{ item.title }}</span>
            <span v-if="item.elapsed !== null" class="phases__work-elapsed"
              >{{ item.elapsed }}</span
            >
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * The band the history table used to be, in the same bordered-box language:
 * `--edge-strong`, `--radius-lg`, dense rows separated by `--edge` (KAR-24.7
 * AC4). A third table shape for the third list on this screen is exactly what
 * that story removed.
 */
.phases {
  min-width: 0;
}

.phases__head {
  display: flex;
  align-items: baseline;
  gap: 12px; /* geometry — title-to-link gutter */
  margin-bottom: 8px; /* geometry — head-to-box gap */
}

.phases__title {
  font-size: var(--text-base);
  font-weight: 600;
  margin: 0;
}

.phases__runs {
  font-size: var(--text-xs);
  color: var(--ink-muted);
  margin-left: auto;
}

/*
 * Two columns: the run's shape, and the work inside the step being read. The
 * phases column is fixed-ish so the work beside it does not jump width as the
 * titles change, and both scroll inside the band rather than growing it — the
 * page's middle row is what absorbs height (KAR-27.5 AC4).
 */
.phases__split {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: 12px; /* geometry — the band's own column gutter */
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  background: var(--surface);
  overflow: hidden;
  max-height: 12rem;
}

.phases__list,
.phases__work-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  min-height: 0;
}

.phases__list {
  border-right: 1px solid var(--edge);
}

.phases__item + .phases__item {
  border-top: 1px solid var(--edge);
}

.phases__phase {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — the row's own gutter */
  width: 100%;
  background: none;
  border: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
  font-size: var(--text-sm);
  /* ~5px vertical — direction C's row density, the same as every other list
     on this screen. */
  padding: 5px 14px;
  text-align: left;
}

.phases__phase:hover {
  background: var(--surface-inset);
}

/* System law 3 — "this is the phase you are reading" is a selection, not a
   state, so it takes the application's one hueless selection ground. */
.phases__phase[aria-pressed="true"] {
  background: var(--select-tint);
}

.phases__phase-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phases__counts {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
  flex: none;
}

.phases__work {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.phases__work-head {
  margin: 0;
  padding: 6px 14px; /* geometry — matches the head row of the tables beside it */
  background: var(--surface-raised);
  border-bottom: 1px solid var(--edge-strong);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0.1em;
  color: var(--ink-faint);
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
}

.phases__work-row {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — the row's own gutter */
  padding: 5px 14px;
  font-size: var(--text-sm);
}

.phases__work-row + .phases__work-row {
  border-top: 1px solid var(--edge);
}

.phases__work-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phases__work-elapsed {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
  flex: none;
}
</style>
