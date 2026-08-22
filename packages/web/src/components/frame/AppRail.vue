<script setup lang="ts">
/**
 * KAR-24.4 AC1, AC2, AC7 — the 246px left rail: brand, project switcher, nav,
 * runtimes, identity. Direction A's frame in one file, composed from KAR-24.2's
 * fifteen primitives and declaring no colour of its own (every value below is
 * `var(--…)`).
 *
 * **KAR-25.2 AC4, AC6 — the brand mark is a link to `/`.** It was a plain
 * `<div>` with no `href` and no accessible name; it is now a `RouterLink`, so
 * "from any route, `/` is reachable in one click without browser history"
 * (AC6) is true because this component is mounted on every authenticated
 * screen, and keyboard reach and activation come from the anchor `RouterLink`
 * renders rather than a key handler this file would otherwise have to write.
 * `color: inherit` and `text-decoration: none` are the only style delta: the
 * icon glyph and the badge use `currentColor`/their own tokens and would
 * otherwise pick up the browser's default link blue and underline the moment
 * the wrapper became an `<a>`. `/` already resolves to `/projects`
 * (`../../router/index.ts`), and the accessible `aria-label` exists because
 * the visible name — "DeFlow" plus the "LOCAL" badge — is one word away from
 * drifting the moment that badge's text changes.
 *
 * **Below 820px this rail — and the brand mark with it — is not rendered at
 * all** (AC7 below). AC6 does not go unmet there: `AppTopBar.vue`'s own nav
 * stands in below that width and already carries a "Projects" item pointing
 * at `/projects`, the same place `/` redirects to, so a narrow tab keeps a
 * one-click way home, just under a different label. Growing a second,
 * brand-mark-shaped affordance into the topbar for widths where this file
 * does not render would be a second implementation of the same fact.
 *
 * **The nav is derived, not copied.** Direction A draws five rows, one of
 * which — "Builder" — this application has no route for, and KAR-24.4 AC2
 * exists precisely so that gap is never quietly filled in. `../../router/index.ts`
 * is read here as the list of routes that are real.
 *
 * **KAR-25.1 — the scope rule, stated once.** Projects and Settings are
 * global and never disappear (AC1, AC3): `/projects` and `/settings`. Inside
 * a project two more rows appear, in this order — Workflows
 * (`/projects/:id`) and Runs (`/projects/:id/runs`) — so the full set reads
 * Projects · Workflows · Runs · Settings (AC2). Connectors is not a row here
 * at all: it is neither a global concern nor one of the four names AC1/AC2
 * list. KAR-25.4 moved it into Settings' own "Issue tracker" panel, so it is
 * reachable through the Settings row like everything else on that page.
 * Every `to` below is a literal path this file's own reading of
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
 * **Amended after review (KAR-25.3 AC8).** The row used to read only
 * `row.installed` — a runtime the operator disabled in `/settings` looked
 * identical to one still on, on the one surface visible from every screen.
 * `row.enabled` (the same field the settings toggle reads and writes) now
 * drives the dot and the detail text too: the rail stays read-only, this is
 * one more fact it reports rather than a control it grows.
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
import { Boxes, Layers, ListChecks, Moon, Settings, Sun, Workflow } from 'lucide-vue-next';
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useApiClient } from '../../api/provide.ts';
import { providersQuery } from '../../api/queries.ts';
import { RUN_VIEW_NAMES } from '../../router/legacy-run.ts';
import { useSessionStore } from '../../stores/useSessionStore.ts';
import { UiChip, UiIconTile, UiSectionLabel } from '../ui/index.ts';
import ProjectSwitcher from './ProjectSwitcher.vue';

/**
 * KAR-26.5 (audit item: the theme toggle's home) — blueprint 01 settles that
 * the toggle lives at the right edge of this rail's identity footer, and the
 * design README has said so since EPIC-25. The button here is the same
 * emit-only shape `AppTopBar.vue`'s was: `useTheme()` stays `App.vue`'s to
 * call, this file only says which button was pressed. Below 820px this rail
 * is not rendered at all, so the topbar keeps a toggle for exactly those
 * widths — the same one-side-or-the-other pairing the nav already uses.
 */
defineProps<{ readonly isDark: boolean }>();

const emit = defineEmits<{ (e: 'toggle-theme'): void }>();

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
 * up "Workflows". `WORKFLOWS_ROUTE_NAMES` and `RUNS_ROUTE_NAMES` are read
 * straight off `../../router/index.ts` and `../../router/legacy-run.ts`'s own
 * `RUN_VIEW_NAMES`, so a route rename fails type-checking here rather than
 * silently going dark — and a run opened at its legacy `/runs/:runId…`
 * bookmark still lights up "Runs" rather than nothing.
 */
const WORKFLOWS_ROUTE_NAMES = ['project-workflows', 'project-run'] as const;
const RUNS_ROUTE_NAMES = [
  'project-runs',
  ...RUN_VIEW_NAMES,
  ...RUN_VIEW_NAMES.map((name) => `legacy-${name}`),
];

interface NavItem {
  readonly key: string;
  readonly to: string;
  readonly label: string;
  readonly icon: typeof ListChecks;
  readonly active: boolean;
}

/**
 * AC1, AC2, AC3, AC8 — only routes `../../router/index.ts` actually
 * registers, in exactly the scope rule the header comment states: Projects
 * and Settings always, Workflows and Runs only inside a project, and always
 * in that order.
 */
const navItems = computed<readonly NavItem[]>(() => {
  const name = String(route.name ?? '');
  const id = projectId.value;

  const items: NavItem[] = [
    {
      key: 'projects',
      to: '/projects',
      label: 'Projects',
      icon: Boxes,
      active: name === 'projects',
    },
  ];

  if (id !== null) {
    items.push({
      key: 'workflows',
      to: `/projects/${id}`,
      label: 'Workflows',
      icon: Layers,
      active: (WORKFLOWS_ROUTE_NAMES as readonly string[]).includes(name),
    });
    items.push({
      key: 'runs',
      to: `/projects/${id}/runs`,
      label: 'Runs',
      icon: ListChecks,
      active: (RUNS_ROUTE_NAMES as readonly string[]).includes(name),
    });
  }

  items.push({
    key: 'settings',
    to: '/settings',
    label: 'Settings',
    icon: Settings,
    active: name === 'settings',
  });

  return items;
});

// AC1 — the runtime list this machine actually has, read once from the
// sanctioned `GET /api/providers` query rather than a request invented for
// this rail.
const { data: providers } = useQuery(providersQuery(client));
</script>

<template>
  <aside class="rail" data-frame-rail aria-label="Application">
    <!-- KAR-25.2 AC4, AC6, EPIC-25-S12 — a real link to `/`, not a div with
         nowhere to go. See the header comment for the icon-mode gap this
         closes and the one it does not. -->
    <RouterLink to="/" class="rail__brand" aria-label="DeFlow — home">
      <UiIconTile size="sm" tint="var(--state-running)" class="rail__brand-mark">
        <Workflow :size="12" aria-hidden="true" />
      </UiIconTile>
      <span class="rail__brand-name">DeFlow</span>
      <UiChip mono class="rail__brand-badge">LOCAL</UiChip>
    </RouterLink>

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
        <li
          v-for="row in providers"
          :key="row.provider"
          class="rail__runtime"
          data-runtime-row
          :data-runtime-enabled="row.enabled"
        >
          <!-- AC8, amended after review — `row.enabled` is `GET /api/providers`'
               own field (KAR-25.3), the same one `RuntimesPanel.vue`'s toggle
               reads and writes, so an operator who just disabled a runtime does
               not see this glance still call it installed and say nothing
               about the toggle: it is one more fact this read-only list
               reports, not a control it grows. `data-installed` alone used to
               decide both the dot and the detail text, which is what let a
               disabled-but-installed runtime render identically to one that
               was on. -->
          <span
            class="rail__runtime-dot"
            :data-installed="row.installed"
            :data-enabled="row.enabled"
            aria-hidden="true"
          />
          <span class="rail__runtime-name">{{ row.provider }}</span>
          <span class="rail__runtime-detail"
            >{{ !row.enabled ? 'disabled' : row.installed ? (row.version ?? 'installed') : 'not installed' }}</span
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
      <!-- KAR-26.5 — the toggle's home per blueprint 01; see the script
           comment for the 820px pairing with `AppTopBar.vue`'s own. -->
      <button
        class="rail__theme"
        type="button"
        :aria-pressed="isDark"
        :aria-label="isDark ? 'Switch to the light theme' : 'Switch to the dark theme'"
        @click="emit('toggle-theme')"
      >
        <component :is="isDark ? Sun : Moon" :size="16" aria-hidden="true" />
      </button>
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
  /* KAR-25.2 AC4 — now a RouterLink; without these two, the browser's
     default link colour and underline would show through wherever a child
     does not paint its own (the icon glyph, via `currentColor`). */
  text-decoration: none;
  color: inherit;
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

/*
 * KAR-25.1 AC4, EPIC-25-S03 — `:not(.rail__nav-item--active)` rather than a
 * specificity fight. `.rail__nav-item:hover` (0,2,0) used to outrank
 * `.rail__nav-item--active` (0,1,0) and win the *background*, while leaving
 * `--active`'s ink in place — so the active row, hovered, painted
 * `--surface-canvas` text on a `--surface` fill: 1.12:1 in light, 1.04:1 in
 * dark. The row was unreadable exactly when an operator's pointer was over
 * it. Narrowing the selector is not a colour override (AC4's own ban), so the
 * active row simply keeps its own fill under the pointer instead.
 */
.rail__nav-item:not(.rail__nav-item--active):hover {
  background: var(--surface);
}

/*
 * Active is inverted — ink-on-accent — never colour alone: the row's own
 * position and its bold weight already carry the state, so an operator who
 * cannot see the fill still reads which row is current (AC5).
 *
 * `--accent` / `--accent-ink` (theme.css), not `--state-running` /
 * `--surface-canvas`: the previous pairing bound an unrelated ink token to a
 * run-status colour with no ink of its own, which is exactly how it went
 * unreadable under hover with nothing here declaring a bad value — the fix is
 * a token pair with a bound ink, not a smarter selector alone (AC4).
 */
.rail__nav-item--active {
  background: var(--accent);
  color: var(--accent-ink);
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

  /* KAR-26.5 — the toggle survives icon mode: the 64px column has no row
     room beside the daemon tile, so the footer stacks instead of clipping a
     control (the identity *text* is clipped above; a button that vanished
     from sighted layout would vanish from pointer reach with it). */
  .rail__identity {
    flex-direction: column;
    gap: 8px;
  }

  .rail__theme {
    margin-left: 0;
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

/* AC8 — a disabled runtime never reads as "on" here, installed or not: two
   attribute selectors outrank the single-attribute rule above regardless of
   source order, so this wins for every installed-but-disabled row. */
.rail__runtime-dot[data-installed="true"][data-enabled="false"] {
  background: var(--ink-faint);
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

/* KAR-26.5 — the same control treatment `AppTopBar.vue`'s toggle has always
   worn, pushed to the footer's right edge the way the blueprint draws it.
   Declaration-for-declaration a copy of `.topbar__theme` — the duplication is
   *reported* (KAR-24.4's "report rather than add a sixteenth primitive" rule;
   see the audit doc and the note on `.topbar__theme` itself) rather than
   extracted, and the two lists are kept identical so a token change cannot
   half-apply. */
.rail__theme {
  margin-left: auto;
  display: inline-flex;
  padding: 0.35rem;
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  background: var(--surface-control);
  color: var(--ink);
  cursor: pointer;
}
</style>
