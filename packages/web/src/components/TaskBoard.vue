<script setup lang="ts">
/**
 * KAR-22.3 AC2, AC3, KAR-24.7 AC3, AC4, KAR-28.2 AC1, AC2, AC3, AC6 — the
 * agent list: the run's work, as a list of who is doing what.
 *
 * Verifies: EPIC-22-S36, EPIC-22-S37, EPIC-22-S38, EPIC-28-S07, EPIC-28-S08,
 * EPIC-28-S09, EPIC-28-S10 · AC1, AC2, AC3, AC6
 *
 * This is the surface the owner asked for in as many words — *"the list of
 * tasks the run created with the step names and which model is handling each"*
 * — and KAR-28.2 promoted it from the column beside the canvas to the thing the
 * screen shows. The thing to understand about it is unchanged: **it is not a
 * second model of the run**. Its rows arrive as a prop, derived by
 * `../lib/agent-rows.ts` from the very object `../app/useNodeBodies.ts` hands
 * the plan graph, in the same tick. There is no array in this file, no store
 * read, no `if` about an event kind, and no formatting of a duration or a price:
 * an elapsed time formatted here and formatted again in `node-body.ts` would be
 * two answers to one question, and the list would read `3.0 s` beside a node
 * reading `3 s`.
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
 * ## A retried step is more than one row (KAR-28.2 AC2)
 *
 * One row per **attempt**, oldest first, each labelled `— try #n`, and the
 * failed one still sitting there after the successful one. The row that is the
 * node's current attempt is the one carrying the shared body, so it is also the
 * one the graph is drawing; the rows above it are attempts that are over and
 * read their state, duration and money off their own span. A single-attempt
 * step gets no label at all, because `try #1` on a step that ran once reads as a
 * warning about a step that is perfectly fine.
 *
 * ## The hierarchy is drawn, never invented (AC1, EPIC-28-S09)
 *
 * A fan-out's children are real nodes named after the node that spawned them,
 * and `agentRows` is where that is read. Here it is two things: an indent, which
 * is for the eye, and a visually-hidden `sub-agent of …` prefix, which is for
 * everyone the indent does not reach — the same discipline as "colour is never
 * the only carrier". A run with no fan-out gets neither, because there is
 * nothing to say and a column of empty hierarchy chrome says something false.
 *
 * ## Colour is never the only carrier of state
 *
 * The state cell is `StateChip`, the one component every surface renders a run
 * state through: colour **and** glyph **and** text label, with no prop for
 * turning any of the three off (docs/12 §9.2, WCAG 1.4.1). The row's tint is an
 * additional cue layered on top of a row that already reads without it.
 *
 * ## The output control opens the route, and renders nothing (AC3)
 *
 * Every row links to `run-node-output`, which is EPIC-17's own surface for a
 * node's transcript. A link rather than a click handler, so it can be opened in
 * a tab and handed to somebody; `test/one-transcript-surface.test.ts` is what
 * stops this file growing a transcript renderer of its own.
 *
 * ## KAR-24.7 — the row this file draws is not a third padding scale
 *
 * `RunListView` restyled the run table to direction C's row density — a
 * ~5px-vertical row on a fixed column grid — and the gallery's "dense table
 * row" composite (KAR-24.3 AC1) shows the same bordered box: `--edge-strong`,
 * `--radius-lg`, a sticky mono header row, rows separated by `--edge`. This
 * file spends exactly that language rather than inventing a second one for nine
 * columns instead of four: the type scale, the padding rhythm and the
 * hover/selected treatment below are read straight off those two, not
 * re-derived. `UiChip` carries the row count next to the title, which is the
 * same "small tinted label" every crumb and pill on this screen already is.
 */
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { AgentRowVM } from '../lib/agent-rows.ts';
import StateChip from './StateChip.vue';
import { UiChip } from './ui/index.ts';

const props = defineProps<{
  /**
   * The rows, in the list's own order — the plan's, with each node's attempts
   * oldest first and each fan-out's children directly under it.
   *
   * A prop rather than a derivation of its own, so the list can be mounted
   * beside a hidden graph, and so the thing this component renders is visibly
   * the thing its caller renders (KAR-22.3 AC3, KAR-28.2 AC4).
   */
  readonly rows: readonly AgentRowVM[];
  /** The run these rows belong to — the output link's route needs both ids. */
  readonly projectId: string;
  readonly runId: string;
  /** The node the rest of the application has selected, if any. */
  readonly selected?: string | null;
}>();

const emit = defineEmits<{ select: [id: string] }>();

/**
 * Whether this run has a hierarchy at all.
 *
 * Read off the rows rather than passed in, and used only to withhold chrome: a
 * flat run must not pay an indent column for a nesting it does not have.
 */
const nested = computed(() => props.rows.some((row) => row.depth > 0));
</script>

<template>
  <section
    class="board"
    aria-labelledby="DeFlow-board-title"
    data-task-board
    data-agent-list
    :data-agent-nested="String(nested)"
  >
    <div class="board__head">
      <h2 id="DeFlow-board-title" class="board__title">Agents</h2>
      <UiChip variant="neutral" mono data-board-count>{{ rows.length }}</UiChip>
    </div>

    <!--
      A table, because it is one: eight facts per row, compared down columns.
      A list of divs would leave a screen-reader user without the column
      headers, which are half of what makes "which model is handling each"
      answerable at all.
    -->
    <!--
      KAR-27.5 AC1 — what the list says before there is anything to say.

      Nine column headers over no rows is not an empty state: it reads exactly
      the same whether the plan has not compiled yet or the load failed, and the
      operator has no way to tell those apart. The sentence names the one that
      is true, and names what will fill the columns when it changes.

      It replaces the table rather than sitting under it, because the headers
      describe rows and there are none — an accessible table with a header row
      and an empty body is a promise the markup does not keep.
    -->
    <div v-if="rows.length === 0" class="board__frame board__frame--empty">
      <p class="board__empty" data-board-empty>
        Nothing scheduled yet. Agents appear here — with their model, permission level, elapsed time
        and cost — once the plan compiles.
      </p>
    </div>

    <div v-else class="board__frame">
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
              <th scope="col">Output</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.key"
              class="board__row"
              :data-agent-row="row.key"
              :data-agent-node="row.nodeId"
              :data-agent-attempt="row.attempt"
              :data-agent-depth="row.depth"
              :data-agent-parent="row.parentId ?? undefined"
              :data-board-row="row.current ? row.nodeId : undefined"
              :data-state="row.state"
              :data-selected="String(row.nodeId === selected)"
              @click="emit('select', row.nodeId)"
            >
              <th scope="row" class="board__step" :style="{ '--board-depth': String(row.depth) }">
                <span v-if="row.depth > 0" class="board__nest" aria-hidden="true">↳</span>
                <button type="button" class="board__open" :data-board-open="row.nodeId">
                  <!--
                    The indent, for everyone the indent does not reach. It names
                    the node that spawned this one, which is the fact the
                    indentation is drawing.
                  -->
                  <span v-if="row.parentId !== null" class="board__hidden"
                    >sub-agent of {{ row.parentId }}:
                  </span>
                  <span data-board-title>{{ row.title }}</span>
                </button>
              </th>
              <td class="board__mono" data-board-type>{{ row.type }}</td>
              <td class="board__state" data-board-state>
                <!--
                  The one component every surface renders a state through, so
                  the list and the node body cannot describe one node two
                  ways.
                -->
                <StateChip :state="row.state" />
              </td>
              <td class="board__mono" data-board-provider>{{ row.provider }}</td>
              <td class="board__mono" data-board-model>{{ row.model }}</td>
              <td data-board-permission>{{ row.permission }}</td>
              <td class="board__figure" data-board-elapsed>{{ row.elapsed }}</td>
              <td class="board__figure" data-board-cost>{{ row.cost }}</td>
              <td class="board__output">
                <!--
                  EPIC-17's own route for a node's transcript. `@click.stop` so
                  opening the output is not also a selection of the row it sits
                  in — two things happening on one press is how an operator
                  loses the node they were reading.
                -->
                <RouterLink
                  class="board__output-link"
                  :data-board-output="row.nodeId"
                  :to="{
                    name: 'run-node-output',
                    params: { projectId, runId, nodeId: row.nodeId },
                  }"
                  @click.stop
                >
                  Output
                </RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.board {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 8px; /* geometry — title-to-table gap, matching RunListView's own */
  min-height: 0;
}

.board__head {
  display: flex;
  align-items: baseline;
  gap: 8px; /* geometry — title-to-count gutter */
}

.board__title {
  font-size: var(--text-base);
  font-weight: 600;
  margin: 0;
}

/*
 * The bordered box direction C's row density lives in — the same shape
 * `RunListView`'s `.run-list__table` and the gallery's `.gallery__table`
 * composite use, not a third one drawn for nine columns (KAR-24.7 AC4).
 */
.board__frame {
  min-height: 0;
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--surface);
}

.board__frame--empty {
  display: grid;
  place-content: center;
  padding: 20px; /* geometry — the sentence's own breathing room */
}

.board__empty {
  margin: 0;
  max-width: 24rem; /* geometry — a readable measure, not the panel's width */
  text-align: center;
  color: var(--ink-muted);
  font-size: var(--text-sm);
}

.board__scroll {
  overflow: auto;
  max-height: 100%;
}

.board__table {
  border-collapse: collapse;
  width: 100%;
}

.board__table thead th {
  position: sticky;
  top: 0;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--edge-strong);
  padding: 6px 8px; /* geometry — the head row's own padding */
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
  text-align: left;
  white-space: nowrap;
}

.board__table td,
.board__step {
  padding: 5px 8px; /* geometry — direction C's ~5px vertical row density */
  vertical-align: middle;
  white-space: nowrap;
}

/* The hierarchy, for the eye: one step of indent per level of nesting, on the
   cell that identifies the row. `--board-depth` is `0` on a flat run, so a run
   with no fan-out pays nothing for one (KAR-28.2 AC1). */
.board__step {
  padding-left: calc(8px + var(--board-depth, 0) * 14px);
}

.board__nest {
  color: var(--ink-faint);
  margin-right: 4px; /* geometry — the caret's own gutter */
}

/* The sentence the indent is drawing, for a reader who cannot see an indent.
   Not `display: none`, which would take it out of the accessibility tree too. */
.board__hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.board__row + .board__row td,
.board__row + .board__row .board__step {
  border-top: 1px solid var(--edge);
}

.board__row {
  cursor: pointer;
  /*
   * The tint is an *additional* cue: every row already carries the state as a
   * glyph and as a word inside `StateChip`, so a reader who cannot see the hue
   * loses nothing at all here (docs/12 §9.2).
   */
  border-left: 3px solid var(--state-pending);
}

.board__row:hover {
  background: var(--surface-inset);
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

/*
 * System law 3 — selection is hueless. This used to be a 10% mix of
 * `--state-running`, which meant a *selected* row and a *running* row were the
 * same green: the list had two vocabularies painted in one colour, and the
 * row's own left border was already saying which state it was in.
 * `--select-tint` is the application's one selection ground.
 */
.board__row[data-selected="true"] {
  background: var(--select-tint);
}

.board__open {
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  padding: 0;
  text-align: left;
  cursor: pointer;
  font-size: var(--text-sm);
}

.board__mono {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
}

.board__figure {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

.board__output-link {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
}

.board__output-link:hover {
  color: var(--ink);
}
</style>
