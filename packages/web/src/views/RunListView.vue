<script setup lang="ts">
/**
 * KAR-19.1 AC5, KAR-24.7 AC3 — the root route: a live list of runs, in
 * direction A's dense run table.
 *
 * The view's own design is unchanged from KAR-19.1 — it reduces nothing, polls
 * nothing and invents no status word, see `../app/useRunList.ts` and
 * `../stores/useRunListStore.ts` for that whole argument. KAR-24.7 only
 * restyles it: a fixed four-column grid at direction C's row density, with a
 * dot in the run's state colour ahead of the id.
 *
 * **The table has four columns, not direction A's six.** Direction A draws
 * run / trigger / workflow / progress / tokens / time; `RunListRow` (the shape
 * `GET /api/runs` answers with, see the store) carries `runId`, `status`,
 * `label`, `title` and `createdAt`, and nothing else usable:
 *
 * - **trigger** and **workflow** have no field at all — there is no distinct
 *   trigger source and no workflow name on the row, only `title` (the run's
 *   goal). Rendering it under either header would be presenting one fact as
 *   two, so this table renders one **Title** column and calls it that.
 * - **progress** would need a node total and a done count; the row carries
 *   neither.
 * - **tokens** would come off `row.cost`, but the store types that field
 *   `unknown` — deliberately, going by every other field on this interface
 *   carrying its own doc comment. Reading through it would mean an unsafe
 *   cast in a view, and even a safe one could not stop at a single "tokens"
 *   figure: `BudgetRollup.run.usage` keeps `vendorReported` and `estimated`
 *   apart on purpose (`@DeFlow/core`'s `cost-rollup.ts`), and adding them
 *   together is exactly the flattening that file's module comment forbids.
 *
 * So the four columns are **run** (the dot and the id), **title**, **status**
 * (`row.label`, the daemon's own word — never re-derived, never a second
 * vocabulary) and **time** (`row.createdAt`, formatted, not aged into a
 * "3m ago" that would need a clock ticking under a route this store's whole
 * design keeps free of intervals).
 */
import { UserRound } from 'lucide-vue-next';
import { RouterLink } from 'vue-router';
import { COMPOSER_OVERLAY, MAIN_CONTENT_ID } from '../app/ids.ts';
import { useRunList } from '../app/useRunList.ts';
import { UiButton, UiEmptyState } from '../components/ui/index.ts';
import { RUN_STATUS_DISPLAY, stateVar } from '../lib/state-palette.ts';
import { useRunListStore } from '../stores/useRunListStore.ts';
import { useUiStore } from '../stores/useUiStore.ts';

const runs = useRunListStore();
useRunList();
const ui = useUiStore();

/** The dot's colour: `RUN_STATUS_DISPLAY` one domain over from the node
 * palette (KAR-24.4), never a colour named in this file. */
function dotColour(status: (typeof runs.list)[number]['status']): string {
  return stateVar(RUN_STATUS_DISPLAY[status]);
}

/**
 * `2026-08-15, 10:11:04` — the tab's own zone, same formatting `when()` in
 * `ProjectWorkspaceView.vue` already uses for the same field. Not "3m ago":
 * an aged label goes stale the moment it is painted and only a `setInterval`
 * fixes that, which is the one thing `useRunList`'s whole design (one fetch,
 * one subscription, no poll) is written not to reach for.
 */
function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toLocaleString();
}
</script>

<template>
  <main :id="MAIN_CONTENT_ID" class="run-list" data-run-list>
    <h1 class="run-list__title">Runs</h1>

    <!--
      AC5 — a real UiEmptyState, with an action this application can actually
      perform: the composer is mounted globally in App.vue and needs no
      project context, so "start one" opens the same overlay the keyboard
      shortcut does rather than pointing at a form this view does not have.
    -->
    <UiEmptyState
      v-if="runs.list.length === 0"
      title="No runs yet"
      hint="Submit one with deflow run --file <path>, or start one from the composer — either appears here without a reload."
      data-run-list-empty
    >
      <template #action>
        <UiButton
          variant="primary"
          size="sm"
          data-run-list-compose
          @click="ui.openOverlay(COMPOSER_OVERLAY)"
        >
          <UserRound :size="12" aria-hidden="true" />
          Start a run
        </UiButton>
      </template>
    </UiEmptyState>

    <div v-else class="run-list__table" data-run-list-table>
      <div class="run-list__head" role="row">
        <span class="run-list__head-cell">Run</span>
        <span class="run-list__head-cell">Title</span>
        <span class="run-list__head-cell">Status</span>
        <span class="run-list__head-cell">Time</span>
      </div>

      <ul class="run-list__rows">
        <li v-for="row in runs.list" :key="row.runId" class="run-list__row" data-run-row>
          <RouterLink class="run-list__link" :to="`/runs/${row.runId}`" :data-run-link="row.runId">
            <span class="run-list__cell run-list__cell--run">
              <!--
                EPIC-24-S28 — a live run's dot animates; `data-motion-token` is
                what lets theme.css's reduced-motion rule switch it off, and
                colour plus `row.label`'s own text (below) are what still tell
                a running row from a finished one when it does.
              -->
              <span
                class="run-list__dot"
                :class="{ 'run-list__dot--live': row.status === 'running' }"
                data-motion-token
                aria-hidden="true"
                :style="{ '--run-list-dot-colour': dotColour(row.status) }"
              />
              <span class="run-list__id">{{ row.runId }}</span>
            </span>
            <span class="run-list__cell run-list__cell--title">{{ row.title }}</span>
            <span class="run-list__cell run-list__cell--status" :data-run-status="row.runId"
              >{{ row.label }}</span
            >
            <span class="run-list__cell run-list__cell--time">{{ when(row.createdAt) }}</span>
            <!--
              KAR-19.12 AC6 — which gate, beside the status word rather than
              instead of it, and in a cell of its own so `data-run-status`
              keeps carrying `row.label` alone.
            -->
            <span v-if="row.gate" class="run-list__gate" :data-run-gate="row.runId"
              >waiting on {{ row.gate.node }} —
              {{ row.gate.options.map((o) => o.id).join(', ') }}</span
            >
          </RouterLink>
        </li>
      </ul>
    </div>
  </main>
</template>

<style scoped>
.run-list {
  display: flex;
  flex-direction: column;
  gap: 12px; /* geometry — title-to-table gap */
  padding: 16px; /* geometry — the page's own padding */
}

.run-list__title {
  font-size: var(--text-xl);
  margin: 0;
}

/*
 * Direction C's row density on a fixed column grid (KAR-24.7 AC3): a run id
 * wide enough for the id's own length, a title that takes the slack, and two
 * mono columns fixed to their content. The head row and each link share the
 * same four-column template so the columns line up.
 */
.run-list__table {
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--surface);
}

.run-list__head,
.run-list__link {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr) 150px 150px;
  align-items: center;
  gap: 12px; /* geometry — the row's own gutter */
}

.run-list__head {
  padding: 6px 14px; /* geometry — the head row's own padding */
  background: var(--surface-raised);
  border-bottom: 1px solid var(--edge-strong);
}

.run-list__head-cell {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.1em;
  color: var(--ink-faint);
  text-transform: uppercase;
}

.run-list__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.run-list__row + .run-list__row {
  border-top: 1px solid var(--edge);
}

.run-list__link {
  /* ~5px vertical — direction C's row density (KAR-24.7 AC3). */
  padding: 5px 14px;
  text-decoration: none;
  color: inherit;
}

.run-list__link:hover {
  background: var(--surface-inset);
}

.run-list__cell--run {
  display: flex;
  align-items: center;
  gap: 7px; /* geometry — the dot-to-id gutter */
  min-width: 0;
}

.run-list__dot {
  width: 5px; /* geometry — direction A's own run-row dot */
  height: 5px; /* geometry — direction A's own run-row dot */
  flex: none;
  border-radius: 50%;
  background: var(--run-list-dot-colour);
}

/*
 * `pulsering` is theme.css's own keyframe (KAR-24.1), first used this way by
 * `RunStatusPill.vue`; this is its second caller, for the reason the state
 * palette exists at all — the same treatment, on the same event, rather than
 * a second one invented per surface.
 */
.run-list__dot--live {
  animation: pulsering 1.8s ease-out infinite;
}

.run-list__id {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-list__cell--title {
  min-width: 0;
  font-size: var(--text-base);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-list__cell--status {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--ink-muted);
}

.run-list__cell--time {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.run-list__gate {
  grid-column: 1 / -1;
  margin-top: 4px; /* geometry — the gate line's own offset from the row above it */
  font-size: var(--text-xs);
  color: var(--state-awaiting-human);
}
</style>
