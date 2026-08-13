<script setup lang="ts">
/**
 * KAR-16.1 — the shell everything else mounts into.
 *
 * Four things live here and nowhere else:
 *
 * 1. **The skip-link**, first in the DOM so it is first in the tab order
 *    (AC7). It is the one piece of a11y that has to be the literally-first
 *    element, so it cannot be a component's business.
 * 2. **The keyboard map**, installed on `document` for the life of the app and
 *    disposed with it (../app/keyboard.ts). Not in a view: a map bound to a
 *    component that is not always mounted works on the landing route and stops
 *    everywhere else, which is the failure AC7's spec is written against.
 * 3. **The session gate** (AC3). A tab with no token renders an explicit
 *    "paste the URL from `DeFlow up`" state — never a spinner, a blank page or
 *    a 401 loop — and, importantly, mounts no view that would issue a request.
 * 4. **The overlay hosts.** The jumper and the inspector are rendered once,
 *    here, so `Cmd-K` works from every route and `Esc` has one stack to pop.
 *
 * The theme is `useDark()` and a class on `<html>`; nothing in this file, or in
 * any view, reads which theme is on.
 */
import { BellRing, Moon, Search, Sun } from 'lucide-vue-next';
import { onMounted, onUnmounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { useApiClient } from './api/provide.ts';
import { MAIN_CONTENT_ID, SEARCH_INPUT_ID } from './app/ids.ts';
import { installKeyboardMap } from './app/keyboard.ts';
import { useTheme } from './app/theme.ts';
import CommandJumper from './components/CommandJumper.vue';
import NodeInspector from './components/NodeInspector.vue';
import RunProviderBanner from './components/RunProviderBanner.vue';
import { useSessionStore } from './stores/useSessionStore.ts';
import { useUiStore } from './stores/useUiStore.ts';
import TokenRequired from './views/TokenRequired.vue';

const ui = useUiStore();
const session = useSessionStore();
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

  <div class="shell">
    <header class="shell__bar">
      <span class="shell__brand">DeFlow</span>

      <button
        class="shell__theme"
        type="button"
        :aria-pressed="isDark"
        :aria-label="isDark ? 'Switch to the light theme' : 'Switch to the dark theme'"
        @click="toggleTheme()"
      >
        <component :is="isDark ? Sun : Moon" :size="16" aria-hidden="true" />
      </button>

      <span
        v-if="awaitingOperator > 0"
        class="shell__approvals"
        :data-approvals="awaitingOperator"
        :aria-label="`${awaitingOperator} waiting on you`"
      >
        <BellRing :size="14" aria-hidden="true" />
        {{ awaitingOperator }}
      </span>

      <label class="shell__search">
        <Search class="shell__search-icon" :size="15" aria-hidden="true" />
        <span class="shell__search-label">Search</span>
        <input
          :id="SEARCH_INPUT_ID"
          class="shell__search-input"
          type="search"
          placeholder="Search nodes  ( / )"
        >
      </label>

      <!--
        KAR-19.10 AC4 — which agent the open run is on, and by which route.
        In the shell rather than in a view because it is true of the run and not
        of one panel of it, and because an operator comparing what `DeFlow
        doctor` said with what the run did should not have to find the right tab
        first. It renders nothing when no run is open.
      -->
      <RunProviderBanner />
    </header>

    <!--
      `tabindex="-1"` so the skip-link above can actually move focus here: an
      anchor that scrolls the viewport without moving focus leaves a keyboard
      user exactly where they were.
    -->
    <main :id="MAIN_CONTENT_ID" class="shell__main" tabindex="-1">
      <TokenRequired v-if="!session.authenticated" />
      <RouterView v-else />
    </main>
  </div>

  <CommandJumper />
  <NodeInspector />
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
}

.shell__bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--edge);
  background: var(--surface-raised);
}

.shell__brand {
  font-weight: 700;
  letter-spacing: 0.02em;
}

.shell__theme {
  display: inline-flex;
  padding: 0.35rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface);
  color: inherit;
}

.shell__approvals {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid currentcolor;
  border-radius: 999px;
  color: var(--state-awaiting-human);
  background: color-mix(in oklch, currentcolor 12%, var(--surface));
  font-size: 0.8125rem;
}

.shell__search {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: auto;
}

.shell__search-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.shell__search-input {
  width: min(20rem, 40vw);
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface);
  color: inherit;
}

.shell__main {
  min-height: 0;
  padding: 0.75rem;
}
</style>
