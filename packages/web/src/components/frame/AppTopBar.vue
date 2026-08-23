<script setup lang="ts">
/**
 * KAR-24.4 AC4 — the topbar: direction A's 52px bar, restyled from what
 * `App.vue`'s `<header class="shell__bar">` already holds.
 *
 * **A restyle, not a redesign.** Every element `App.vue`'s header carries
 * today survives here, unchanged in behaviour: the theme toggle (its
 * `aria-pressed` and its two `aria-label`s), the approvals badge (its
 * `aria-label`, its `data-approvals`), the search field (`SEARCH_INPUT_ID`,
 * its visually-hidden label), `RunProviderBanner`, `RunTaskBanner` and the
 * composer button (`data-composer-open`). None of it is reimplemented —
 * this component's whole job is new markup and tokenised styling around the
 * same pieces.
 *
 * **It owns no request and no store mutation.** `task` arrives as a prop
 * because the fetch behind it lives in `App.vue` and must stay there — a
 * component that fetches is a component that fetches twice the day something
 * else mounts it. `toggle-theme` and `open-composer` are emitted rather than
 * actioned here, because `useTheme()` and `ui.openOverlay()` are `App.vue`'s
 * to call; this component only says which button was pressed.
 *
 * **KAR-25.7 — the approvals chip became `./ApprovalsMenu.vue`.** It used to
 * be a bare `UiChip` fed an `awaitingOperator` count prop, the way `task` still
 * arrives. It reads `useApprovalsStore()` for itself instead, the same
 * exception `RunStatusPill.vue` already makes to "no store mutation" above —
 * reading a store is not mutating one, and the fetch that fills it is still
 * `App.vue`'s (`../../app/useApprovals.ts`), not this bar's.
 *
 * **The search field is hand-rolled, not `UiField`.** `UiField` always
 * renders a visible mono label above the input (KAR-24.2's own contract for
 * it), and AC4 asks for the opposite: a label that is present for a screen
 * reader and invisible on screen, exactly as `App.vue`'s
 * `.shell__search-label` is today. Forcing this input through `UiField` would
 * either grow it a visibility escape hatch that serves one caller, or silently
 * change what a screen reader announces here — so this is the one shape this
 * story reports rather than routes through the fifteen, per KAR-24.4's own
 * "report rather than add a sixteenth primitive" rule (only `UiField` was a
 * candidate; no *new* component is added anywhere).
 *
 * **The breadcrumb reads the route — and, since KAR-26.5, the one projects
 * answer the application already holds.** `<project> / <view>` comes from
 * `route.params.projectId` and a fixed label per route name. This bar still
 * adds no request to resolve the id into a display name — the refusal stands
 * — but the blueprint draws the *name*, and `ProjectSwitcher.vue`'s one
 * `GET /api/projects` already carries it; `../../app/useProjects.ts` is that
 * read lifted into a shared handle, which this file only *reads* (the
 * switcher still owns the fetch, so a tokenless tab still issues nothing
 * from here). Until the answer lands, the raw id renders, which is the
 * honest fallback rather than a blank. When the route carries no `projectId`
 * (the runs list, the projects list, `/gallery`) only the view segment
 * renders.
 *
 * **KAR-26.5 — the theme toggle's home is the rail's footer now** (blueprint
 * 01 settles it; see `AppRail.vue`). The button here survives *for the states
 * where the rail does not render*, which are two, not one: below 820px (the
 * width pairing `.topbar__nav` already keeps) and on a tokenless tab, where
 * `App.vue` mounts no rail at **any** width (its AC6 `v-if`) — `no-rail`
 * below is `App.vue` saying so, the same threading `isDark` uses, and without
 * it the TokenRequired screen at desktop width would have no theme control at
 * all (the KAR-24.4 AC4 contract above forbids exactly that loss). Its
 * behaviour, `aria-pressed` and both `aria-label`s are unchanged.
 *
 * **KAR-25.2 AC5, EPIC-25-S13 — the breadcrumb is a path, not a caption.**
 * It is a `<nav aria-label="Breadcrumb"><ol>` now, one `<li>` per segment,
 * rather than a `<p>` of spans: "which segments are links" is then a
 * structural fact a test reads off the DOM, not a class name. The project
 * segment is a `RouterLink` to `project-workflows` — the same route
 * `ProjectSwitcher.select()` already pushes when a project is chosen, so
 * activating either one lands on the same place. The last segment is never a
 * link and carries `aria-current="page"`. The project id shown is still the
 * raw id, not a display name — resolving one needs `GET /api/projects`,
 * which this component's docblock already refuses to fetch, and `AC5` is
 * about links, which work fine against an id.
 *
 * ## The sub-820px nav contract, for whoever builds `AppRail.vue` next
 *
 * AC7 asks the rail to disappear below 820px "with the nav moving into the
 * topbar" — and `AppRail.vue` does not exist yet, so this file is where that
 * contract is written down rather than assumed:
 *
 * - **The breakpoint is 820px on both sides, `max-width` on this nav's
 *   wrapper and (the rail's job) `display: none` above it on the rail's own
 *   root.** Neither side reads the other's width; each hides itself at the
 *   same number, so exactly one is ever visible at a given viewport.
 * - **The item set is `projects` and `settings` always, and — only when
 *   `route.params.projectId` is set — that project's `project-workflows` and
 *   `project-runs` between them.** This mirrors KAR-25.1's scope rule for the
 *   rail (`docs/delivery/epics/EPIC-25-frame-and-settings.md` KAR-25.1 AC1,
 *   AC2) so the two navs never disagree about which routes exist or in what
 *   order.
 * - **Active state is `route.name === item.name`**, the same comparison a
 *   `RouterLink`'s own `router-link-active` class makes, kept explicit here
 *   so the active row's background comes from `data-active` rather than from
 *   a Vue Router class this stylesheet would otherwise have to reach for by
 *   name.
 */
import { Moon, Search, Sun } from 'lucide-vue-next';
import { computed } from 'vue';
import { type RouteLocationRaw, RouterLink, useRoute } from 'vue-router';
import { SEARCH_INPUT_ID } from '../../app/ids.ts';
import { useProjects } from '../../app/useProjects.ts';
import type { SubmittedTask } from '../../ledger/projections/index.ts';
import { RUN_VIEW_NAMES } from '../../router/legacy-run.ts';
import RunProviderBanner from '../RunProviderBanner.vue';
import RunTaskBanner from '../RunTaskBanner.vue';
import { UiButton } from '../ui/index.ts';
import ApprovalsMenu from './ApprovalsMenu.vue';
import RunStatusPill from './RunStatusPill.vue';

const props = defineProps<{
  readonly isDark: boolean;
  /** `run.submittedTask`, passed down rather than read here — see the header
   * comment on why `RunProviderBanner`'s sibling reads its own store while
   * this value does not: `App.vue` already holds it for the gate band above
   * the outlet, and threading it down is one read instead of a second one. */
  readonly task: SubmittedTask | null;
  /** True when `App.vue` renders no rail at any width (a tokenless tab) — the
   * one state where this bar's theme toggle must stand in above 820px too.
   * See the header comment. */
  readonly noRail?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-theme'): void;
  (e: 'open-composer'): void;
}>();

const route = useRoute();

/** The view segment's fixed word per route name — see the header comment;
 * this is deliberately total-ish rather than a `route.meta.title` this
 * codebase does not carry, so a new route with no entry here still renders
 * its own name rather than nothing. Keyed by *canonical* name only — a
 * `legacy-*` route's name has its prefix stripped before the lookup below,
 * so a project-less run at its bookmark path reads the same word a
 * project-scoped one does. */
const VIEW_LABELS: Readonly<Record<string, string>> = {
  projects: 'Projects',
  settings: 'Settings',
  'project-workflows': 'Workflows',
  'project-runs': 'Runs',
  'project-run': 'Workflows',
  'run-plan': 'Plan',
  'plan-evolution': 'Evolution',
  'run-context': 'Context',
  'run-diff': 'Diff',
  'run-criteria': 'Criteria',
  'run-timeline': 'Timeline',
  'run-node-output': 'Output',
  'run-memory': 'Memory',
  gallery: 'Gallery',
  'not-found': 'Not found',
};

const projectId = computed<string | null>(() =>
  typeof route.params.projectId === 'string' ? route.params.projectId : null,
);

// KAR-26.5 — a read of the shared handle, never a fetch; see the header
// comment. The switcher is the one caller of its `load()`.
const { rows: projectRows } = useProjects();

/** The project's display name where the answer holds it, the raw id until —
 * and only until — it does. Never blank: an id is a fact, a blank is not. */
const projectLabel = computed<string | null>(() => {
  const id = projectId.value;
  if (id === null) return null;
  return projectRows.value.find((row) => row.id === id)?.name ?? id;
});

const viewLabel = computed<string>(() => {
  const name = typeof route.name === 'string' ? route.name : null;
  if (name === null) return '';
  const canonical = name.startsWith('legacy-') ? name.slice('legacy-'.length) : name;
  return VIEW_LABELS[canonical] ?? name;
});

interface NavItem {
  readonly name: string;
  readonly label: string;
  readonly to: RouteLocationRaw;
}

/**
 * KAR-25.1 AC1, AC2, AC8 — the rail's item set, mirrored exactly: Projects
 * and Settings always, Workflows and Runs only inside a project, in that
 * order. See the header comment's nav contract.
 */
const navItems = computed<readonly NavItem[]>(() => {
  const items: NavItem[] = [{ name: 'projects', label: 'Projects', to: { name: 'projects' } }];
  const id = projectId.value;
  if (id !== null) {
    items.push({
      name: 'project-workflows',
      label: 'Workflows',
      to: { name: 'project-workflows', params: { projectId: id } },
    });
    items.push({
      name: 'project-runs',
      label: 'Runs',
      to: { name: 'project-runs', params: { projectId: id } },
    });
  }
  items.push({ name: 'settings', label: 'Settings', to: { name: 'settings' } });
  return items;
});

/**
 * The route names that count as "on the Runs item", the topbar's own copy of
 * `AppRail.vue`'s `RUNS_ROUTE_NAMES` — kept here rather than imported so this
 * file's `[data-active]` check (below 820px, where this nav is the only one
 * on screen) does not have to reach into a sibling component's script for a
 * constant it can build from the same source, `../../router/legacy-run.ts`'s
 * `RUN_VIEW_NAMES`.
 */
const RUNS_ROUTE_NAMES = new Set<string>([
  'project-runs',
  ...RUN_VIEW_NAMES,
  ...RUN_VIEW_NAMES.map((name) => `legacy-${name}`),
]);

const WORKFLOWS_ROUTE_NAMES = new Set(['project-workflows', 'project-run']);

/**
 * Whether the view under this bar draws its own run header.
 *
 * The redesign moves the run's task, provider and status into
 * `../RunHeader.vue` on the project's workflows view — where there is room for
 * them as a heading and a row of labelled pairs, instead of three things
 * squeezed between a breadcrumb and a search field. System law 4 then says
 * they must not *also* be here: a status said twice on one screen is two
 * things to keep in step, and the first one to go stale is the small one.
 *
 * They are hidden rather than deleted, and that is the whole of this
 * computed's reason to exist. Eight other routes show a run — its plan, its
 * timeline, its diff, its output — and none of them has a header of its own.
 * Removing the three mounts outright would take "what was this run asked to
 * do" off every one of them, which is a feature change wearing a redesign's
 * clothes (`../../views/composer.test.ts`'s EPIC-22-S27 is the scenario that
 * says so out loud: the task is readable *afterwards*, from the run's own
 * ledger, on the run's own view).
 */
const runHasHeader = computed<boolean>(() => WORKFLOWS_ROUTE_NAMES.has(String(route.name ?? '')));

/** Which nav item's own name this route lights up — distinct from `name ===
 * item.name` because the Runs and Workflows items each stand for a set of
 * route names, not one. */
function isActive(itemName: string): boolean {
  const current = String(route.name ?? '');
  if (itemName === 'project-runs') return RUNS_ROUTE_NAMES.has(current);
  if (itemName === 'project-workflows') return WORKFLOWS_ROUTE_NAMES.has(current);
  return current === itemName;
}
</script>

<template>
  <header class="topbar" :class="{ 'topbar--no-rail': props.noRail }">
    <nav class="topbar__crumb" aria-label="Breadcrumb">
      <ol class="topbar__crumb-list">
        <li v-if="projectId !== null" class="topbar__crumb-item">
          <RouterLink
            :to="{ name: 'project-workflows', params: { projectId } }"
            class="topbar__crumb-project"
          >
            {{ projectLabel }}
          </RouterLink>
          <span class="topbar__crumb-sep" aria-hidden="true">/</span>
        </li>
        <li class="topbar__crumb-item">
          <span class="topbar__crumb-view" aria-current="page">{{ viewLabel }}</span>
        </li>
      </ol>
    </nav>

    <!-- KAR-24.4 AC7's contract — visible only below 820px, exactly one of
         this and `AppRail.vue`'s own nav ever showing at a given width. -->
    <nav class="topbar__nav" aria-label="Primary">
      <RouterLink
        v-for="item in navItems"
        :key="item.name"
        class="topbar__nav-item"
        :data-active="isActive(item.name) || undefined"
        :to="item.to"
      >
        {{ item.label }}
      </RouterLink>
    </nav>

    <!--
      System law 4 — a status is said once per surface, and on a route that
      draws its own run header these three are that header's. See
      `runHasHeader` in the script for the two route names and for why the bar
      keeps them everywhere else rather than dropping them outright.
    -->
    <template v-if="!runHasHeader">
      <RunProviderBanner />
      <RunTaskBanner :task="props.task" />
      <RunStatusPill />
    </template>

    <button
      class="topbar__theme"
      type="button"
      :aria-pressed="isDark"
      :aria-label="isDark ? 'Switch to the light theme' : 'Switch to the dark theme'"
      @click="emit('toggle-theme')"
    >
      <component :is="isDark ? Sun : Moon" :size="16" aria-hidden="true" />
    </button>

    <ApprovalsMenu />

    <label class="topbar__search">
      <Search class="topbar__search-icon" :size="15" aria-hidden="true" />
      <span class="topbar__search-label">Search</span>
      <input
        :id="SEARCH_INPUT_ID"
        class="topbar__search-input"
        type="search"
        placeholder="Search nodes  ( / )"
      >
    </label>

    <UiButton variant="primary" data-composer-open @click="emit('open-composer')">
      Start a run
    </UiButton>
  </header>
</template>

<style scoped>
.topbar {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0 1rem;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--edge);
}

.topbar__crumb {
  margin: 0;
  min-width: 0;
  font-size: var(--text-md);
}

.topbar__crumb-list {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
  white-space: nowrap;
}

.topbar__crumb-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.topbar__crumb-project {
  color: var(--ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  /* KAR-25.2 AC5 — now a RouterLink; the token colour above already beats the
     browser's default link blue on specificity, so only the underline needs
     switching off to keep the visual exactly what it was as plain text. */
  text-decoration: none;
}

.topbar__crumb-sep {
  color: var(--edge-hover);
}

.topbar__crumb-view {
  font-weight: 600;
  color: var(--ink);
}

.topbar__nav {
  display: none;
  align-items: center;
  gap: 2px; /* geometry, not type */
}

.topbar__nav-item {
  padding: 5px 9px; /* geometry, not type */
  border-radius: var(--radius-md);
  font-size: var(--text-base);
  color: var(--ink-muted);
  text-decoration: none;
  white-space: nowrap;
}

.topbar__nav-item[data-active] {
  background: var(--ink);
  color: var(--surface);
}

.topbar__theme,
.topbar__search {
  flex: none;
}

/* KAR-26.5 — hidden at rail widths: the toggle's home is the rail's footer
   now (blueprint 01), and two live toggles for one fact is the drift the
   emit-only wiring exists to prevent. The 820px block below shows this one
   exactly where the rail — and its footer — stops rendering; `--no-rail`
   shows it wherever `App.vue` renders no rail at all (a tokenless tab), for
   the same reason at every width. This control treatment is deliberately the
   same declaration list as `AppRail.vue`'s `.rail__theme` — reported there
   rather than minted as a sixteenth `ui/` primitive for one button skin. */
.topbar__theme {
  display: none;
  padding: 0.35rem;
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  background: var(--surface-control);
  color: var(--ink);
  cursor: pointer;
}

.topbar--no-rail .topbar__theme {
  display: inline-flex;
}

.topbar__search {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: auto;
  padding: 5px 9px; /* geometry, not type */
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  background: var(--surface-control);
  color: var(--ink-muted);
}

.topbar__search-icon {
  flex: none;
}

.topbar__search-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.topbar__search-input {
  width: min(20rem, 30vw);
  border: none;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--text-base);
}

/* KAR-24.4 AC7 — the nav moves into the topbar exactly where the rail stops
   rendering it; see the header comment's nav contract for the 820px pairing
   this depends on. `.topbar__search` folds away first, at the same
   breakpoint, so the two never fight over the bar's width.

   Off-screen rather than `display: none`, and that is load-bearing rather
   than cosmetic: `../../app/keyboard.ts`'s `/` handler finds this input by id
   and calls `.focus()` on it from *any* route, with no idea this bar has a
   narrow state at all — a map that outlives every component cannot also know
   the width of one. Chromium refuses focus to a `display: none` element
   outright, which would turn "/" into a silent no-op below 820px; clipping it
   to a point keeps it exactly as reachable as `.rail__nav-label`'s own
   off-screen labels are for a screen reader, which is the same technique for
   the same reason. */
@media (max-width: 820px) {
  .topbar__nav {
    display: flex;
  }

  /* KAR-26.5 — the rail is gone below this width, and the toggle it carries
     with it; this is the toggle for exactly those widths. */
  .topbar__theme {
    display: inline-flex;
  }

  .topbar__search {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    border: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
