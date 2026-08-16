<script setup lang="ts">
/**
 * KAR-22.3 — the project workspace: what is happening, and what happened.
 *
 * Verifies: EPIC-22-S34, EPIC-22-S36, EPIC-22-S37, EPIC-22-S41, EPIC-22-S42,
 * EPIC-22-S43, EPIC-22-S46 · AC1–AC7
 *
 * This is the screen the epic exists for. Everything on it already existed
 * somewhere in the application and none of it was reachable from a project:
 * the graph is EPIC-17's canvas mounted through `PlanGraphView` (not a second
 * one — `test/one-workspace-surface.test.ts` fails the build if it ever
 * becomes one), the board is the same join in a different shape, and the
 * history is the daemon's own answer for this project.
 *
 * ## The four things this file is responsible for
 *
 * 1. **Choosing the run.** `/projects/:projectId` opens the newest run —
 *    which is the live one while anything is running, and the last one
 *    afterwards. `/projects/:projectId/runs/:runId` opens the one named. That
 *    is the whole of "history is browsable without knowing a run id" (AC5): the
 *    only place a run id is ever typed is a link's `href`.
 * 2. **Releasing the previous project.** Switching project calls `run.close()`
 *    *before* anything of the new one arrives, so the store, the ring and the
 *    subscription go together (AC7). Without it, a project with no runs would
 *    render the previous project's graph under this project's name — which is
 *    the exact failure EPIC-22-S43 is written against, and it is silent.
 * 3. **Saying nothing has run yet, usefully.** A blank canvas reads as a broken
 *    page. A project with no runs gets a sentence and the composer (AC6).
 * 4. **Nothing else.** It reduces nothing, formats no duration and no price,
 *    and holds no array of nodes: the board's rows and the graph's bodies are
 *    one object from `../app/useNodeBodies.ts` (AC3).
 */
import { computed, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { COMPOSER_OVERLAY } from '../app/ids.ts';
import { useNodeBodies } from '../app/useNodeBodies.ts';
import TaskBoard from '../components/TaskBoard.vue';
import { useRunStore } from '../stores/useRunStore.ts';
import { useUiStore } from '../stores/useUiStore.ts';
import PlanGraphView from './PlanGraphView.vue';

const props = defineProps<{
  /** From `/projects/:projectId`. */
  readonly projectId: string;
  /** From `/projects/:projectId/runs/:runId`, when a past run was opened. */
  readonly runId?: string;
}>();

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly health: { readonly state: string; readonly message: string | null };
}

/** One row of `GET /api/projects/:id/runs` — the daemon's own list row. */
interface HistoryRow {
  readonly runId: string;
  readonly status: string;
  /** `runStatusLabel`'s string: the one sentence every surface prints. */
  readonly label: string;
  readonly title: string;
  readonly createdAt: string;
  readonly cost: { readonly run?: { readonly costUsd?: number | null } } | null;
  /**
   * KAR-22.5 AC7 — the gate this run has stopped on, or `null`.
   *
   * `pendingGate`'s own answer, arriving on the row because `runEntry` already
   * carries it for the global run list (KAR-19.12 AC6). No second query and no
   * second vocabulary: a run that wants you is findable here without being
   * opened.
   */
  readonly gate: { readonly node: string } | null;
}

/**
 * The two calls this view makes, named — the same seam `ProjectsView` draws.
 *
 * `hc<ApiType>` types them off the daemon's own chained routes; this interface
 * is the shape those calls have, so the casts are one readable statement rather
 * than a `never` at each call site.
 */
interface WorkspaceApi {
  readonly projects: {
    readonly $get: () => Promise<HttpAnswer>;
    readonly ':id': {
      readonly runs: { readonly $get: (args: { param: { id: string } }) => Promise<HttpAnswer> };
    };
  };
}

interface HttpAnswer {
  readonly ok: boolean;
  readonly json: () => Promise<unknown>;
}

const api = useApiClient() as never as WorkspaceApi;
const run = useRunStore();
const ui = useUiStore();
const router = useRouter();

const project = ref<ProjectRow | null>(null);
const history = ref<readonly HistoryRow[]>([]);
const loaded = ref(false);

/**
 * The run on screen: the one the route names, or this project's newest.
 *
 * `null` while the history is still arriving, which is what keeps the empty
 * state from flashing on a project that has plenty of runs.
 */
const currentRun = computed<string | null>(() => props.runId ?? history.value[0]?.runId ?? null);

const nothingHasRun = computed(() => loaded.value && history.value.length === 0);

/** The bodies — the same object the graph draws (AC3). */
const bodies = useNodeBodies();
const rows = computed(() => [...bodies.value.values()]);

async function load(id: string): Promise<void> {
  const [projects, runs] = await Promise.all([
    api.projects.$get(),
    api.projects[':id'].runs.$get({ param: { id } }),
  ]);

  if (props.projectId !== id) return; // The operator moved on while we asked.

  if (projects.ok) {
    const listed = ((await projects.json()) as { projects: readonly ProjectRow[] }).projects;
    project.value = listed.find((row) => row.id === id) ?? null;
  }
  if (runs.ok) {
    history.value = ((await runs.json()) as { runs: readonly HistoryRow[] }).runs;
  }
  loaded.value = true;
}

/**
 * AC7 — the previous project is released before the next one is asked for.
 *
 * `run.close()` disposes the projections, the debug ring and every terminal the
 * store adopted; the feed goes with `PlanGraphView`, which unmounts the moment
 * `currentRun` is `null`. Doing it here rather than relying on `run.open()`'s
 * own "different run closes the old one" is deliberate: a project with **no**
 * runs never calls `open()` at all, and that is precisely the case where the
 * previous project's nodes would still be on screen.
 */
watch(
  () => props.projectId,
  (id) => {
    run.close();
    ui.setNodes([]);
    project.value = null;
    history.value = [];
    loaded.value = false;
    void load(id);
  },
  { immediate: true },
);

/** Opens a run of this project. The id travels in the route, never in a field. */
function openRun(runId: string): void {
  void router.push({ name: 'project-run', params: { projectId: props.projectId, runId } });
}

/** `2026-08-15 10:11` — enough to tell two runs apart, in the tab's own zone. */
function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toLocaleString();
}

/**
 * What a run cost, in the vocabulary `node-body.ts` uses for the same figure:
 * a price when one was measured, and the words "not priced" when nothing could
 * measure it. Never `$0.00` for a run nobody could price — those are different
 * facts and only one of them is a defect.
 */
function spent(row: HistoryRow): string {
  const costUsd = row.cost?.run?.costUsd;
  return typeof costUsd === 'number' ? `$${costUsd.toFixed(2)}` : 'not priced';
}
</script>

<template>
  <div class="workspace" data-project-workspace :data-project="projectId">
    <header class="workspace__head">
      <h1 class="workspace__title">
        <RouterLink to="/projects" class="workspace__back">Projects</RouterLink>
        <span class="workspace__name" data-workspace-project-name>
          {{ project?.name ?? projectId }}
        </span>
      </h1>
      <code v-if="project" class="workspace__path">{{ project.path }}</code>
      <!--
        KAR-22.4 — the way in to this project's connectors. A route nothing
        links to is a route nobody can reach, and the connectors screen is where
        AC1's whole story about who holds the token is told.
      -->
      <RouterLink
        class="workspace__connectors"
        data-workspace-connectors
        :to="{ name: 'project-connectors', params: { projectId } }"
      >
        Connectors
      </RouterLink>
      <!--
        A project whose directory has gone still shows everything below; it just
        says so, in the daemon's own sentence (EPIC-22-S45).
      -->
      <p
        v-if="project?.health.message"
        class="workspace__health"
        data-workspace-health
        role="status"
      >
        {{ project.health.message }}
      </p>
    </header>

    <!--
      AC6 — a project with no runs says so and points at the composer. There is
      deliberately no canvas here: an empty graph reads as a broken page rather
      than as "nothing has run yet".
    -->
    <section v-if="nothingHasRun" class="workspace__empty" data-workspace-empty>
      <p>Nothing has run in this project yet.</p>
      <p>
        Start one with the composer — describe the task, pick the agent, and this page will show its
        graph as it happens.
      </p>
      <button type="button" data-workspace-compose @click="ui.openOverlay(COMPOSER_OVERLAY)">
        Start a run
      </button>
    </section>

    <template v-else-if="currentRun !== null">
      <section class="workspace__graph" aria-label="The run's plan graph">
        <!--
          AC1 — EPIC-17's canvas, mounted rather than reimplemented. It owns the
          run's feed (`../app/useRunFeed.ts`), so this view opens no
          subscription of its own and there is exactly one per run.
        -->
        <PlanGraphView :run-id="currentRun" />
      </section>

      <aside class="workspace__board">
        <TaskBoard
          :bodies="rows"
          :selected="ui.selectedNodeId"
          @select="(id: string) => ui.selectNode(id)"
        />
      </aside>
    </template>

    <section class="workspace__history" aria-labelledby="DeFlow-history-title">
      <h2 id="DeFlow-history-title" class="workspace__history-title">History</h2>
      <p v-if="history.length === 0" class="workspace__history-empty">
        Runs you start in this project appear here.
      </p>
      <ul v-else class="workspace__history-rows">
        <li
          v-for="row in history"
          :key="row.runId"
          class="workspace__history-row"
          :data-history-row="row.runId"
          :data-current="String(row.runId === currentRun)"
        >
          <!--
            AC5 — the whole of "without knowing a run id": the operator presses
            a row. The id is in the route this button pushes and nowhere else.
          -->
          <button
            type="button"
            class="workspace__history-open"
            :data-history-open="row.runId"
            @click="openRun(row.runId)"
          >
            {{ row.title }}
          </button>
          <span class="workspace__history-outcome" :data-history-outcome="row.runId">
            {{ row.label }}
          </span>
          <!--
            AC7 — and which gate it is waiting on, when it is waiting on one.
            The row already says `needs a decision`; this says *which* decision,
            which is the difference between a list you can act on and one you
            have to open row by row.
          -->
          <span v-if="row.gate" class="workspace__history-gate" :data-history-gate="row.runId"
            >waiting on {{ row.gate.node }}</span
          >
          <span class="workspace__history-when">{{ when(row.createdAt) }}</span>
          <span class="workspace__history-cost">{{ spent(row) }}</span>
          <!--
            AC4 — and the existing scrubber for it, one link away. The plan's
            version rail is where "what did this run look like at v2" is
            answered, and it is EPIC-17's surface rather than a second one here.
          -->
          <RouterLink
            class="workspace__history-scrub"
            :to="`/runs/${row.runId}/evolution`"
            :data-run-scrubber="row.runId"
          >
            Scrubber
          </RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(18rem, 2fr);
  grid-template-rows: auto minmax(16rem, 1fr) auto;
  gap: 0.75rem;
  height: 100%;
  min-height: 0;
}

.workspace__connectors {
  font-size: 0.85em;
}

.workspace__head,
.workspace__empty,
.workspace__history {
  grid-column: 1 / -1;
}

.workspace__title {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 1.1rem;
  margin: 0;
}

.workspace__back {
  font-size: 0.8rem;
  color: var(--ink-muted);
}

.workspace__path {
  font-family: var(--font-mono, monospace);
  font-size: 0.8em;
  opacity: 0.7;
}

/* The message is always a sentence: the colour is an extra cue, never the
   carrier (docs/12 §9.2). */
.workspace__health {
  color: var(--ink-warn, inherit);
  font-size: 0.85em;
  margin: 0.25rem 0 0;
}

.workspace__empty {
  display: grid;
  gap: 0.5rem;
  justify-items: start;
  align-content: center;
  padding: 2rem 0;
  max-width: 40rem;
}

.workspace__graph {
  min-height: 0;
  position: relative;
}

.workspace__board {
  min-height: 0;
  overflow: hidden;
}

.workspace__history-title {
  font-size: 0.95rem;
  margin: 0 0 0.4rem;
}

.workspace__history-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 12rem;
  overflow: auto;
}

.workspace__history-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto auto auto;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.3rem 0.25rem;
  font-size: 0.8125rem;
}

.workspace__history-row + .workspace__history-row {
  border-top: 1px solid var(--edge, rgb(0 0 0 / 8%));
}

.workspace__history-row[data-current="true"] {
  background: color-mix(in oklch, var(--state-running) 8%, transparent);
}

.workspace__history-open {
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  padding: 0;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace__history-when,
.workspace__history-cost {
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

/* A sentence, not a dot: the state is carried by the words (docs/12 §9.2). */
.workspace__history-gate {
  color: var(--ink-warn, inherit);
  white-space: nowrap;
}
</style>
