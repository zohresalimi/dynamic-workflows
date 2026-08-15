<script setup lang="ts">
/**
 * KAR-22.1 — projects: the first screen of the control center.
 *
 * The view does almost nothing, which is the same discipline `RunListView`
 * follows and for the same reasons:
 *
 * - **It decides nothing about a path.** Whether a directory is a git working
 *   tree, whether it is still there, and what to say when it is not are all
 *   answered by the daemon, and the page renders the sentence it was given.
 *   `deflow init`'s refusal reaches an operator's screen in its own words
 *   because nothing here rewrites it (AC1).
 * - **It hides nothing.** A project whose path has gone is rendered with its
 *   health message beside it (AC5). A list that filtered unhealthy rows would
 *   answer "where did my project go?" with silence.
 * - **It promises what the API promises.** The removal confirmation names the
 *   path and states that no files are deleted, because that is what
 *   `DELETE /api/projects/:id` actually does (AC6) — and it is stated *before*
 *   the request is sent, which is the only moment at which the promise is
 *   worth anything.
 *
 * There is no store: this list has no stream topic and no live frames, so a
 * Pinia store would be state with one writer and one reader in one component.
 * When KAR-22.3 gives the workspace a subscription, the store arrives with it.
 */
import { onMounted, ref } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { MAIN_CONTENT_ID } from '../app/ids.ts';

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
    <h1 class="projects__title">Projects</h1>

    <form class="projects__form" data-project-form @submit.prevent="create">
      <label class="projects__field">
        <span>Name</span>
        <input v-model="name" data-project-name type="text" autocomplete="off">
      </label>
      <label class="projects__field">
        <span>Path to a git repository on this machine</span>
        <input v-model="path" data-project-path type="text" autocomplete="off" spellcheck="false">
      </label>
      <button type="submit" data-project-create>Create project</button>
      <!--
        The daemon's sentence, rendered verbatim. `deflow init` and this form
        refuse the same directory with the same words because neither of them
        writes those words (AC1).
      -->
      <p v-if="error" class="projects__error" data-project-error role="alert">{{ error }}</p>
    </form>

    <p v-if="projects.length === 0" class="projects__empty" data-projects-empty>
      No projects yet. Point one at a git repository on this machine and every run you start will
      belong to it.
    </p>

    <ul v-else class="projects__rows">
      <li
        v-for="project in projects"
        :key="project.id"
        class="projects__row"
        data-project-row
        :data-project-health="project.health.state"
      >
        <span class="projects__row-name">{{ project.name }}</span>
        <span class="projects__row-path">{{ project.path }}</span>
        <span v-if="project.lastRun" class="projects__row-run" :data-project-last-run="project.id">
          last run: {{ project.lastRun.label }}
        </span>
        <!--
          AC5 — an unhealthy project is listed and says so. Never filtered out:
          a project that disappears without explanation gets recreated under a
          second id, stranding every run stamped with the first.
        -->
        <span
          v-if="project.health.message"
          class="projects__row-health"
          :data-project-health-message="project.id"
        >
          {{ project.health.message }}
        </span>
        <button type="button" data-project-remove @click="removing = project">Remove</button>
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
      <button type="button" data-project-remove-cancel @click="removing = null">Cancel</button>
      <button type="button" data-project-remove-accept @click="confirmRemoval">
        Remove project
      </button>
    </div>
  </main>
</template>

<style scoped>
.projects {
  padding: 1rem;
}

.projects__title {
  font-size: 1.1rem;
  margin: 0 0 0.75rem;
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
  font-size: 0.85em;
}

.projects__error {
  color: var(--ink-danger, var(--ink-warn, inherit));
  margin: 0;
}

.projects__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.projects__row {
  display: grid;
  gap: 0.2rem 1rem;
  grid-template-columns: 1fr auto;
  padding: 0.5rem 0.25rem;
}

.projects__row + .projects__row {
  border-top: 1px solid var(--border, rgb(0 0 0 / 10%));
}

.projects__row-path,
.projects__row-run {
  font-family: var(--font-mono, monospace);
  font-size: 0.8em;
  grid-column: 1 / -1;
  opacity: 0.7;
}

/* State is carried by a word as well as by colour: the message is always
   rendered, and the colour is an additional cue rather than the only one. */
.projects__row-health {
  grid-column: 1 / -1;
  font-size: 0.8em;
  color: var(--ink-warn, inherit);
}

.projects__confirm {
  border: 1px solid var(--border, rgb(0 0 0 / 20%));
  border-radius: 0.4rem;
  display: grid;
  gap: 0.5rem;
  margin-top: 1rem;
  max-width: 42rem;
  padding: 0.75rem;
}
</style>
