<script setup lang="ts">
/**
 * KAR-22.3 — this project's workflows: what is happening, and what happened.
 *
 * Verifies: EPIC-22-S34, EPIC-22-S36, EPIC-22-S37, EPIC-22-S41, EPIC-22-S42,
 * EPIC-22-S43, EPIC-22-S46 · AC1–AC7
 *
 * Renamed from `ProjectWorkspaceView` by KAR-25.1 (EPIC-25-S05): "Workspace"
 * is not the word for what this screen shows, and does not appear anywhere a
 * person can read it in this application any more. The route is
 * `project-workflows` now; nothing about what this file renders changed — the
 * `workspace__*` BEM prefix and the `data-workspace-*` hooks below are left
 * alone on purpose, because they are not user-visible strings and renaming
 * them costs four selector edits in `project-workflows.test.ts` for nothing
 * EPIC-25-S05 asks for (see that scenario's own scope: nav label, heading,
 * breadcrumb, page title — not an internal class name).
 *
 * This is the screen EPIC-22 exists for. Everything on it already existed
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
import { type PendingGate, type RunStatus, SPEC_GATE_NODE } from '@DeFlow/core';
import { UserRound } from 'lucide-vue-next';
import { computed, inject, onScopeDispose, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { readToken } from '../api/token.ts';
import { COMPOSER_OVERLAY } from '../app/ids.ts';
import { useNodeBodies } from '../app/useNodeBodies.ts';
import { openLazyRunsFeed, RUNS_FEED } from '../app/useRunList.ts';
import TaskBoard from '../components/TaskBoard.vue';
import { UiButton, UiCard, UiChip, UiEmptyState } from '../components/ui/index.ts';
import { RUN_STATUS_DISPLAY, stateVar } from '../lib/state-palette.ts';
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
  readonly status: RunStatus;
  /** `runStatusLabel`'s string: the one sentence every surface prints. */
  readonly label: string;
  readonly title: string;
  readonly createdAt: string;
  readonly cost: { readonly run?: { readonly costUsd?: number | null } } | null;
  /**
   * KAR-22.5 AC7, KAR-25.7 — the gate this run has stopped on, or `null`.
   *
   * `pendingGate`'s own answer, arriving on the row because `runEntry` already
   * carries it for the global run list (KAR-19.12 AC6). No second query and no
   * second vocabulary: a run that wants you is findable here without being
   * opened.
   *
   * KAR-25.7 widens this from `{ node: string }` to the daemon's full
   * `PendingGate`: the options were already on the wire (`runEntry` calls the
   * same `pendingGate` the run list's row does) and this type simply dropped
   * them. Carrying them is what lets a waiting row answer through
   * `../components/gate/GateOptions.vue` without a second request.
   */
  readonly gate: PendingGate | null;
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

/**
 * KAR-25.7 AC3 — the one place `human.responded` reaches this list.
 *
 * `history` has no subscription of any kind before this story — one
 * `GET /api/projects/:id/runs`, and a waiting row's gate stayed marked
 * "waiting" for the rest of the tab's life, an answer notwithstanding. The
 * `RUNS_FEED` factory this calls is the same one `../app/useRunList.ts`
 * injects and `../app/useApprovals.ts` reuses: in production all three are
 * listeners on the one shared `?runs=*` connection
 * (`../ledger/shared-hub.ts`), so this is not a second socket, only a second
 * fold of a frame that was already arriving.
 *
 * Both halves of a gate's life are read here, `human.requested` as well as
 * `human.responded`. An earlier revision folded only the closing frame, on the
 * stated grounds that "the other four kinds on the topic say nothing about a
 * gate" — which is wrong about exactly one of them: `human.requested` *is* the
 * frame that announces a gate. The effect was a narrower version of the defect
 * this story exists to remove: an operator sitting on a project's history when
 * one of its runs stopped for a decision saw nothing, because the row only ever
 * reflected whatever `GET /api/projects/:id/runs` returned at load. The other
 * three kinds are run statuses, and this view has no status word of its own to
 * keep in step — `row.label` is the daemon's.
 */
const openRunsFeed = inject(RUNS_FEED, openLazyRunsFeed);
let closeRunsFeed: (() => void) | null = null;

/**
 * The gate a `human.requested` frame opened, in the shape the daemon's own
 * `pendingGate` puts on `GET /api/projects/:id/runs` — so a row updated live
 * and a row loaded from that fetch are the same shape, and
 * `../components/gate/GateOptions.vue` cannot tell them apart.
 *
 * `prompt`, `requestedSeq` and `reason` come off the frame when it carries
 * them and default to the empty answer when it does not, rather than being
 * invented: a live row that renders a shorter prompt than the fetched one
 * would is a row that is honest about what the frame said.
 */
function gateFromFrame(payload: unknown): PendingGate | null {
  const frame = payload as {
    readonly node?: unknown;
    readonly prompt?: unknown;
    readonly seq?: unknown;
    readonly reason?: unknown;
    readonly options?: readonly { readonly id?: unknown; readonly label?: unknown }[];
  };
  if (typeof frame.node !== 'string') return null;

  return {
    node: frame.node as PendingGate['node'],
    prompt: typeof frame.prompt === 'string' ? frame.prompt : '',
    options: (frame.options ?? [])
      .filter(
        (option): option is { id: string; label: string } =>
          typeof option.id === 'string' && typeof option.label === 'string',
      )
      .map((option) => ({ id: option.id, label: option.label })),
    requestedSeq: typeof frame.seq === 'number' ? frame.seq : 0,
    specApproval: frame.node === SPEC_GATE_NODE,
    reason: (frame.reason ?? null) as PendingGate['reason'],
  };
}

/** Replace one row's `gate`, leaving every other row alone. */
function setHistoryGate(runId: string, at: number, gate: PendingGate | null): void {
  const next = [...history.value];
  const current = next[at];
  if (current === undefined) return;
  next[at] = { ...current, gate };
  history.value = next;
}

function applyHistoryGate(event: {
  readonly kind: string;
  readonly runId: string;
  readonly payload: unknown;
}): void {
  if (event.kind === 'human.requested') {
    const gate = gateFromFrame(event.payload);
    if (gate === null) return;
    const at = history.value.findIndex((row) => row.runId === event.runId);
    if (at === -1) return; // A run this project's list has not fetched yet.
    setHistoryGate(event.runId, at, gate);
    return;
  }

  if (event.kind !== 'human.responded') return;
  const node = (event.payload as { readonly node?: unknown }).node;
  if (typeof node !== 'string') return;

  // Matched by node, not just by run: a run with two open gates keeps the one
  // that was not answered.
  const at = history.value.findIndex((row) => row.runId === event.runId && row.gate?.node === node);
  if (at === -1) return;
  setHistoryGate(event.runId, at, null);
}

const runsFeed = openRunsFeed({ token: readToken, onLifecycle: applyHistoryGate });
closeRunsFeed = () => runsFeed.close();
onScopeDispose(() => closeRunsFeed?.());

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

/**
 * The history row's dot colour, through the same domain-to-display mapping
 * `RunListView` reads for the run table's own dot (KAR-24.7 AC3, AC4) — never
 * a colour named in this file, and never a second vocabulary for the same
 * run statuses.
 */
function dotColour(status: RunStatus): string {
  return stateVar(RUN_STATUS_DISPLAY[status]);
}

/** `UiChip`'s tone for a health state — the same mapping `ProjectsView` uses
 * for the same field, so one project reads the same way on both screens. */
function healthTone(state: string): 'ok' | 'warn' | 'error' {
  if (state === 'ok') return 'ok';
  if (state === 'missing') return 'warn';
  return 'error';
}
</script>

<template>
  <div class="workspace" data-project-workspace :data-project="projectId">
    <!--
      KAR-24.7 AC4 — the one "card" shape this screen has (the board and the
      history below are the dense-row table, not a card). Everything else in
      this header is content, not chrome, so it sits inside `UiCard`'s own
      slot rather than growing a second bordered box beside it.
    -->
    <UiCard variant="raised" class="workspace__head-card">
      <header class="workspace__head">
        <h1 class="workspace__title">
          <RouterLink to="/projects" class="workspace__back">Projects</RouterLink>
          <span class="workspace__name" data-workspace-project-name>
            {{ project?.name ?? projectId }}
          </span>
        </h1>
        <code v-if="project" class="workspace__path">{{ project.path }}</code>
        <!--
          A project whose directory has gone still shows everything below; it
          just says so, in the daemon's own sentence (EPIC-22-S45). The chip
          repeats the same fact with a token; the sentence stays the carrier.
        -->
        <p
          v-if="project?.health.message"
          class="workspace__health"
          data-workspace-health
          role="status"
        >
          <UiChip :variant="healthTone(project.health.state)" mono
            >{{ project.health.state }}</UiChip
          >
          {{ project.health.message }}
        </p>
      </header>
    </UiCard>

    <!--
      AC6, KAR-24.7 AC5 — a project with no runs says so and points at the
      composer, through the one component every empty list on this screen
      routes through. There is deliberately no canvas here: an empty graph
      reads as a broken page rather than as "nothing has run yet".
    -->
    <UiEmptyState
      v-if="nothingHasRun"
      class="workspace__empty"
      data-workspace-empty
      title="Nothing has run in this project yet"
      hint="Start one with the composer — describe the task, pick the agent, and this page will show its graph as it happens."
    >
      <template #action>
        <UiButton
          variant="primary"
          size="md"
          data-workspace-compose
          @click="ui.openOverlay(COMPOSER_OVERLAY)"
        >
          <UserRound :size="12" aria-hidden="true" />
          Start a run
        </UiButton>
      </template>
    </UiEmptyState>

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

    <!--
      KAR-24.7 AC4 — the history is the run table's own shape: the same dense
      row, the same dot-plus-mono-figures language `RunListView` draws, rather
      than the six-column baseline grid this section used to invent on its
      own.
    -->
    <section class="workspace__history" aria-labelledby="DeFlow-history-title">
      <h2 id="DeFlow-history-title" class="workspace__history-title">History</h2>

      <UiEmptyState
        v-if="history.length === 0"
        data-workspace-history-empty
        title="No runs yet"
        hint="Runs you start in this project appear here."
      >
        <template #action>
          <UiButton
            variant="ghost"
            size="sm"
            data-workspace-history-compose
            @click="ui.openOverlay(COMPOSER_OVERLAY)"
          >
            Start a run
          </UiButton>
        </template>
      </UiEmptyState>

      <div v-else class="workspace__history-table" data-workspace-history-table>
        <div class="workspace__history-head" role="row">
          <span class="workspace__history-head-cell">Run</span>
          <span class="workspace__history-head-cell">Status</span>
          <span class="workspace__history-head-cell">Cost</span>
          <span class="workspace__history-head-cell">Time</span>
          <span class="workspace__history-head-cell">Scrubber</span>
        </div>

        <ul class="workspace__history-rows">
          <li
            v-for="row in history"
            :key="row.runId"
            class="workspace__history-row"
            :data-history-row="row.runId"
            :data-current="String(row.runId === currentRun)"
          >
            <span class="workspace__history-cell workspace__history-cell--run">
              <!--
                A live run's dot animates, same as `RunListView`'s own — the
                same `pulsering` token, the same reason (KAR-24.7 AC3, AC4).
              -->
              <span
                class="workspace__history-dot"
                :class="{ 'workspace__history-dot--live': row.status === 'running' }"
                data-motion-token
                aria-hidden="true"
                :style="{ '--history-dot-colour': dotColour(row.status) }"
              />
              <!--
                AC5 — the whole of "without knowing a run id": the operator
                presses a row. The id is in the route this button pushes and
                nowhere else.
              -->
              <button
                type="button"
                class="workspace__history-open"
                :data-history-open="row.runId"
                @click="openRun(row.runId)"
              >
                {{ row.title }}
              </button>
            </span>
            <span
              class="workspace__history-cell workspace__history-cell--status"
              :data-history-outcome="row.runId"
            >
              {{ row.label }}
            </span>
            <span class="workspace__history-cell workspace__history-cell--cost"
              >{{ spent(row) }}</span
            >
            <span class="workspace__history-cell workspace__history-cell--when"
              >{{ when(row.createdAt) }}</span
            >
            <!--
              AC4 — and the existing scrubber for it, one link away. The plan's
              version rail is where "what did this run look like at v2" is
              answered, and it is EPIC-17's surface rather than a second one here.
            -->
            <RouterLink
              class="workspace__history-cell workspace__history-scrub"
              :to="{ name: 'plan-evolution', params: { projectId, runId: row.runId } }"
              :data-run-scrubber="row.runId"
            >
              Scrubber
            </RouterLink>
            <!--
              AC7 — and which gate it is waiting on, when it is waiting on one.
              The row already says `needs a decision`; this says *which*
              decision, which is the difference between a list you can act on
              and one you have to open row by row.
            -->
            <span v-if="row.gate" class="workspace__history-gate" :data-history-gate="row.runId"
              >waiting on {{ row.gate.node }}</span
            >
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(18rem, 2fr);
  grid-template-rows: auto minmax(16rem, 1fr) auto;
  gap: 12px; /* geometry — matches the dense sections' own row gap */
  height: 100%;
  min-height: 0;
}

.workspace__head-card,
.workspace__empty,
.workspace__history {
  grid-column: 1 / -1;
}

.workspace__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px; /* geometry — the header's own gutter */
}

.workspace__title {
  display: flex;
  align-items: baseline;
  gap: 8px; /* geometry — crumb-to-name gutter */
  font-size: var(--text-lg);
  margin: 0;
}

.workspace__back {
  font-size: var(--text-sm);
  color: var(--ink-muted);
}

.workspace__path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

/* The message is always a sentence: the colour is an extra cue, never the
   carrier (docs/12 §9.2). The chip beside it says the same word with a token. */
.workspace__health {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — chip-to-message gutter */
  color: var(--state-blocked);
  font-size: var(--text-sm);
  margin: 0;
  flex-basis: 100%;
}

.workspace__empty {
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
  font-size: var(--text-base);
  font-weight: 600;
  margin: 0 0 8px; /* geometry — title-to-table gap */
}

/*
 * The bordered box direction C's row density lives in — the same shape
 * `RunListView`'s `.run-list__table` and `TaskBoard`'s `.board__frame` use
 * (KAR-24.7 AC4), so a run's history does not read as a third table.
 */
.workspace__history-table {
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--surface);
  max-height: 12rem;
  display: flex;
  flex-direction: column;
}

.workspace__history-head,
.workspace__history-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px 90px 150px 90px;
  align-items: center;
  gap: 12px; /* geometry — the row's own gutter */
}

.workspace__history-head {
  padding: 6px 14px; /* geometry — the head row's own padding */
  background: var(--surface-raised);
  border-bottom: 1px solid var(--edge-strong);
  flex: none;
}

.workspace__history-head-cell {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.1em;
  color: var(--ink-faint);
  text-transform: uppercase;
}

.workspace__history-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  min-height: 0;
}

.workspace__history-row {
  /* ~5px vertical — direction C's row density (KAR-24.7 AC3, AC4). */
  padding: 5px 14px;
  font-size: var(--text-sm);
}

.workspace__history-row + .workspace__history-row {
  border-top: 1px solid var(--edge);
}

.workspace__history-row:hover {
  background: var(--surface-inset);
}

.workspace__history-row[data-current="true"] {
  background: color-mix(in oklch, var(--state-running) 8%, transparent);
}

.workspace__history-cell--run {
  display: flex;
  align-items: center;
  gap: 7px; /* geometry — the dot-to-title gutter */
  min-width: 0;
}

.workspace__history-dot {
  width: 5px; /* geometry — direction A's own run-row dot */
  height: 5px; /* geometry — direction A's own run-row dot */
  flex: none;
  border-radius: 50%;
  background: var(--history-dot-colour);
}

.workspace__history-dot--live {
  animation: pulsering 1.8s ease-out infinite;
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

.workspace__history-cell--status {
  font-family: var(--font-mono);
  color: var(--ink-muted);
}

.workspace__history-cell--when,
.workspace__history-cell--cost {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}

.workspace__history-scrub {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
}

/* A sentence, not a dot: the state is carried by the words (docs/12 §9.2). */
.workspace__history-gate {
  grid-column: 1 / -1;
  margin-top: 4px; /* geometry — the gate line's own offset from the row above it */
  font-size: var(--text-xs);
  color: var(--state-awaiting-human);
}
</style>
