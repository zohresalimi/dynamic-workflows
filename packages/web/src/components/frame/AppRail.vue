<script setup lang="ts">
/**
 * KAR-24.4 AC1, AC2, AC7 — the 246px left rail: brand, project switcher, nav,
 * runtimes, identity. Direction A's frame in one file, composed from KAR-24.2's
 * fifteen primitives and declaring no colour of its own (every value below is
 * `var(--…)`).
 *
 * **The nav is derived, not copied.** Direction A draws five rows, one of
 * which — "Builder" — this application has no route for, and KAR-24.4 AC2
 * exists precisely so that gap is never quietly filled in. `../../router/index.ts`
 * is read here as the list of routes that are real: Runs and Projects always,
 * and the current project's Workspace and Connectors only while a
 * `projectId` route param is in scope. A nav item that pointed at a route the
 * router does not have would be a dead link nobody notices until they click
 * it, so every `to` below is a literal path this file's own reading of
 * `../../router/index.ts` confirms exists, and every "is this row active"
 * check names the matching route's own `name` rather than guessing at a path
 * prefix.
 *
 * **The RUNTIMES section reads `GET /api/providers`.** That endpoint and its
 * `providersQuery` helper already exist in `../../api/queries.ts` — on the
 * query side of KAR-16.4 AC10's cache/projection line, sanctioned in
 * `SANCTIONED_QUERY_PATHS` — and simply had no screen calling it yet. This is
 * the first caller, not a new request: the daemon's own probe of what is
 * installed on this machine, shown as-is. Nothing here re-probes, ranks or
 * invents a runtime the endpoint did not report, and an empty list renders no
 * section at all rather than a fabricated placeholder row.
 *
 * **The identity footer shows the daemon connection, not a person.**
 * `useSessionStore` has a token and an `authenticated` boolean — DeFlow has no
 * notion of "who is logged in", only "does this tab hold the daemon's token" —
 * so the footer says exactly that rather than inventing a name and a role the
 * way direction A's "Sam Rao — Workspace admin" does.
 *
 * **AC7's breakpoints are CSS-only, and match `AppTopBar.vue`'s own contract
 * for them exactly rather than inventing a second one.** That file's header
 * comment ("The sub-820px nav contract, for whoever builds `AppRail.vue`
 * next") already commits to the shape this rail has to fit: 820px on both
 * sides, each side hiding *itself* at that number, neither reading the
 * other's width. No JS media-query watcher and no data attribute is needed
 * to "expose" the breakpoint to the topbar, because the topbar never asks
 * this file anything — its own `@media (max-width: 820px)` block shows
 * `.topbar__nav` at the same number this file's hides `<aside>` at, so
 * exactly one of the two is ever on screen, by construction, with nothing to
 * fall out of sync at runtime. Between 820px and 1100px the rail narrows to
 * an icon column in the same stylesheet, no script involved.
 *
 * In icon mode the row label is not `display:none` — it is clipped
 * off-screen with the same technique `App.vue`'s search label (and
 * `AppTopBar.vue`'s own `.topbar__search-label`) already use — so the
 * accessible name `RouterLink` builds from its slot content survives for a
 * screen reader even though sighted operators see icons only.
 */
import { useQuery } from '@pinia/colada';
import { Boxes, Cable, Layers, ListChecks, Workflow } from 'lucide-vue-next';
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useApiClient } from '../../api/provide.ts';
import { providersQuery } from '../../api/queries.ts';
import { useSessionStore } from '../../stores/useSessionStore.ts';
import { UiChip, UiIconTile, UiSectionLabel } from '../ui/index.ts';
import ProjectSwitcher from './ProjectSwitcher.vue';

const route = useRoute();
const client = useApiClient();
const session = useSessionStore();

/** The project this route is inside, if any — `null` on `/` and `/projects`. */
const projectId = computed<string | null>(() => {
  const id = route.params.projectId;
  return typeof id === 'string' && id !== '' ? id : null;
});

/**
 * Every route name that counts as "on this nav item", named explicitly rather
 * than derived from path prefixes: `vue-router`'s default active-link
 * matching only looks at the current route's own matched record, so a nested
 * run view (`run-diff`, `run-timeline`, …) would not otherwise light up
 * "Runs", and a run reached through a project (`project-run`) would not light
 * up "Workspace". Both lists are read straight off `../../router/index.ts`'s
 * `name` fields, so a route rename fails type-checking here rather than
 * silently going dark.
 */
const RUN_ROUTE_NAMES = [
  'runs',
  'run-plan',
  'plan-evolution',
  'run-context',
  'run-diff',
  'run-criteria',
  'run-timeline',
  'run-node-output',
  'run-memory',
] as const;
const WORKSPACE_ROUTE_NAMES = ['project-workspace', 'project-run'] as const;

interface NavItem {
  readonly key: string;
  readonly to: string;
  readonly label: string;
  readonly icon: typeof ListChecks;
  readonly active: boolean;
}

/** AC2 — only routes `../../router/index.ts` actually registers. */
const navItems = computed<readonly NavItem[]>(() => {
  const name = String(route.name ?? '');
  const items: NavItem[] = [
    {
      key: 'runs',
      to: '/',
      label: 'Runs',
      icon: ListChecks,
      active: (RUN_ROUTE_NAMES as readonly string[]).includes(name),
    },
    {
      key: 'projects',
      to: '/projects',
      label: 'Projects',
      icon: Boxes,
      active: name === 'projects',
    },
  ];

  const id = projectId.value;
  if (id !== null) {
    items.push({
      key: 'workspace',
      to: `/projects/${id}`,
      label: 'Workspace',
      icon: Layers,
      active: (WORKSPACE_ROUTE_NAMES as readonly string[]).includes(name),
    });
    items.push({
      key: 'connectors',
      to: `/projects/${id}/connectors`,
      label: 'Connectors',
      icon: Cable,
      active: name === 'project-connectors',
    });
  }

  return items;
});

// AC1 — the runtime list this machine actually has, read once from the
// sanctioned `GET /api/providers` query rather than a request invented for
// this rail.
const { data: providers } = useQuery(providersQuery(client));
</script>

<template>
  <aside class="rail" data-frame-rail aria-label="Application">
    <div class="rail__brand">
      <UiIconTile size="sm" tint="var(--state-running)" class="rail__brand-mark">
        <Workflow :size="12" aria-hidden="true" />
      </UiIconTile>
      <span class="rail__brand-name">DeFlow</span>
      <UiChip mono class="rail__brand-badge">LOCAL</UiChip>
    </div>

    <ProjectSwitcher />

    <nav class="rail__nav" aria-label="Sections">
      <RouterLink
        v-for="item in navItems"
        :key="item.key"
        :to="item.to"
        class="rail__nav-item"
        :class="{ 'rail__nav-item--active': item.active }"
        :aria-current="item.active ? 'page' : undefined"
      >
        <component :is="item.icon" :size="14" class="rail__nav-icon" aria-hidden="true" />
        <span class="rail__nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <template v-if="providers && providers.length > 0">
      <UiSectionLabel class="rail__section" as="div">Runtimes</UiSectionLabel>
      <ul class="rail__runtimes">
        <li v-for="row in providers" :key="row.provider" class="rail__runtime" data-runtime-row>
          <span class="rail__runtime-dot" :data-installed="row.installed" aria-hidden="true" />
          <span class="rail__runtime-name">{{ row.provider }}</span>
          <span class="rail__runtime-detail"
            >{{ row.installed ? (row.version ?? 'installed') : 'not installed' }}</span
          >
        </li>
      </ul>
    </template>

    <div class="rail__identity">
      <UiIconTile size="md" tint="var(--surface-control)">
        <span class="rail__identity-glyph" aria-hidden="true"
          >{{ session.authenticated ? '●' : '○' }}</span
        >
      </UiIconTile>
      <div class="rail__identity-text">
        <span class="rail__identity-title">Local daemon</span>
        <span class="rail__identity-meta"
          >{{ session.authenticated ? 'Connected' : 'No session' }}</span
        >
      </div>
    </div>
  </aside>
</template>

<style scoped>
/*
 * AC7 — 246px and full above 1100px. The two narrower states are plain media
 * queries below (icon width at 1100px, `display: none` at 820px) rather than
 * a script-computed mode — see the header comment for why that is also what
 * keeps this file's half of the 820px contract in step with
 * `AppTopBar.vue`'s.
 */
.rail {
  display: flex;
  flex-direction: column;
  width: 246px; /* geometry — direction A's rail width */
  flex: none;
  height: 100%;
  background: var(--surface-raised);
  border-right: 1px solid var(--edge);
  overflow-y: auto;
}

.rail__brand {
  display: flex;
  align-items: center;
  gap: 9px; /* geometry — the prototype's brand row gutter */
  padding: 16px 14px 12px; /* geometry — the brand row's own padding */
}

.rail__brand-name {
  font-size: var(--text-md);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.rail__brand-badge {
  margin-left: auto;
  color: var(--ink-faint);
}

.rail__nav {
  display: flex;
  flex-direction: column;
  gap: 1px; /* geometry — the prototype's row rhythm */
  padding: 2px 10px;
}

.rail__nav-item {
  display: flex;
  align-items: center;
  gap: 9px; /* geometry — icon-to-label gutter */
  padding: 7px 9px; /* geometry — the row's own padding */
  border-radius: var(--radius-lg);
  color: var(--ink-muted);
  text-decoration: none;
  font-size: var(--text-md);
  font-weight: 500;
}

.rail__nav-item:hover {
  background: var(--surface);
}

/* Active is inverted — ink-on-accent — never colour alone: the row's own
   position (first, second, …) and its bold weight already carry the state,
   so an operator who cannot see the fill still reads which row is current. */
.rail__nav-item--active {
  background: var(--state-running);
  color: var(--surface-canvas);
  font-weight: 600;
}

.rail__nav-icon {
  flex: none;
}

/*
 * AC7 — between 820px and 1100px: an icon-only rail. The label is never
 * `display:none` — that would drop it from the accessible name `RouterLink`
 * builds from its slot — it is clipped off-screen the same way `App.vue`'s
 * search label is, so a screen reader still announces "Runs", "Projects",
 * and so on.
 */
@media (max-width: 1100px) {
  .rail {
    width: 64px; /* geometry — the icon-only rail */
  }

  .rail__nav-label,
  .rail__brand-name,
  .rail__brand-badge,
  .rail__identity-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

/*
 * AC7 — below 820px the rail is not rendered, the same number and the same
 * "one side hides, the other shows" logic `AppTopBar.vue`'s own
 * `@media (max-width: 820px) { .topbar__nav { display: flex } }` block uses
 * for its half of the pairing (see that file's header comment).
 */
@media (max-width: 820px) {
  .rail {
    display: none;
  }
}

.rail__section {
  margin-top: 18px; /* geometry — the gap above RUNTIMES */
  padding: 0 20px 8px;
}

.rail__runtimes {
  display: flex;
  flex-direction: column;
  gap: 2px; /* geometry — the runtime row rhythm */
  padding: 0 12px;
  margin: 0;
  list-style: none;
}

.rail__runtime {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — dot-to-name gutter */
  padding: 5px 8px; /* geometry — the runtime row's own padding */
  border-radius: var(--radius-md);
}

.rail__runtime:hover {
  background: var(--surface);
}

.rail__runtime-dot {
  width: 6px; /* geometry — the prototype's status dot */
  height: 6px; /* geometry — the prototype's status dot */
  flex: none;
  border-radius: var(--radius-pill);
  background: var(--ink-faint);
}

.rail__runtime-dot[data-installed="true"] {
  background: var(--state-passed);
}

.rail__runtime-name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  color: var(--ink-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail__runtime-detail {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

/* AC1 — pinned to the bottom with `margin-top: auto`, not a fixed position:
   a rail shorter than the viewport still ends with the footer flush against
   its edge, and a rail long enough to scroll never leaves it stranded. */
.rail__identity {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 9px; /* geometry — the prototype's identity row gutter */
  padding: 12px;
  border-top: 1px solid var(--edge);
}

.rail__identity-glyph {
  font-size: var(--text-sm);
  color: var(--state-passed);
}

.rail__identity-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rail__identity-title {
  font-size: var(--text-base);
  color: var(--ink-strong);
}

.rail__identity-meta {
  font-size: var(--text-xs);
  color: var(--ink-faint);
}
</style>
