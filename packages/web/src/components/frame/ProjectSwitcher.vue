<script setup lang="ts">
/**
 * KAR-24.4 AC3 — the rail's project switcher: a card showing the active
 * project, opening onto the rest.
 *
 * **It adds no request the application did not already make.** `ProjectsView`
 * already calls `GET /api/projects` and reads `{ projects: ProjectRow[] }`
 * back (`../../views/ProjectsView.vue`); this component's `ProjectsApi` type
 * and `load()` are that same shape, copied rather than reinvented, so a
 * change to the endpoint's response has exactly one other call site to keep
 * in step with. There is still no store behind it for the reason
 * `ProjectsView`'s own docblock gives: this list has no stream topic, so a
 * Pinia store would be one writer and one reader wearing a second name.
 *
 * **The popover is Reka UI's, not hand-rolled.** `CommandJumper.vue` already
 * makes the case for this in the jumper's own docblock — outside-click,
 * focus-return and `Esc` handling are the genuinely hard part of a menu's
 * accessibility, and `PopoverRoot`/`PopoverContent` supply all three for
 * free. `PopoverContent`'s own `Escape` handling is left alone here (unlike
 * the jumper, which overrides it to route through the app's single overlay
 * stack): a project switcher is a plain disclosure widget, not one of the
 * jumper/inspector overlays `../../app/keyboard.ts` tracks, so there is only
 * ever the one `Esc` handler Reka UI already wires up.
 *
 * **Selecting a project routes to its workflows** (`/projects/:id`,
 * `project-workflows`) rather than mutating any store — KAR-22.3's route is
 * already the single place "which project am I looking at" lives, so this
 * component reads that fact off `useRoute()` for its own active marker and
 * writes it only through `router.push`.
 */
import { ChevronsUpDown, Plus } from 'lucide-vue-next';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useApiClient } from '../../api/provide.ts';
import { UiCard, UiChip, UiIconTile } from '../ui/index.ts';

interface ProjectHealth {
  readonly state: 'ok' | 'missing' | 'not-a-git-repo';
  readonly message: string | null;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: ProjectHealth;
  readonly lastRun: { readonly runId: string; readonly label: string } | null;
}

/** `ProjectsView.vue`'s own `ProjectsApi` seam, narrowed to the one call this
 *  component makes. */
interface ProjectsApi {
  readonly projects: {
    readonly $get: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  };
}

const client = useApiClient();
const route = useRoute();
const router = useRouter();

const projects = ref<ProjectRow[]>([]);
const open = ref(false);

async function load(): Promise<void> {
  try {
    const response = await (client as never as ProjectsApi).projects.$get();
    if (!response.ok) return;
    projects.value = [...((await response.json()) as { projects: ProjectRow[] }).projects];
  } catch {
    // KAR-24.4 AC6 — this rail is mounted on every authenticated screen now,
    // not one route that opted in, so a daemon that is restarting (or, in a
    // spec, a test double that only implements the endpoints its own story
    // cares about) must not take the whole frame down with it. `App.vue`'s
    // own `loadApprovals` is the precedent: the switcher simply shows no
    // projects rather than throwing an unhandled rejection out of `onMounted`.
  }
}

onMounted(() => {
  void load();
});

const activeProjectId = computed<string | null>(() => {
  const id = route.params.projectId;
  return typeof id === 'string' && id !== '' ? id : null;
});

const activeProject = computed<ProjectRow | null>(
  () => projects.value.find((project) => project.id === activeProjectId.value) ?? null,
);

/** Up to two letters, the way `UiIconTile`'s callers spell an initials tile
 *  elsewhere in the app (see `../../views/GalleryView.vue`). */
function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .filter((letter): letter is string => Boolean(letter));
  return (letters.slice(0, 2).join('') || '?').toUpperCase();
}

function select(project: ProjectRow): void {
  open.value = false;
  void router.push(`/projects/${project.id}`);
}
</script>

<template>
  <div class="switcher">
    <PopoverRoot v-model:open="open">
      <PopoverTrigger as-child>
        <button type="button" class="switcher__trigger" data-project-switcher>
          <UiIconTile size="md" tint="var(--state-running)">
            <span class="switcher__initials"
              >{{ activeProject ? initialsOf(activeProject.name) : '—' }}</span
            >
          </UiIconTile>
          <span class="switcher__text">
            <span class="switcher__name">{{ activeProject?.name ?? 'No project open' }}</span>
            <span class="switcher__meta"
              >{{ activeProject ? activeProject.path : 'Choose a project' }}</span
            >
          </span>
          <ChevronsUpDown :size="12" class="switcher__chevron" aria-hidden="true" />
        </button>
      </PopoverTrigger>

      <PopoverPortal>
        <PopoverContent class="switcher__panel" align="start" :side-offset="6">
          <UiCard variant="raised" class="switcher__card">
            <p v-if="projects.length === 0" class="switcher__empty">No projects yet.</p>
            <ul v-else class="switcher__list">
              <li v-for="project in projects" :key="project.id">
                <button
                  type="button"
                  class="switcher__row"
                  :class="{ 'switcher__row--active': project.id === activeProjectId }"
                  :data-project-switcher-option="project.id"
                  @click="select(project)"
                >
                  <UiIconTile size="sm" tint="var(--state-running)">
                    <span class="switcher__row-initials">{{ initialsOf(project.name) }}</span>
                  </UiIconTile>
                  <span class="switcher__row-name">{{ project.name }}</span>
                  <UiChip v-if="!project.health.message" mono variant="neutral">ok</UiChip>
                  <UiChip v-else mono variant="warn">{{ project.health.state }}</UiChip>
                </button>
              </li>
            </ul>
            <RouterLink to="/projects" class="switcher__new" @click="open = false">
              <span class="switcher__new-icon" aria-hidden="true"><Plus :size="11" /></span>
              <span>All projects</span>
            </RouterLink>
          </UiCard>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>
</template>

<style scoped>
.switcher {
  padding: 4px 10px 10px;
}

.switcher__trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px; /* geometry — the prototype's switcher row gutter */
  padding: 9px 10px; /* geometry — the switcher row's own padding */
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.switcher__trigger:hover {
  border-color: var(--edge-hover);
}

.switcher__initials,
.switcher__row-initials {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--surface-canvas);
}

.switcher__text {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.switcher__name {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.switcher__meta {
  font-size: var(--text-xs);
  color: var(--ink-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.switcher__chevron {
  flex: none;
  color: var(--ink-faint);
}

.switcher__panel {
  width: 226px; /* geometry — the rail's own width minus its padding */
  z-index: 20;
}

.switcher__card {
  padding: 5px; /* geometry — the prototype's popover padding */
  box-shadow: var(--shadow-modal);
}

.switcher__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 15rem;
  overflow-y: auto;
}

.switcher__empty {
  margin: 0;
  padding: 7px 8px;
  font-size: var(--text-base);
  color: var(--ink-faint);
}

.switcher__row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — the row's own icon-to-name gutter */
  padding: 7px 8px; /* geometry — the row's own padding */
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.switcher__row:hover {
  background: var(--surface-inset);
}

.switcher__row--active {
  background: var(--surface-inset);
}

.switcher__row-name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  color: var(--ink-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.switcher__new {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid var(--edge);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-md);
  color: var(--ink-faint);
  font-size: var(--text-base);
  text-decoration: none;
}

.switcher__new:hover {
  background: var(--surface-inset);
  color: var(--ink);
}

.switcher__new-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px; /* geometry — matches the sm icon tile it sits beside */
  height: 18px; /* geometry — matches the sm icon tile it sits beside */
  border: 1px dashed var(--edge-hover);
  border-radius: var(--radius-sm);
}
</style>
