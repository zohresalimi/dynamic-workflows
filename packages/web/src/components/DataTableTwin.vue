<script setup lang="ts">
/**
 * EPIC-17-S32 — every chart's data-table twin, as one component.
 *
 * Verifies: EPIC-17-S32 (scenarios 1 and 3) · KAR-17.4 AC9, KAR-17.8 AC9
 *
 * > The table view is one shared component parameterised per chart, and
 * > building it costs roughly twenty lines and doubles as accessibility
 * > compliance.
 *
 * Two things it is deliberately **not**:
 *
 * 1. **It does not derive anything.** `rows` arrives already formatted, from
 *    the same module the chart's geometry came from. A table that ran its own
 *    query would be a second source of truth, and the two disagree eventually —
 *    which is worse than having no table, because the table is the half a
 *    non-visual reader trusts.
 * 2. **It is not a grid.** No sorting, no filtering, no virtualisation. It is a
 *    `<table>` a screen reader can walk and a person can select and paste into
 *    a PR description, which is the M1 stand-in for the shareable run report
 *    (F10.13, docs/12-frontend-architecture.md §9.4).
 *
 * `name` becomes the table's own data attribute (`data-<name>-table`) so each
 * caller keeps the hook its specs already use, and the first column is a
 * `<th scope="row">` because it is what identifies the row.
 *
 * KAR-24.7 AC4 — this is "the graph's a11y twin", not a screen, so it takes no
 * variant of its own: it is restyled here into the same dense-row bordered
 * box `RunListView` and `TaskBoard` use — `--edge-strong`, `--radius-lg`, a
 * mono uppercase header row, ~5px rows — so a keyboard user moving from the
 * run table to this twin is not reading a second product's idea of a table.
 * Every a11y property it had stays exactly as it was: the `<caption>`, the
 * `scope="col"`/`scope="row"` cells and the `data-<name>-table`/`data-row`
 * hooks are unchanged, because restyling this file is not a licence to remove
 * the one thing it exists for.
 */
const props = defineProps<{
  /** `budget`, `timeline`, … — the chart this is the twin of. */
  readonly name: string;
  readonly caption: string;
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  /** One entry per mark in the chart, in the chart's own order. */
  readonly rows: readonly (Record<string, string> & { readonly key: string })[];
}>();

const cell = (row: Record<string, string>, key: string): string => row[key] ?? '';
</script>

<template>
  <div class="twin-frame">
    <table class="twin" v-bind="{ [`data-${props.name}-table`]: '' }">
      <caption class="twin__caption">
        {{ props.caption }}
      </caption>
      <thead>
        <tr>
          <th v-for="column in props.columns" :key="column.key" scope="col">{{ column.label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in props.rows" :key="row.key" :data-row="row.key">
          <template v-for="(column, index) in props.columns" :key="column.key">
            <th v-if="index === 0" scope="row">{{ cell(row, column.key) }}</th>
            <td v-else>{{ cell(row, column.key) }}</td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
/*
 * The bordered box direction C's row density lives in — the same shape
 * `RunListView`'s `.run-list__table` and `TaskBoard`'s `.board__frame` use
 * (KAR-24.7 AC4), so the graph's keyboard-reachable twin does not read as a
 * second table language.
 */
.twin-frame {
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--surface);
}

.twin {
  border-collapse: collapse;
  width: 100%;
}

.twin__caption {
  padding: 6px 8px; /* geometry — matches the head row's own padding */
  color: var(--ink-muted);
  font-size: var(--text-xs);
  text-align: start;
  border-bottom: 1px solid var(--edge-strong);
  background: var(--surface-raised);
}

.twin thead th {
  background: var(--surface-raised);
  border-bottom: 1px solid var(--edge-strong);
  padding: 6px 8px; /* geometry — the head row's own padding */
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
  text-align: start;
  white-space: nowrap;
}

.twin tbody th,
.twin tbody td {
  padding: 5px 8px; /* geometry — direction C's ~5px vertical row density */
  text-align: start;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
}

.twin tbody tr + tr th,
.twin tbody tr + tr td {
  border-top: 1px solid var(--edge);
}

.twin tbody th[scope="row"] {
  color: var(--ink);
  font-weight: 500;
}
</style>
