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
import { useNodeBodies } from '../app/useNodeBodies.ts';
import { openLazyRunsFeed, RUNS_FEED } from '../app/useRunList.ts';
import GateDecisionCard from '../components/gate/GateDecisionCard.vue';
import TurnActivityFeed from '../components/output/TurnActivityFeed.vue';
import TurnActivityStrip from '../components/output/TurnActivityStrip.vue';
import RunHeader from '../components/RunHeader.vue';
import TaskBoard from '../components/TaskBoard.vue';
import { UiButton, UiEmptyState } from '../components/ui/index.ts';
import { agentRows } from '../lib/agent-rows.ts';
import { RUN_STATUS_DISPLAY, stateVar } from '../lib/state-palette.ts';
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
  const live =
    run.runId === currentRun.value ? (run.runState?.status ?? run.lifecycleStatus) : null;
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

          <RouterLink
            class="workspace__graph-link"
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
          <div
            class="workspace__canvas"
            data-workspace-canvas
            :data-hidden="String(hidden('graph'))"
          >
            <PlanGraphView :run-id="currentRun" />
          </div>
          <div class="workspace__agents" :data-hidden="String(hidden('agents'))">
            <TaskBoard
              :rows="rows"
              :project-id="projectId"
              :run-id="currentRun"
              :selected="ui.selectedNodeId"
              @select="(id: string) => ui.selectNode(id)"
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
            @click="router.push({ name: 'new-run', params: { projectId: props.projectId } })"
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
/*
 * KAR-28.2 — one column, because there is one panel.
 *
 * It was `minmax(0, 3fr) minmax(18rem, 2fr)`: the canvas on the left, the task
 * board on the right. The list is the primary surface now and the canvas is
 * behind a toggle in the same panel, so a second column would be an empty
 * track — and an empty `2fr` track is how a screen ends up with a graph
 * squeezed into 60% of a window for no reason a reader can see. The middle row
 * still absorbs the height, in every run state, which is what puts the history
 * on the bottom edge (KAR-27.5 AC4).
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
 * into every track rather than into the one that can use it, and the history
 * table ended up floating in the middle of the page with a void above it and
 * another below. The `minmax(16rem, 1fr)` middle row here is what absorbs the
 * height instead, in every run state, which is also what puts the last row on
 * the bottom edge.
 */
.workspace__top,
.workspace__history {
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

.workspace__feed {
  background: var(--surface);
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
  font-size: var(--text-xs);
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

/*
 * System law 3 — "this is the run you are looking at" is a selection, not a
 * run state. It used to be an 8% mix of `--state-running`, which made the
 * lime mean three things on one page: the primary action, the running status,
 * and the current row.
 */
.workspace__history-row[data-current="true"] {
  background: var(--select-tint);
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
