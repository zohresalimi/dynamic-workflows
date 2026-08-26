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
 * becomes one), the board is the same join in a different shape, and the band
 * under them is this run's phases.
 *
 * ## Where the history went (KAR-28.6 AC1, AC3)
 *
 * It used to be a table of *other runs* under the agents, on the screen whose
 * whole subject is the run in front of you. It is the Runs view's now
 * (`/projects/:id/runs`, `./RunListView.vue`) — which is what that view is for,
 * which already folds both halves of a gate's life for its rows
 * (`../stores/useRunListStore.ts`), and which is one click from the band's own
 * header. Moved, not removed: no run's history became unreachable, and this
 * file stopped keeping a second, hand-rolled copy of that fold.
 *
 * `GET /api/projects/:id/runs` is still read here, because *choosing the run*
 * needs it — the newest run's id, its `createdAt` and its status. What is gone
 * is the table, and the live gate bookkeeping that existed only to keep the
 * table's `waiting on …` marker current.
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
import type { RunStatus } from '@DeFlow/core';
import { UserRound } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { INSPECTOR_OVERLAY } from '../app/ids.ts';
import { useNodeBodies } from '../app/useNodeBodies.ts';
import { useRunPhases } from '../app/useRunPhases.ts';
import GateDecisionCard from '../components/gate/GateDecisionCard.vue';
import TurnActivityFeed from '../components/output/TurnActivityFeed.vue';
import TurnActivityStrip from '../components/output/TurnActivityStrip.vue';
import PhasesBand from '../components/PhasesBand.vue';
import RunHeader from '../components/RunHeader.vue';
import TaskBoard from '../components/TaskBoard.vue';
import { UiButton, UiEmptyState } from '../components/ui/index.ts';
import { agentRows } from '../lib/agent-rows.ts';
import { useRunStore } from '../stores/useRunStore.ts';
import { RUN_PANELS, type RunPanel, useUiStore } from '../stores/useUiStore.ts';
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

/**
 * One row of `GET /api/projects/:id/runs`, in the three fields *choosing the
 * run* reads.
 *
 * The daemon's row carries more — `title`, `label`, `cost` and the `gate` this
 * run has stopped on — and until KAR-28.6 this file read all of them, for the
 * history table under the agents. That table is `./RunListView.vue`'s now, and
 * so is every field only it wanted: declaring them here as well would be a
 * second, unread copy of a wire shape, which is how the two drift.
 */
interface RunChoice {
  readonly runId: string;
  readonly status: RunStatus;
  readonly createdAt: string;
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
const history = ref<readonly RunChoice[]>([]);
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

/**
 * KAR-28.2 AC4 — the agent list's rows, off those very bodies.
 *
 * `agentRows` is a pure function of the shared map and the run's own spans, so
 * the list and the canvas are two shapes of one object rather than two folds of
 * one log. The spans are the second argument because a `NodeBodyVM` describes a
 * *node* and the list draws one row per *attempt* — see `../lib/agent-rows.ts`
 * for why that is the whole point of the story.
 */
const rows = computed(() => agentRows({ bodies: bodies.value, spans: run.timelineSpans }));

/** Whether the plan has compiled — the one fact three layout decisions read. */
const hasPlan = computed(() => bodies.value.size > 0);

/*
 * `openRunsFeed`, `gateFromFrame`, `setHistoryGate` and `applyHistoryGate` used
 * to live here: a listener on the shared `?runs=*` topic, folding both halves of
 * a gate's life onto this view's own history rows so a waiting run said
 * `waiting on …` without a reload (KAR-25.7 AC3).
 *
 * KAR-28.6 moved the rows to `./RunListView.vue`, and that view has folded the
 * same two frames onto the same field since KAR-19.12 — in
 * `../stores/useRunListStore.ts`, matched by node, with the same "a run this
 * list has not fetched is not ours" rule. So this was a *second* implementation
 * of one fold, kept alive only by the table above it; with the table gone it
 * would be a subscription feeding nothing. The scenario it was written for is
 * asserted against the Runs view now (`./run-gate-answer.test.ts`).
 */

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
    history.value = ((await runs.json()) as { runs: readonly RunChoice[] }).runs;
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

/*
 * `openRun`, `when`, `spent` and `dotColour` used to live here — the four
 * helpers the history table needed, and nothing else on this screen ever asked
 * for. They went with the table (KAR-28.6 AC1): `./RunListView.vue` formats a
 * run's timestamp and paints its dot for the list that is now the only one, and
 * a run is opened by pressing its row there rather than by a handler here.
 *
 * This file formats nothing again, which is the fourth of the four
 * responsibilities above and was quietly untrue for two stories.
 */

/* ── the redesign's three layout states ─────────────────────────────────── */

/**
 * The gate the run on screen has stopped on, or `null`.
 *
 * `useRunStore().openGate` and a real check that it belongs to *this* run —
 * `run.runId === currentRun`, not merely "some run is on screen". The store
 * holds one run at a time, so the window is a single render tick, but the card
 * below is handed its `run-id` from the route and its `gate` from the store,
 * and two sources for one fact is how the previous run's gate survives a route
 * change silently (EPIC-22-S43's whole subject, one surface over). The check
 * costs a string compare and makes the two sources agree by construction.
 */
const openGate = computed(() =>
  currentRun.value !== null && run.runId === currentRun.value ? run.openGate : null,
);

/**
 * KAR-27.3 AC3 — the pre-execution turn this run has in flight, or `null`.
 *
 * Guarded on `run.runId === currentRun` for the same reason `openGate` is: the
 * store holds one run at a time, and two sources for one fact is how a previous
 * run's strip survives a route change.
 */
const liveTurn = computed(() =>
  currentRun.value !== null && run.runId === currentRun.value ? run.liveTurnInFlight : null,
);

/**
 * KAR-28.1 AC1 — whether the plan panel is showing the turn rather than a plan.
 *
 * Two conditions, and the second is the one AC1's last clause is about: a turn
 * is in flight, **and** no plan has compiled yet. The moment nodes arrive the
 * feed is gone and the canvas is what the panel shows — no refresh, and no
 * decision of this view's own about "when a plan is ready", because
 * `useNodeBodies()` having rows *is* that fact.
 *
 * The canvas is never unmounted for this. It owns the run's subscription
 * (`../app/useRunFeed.ts`), so a `v-if` here would close the feed that is
 * supposed to end the wait — the same trap `test/one-workspace-surface.test.ts`
 * guards. The two share one grid cell and the feed paints over it.
 */
const showTurnFeed = computed(() => liveTurn.value !== null && !hasPlan.value);

/**
 * KAR-28.6 AC1 — this run's phases, for the band under the panel.
 *
 * The **membership** only: which nodes each top-level step of the plan
 * materialises, which is `runPhases()`'s answer over the wire (KAR-28.5,
 * ADR 0018) and is not derivable in the tab, because the plan projection here is
 * flat and containment is a property of the plan document. The counts and states
 * beside each phase are folded off the stream by `../lib/phases-band.ts` — see
 * `../app/useRunPhases.ts` for why fetching those would be a request per frame.
 */
const { phases: runPhases } = useRunPhases(() => currentRun.value);

/** The phases themselves, or none: a run with no adopted plan has no band. */
const phases = computed(() => runPhases.value?.phases ?? []);

/*
 * `planActivity`, `feedStatus`, `pendingPlan`, `hydratingPlan` and `stripped`
 * used to live here, feeding a `GraphEmptyNote` in the strip that stood in for
 * the plan panel and a `--pending` modifier that removed the board.
 *
 * KAR-27.5 put the panel back on screen in that state, and the note inside it
 * is `PlanGraphView`'s own — mounted on its own `nodes.length === 0`, with its
 * own copy of the same four states. Deriving them a second time here was only
 * ever necessary because a *second surface* had to say the same sentences; with
 * one surface saying them there is nothing for this view to compute, and two
 * derivations of one fact is how they start to disagree.
 */

/** When the run on screen was created, for the header's `started` pair. */
const startedAt = computed<string | null>(
  () => history.value.find((row) => row.runId === currentRun.value)?.createdAt ?? null,
);

/**
 * KAR-27.7 AC2 — the status the header's controls are offered against, and it
 * comes from the ledger by both routes it can come from.
 *
 * The store first, because a tab watching a live run folds `run.paused` and
 * `run.resumed` off that run's own feed and is therefore current to the frame.
 * The history row second, because the daemon's `reduce()` produced it and it is
 * the honest answer for a run whose feed has not caught up yet — or for a past
 * run opened from history, whose feed will never carry a lifecycle frame at
 * all. Neither is this view's own opinion, which is the point: nothing here
 * moves the status because a control was pressed.
 *
 * Guarded on `run.runId === currentRun` for the reason `openGate` is.
 */
const runStatus = computed<RunStatus | null>(() => {
  if (currentRun.value === null) return null;
  // KAR-28.7 — one derivation, the store's, rather than this view choosing
  // between a scrubbed snapshot and a live fold for itself.
  const live = run.runId === currentRun.value ? (run.statusView?.status ?? null) : null;
  return live ?? history.value.find((row) => row.runId === currentRun.value)?.status ?? null;
});

/* ── KAR-28.2 — the primary panel, and the toggle behind it ──────────────── */

/**
 * What the two choices are called on screen.
 *
 * A record over the vocabulary rather than two literals in the template, so
 * adding a third panel is a type error here instead of a button somebody forgot
 * to add a label for.
 */
const PANEL_LABELS: Record<RunPanel, string> = { agents: 'Agents', graph: 'Graph' };

/**
 * AC5 — which panel is on screen, from the tab's own store.
 *
 * Read rather than held locally, because "persists for the session" is the
 * whole of the acceptance criterion: a `ref` in this file resets every time the
 * operator opens a run from the history and comes back.
 */
const panel = computed<RunPanel>(() => ui.runPanel);

/**
 * AC5 — and the invariant the toggle must not break: **one canvas, one
 * subscription**.
 *
 * The canvas is never unmounted for a panel change, only hidden. It owns the
 * run's feed (`../app/useRunFeed.ts`), so a `v-if` here would close the run's
 * subscription every time somebody looked at the list — and reopen it, from
 * scratch, on the way back. `visibility` is what hides it: the box keeps its
 * real size, so the renderer is not re-measuring a 0×0 viewport on every
 * toggle, and a hidden subtree is out of the accessibility tree and out of the
 * tab order by the same rule.
 */
const hidden = (mine: RunPanel): boolean => panel.value !== mine;
</script>

<template>
  <div class="workspace" data-project-workspace :data-project="projectId">
    <!--
      Everything above the graph is one grid child, so the grid stays the three
      rows it has always been — header block, the graph-and-board row that has
      to be able to *fill*, and the history. A gate card placed as a fourth
      row of its own would have taken the `minmax(16rem, 1fr)` track the graph
      needs, and the symptom is a 16rem-tall decision card with a squashed
      graph beside it.
    -->
    <div class="workspace__top">
      <!--
        System law 1 — the head card is gone. This page's one raised object is
        the gate card below; a bordered, shadowed header above it would be a
        second raised box, and it would win by being first. The header is
        content on the canvas now (`../components/RunHeader.vue`), and it
        carries the run facts the topbar used to squeeze between a breadcrumb
        and a search field.
      -->
      <div class="workspace__head-card">
        <RunHeader
          :task="run.submittedTask"
          :project-name="project?.name ?? projectId"
          :project-path="project?.path ?? null"
          :health-message="project?.health.message ?? null"
          :started-at="startedAt"
          :run-id="currentRun"
          :run-status="runStatus"
        />
        <RouterLink to="/projects" class="workspace__back">Projects</RouterLink>
      </div>

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
            @click="router.push({ name: 'new-run', params: { projectId: props.projectId } })"
          >
            <UserRound :size="12" aria-hidden="true" />
            Start a run
          </UiButton>
        </template>
      </UiEmptyState>

      <template v-else-if="currentRun !== null">
        <!--
          The decision, when there is one — the page's one raised card, and
          deliberately above the graph rather than beside it. A run that has
          stopped to ask a human a question has exactly one thing to do, and
          the previous layout put it in a hairline band above the fold at the
          same weight as everything else.
        -->
        <GateDecisionCard
          v-if="openGate"
          class="workspace__gate"
          :run-id="currentRun"
          :gate="{
            node: openGate.node,
            prompt: openGate.prompt,
            options: openGate.options,
            requestedSeq: openGate.seq,
          }"
        />
      </template>
    </div>

    <template v-if="!nothingHasRun && currentRun !== null">
      <!--
        KAR-28.2 AC1, AC5 — the run's one primary panel: the agent list by
        default, EPIC-17's canvas one toggle away.

        The canvas is mounted rather than reimplemented, and it owns the run's
        feed (`../app/useRunFeed.ts`), so this view opens no subscription of its
        own and there is exactly one per run.

        **Never `v-if`d, only hidden.** Unmounting it would close the run's
        subscription — on every toggle, and in exactly the states where the run
        is still arriving, so a `v-if` here would stop the feed that is supposed
        to end the wait. `visibility` keeps the one canvas mounted at its real
        size and the one feed open (`test/one-workspace-surface.test.ts` is the
        guard that says there is only ever one of each).
      -->
      <section
        class="workspace__graph"
        data-workspace-plan-panel
        data-run-panel
        aria-label="The run's agents and plan"
      >
        <!--
          KAR-27.5 AC2 — the panel's header line, and the one place the live
          strip belongs.

          It used to be a card of its own that *replaced* this panel and the
          board beside it while a run had no plan. The intent was to spend no
          height on an empty split; what it actually produced, watched on a real
          framing run on 2026-08-25, was a one-line strip over several hundred
          pixels of nothing, for the minutes a framing turn takes. The canvas
          below says what it is waiting for — `GraphEmptyNote` names framing,
          the spec gate and the planner from ledger facts — and it can only say
          it from inside a panel somebody can see.
        -->
        <header class="workspace__graph-head">
          <TurnActivityStrip
            v-if="liveTurn !== null && currentRun !== null"
            :run-id="currentRun"
            :node="liveTurn.node"
            :attempt="Math.min(liveTurn.turn.failures + 1, liveTurn.turn.maxAttempts)"
            :max-attempts="liveTurn.turn.maxAttempts"
            :since-ts="liveTurn.turn.sinceTs"
          />
          <h2 v-else class="workspace__graph-title">{{ PANEL_LABELS[panel] }}</h2>

          <!--
            KAR-28.2 AC5 — the toggle, and it is two real buttons rather than a
            styled `select`: the choice is between two things that are both on
            the page's own vocabulary, and `aria-pressed` is what tells a screen
            reader which one the screen is currently showing.
          -->
          <div class="workspace__panels" role="group" aria-label="Panel" data-run-panel-toggle>
            <button
              v-for="choice in RUN_PANELS"
              :key="choice"
              type="button"
              class="workspace__panel-choice"
              :data-panel-choice="choice"
              :aria-pressed="panel === choice"
              @click="ui.showRunPanel(choice)"
            >
              {{ PANEL_LABELS[choice] }}
            </button>
          </div>

          <!--
            The plan's version rail — where "what did this run look like at v2"
            is answered. It is the run scrubber this screen offers, and since
            KAR-28.6 it is the only one: the history table used to repeat the
            link per row, and there is no per-row scrubber on the Runs view
            because a run is opened first and scrubbed from here.
          -->
          <RouterLink
            class="workspace__graph-link"
            data-plan-evolution-link
            :to="{ name: 'plan-evolution', params: { projectId, runId: currentRun } }"
            >Evolution</RouterLink
          >
        </header>

        <!--
          KAR-28.1 AC1 — the panel's body: the turn while one is running with no
          plan yet, the canvas once the plan compiles.

          One grid cell holding both, rather than a `v-if` around the canvas.
          The canvas owns the run's subscription and must stay mounted at its
          real size — a collapsed-to-zero canvas would have the renderer
          measuring a 0×0 box and re-measuring on every transition. The feed
          simply paints over it while it is there.
        -->
        <div class="workspace__panel-body">
          <!--
            KAR-28.8 AC1 — `inert` beside the `data-hidden` the stylesheet keys
            off, on both panels.

            The CSS rule at the bottom of this file is what stops the hidden
            panel being *painted*. `inert` is what stops it being *reached*, and
            it is here rather than left to `visibility` because the same
            `NodeWrapper` style object that re-declares `visibility` also writes
            `pointer-events: all` inline and `tabindex="0"` as an attribute —
            three per-node declarations this view does not control. `visibility:
            hidden` happens to answer all three, but AC1 asks for three separate
            guarantees and resting every one of them on a single cascade race is
            how the original defect went unnoticed. `inert` is the platform's own
            answer to two of them and no stylesheet can override it.

            It costs no layout, so the canvas keeps measuring its real box and
            KAR-28.2 AC5's one-canvas-one-subscription invariant is untouched.
          -->
          <div
            class="workspace__canvas"
            data-workspace-canvas
            :data-hidden="String(hidden('graph'))"
            :inert="hidden('graph')"
          >
            <PlanGraphView :run-id="currentRun" />
          </div>
          <div
            class="workspace__agents"
            data-workspace-agents
            :data-hidden="String(hidden('agents'))"
            :inert="hidden('agents')"
          >
            <!--
              KAR-28.4 AC4 — a row is a way into the docked inspector.

              `inspectNodeById` sets the inspected *and* the selected node, so
              there is no second `selectNode` call here: the panel and the row
              highlight cannot end up on different nodes. Opening an overlay
              that is already open is a no-op, so pressing a second row while
              the panel is up simply moves it.
            -->
            <TaskBoard
              :rows="rows"
              :project-id="projectId"
              :run-id="currentRun"
              :selected="ui.selectedNodeId"
              @select="(id: string) => ui.selectNode(id)"
              @inspect="
                (id: string) => {
                  ui.inspectNodeById(id);
                  ui.openOverlay(INSPECTOR_OVERLAY);
                }
              "
            />
          </div>
          <TurnActivityFeed
            v-if="showTurnFeed && liveTurn !== null"
            class="workspace__feed"
            :run-id="currentRun"
            :project-id="projectId"
            :node="liveTurn.node"
          />
        </div>
      </section>
    </template>

    <!--
      KAR-28.6 AC1, AC2 — the band under the primary panel: this run's phases,
      and the work in the one selected.

      What was here was a table of the *project's other runs* — on the screen
      whose entire subject is the run in front of you. It is the Runs view's
      now, and the band's own header is the click that gets there (AC3).

      Mounted only when there is a run and the daemon has phases for it: a run
      still being framed has adopted no plan, and `basis: 'no-plan'` is an
      honest empty answer rather than a shape to draw an empty band from.
    -->
    <PhasesBand
      v-if="currentRun !== null && phases.length > 0"
      class="workspace__phases"
      :phases="phases"
      :nodes="run.planNodes"
      :bodies="bodies"
      :project-id="projectId"
      :run-id="currentRun"
    />
  </div>
</template>

<style scoped>
/*
 * KAR-28.2 — one column, because there is one panel.
 *
 * It was `minmax(0, 3fr) minmax(18rem, 2fr)`: the canvas on the left, the task
 * board on the right. The list is the primary surface now and the canvas is
 * behind a toggle in the same panel, so a second column would be an empty
 * track — and an empty `2fr` track is how a screen ends up with a graph
 * squeezed into 60% of a window for no reason a reader can see. The middle row
 * still absorbs the height, in every run state, which is what puts the phases
 * band on the bottom edge (KAR-27.5 AC4).
 */
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(16rem, 1fr) auto;
  gap: 12px; /* geometry — matches the dense sections' own row gap */
  height: 100%;
  min-height: 0;
}

/*
 * There is one grid, and KAR-27.5 is why there is no longer a second.
 *
 * A `--pending` modifier used to switch this to one column and three `auto`
 * rows while a run had no plan. Three `auto` rows inside a `height: 100%` grid
 * are stretched *equally* by `align-content`'s default — so the free space went
 * into every track rather than into the one that can use it, and the bottom
 * band ended up floating in the middle of the page with a void above it and
 * another below. The `minmax(16rem, 1fr)` middle row here is what absorbs the
 * height instead, in every run state, which is also what puts the last row on
 * the bottom edge.
 */
.workspace__top,
.workspace__phases {
  grid-column: 1 / -1;
  min-width: 0;
}

/* The header block, the gate card and the strip, stacked — one grid child,
   for the reason the template's own comment gives. */
.workspace__top {
  display: grid;
  gap: 12px; /* geometry — matches the page's own row gap */
  align-content: start;
}

.workspace__head-card {
  display: grid;
  gap: 6px; /* geometry — header-to-crumb gap */
  min-width: 0;
}

.workspace__back {
  font-size: var(--text-xs);
  color: var(--ink-muted);
  justify-self: start;
}

/* `.workspace__path` used to live here. The element moved into
   `../components/RunHeader.vue`, and scoped CSS does not cross that boundary,
   so the rule was styling nothing while looking like it styled the path —
   `.run-header__project` sets the same mono/`--text-xs`/`--ink-faint`
   treatment on the line that contains it, in the file that renders it. The
   class name went with the rule; the path is a bare `<span>` there now. */

.workspace__empty {
  max-width: 40rem;
}

/* A bordered panel with no shadow (system law 1) — the raised treatment on
   this page belongs to the gate card alone.

   Two rows: the header line, and the canvas taking whatever is left.
   `minmax(0, 1fr)` rather than `1fr` because the renderer inside measures its
   own box, and an `auto`-floored track would let it grow the panel instead of
   fitting inside it. */
.workspace__graph {
  min-height: 0;
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--surface);
}

/* One slim line, never a band of its own: the panel's own title bar, carrying
   the live strip while a pre-execution turn runs and the panel's name when one
   is not. */
.workspace__graph-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px; /* geometry — header-to-link gutter */
  min-height: 40px; /* geometry — the header's own height */
  padding: 0 12px; /* geometry — the panel's own inset */
  box-sizing: border-box;
  border-bottom: 1px solid var(--edge);
}

.workspace__graph-title {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--ink);
  margin: 0;
}

.workspace__graph-link {
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

/* KAR-28.2 AC5 — the `Agents | Graph` toggle. Two segments in one bordered
   box, the shape the design system already spends on a small two-state control;
   the pressed one takes the application's one selection ground rather than a
   state hue (system law 3 — selection is hueless). */
.workspace__panels {
  display: inline-flex;
  margin-left: auto;
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-pill);
  overflow: hidden;
}

.workspace__panel-choice {
  background: none;
  border: 0;
  cursor: pointer;
  color: var(--ink-muted);
  font: inherit;
  font-size: var(--text-xs);
  padding: 3px 12px; /* geometry — the segment's own padding */
}

.workspace__panel-choice + .workspace__panel-choice {
  border-left: 1px solid var(--edge);
}

.workspace__panel-choice:hover {
  color: var(--ink);
}

.workspace__panel-choice[aria-pressed="true"] {
  background: var(--select-tint);
  color: var(--ink);
}

/* KAR-28.1 — the panel's second row, holding the canvas and the feed in one
   cell. Both children are full size; the feed is opaque and above, so the
   canvas keeps its own measurement whether or not it is the thing being read. */
.workspace__panel-body {
  display: grid;
  min-height: 0;
  overflow: hidden;
}

.workspace__panel-body > * {
  grid-area: 1 / 1;
  min-height: 0;
}

.workspace__canvas,
.workspace__agents {
  min-height: 0;
  overflow: hidden;
}

.workspace__agents {
  padding: 12px; /* geometry — the panel's own inset around the list */
  background: var(--surface);
}

/*
 * KAR-28.2 AC5 — the panel that is not chosen is hidden, never unmounted.
 *
 * `visibility` rather than `display: none` on purpose. The canvas measures its
 * own box, and a `display: none` subtree has no box at all — the renderer would
 * re-measure from zero on every toggle, which is the flicker `useNodeBodies`'s
 * memoisation exists to avoid. `visibility: hidden` keeps the geometry, takes
 * the subtree out of the accessibility tree and out of the tab order, and costs
 * one property.
 */
.workspace__canvas[data-hidden="true"],
.workspace__agents[data-hidden="true"] {
  visibility: hidden;
}

/*
 * KAR-28.8 AC1, AC3 — and the one element that escaped the rule above.
 *
 * **The defect.** Observed 2026-08-26: with the Agents panel chosen, six or so
 * vue-flow node cards were painted *over* the agents table, several of them
 * half faded. The rule above was doing its job — the canvas container really
 * did report `visibility: hidden` — and the cards were on screen anyway.
 *
 * **The escaping element** is `.vue-flow__node`: the wrapper `div`
 * `@vue-flow/core`'s `NodeWrapper` renders around every node.
 *
 * **Why it escapes.** `NodeWrapper` writes `visibility` as an **inline style**,
 * `visibility: isInit ? 'visible' : 'hidden'` — its own way of keeping a node
 * that has not been measured yet from flashing at 0,0. `visibility` is an
 * inherited property, and inheritance only supplies a value to an element that
 * declares none of its own, so the moment vue-flow measures a node the node
 * re-declares itself visible and the ancestor's `hidden` never reaches it. It
 * is a *JavaScript* declaration, not a stylesheet one, which is why reading
 * `@vue-flow/core`'s `style.css` for a `visibility` rule finds nothing: the
 * package's CSS contains none. Both panels share one grid cell
 * (`.workspace__panel-body > *`, `grid-area: 1 / 1`) and the node is
 * `position: absolute` with a `z-index`, so an escaped card lands on top of the
 * agents table rather than beside it.
 *
 * **Why the half-faded ones.** Not leftover hover or drag state, which was the
 * standing hypothesis: this canvas holds no hover state at all. They are
 * `.is-distant` — `../components/graph/GraphCanvas.vue`'s selection dimming
 * (`opacity: 0.32`, KAR-17.1 AC7), which applies to every node outside the
 * selected node's neighbourhood. Pressing an agent row selects a node, so
 * reading the list is exactly how an operator arrives at a graph where most
 * cards are dimmed — and `only-render-visible-elements` is why it was six of
 * the twelve rather than all of them.
 *
 * **Why this remedy.** It re-states `visibility: hidden` on precisely the
 * element that re-declared it, with `!important` so it beats an inline
 * declaration: an important author declaration outranks a normal inline one, so
 * this settles the cascade rather than escalating specificity against it. It is
 * deliberately not a blanket rule over the subtree — the container's own
 * `visibility` still hides everything that inherits properly, and this names the
 * single element that does not, so a new escapee shows up as a new bug rather
 * than being absorbed silently.
 *
 * `:deep()` because the node wrapper is the renderer's element, two components
 * down, and a scoped selector would never reach it.
 */
.workspace__canvas[data-hidden="true"] :deep(.vue-flow__node) {
  visibility: hidden !important;
}

.workspace__feed {
  background: var(--surface);
}

/*
 * The narrow-width rule that used to live here put the board under the graph
 * below 820px, because the page was two columns. KAR-28.2 made it one — there
 * is one panel and it fills the width at every size — so a breakpoint that
 * restates the layout the page already has is a second grid definition waiting
 * to disagree with the first, which is exactly what KAR-27.5 AC4 removed. The
 * rail's own breakpoint is still `../components/frame/AppRail.vue`'s business,
 * and the gate card's narrow padding is its file's.
 */
</style>
