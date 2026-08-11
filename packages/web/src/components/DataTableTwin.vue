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
  <table class="twin" v-bind="{ [`data-${props.name}-table`]: '' }">
    <caption>
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
</template>

<style scoped>
.twin {
  border-collapse: collapse;
  font-size: 0.85rem;
}

.twin caption {
  padding-block-end: 0.35rem;
  color: var(--ink-muted);
  text-align: start;
}

.twin th,
.twin td {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--edge);
  text-align: start;
  white-space: nowrap;
}

.twin th[scope="row"] {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 500;
}
</style>
