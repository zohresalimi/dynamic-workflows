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
 *
 * KAR-25.6, EPIC-25-S38…S41 — the create form now lives in `UiModal` instead
 * of being permanently in the DOM. `UiModal` already supplies the focus
 * trap, `Esc`, outside-click and focus return (`ui/a11y.test.ts` is that
 * contract); this file adds none of it — `formOpen` is the one flag that
 * decides whether the dialog and its form are mounted at all, and the three
 * triggers (the header button, the dashed grid tile, the empty state's
 * action) all set the same flag rather than each opening something of its
 * own. What `create()` does on submission — the request, the verbatim
 * refusal, the row appended to the grid — is unchanged; the only addition is
 * closing the modal once a project actually exists (AC3).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { MAIN_CONTENT_ID } from '../app/ids.ts';
import { type ProjectHealth, type ProjectRow, useProjects } from '../app/useProjects.ts';
import { UiButton, UiChip, UiEmptyState, UiIconTile, UiModal } from '../components/ui/index.ts';

const client = useApiClient();
const route = useRoute();
const router = useRouter();

/**
 * KAR-25.5 AC3, EPIC-25-S35 — the chooser says why it was reached.
 *
 * A query parameter rather than a store flag, for the same reason
 * `router/index.ts`'s header comment gives for `project-run` being a route
 * rather than component state: "send me what you are looking at" has to
 * survive being pasted or reloaded. `App.vue`'s `openComposer()` is the one
 * writer — `c` or the topbar button, pressed with no project open.
 *
 * `computed`, not a plain read at setup: a `c` press that lands here from an
 * already-mounted `/projects` reuses this component instance (only the query
 * changed, not the route's name), so a value read once at `setup()` would
 * carry the tab's *first* query forever, missing every push after it.
 */
const needsProject = computed(() => route.query['needsProject'] === '1');

/**
 * KAR-26.5 (audit item: the breadcrumb's project segment) — the grid reads and
 * writes the application's one shared projects handle (`../app/useProjects.ts`)
 * instead of a private `ref` of its own. Same list, same one `GET` on mount
 * (`load` below is the handle's), zero extra requests — but a create or a
 * removal made here now updates the switcher and the breadcrumb in the same
 * session, instead of leaving the frame to render the raw id for exactly the
 * project the operator just made. Mounted outside the shell (a component-level
 * spec), `useProjects()` hands back a private handle that behaves identically.
 */
const { rows: projects, load } = useProjects();
const name = ref('');
const path = ref('');
const error = ref<string | null>(null);
const removing = ref<ProjectRow | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
/** AC1 — whether the create-project modal (and therefore the form) is mounted. */
const formOpen = ref(false);

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
  // AC3, EPIC-25-S38 — a project was created, so the form that asked for one
  // has nothing left to do. A refusal above returns before this line, which
  // is what keeps the modal open with the typed path on failure (EPIC-25-S40).
  formOpen.value = false;
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
 * AC1, EPIC-25-S39 — all three triggers (the header button, the dashed grid
 * tile, the empty state's action) call this one function, so there is one
 * modal rather than three things that each think they open something.
 */
function openCreateForm(): void {
  formOpen.value = true;
}

/**
 * AC4, EPIC-25-S41 — Cancel's own handler. `Esc` and an outside click close
 * the same way, through `UiModal`'s `close` emit (`onUpdateOpen` in
 * `UiModal.vue`) — Cancel is not a second dismissal mechanism, it is this
 * function bound to a button instead of to Reka's dismiss events.
 */
function closeCreateForm(): void {
  formOpen.value = false;
}

/**
 * EPIC-25-S38 — the name field is focused the moment the modal has
 * something to focus, matching what the form did when it was always
 * mounted. `nextTick` waits for the field to exist; running after Reka's own
 * open-autofocus (which would otherwise land on the dialog's close button,
 * the first tabbable element in `UiModal`'s header) is what makes this the
 * field that ends up focused.
 */
watch(formOpen, (open) => {
  if (open) void nextTick(() => nameInput.value?.focus());
});

/**
 * KAR-26.5, EPIC-26-S35 — the rail's dashed new-project affordance
 * (`frame/ProjectSwitcher.vue`) routes here as `/projects?new=1`, and this
 * watcher is what makes that the *same* modal every other trigger opens: it
 * sets the one `formOpen` flag, exactly as `openCreateForm()` does. A query
 * parameter rather than a store flag for the reason `needsProject` above
 * already records — the intent has to survive being pasted or reloaded.
 */
watch(
  () => route.query['new'],
  (marker) => {
    if (marker === '1') formOpen.value = true;
  },
  { immediate: true },
);

/**
 * The marker is spent when the modal closes — by Cancel, `Esc`, an outside
 * click or a successful create, all of which land on `formOpen` becoming
 * false. Cleared with a `replace` (no history entry) so the affordance works
 * a second time and a reload after closing does not reopen a dialog the
 * operator just dismissed. This is the one route write the audit item names.
 */
watch(formOpen, (open) => {
  if (open || route.query['new'] === undefined) return;
  const { new: _spent, ...rest } = route.query;
  void router.replace({ query: rest });
});

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
 * The calls this view makes itself, named — the list `GET` is the shared
 * handle's now (KAR-26.5; see `projects` above), leaving this view the two
 * writes.
 *
 * `hc<ApiType>` types them from the daemon's own chained routes, and this
 * interface is the shape those calls have — declared so the casts above are one
 * narrow, readable statement rather than a `never` at each call site.
 */
interface ProjectsApi {
  readonly projects: {
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
      <UiButton variant="primary" size="md" data-project-new-header @click="openCreateForm"
        >New project</UiButton
      >
    </header>

    <!--
      AC3, EPIC-25-S35 — "Start a run" was reached with no project open. No
      run was submitted (there is nothing here to submit): this is the reason
      line the composer used to render inside its own form, moved to the
      affordance that actually answers it.
    -->
    <p v-if="needsProject" class="projects__needs-project" data-projects-needs-project>
      Pick a project to start a run in, or create one below.
    </p>

    <!--
      KAR-25.6 AC1 — the form exists only while this is open. `UiModal`
      supplies the focus trap, `Esc`, outside-click and focus return
      (`ui/a11y.test.ts`); `closeCreateForm` is this view's own Cancel
      handler and `UiModal`'s `close` emit, one function either way.
    -->
    <UiModal :open="formOpen" title="New project" @close="closeCreateForm">
      <form
        id="DeFlow-project-form"
        class="projects__form"
        data-project-form
        @submit.prevent="create"
      >
        <label class="projects__field">
          <span>Name</span>
          <input ref="nameInput" v-model="name" data-project-name type="text" autocomplete="off">
        </label>
        <label class="projects__field">
          <span>Path to a git repository on this machine</span>
          <input v-model="path" data-project-path type="text" autocomplete="off" spellcheck="false">
        </label>
        <!--
          The daemon's sentence, rendered verbatim. `deflow init` and this
          form refuse the same directory with the same words because
          neither of them writes those words (AC1 of KAR-22.1).
        -->
        <p v-if="error" class="projects__error" data-project-error role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <UiButton variant="ghost" size="sm" data-project-create-cancel @click="closeCreateForm"
          >Cancel</UiButton
        >
        <!--
          KAR-24.7 — the one button in the application that submits a form,
          and it is a `UiButton` like every other. The primitive shipped
          with `type` hardcoded to `button`, which is the right default and
          the wrong constraint: it sent this caller back to a bare
          `<button>`, and a primitive people step around has started
          shrinking the system instead of growing it. `type` is a prop now.
          `form="DeFlow-project-form"` is what lets this button live in the
          modal's footer, outside the `<form>` element itself, and still
          submit it — the same pattern `RunComposer.vue`'s own submit button
          uses for the same reason.
        -->
        <UiButton
          type="submit"
          form="DeFlow-project-form"
          variant="primary"
          size="sm"
          class="projects__submit"
          data-project-create
          >Create project</UiButton
        >
      </template>
    </UiModal>

    <!-- KAR-24.7 AC5 — a first-run account gets a sentence and an action, not
         a bare "No projects". -->
    <UiEmptyState
      v-if="projects.length === 0"
      title="No projects yet"
      hint="Point one at a git repository on this machine and every run you start will belong to it."
      data-projects-empty
    >
      <template #action>
        <UiButton variant="primary" size="sm" data-project-new-empty-action @click="openCreateForm"
          >New project</UiButton
        >
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
            <UiButton variant="ghost" size="sm" data-project-new-tile-action @click="openCreateForm"
              >Add project</UiButton
            >
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

.projects__needs-project {
  color: var(--state-blocked);
  font-size: var(--text-sm);
  margin: 0 0 1rem;
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
