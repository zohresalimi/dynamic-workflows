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
 * `AppTopBar` stays mounted either way: it takes its `awaitingOperator` count
 * and `task` as props and asks for nothing itself, and `RunStatusPill` inside
 * it only reads `useRunStore()`, which is empty rather than absent on a
 * tokenless tab. Losing the topbar on top of the rail would leave a tab with
 * no token nothing to look at while it reads the "paste the URL" panel.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { useApiClient } from './api/provide.ts';
import { COMPOSER_OVERLAY, MAIN_CONTENT_ID } from './app/ids.ts';
import { installKeyboardMap } from './app/keyboard.ts';
import { useTheme } from './app/theme.ts';
import CommandJumper from './components/CommandJumper.vue';
import AppRail from './components/frame/AppRail.vue';
import AppTopBar from './components/frame/AppTopBar.vue';
import NodeInspector from './components/NodeInspector.vue';
import RunComposer from './components/RunComposer.vue';
import RunGateBanner from './components/RunGateBanner.vue';
import { useRunStore } from './stores/useRunStore.ts';
import { useSessionStore } from './stores/useSessionStore.ts';
import { useUiStore } from './stores/useUiStore.ts';
import TokenRequired from './views/TokenRequired.vue';

const ui = useUiStore();
const session = useSessionStore();
// KAR-19.12 AC6 — the open run's pending gate, read off the store's own fold.
const run = useRunStore();
const client = useApiClient();
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
 */
const awaitingOperator = ref(0);

async function loadApprovals(): Promise<void> {
  if (!session.authenticated) return;
  try {
    const response = await client.approvals.$get({ query: {} });
    if (!response.ok) return;
    const queue = (await response.json()) as { items?: readonly unknown[] };
    awaitingOperator.value = queue.items?.length ?? 0;
  } catch {
    // A daemon that is restarting is not something to shout about in a
    // toolbar; the badge simply does not appear.
  }
}

let uninstallKeyboardMap: (() => void) | null = null;

onMounted(() => {
  uninstallKeyboardMap = installKeyboardMap(document, ui);
  void loadApprovals();
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
    <AppRail v-if="session.authenticated" />

    <div class="shell__column">
      <AppTopBar
        :awaiting-operator="awaitingOperator"
        :is-dark="isDark"
        :task="run.submittedTask"
        @toggle-theme="toggleTheme()"
        @open-composer="ui.openOverlay(COMPOSER_OVERLAY)"
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
        <RunGateBanner :run-id="run.runId ?? ''" :gate="run.openGate" />
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
  </div>

  <CommandJumper />
  <NodeInspector />
  <RunComposer />
</template>

<style scoped>
/* Two columns: the rail (its own fixed/collapsing width, `AppRail.vue`'s
   business) and everything else. `--no-rail` collapses to the one column a
   tokenless tab actually has, rather than leaving an "auto" track to size
   itself off whatever `.shell__column`'s content happens to be. */
.shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  height: 100%;
}

.shell--no-rail {
  grid-template-columns: minmax(0, 1fr);
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

.shell__main {
  min-height: 0;
  padding: 0.75rem;
  overflow: auto;
}
</style>
