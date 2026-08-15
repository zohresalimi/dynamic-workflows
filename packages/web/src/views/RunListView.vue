<script setup lang="ts">
/**
 * KAR-19.1 AC5 — the root route: a live list of runs.
 *
 * Until this view, `/` rendered `PlanGraphView` with no run id, so a tab that
 * had just submitted a task showed a graph of nothing and the operator had to
 * type a run id into the address bar to find their own run. That is the third of
 * the three joints EPIC-19 reconnects, and it is the one they actually noticed.
 *
 * The view itself does almost nothing, which is the point:
 *
 * - **It reduces nothing.** Every row came off `useRunListStore`, whose only
 *   two inputs are one `GET /api/runs` and the `?runs=*` frames.
 * - **It polls nothing.** There is no interval in this file or under it. A run
 *   created while this page is open arrives on the subscription the composable
 *   opened, and the row appears because the store changed.
 * - **It invents no status word.** `row.label` is `runStatusLabel`'s string,
 *   produced in `@DeFlow/core` and rendered here, in `deflow status` and in
 *   `deflow run` (AC6).
 */
import { RouterLink } from 'vue-router';
import { MAIN_CONTENT_ID } from '../app/ids.ts';
import { useRunList } from '../app/useRunList.ts';
import { useRunListStore } from '../stores/useRunListStore.ts';

const runs = useRunListStore();
useRunList();
</script>

<template>
  <main :id="MAIN_CONTENT_ID" class="run-list" data-run-list>
    <h1 class="run-list__title">Runs</h1>

    <p v-if="runs.list.length === 0" class="run-list__empty" data-run-list-empty>
      No runs yet. Submit one with <code>deflow run --file &lt;path&gt;</code>, and it will appear
      here as soon as it is accepted — you do not need to reload this page.
    </p>

    <ul v-else class="run-list__rows">
      <li v-for="row in runs.list" :key="row.runId" class="run-list__row" data-run-row>
        <RouterLink class="run-list__link" :to="`/runs/${row.runId}`" :data-run-link="row.runId">
          <span class="run-list__row-title">{{ row.title }}</span>
          <span class="run-list__row-status" :data-run-status="row.runId">{{ row.label }}</span>
          <!--
            KAR-19.12 AC6 — which gate, beside the status word rather than
            instead of it. `needs a decision` is true and says nothing about
            *what* is being decided, which is the fact an operator scanning this
            list is looking for.
          -->
          <span v-if="row.gate" class="run-list__row-gate" :data-run-gate="row.runId"
            >waiting on {{ row.gate.node }} —
            {{ row.gate.options.map((o) => o.id).join(', ') }}</span
          >
          <span class="run-list__row-id">{{ row.runId }}</span>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.run-list {
  padding: 1rem;
}

.run-list__title {
  font-size: 1.1rem;
  margin: 0 0 0.75rem;
}

.run-list__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.run-list__row + .run-list__row {
  border-top: 1px solid var(--border, rgb(0 0 0 / 10%));
}

.run-list__link {
  display: grid;
  gap: 0.25rem 1rem;
  grid-template-columns: 1fr auto;
  padding: 0.5rem 0.25rem;
  text-decoration: none;
  color: inherit;
}

.run-list__row-status {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.run-list__row-gate {
  grid-column: 1 / -1;
  font-size: 0.8em;
  color: var(--ink-warn, var(--ink-muted));
}

.run-list__row-id {
  font-family: var(--font-mono, monospace);
  font-size: 0.8em;
  grid-column: 1 / -1;
  opacity: 0.6;
}
</style>
