<script setup lang="ts">
/**
 * KAR-16.1 — the shell everything else mounts into.
 * KAR-24.4 — restyled onto direction A's frame (the rail, the switcher, the
 * topbar), with no change to what any of it *does*.
 *
 * Four things live here and nowhere else, and every one of them survives this
 * restyle unchanged (AC6):
 *
 * 1. **The skip-link**, still the literally first element in the DOM, so it
 *    is first in the tab order. It is the one piece of a11y that has to be the
 *    literally-first element, so it cannot be a component's business.
 * 2. **The keyboard map**, installed on `document` for the life of the app and
 *    disposed with it (./app/keyboard.ts). Not in a view: a map bound to a
 *    component that is not always mounted works on the landing route and stops
 *    everywhere else, which is the failure AC7's spec is written against.
 * 3. **The session gate** (AC3). A tab with no token renders an explicit
 *    "paste the URL from `deflow up`" state — never a spinner, a blank page or
 *    a 401 loop — and, importantly, mounts no view that would issue a request.
 * 4. **The overlay hosts.** The jumper and the inspector are rendered once,
 *    here, so `Cmd-K` works from every route and `Esc` has one stack to pop.
 *    The composer used to be a third one; KAR-25.5 made it a route instead
 *    (`views/NewRunView.vue`), so it is not mounted here any more — see
 *    `openComposer()` below for where "Start a run" goes now.
 *
 * The theme is `useDark()` and a class on `<html>`; nothing in this file, or in
 * any view, reads which theme is on.
 *
 * ## The rail is not rendered for a tab with no token
 *
 * `./components/frame/AppRail.vue` reads `GET /api/providers` on mount, and
 * its own `ProjectSwitcher.vue` reads `GET /api/projects` on mount — both real
 * requests, not deferred ones. AC6 says "the rail and topbar must not issue
 * requests in that state either", and a component that fetches on mount cannot
 * be told to fetch later just by not showing its data — it has already asked.
 * So rather than mounting `AppRail` and hoping its markup renders emptily, this
 * file does not mount it at all while `!session.authenticated`: `v-if`, not a
 * prop that tells it to hush. That is "do not render the rail at all" from
 * AC6's own two offered shapes, chosen over "chrome without data" because the
 * chrome is not the thing that requests — the mount is, and a `v-if` is the
 * only way to stop one.
 *
 * `AppTopBar` stays mounted either way: it takes its `task` as a prop and
 * asks for nothing itself, and `RunStatusPill`, like `ApprovalsMenu` inside
 * it, only reads a store — `useRunStore()`, `useApprovalsStore()` — which is
 * empty rather than absent on a tokenless tab. Losing the topbar on top of
 * the rail would leave a tab with no token nothing to look at while it reads
 * the "paste the URL" panel.
 *
 * ## KAR-25.7 — the approvals badge stopped being a `ref` filled once
 *
 * `awaitingOperator` used to be a plain `ref(0)`, filled by one
 * `GET /api/approvals` at `onMounted` and never touched again — a gate that
 * opened after that first request was invisible until the next reload, and
 * one answered from another tab or `deflow answer` never cleared it at all.
 * `./app/useApprovals.ts` replaces both halves: the same one `GET`, plus the
 * tab's shared `?runs=*` subscription (`./ledger/shared-hub.ts`) folding
 * `human.requested`/`human.responded` into `useApprovalsStore()` for the
 * life of the tab. The count on the topbar's control is that store's own
 * `count`, read directly — there is no prop threading it any more, matching
 * how `RunStatusPill` has always read `useRunStore()` for itself rather than
 * being handed a status string.
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { MAIN_CONTENT_ID } from './app/ids.ts';
import { installKeyboardMap } from './app/keyboard.ts';
import { useTheme } from './app/theme.ts';
import { useApprovals } from './app/useApprovals.ts';
import { provideProjects } from './app/useProjects.ts';
import CommandJumper from './components/CommandJumper.vue';
import AppRail from './components/frame/AppRail.vue';
import AppTopBar from './components/frame/AppTopBar.vue';
import NodeInspector from './components/NodeInspector.vue';
import RunGateBanner from './components/RunGateBanner.vue';
import { useRunStore } from './stores/useRunStore.ts';
import { useSessionStore } from './stores/useSessionStore.ts';
import { useUiStore } from './stores/useUiStore.ts';
import TokenRequired from './views/TokenRequired.vue';

const ui = useUiStore();
const session = useSessionStore();
const route = useRoute();
const router = useRouter();
// KAR-19.12 AC6 — the open run's pending gate, read off the store's own fold.
const run = useRunStore();
const { isDark, toggleTheme } = useTheme();

/**
 * How many things are waiting on the operator, across **every** run.
 *
 * One request rather than one per run, and it belongs to the shell rather than
 * to a view for the reason the endpoint was specified with: *"I never discover
 * a nine-hour run that has been blocked since hour two because I was looking at
 * a different tab"* (KAR-13.2 AC1). A badge inside one view cannot make that
 * promise. It is also the tab's first authenticated request, which is what
 * makes the fragment handoff observable end to end (AC2).
 *
 * KAR-25.7 — called unconditionally, in `<script setup>` rather than inside
 * `onMounted`, matching `useRunList`'s own call site in `RunListView.vue`:
 * the composable itself is what checks `session.authenticated` before it
 * fetches or subscribes (see its own docblock), so calling it early costs
 * nothing on a tokenless tab.
 */
useApprovals();

/**
 * Whether the view under the band already draws the open gate in full.
 *
 * The two workflows routes mount `views/ProjectWorkflowsView.vue`, which shows
 * the run's gate as `components/gate/GateDecisionCard.vue` — the page's one
 * raised card, with the spec beside the buttons. On those two routes the band
 * says the same thing twice, so it collapses to one line and a link to the
 * card's own anchor. Everywhere else it stays the full form, because KAR-22.5
 * AC1's promise is that a gate is answerable from *anywhere*, and "anywhere"
 * is every other route in this application.
 *
 * The run the band shows is `run.openGate`, which is the store's one open run
 * — the same run those two routes put on screen — so there is no third case
 * where the route matches but the gate belongs to something else.
 */
const GATE_IN_FULL_ROUTES = new Set(['project-workflows', 'project-run']);
const routeShowsGateInFull = computed<boolean>(() =>
  GATE_IN_FULL_ROUTES.has(String(route.name ?? '')),
);

/**
 * KAR-26.5 — the one `GET /api/projects` read, provided here so the switcher
 * (its one caller) and the topbar's breadcrumb read the same answer. Providing
 * is not fetching: a tokenless tab never mounts the rail, so the request this
 * handle owns never fires there (see `./app/useProjects.ts`).
 */
provideProjects();

/**
 * KAR-25.5 AC3 — "Start a run", reached from `c` or the topbar button.
 *
 * Reads `route.params.projectId` because that is the one thing both callers
 * lack and both need: a project scopes a run, and a run started with no
 * project open is not a state the composer can be in any more — the composer
 * is `/projects/:projectId/new-run`, and a route with no id in it is not that
 * route. `AppTopBar.vue` computes the same value for its breadcrumb and could
 * decide this itself; it emits instead so this decision is made once, in the
 * one place `../app/keyboard.ts`'s `c` also calls into (that module holds no
 * router of its own — see its header comment).
 *
 * No POST is issued on either branch: `needsProject` names a reason on the
 * chooser, not a submission the composer skipped.
 */
function openComposer(): void {
  const projectId = route.params.projectId;
  if (typeof projectId === 'string') {
    void router.push({ name: 'new-run', params: { projectId } });
    return;
  }
  void router.push({ name: 'projects', query: { needsProject: '1' } });
}

let uninstallKeyboardMap: (() => void) | null = null;

onMounted(() => {
  uninstallKeyboardMap = installKeyboardMap(document, ui, openComposer);
});

onUnmounted(() => {
  uninstallKeyboardMap?.();
  uninstallKeyboardMap = null;
});
</script>

<template>
  <a class="skip-link" :href="`#${MAIN_CONTENT_ID}`">Skip to main content</a>

  <div class="shell" :class="{ 'shell--no-rail': !session.authenticated }">
    <!-- See the header comment: not rendered at all for a tokenless tab, so
         its own and `ProjectSwitcher`'s mount-time requests never fire. -->
    <!-- KAR-26.5 — `isDark`/`toggle-theme` threaded exactly as the topbar's
         always were: `useTheme()` stays this file's to call. -->
    <AppRail v-if="session.authenticated" :is-dark="isDark" @toggle-theme="toggleTheme()" />

    <div class="shell__column">
      <!-- `no-rail` — KAR-26.5: with the toggle's home in the rail footer,
           the bar must know when no rail exists at any width (this same
           `!session.authenticated`), or a tokenless tab above 820px has no
           theme control anywhere. -->
      <AppTopBar
        :is-dark="isDark"
        :no-rail="!session.authenticated"
        :task="run.submittedTask"
        @toggle-theme="toggleTheme()"
        @open-composer="openComposer()"
      />

      <!--
        KAR-19.12 AC6, KAR-22.5 AC1 — what the run is waiting for, and the
        buttons that answer it.

        Its own band between the bar and the view, rather than an item in the
        toolbar where KAR-19.12 first put it. Two reasons, and neither is
        taste: the F1.3 gate's prompt is a whole rendered spec that has to be
        *read* before it is approved (AC3), which a toolbar cannot hold; and
        AC1 asks for it in the workspace **and** on the run view, which one
        band above the router outlet answers once rather than twice.

        The wrapper is always in the DOM — never `v-if`d — so the shell's
        three rows (bar, gate, view) are always three; the panel inside it
        renders nothing when no gate is open, and a tab with no token has no
        run and therefore no gate.
      -->
      <div class="shell__gate">
        <RunGateBanner
          :run-id="run.runId ?? ''"
          :gate="run.openGate"
          :compact="routeShowsGateInFull"
        />
      </div>

      <!--
        `tabindex="-1"` so the skip-link above can actually move focus here:
        an anchor that scrolls the viewport without moving focus leaves a
        keyboard user exactly where they were.
      -->
      <main :id="MAIN_CONTENT_ID" class="shell__main" tabindex="-1">
        <TokenRequired v-if="!session.authenticated" />
        <RouterView v-else />
      </main>
    </div>

    <!--
      KAR-28.4 — the inspector, docked.

      Inside `.shell` and beside the column rather than portalled over it: it is
      the grid's third track, so an open inspector *narrows* the view rather
      than covering it, and the rail, the topbar and the agent list stay lit and
      clickable while it is up (AC1). It renders nothing at all when closed, so
      the track is zero-width and the shell is exactly the two columns it was.

      `CommandJumper` below stays outside, because it *is* a modal: a jumper is
      the one interaction where the rest of the screen genuinely should stop
      taking input until it is answered or dismissed.
    -->
    <NodeInspector />
  </div>

  <CommandJumper />
</template>

<style scoped>
/* Three columns: the rail (its own fixed/collapsing width, `AppRail.vue`'s
   business), everything else, and — KAR-28.4 — the docked inspector.
   `--no-rail` collapses to the two a tokenless tab actually has, rather than
   leaving an "auto" track to size itself off whatever `.shell__column`'s
   content happens to be.

   The inspector's track is `auto` and `NodeInspector` renders nothing when it
   is closed, so a shell with no inspector open is the two columns it always
   was: an empty auto track has no width. */
.shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  height: 100%;
}

.shell--no-rail {
  grid-template-columns: minmax(0, 1fr) auto;
}

/* Three rows, always: the bar, the gate band (empty until a run stops to ask)
   and the view. Stated rather than left implicit so an opening gate takes its
   own height from the band and never from the view underneath it. */
.shell__column {
  display: grid;
  grid-template-rows: auto auto 1fr;
  min-width: 0;
  height: 100%;
}

/* No padding of its own when it is empty, so a shell with no open gate looks
   exactly as it did before this band existed. */
.shell__gate:not(:empty) {
  padding: 0.5rem 0.75rem 0;
}

/* System law 1 — the page's ground is the canvas, so a raised card is raised
   *against something*. Before this, `<body>`'s `--surface` showed through and
   every panel had to draw a border to be visible at all; with the canvas
   behind them, the borders are a choice rather than a necessity. The value is
   a token, never a literal: `./styles/theme.css` is the one file allowed to
   know what colour anything is (`PALETTE_FILES`). */
.shell__main {
  min-height: 0;
  padding: 0.75rem;
  overflow: auto;
  background: var(--surface-canvas);
}
</style>
