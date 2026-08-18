<script setup lang="ts">
/**
 * KAR-24.7 AC1, AC2, AC5 — projects, rendered as direction A's card grid.
 *
 * The behaviour this view answers to is unchanged from KAR-22.1 and this file
 * changes none of it — only the shape the same three requests are drawn in:
 *
 * - **It decides nothing about a path.** Whether a directory is a git working
 *   tree, whether it is still there, and what to say when it is not are all
 *   answered by the daemon, and the card renders the sentence it was given.
 *   `deflow init`'s refusal reaches an operator's screen in its own words
 *   because nothing here rewrites it (KAR-24.7 AC1, KAR-22.1 AC1).
 * - **It hides nothing.** A project whose path has gone is still a card, with
 *   its health message beside it, never dropped from the grid (KAR-24.7 AC2).
 *   `projects.test.ts` is the contract for that and passes unmodified.
 * - **It promises what the API promises.** The removal confirmation names the
 *   path and states that no files are deleted, because that is what
 *   `DELETE /api/projects/:id` actually does — stated before the request is
 *   sent, which is the only moment the promise is worth anything.
 *
 * **What the card does *not* draw.** Direction A's prototype card also carries
 * a tracker badge, a description, a list of the project's flows and a
 * three-figure stats footer (runs this week, pass rate, average duration).
 * `ProjectRow` — the type below, read straight off `GET /api/projects` — has
 * none of that: a project here is an id, a name, a path, a creation
 * timestamp, a health verdict and at most one last-run pointer. Per the "no
 * invented field" rule this story is built against, none of the four missing
 * affordances is faked or backfilled with a client-side computation; the card
 * renders what the row has and stops. See KAR-24.7's `notes` in the delivery
 * record for the gap this leaves against the prototype.
 *
 * There is still no store: this list has no stream topic and no live frames,
 * so a Pinia store would be state with one writer and one reader in one
 * component. When KAR-22.3 gives the workspace a subscription, the store
 * arrives with it.
 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { MAIN_CONTENT_ID } from '../app/ids.ts';
import { UiButton, UiChip, UiEmptyState, UiIconTile } from '../components/ui/index.ts';

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

const client = useApiClient();

const projects = ref<ProjectRow[]>([]);
const name = ref('');
const path = ref('');
const error = ref<string | null>(null);
const removing = ref<ProjectRow | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);

/** The daemon's own sentence, or a fallback for a failure with no envelope. */
async function refusalOf(response: { json: () => Promise<unknown> }): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === 'string' && message !== ''
      ? message
      : 'the daemon refused this project and said nothing about why';
  } catch {
    return 'the daemon could not be reached';
  }
}

async function load(): Promise<void> {
  const response = await (client as never as ProjectsApi).projects.$get();
  if (!response.ok) return;
  projects.value = [...((await response.json()) as { projects: ProjectRow[] }).projects];
}

async function create(): Promise<void> {
  error.value = null;
  const response = await (client as never as ProjectsApi).projects.$post({
    json: { name: name.value.trim(), path: path.value.trim() },
  });

  if (!response.ok) {
    // The typed path stays in the field: a refusal is usually one character
    // wrong, and clearing the box makes the operator find the directory again.
    error.value = await refusalOf(response);
    return;
  }

  const created = (await response.json()) as { project: ProjectRow };
  projects.value = [...projects.value, created.project];
  name.value = '';
  path.value = '';
}

async function confirmRemoval(): Promise<void> {
  const target = removing.value;
  if (target === null) return;
  removing.value = null;
  const response = await (client as never as ProjectsApi).projects[':id'].$delete({
    param: { id: target.id },
  });
  if (response.ok) projects.value = projects.value.filter((row) => row.id !== target.id);
}

/**
 * The dashed grid tile and the empty-state action both open the same form —
 * the form was never hidden (it has to stay in the DOM for `projects.test.ts`
 * to reach it without a click this story does not own), so "open" here means
 * carrying the operator's focus to the first field rather than mounting
 * anything new.
 */
function focusCreateForm(): void {
  nameInput.value?.focus();
}

/** Up to two initials for the icon tile, the way `UiIconTile`'s callers do it. */
function initials(projectName: string): string {
  const words = projectName.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0], words[words.length - 1]] : [projectName];
  return letters
    .map((word) => word?.[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** `UiChip`'s tone for a health state — a colour token, never a literal. */
function healthTone(state: ProjectHealth['state']): 'ok' | 'warn' | 'error' {
  if (state === 'ok') return 'ok';
  if (state === 'missing') return 'warn';
  return 'error';
}

/**
 * The three calls this view makes, named.
 *
 * `hc<ApiType>` types them from the daemon's own chained routes, and this
 * interface is the shape those calls have — declared so the casts above are one
 * narrow, readable statement rather than a `never` at each call site.
 */
interface ProjectsApi {
  readonly projects: {
    readonly $get: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    readonly $post: (args: {
      json: { name: string; path: string };
    }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    readonly ':id': {
      readonly $delete: (args: {
        param: { id: string };
      }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    };
  };
}

onMounted(() => {
  void load();
});
</script>

<template>
  <main :id="MAIN_CONTENT_ID" class="projects" data-projects>
    <header class="projects__header">
      <div>
        <h1 class="projects__title">Projects</h1>
        <p class="projects__subtitle">Each project carries its own workflows and run history.</p>
      </div>
      <UiButton variant="primary" size="md" @click="focusCreateForm">New project</UiButton>
    </header>

    <form class="projects__form" data-project-form @submit.prevent="create">
      <label class="projects__field">
        <span>Name</span>
        <input ref="nameInput" v-model="name" data-project-name type="text" autocomplete="off">
      </label>
      <label class="projects__field">
        <span>Path to a git repository on this machine</span>
        <input v-model="path" data-project-path type="text" autocomplete="off" spellcheck="false">
      </label>
      <!--
        KAR-24.7 — the one button in the application that submits a form, and
        it is a `UiButton` like every other. The primitive shipped with
        `type` hardcoded to `button`, which is the right default and the wrong
        constraint: it sent this caller back to a bare `<button>`, and a
        primitive people step around has started shrinking the system instead
        of growing it. `type` is a prop now. `@submit.prevent="create"` above
        is still what makes Enter-to-submit and a real click take one path.
      -->
      <UiButton type="submit" variant="primary" class="projects__submit" data-project-create
        >Create project</UiButton
      >
      <!--
        The daemon's sentence, rendered verbatim. `deflow init` and this form
        refuse the same directory with the same words because neither of them
        writes those words (AC1).
      -->
      <p v-if="error" class="projects__error" data-project-error role="alert">{{ error }}</p>
    </form>

    <!-- KAR-24.7 AC5 — a first-run account gets a sentence and an action, not
         a bare "No projects". -->
    <UiEmptyState
      v-if="projects.length === 0"
      title="No projects yet"
      hint="Point one at a git repository on this machine and every run you start will belong to it."
      data-projects-empty
    >
      <template #action>
        <UiButton variant="primary" size="sm" @click="focusCreateForm">New project</UiButton>
      </template>
    </UiEmptyState>

    <ul v-else class="projects__grid">
      <li
        v-for="project in projects"
        :key="project.id"
        class="projects__card"
        data-project-row
        :data-project-health="project.health.state"
      >
        <!--
          KAR-22.3 — the way into the project's workspace, and the reason the
          operator never types a run id: from here to the graph, the board and
          everything this project has ever run is one press.
        -->
        <RouterLink
          class="projects__card-link"
          :to="`/projects/${project.id}`"
          :data-project-open="project.id"
        >
          <div class="projects__card-head">
            <UiIconTile size="lg" tint="var(--surface-control)"
              >{{ initials(project.name) }}</UiIconTile
            >
            <div class="projects__card-heading">
              <span class="projects__card-name">{{ project.name }}</span>
              <span class="projects__card-updated">created {{ project.createdAt }}</span>
            </div>
          </div>
          <span class="projects__card-path">{{ project.path }}</span>
          <span
            v-if="project.lastRun"
            class="projects__card-last-run"
            :data-project-last-run="project.id"
          >
            last run: {{ project.lastRun.label }}
          </span>
        </RouterLink>
        <!--
          AC2 — an unhealthy project is a card too, never filtered out: a
          project that disappears without explanation gets recreated under a
          second id, stranding every run stamped with the first. The message
          is always the text; the chip is the same fact said with a token.
        -->
        <div v-if="project.health.message" class="projects__card-health">
          <UiChip :variant="healthTone(project.health.state)">{{ project.health.state }}</UiChip>
          <span :data-project-health-message="project.id">{{ project.health.message }}</span>
        </div>
        <button
          type="button"
          class="projects__card-remove"
          data-project-remove
          @click="removing = project"
        >
          Remove
        </button>
      </li>

      <!-- AC1 — the dashed tile direction A's grid always ends on. -->
      <li>
        <UiEmptyState
          title="New project"
          hint="Point it at a git repository on this machine."
          class="projects__new-tile"
          data-project-new-tile
        >
          <template #action>
            <UiButton variant="ghost" size="sm" @click="focusCreateForm">Add project</UiButton>
          </template>
        </UiEmptyState>
      </li>
    </ul>

    <!--
      AC6 — the promise, made before the request rather than reported after it.
      Dismissing this sends nothing at all.
    -->
    <div v-if="removing" class="projects__confirm" data-project-remove-confirm role="alertdialog">
      <p>
        Remove <strong>{{ removing.name }}</strong> from DeFlow? Its repository at
        <code>{{ removing.path }}</code>
        stays exactly as it is — no files on disk are deleted, and the runs it already has stay
        readable.
      </p>
      <UiButton variant="ghost" size="sm" data-project-remove-cancel @click="removing = null">
        Cancel
      </UiButton>
      <UiButton variant="danger" size="sm" data-project-remove-accept @click="confirmRemoval">
        Remove project
      </UiButton>
    </div>
  </main>
</template>

<style scoped>
.projects {
  padding: 16px; /* geometry — the page's own padding */
}

.projects__header {
  display: flex;
  align-items: flex-end;
  gap: 16px; /* geometry — the header's own gutter */
  margin-bottom: 22px; /* geometry — header-to-form gap */
}

.projects__title {
  font-size: var(--text-2xl);
  margin: 0;
}

.projects__subtitle {
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 5px 0 0; /* geometry — title-to-subtitle gap */
}

.projects__form {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
  max-width: 42rem;
}

.projects__field {
  display: grid;
  gap: 0.2rem;
  font-size: var(--text-sm);
  color: var(--ink-muted);
}

.projects__field input {
  box-sizing: border-box;
  background: var(--surface-inset);
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  padding: 9px 11px; /* geometry — matches UiField's own input padding */
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--text-md);
}

.projects__submit {
  justify-self: start;
  background: var(--surface-control);
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  padding: 6px 11px; /* geometry — matches UiButton's sm padding */
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  font-weight: 500;
  cursor: pointer;
}

.projects__submit:hover {
  border-color: var(--edge-hover);
}

.projects__error {
  color: var(--state-failed);
  margin: 0;
}

.projects__grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px; /* geometry — the prototype's own card gutter */
}

.projects__card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px; /* geometry — the card's own stack gap */
  background: var(--surface);
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-xl);
  padding: 14px; /* geometry — matches UiCard's raised padding */
}

.projects__card-link {
  display: flex;
  flex-direction: column;
  gap: 8px; /* geometry — the link block's own stack gap */
  color: inherit;
  text-decoration: none;
}

.projects__card-head {
  display: flex;
  align-items: center;
  gap: 9px; /* geometry — icon-to-heading gutter */
}

.projects__card-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.projects__card-name {
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.projects__card-updated {
  font-size: var(--text-xs);
  color: var(--ink-faint);
  margin-top: 1px; /* geometry — name-to-updated gap */
}

.projects__card-path,
.projects__card-last-run {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
}

.projects__card-health {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — chip-to-message gutter */
  font-size: var(--text-sm);
  color: var(--state-blocked);
  padding-top: 8px; /* geometry — separates the health line from the link block */
  border-top: 1px solid var(--edge);
}

.projects__card-remove {
  align-self: flex-start;
  background: transparent;
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  padding: 5px 10px; /* geometry — matches UiButton's sm padding */
  color: var(--ink-muted);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  cursor: pointer;
}

.projects__card-remove:hover {
  border-color: var(--edge-hover);
  color: var(--ink);
}

.projects__new-tile {
  height: 100%;
}

.projects__confirm {
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  display: grid;
  gap: 0.5rem;
  margin-top: 1rem;
  max-width: 42rem;
  padding: 0.75rem;
  background: var(--surface);
}
</style>
