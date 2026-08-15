<script setup lang="ts">
/**
 * KAR-22.3 AC2, AC3 — the task board: the plan, as a list of work.
 *
 * Verifies: EPIC-22-S36, EPIC-22-S37, EPIC-22-S38 · AC2, AC3
 *
 * This is the surface the owner asked for in as many words — *"the list of
 * tasks the run created with the step names and which model is handling each"*
 * — and the thing to understand about it is that **it is not a second model of
 * the run**. Its rows arrive as a prop, from `../app/useNodeBodies.ts`, which
 * is the same object the plan graph draws and in the same tick. There is no
 * array in this file, no store read, no `if` about an event kind, and no
 * formatting of a duration or a price: an elapsed time
 * formatted here and formatted again in `node-body.ts` would be two answers to
 * one question, and the board would read `3.0 s` beside a node reading `3 s`.
 *
 * ## Why every row carries eight facts and not three
 *
 * A status board that says "running / passed / failed" answers *what* and
 * nothing an operator can act on. The eight are the ones AC2 names — title,
 * node type, state, provider, model, permission level, elapsed and cost — and
 * they are exactly what a person needs to decide "is this stuck", "is this the
 * expensive one" and "why is *that* model doing *this*". Where the ledger has
 * not said yet, the cell says so in words (`no model reported`), because an
 * empty cell reads as "there is nothing to say" and that is a different claim.
 *
 * ## Colour is never the only carrier of state
 *
 * The state cell is `StateChip`, the one component every surface renders a run
 * state through: colour **and** glyph **and** text label, with no prop for
 * turning any of the three off (docs/12 §9.2, WCAG 1.4.1). The row's tint is an
 * additional cue layered on top of a row that already reads without it.
 */
import type { NodeBodyVM } from './graph/node-body.ts';
import StateChip from './StateChip.vue';

defineProps<{
  /**
   * The shared bodies, in the plan's own order.
   *
   * A prop rather than a `useNodeBodies()` call of its own, so the board can be
   * mounted beside a collapsed graph, and so the thing this component renders
   * is visibly the thing its caller renders (KAR-22.3 AC3).
   */
  readonly bodies: readonly NodeBodyVM[];
  /** The node the rest of the application has selected, if any. */
  readonly selected?: string | null;
}>();

const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <section class="board" aria-labelledby="DeFlow-board-title" data-task-board>
    <h2 id="DeFlow-board-title" class="board__title">
      Tasks
      <span class="board__count" data-board-count>{{ bodies.length }}</span>
    </h2>

    <!--
      A table, because it is one: eight facts per row, compared down columns.
      A list of divs would leave a screen-reader user without the column
      headers, which are half of what makes "which model is handling each"
      answerable at all.
    -->
    <div class="board__scroll">
      <table class="board__table">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Type</th>
            <th scope="col">State</th>
            <th scope="col">Agent</th>
            <th scope="col">Model</th>
            <th scope="col">Permission</th>
            <th scope="col">Elapsed</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="body in bodies"
            :key="body.id"
            class="board__row"
            :data-board-row="body.id"
            :data-state="body.state"
            :data-selected="String(body.id === selected)"
            @click="emit('select', body.id)"
          >
            <th scope="row" class="board__step">
              <button type="button" class="board__open" :data-board-open="body.id">
                <span data-board-title>{{ body.title }}</span>
              </button>
            </th>
            <td data-board-type>{{ body.type }}</td>
            <td class="board__state" data-board-state>
              <!--
                The one component every surface renders a state through, so the
                board and the node body cannot describe one node two ways.
              -->
              <StateChip :state="body.state" />
            </td>
            <td data-board-provider>{{ body.provider }}</td>
            <td data-board-model>{{ body.model }}</td>
            <td data-board-permission>{{ body.permission }}</td>
            <td class="board__figure" data-board-elapsed>{{ body.elapsed }}</td>
            <td class="board__figure" data-board-cost>{{ body.cost }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.board {
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 0;
}

.board__title {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.95rem;
  margin: 0 0 0.4rem;
}

.board__count {
  font-size: 0.8em;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

.board__scroll {
  overflow: auto;
  min-height: 0;
}

.board__table {
  border-collapse: collapse;
  font-size: 0.8125rem;
  width: 100%;
}

.board__table th {
  text-align: left;
  font-weight: 600;
}

.board__table thead th {
  position: sticky;
  top: 0;
  background: var(--surface-raised, canvas);
  border-bottom: 1px solid var(--edge, rgb(0 0 0 / 15%));
  padding: 0.3rem 0.5rem;
  white-space: nowrap;
}

.board__table td,
.board__step {
  padding: 0.3rem 0.5rem;
  vertical-align: middle;
  white-space: nowrap;
}

.board__row + .board__row td,
.board__row + .board__row .board__step {
  border-top: 1px solid var(--edge, rgb(0 0 0 / 8%));
}

/*
 * The tint is an *additional* cue: every row already carries the state as a
 * glyph and as a word inside `StateChip`, so a reader who cannot see the hue
 * loses nothing at all here (docs/12 §9.2).
 */
.board__row {
  border-left: 3px solid var(--state-pending);
}

.board__row[data-state="running"] {
  border-left-color: var(--state-running);
}
.board__row[data-state="blocked"] {
  border-left-color: var(--state-blocked);
}
.board__row[data-state="passed"] {
  border-left-color: var(--state-passed);
}
.board__row[data-state="failed"] {
  border-left-color: var(--state-failed);
}
.board__row[data-state="abandoned"] {
  border-left-color: var(--state-abandoned);
}
.board__row[data-state="awaiting-human"] {
  border-left-color: var(--state-awaiting-human);
}

.board__row[data-selected="true"] {
  background: color-mix(in oklch, var(--state-running) 10%, transparent);
}

.board__open {
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  padding: 0;
  text-align: left;
  cursor: pointer;
}

.board__figure {
  font-variant-numeric: tabular-nums;
}
</style>
