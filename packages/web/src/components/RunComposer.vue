<script setup lang="ts">
/**
 * KAR-22.2 — the composer: the thing that makes the control center a control
 * center rather than a viewer.
 *
 * Three constraints shape this file, and all three come from defects this
 * project has already paid for.
 *
 * **It builds the API's own body and reads nothing itself.** `--file` sends the
 * *string the operator typed*; the realpath containment check that makes it
 * safe belongs to intake, on the daemon's side of the boundary, and a page that
 * read the file to be helpful would have stepped around it (AC1). There is one
 * intake, and this is a client of it.
 *
 * **The picker is a read of `GET /api/providers/routes` and nothing else.** It
 * reduces the resolutions `boot()` handed admission, so the picker, `doctor`
 * and admission are three renderings of one answer. EPIC-19 exists because two
 * reductions of this machine could disagree; a picker with a probe of its own
 * would be a third, and the first thing an operator would do with it is select
 * something admission then refuses (AC2).
 *
 * **A refusal is rendered in the daemon's own words.** KAR-19.2's admission
 * refusal is a shipped string produced by one renderer. Nothing here rewrites,
 * shortens or friendlifies it — a composer that paraphrased would make the same
 * machine describe the same state two ways (AC5).
 *
 * ## Why it is a plain section and not a Reka dialog
 *
 * `CommandJumper` is a vendored `command` palette because that shape's hard
 * half — roving tabindex, `aria-activedescendant`, filter wiring — is not worth
 * hand-rolling. A compose form has none of that: it is a `<form>` with labelled
 * fields, and what AC7 asks for is that it opens by key, focuses itself, and
 * submits by chord. All three are explicit here, and staying out of a portal
 * keeps the whole thing inside the shell's own DOM where `Esc` (../app/keyboard.ts)
 * already closes it.
 *
 * Verifies: EPIC-22-S18, EPIC-22-S19, EPIC-22-S22, EPIC-22-S23, EPIC-22-S25,
 * EPIC-22-S28, EPIC-22-S29, EPIC-22-S30, EPIC-22-S32 · AC1–AC7
 */
import { type ProviderRoute, routeLabel } from '@DeFlow/core';
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { COMPOSER_OVERLAY } from '../app/ids.ts';
import { useUiStore } from '../stores/useUiStore.ts';

/** The three wire shapes `POST /api/runs` accepts, and no fourth. */
const SHAPES = ['text', 'file', 'issue'] as const;
type Shape = (typeof SHAPES)[number];

/** One row of `GET /api/providers/routes`, as the daemon sends it. */
interface ProviderRow {
  readonly id: string;
  readonly available: boolean;
  readonly route: ProviderRoute | null;
  readonly routes: { readonly acp: string; readonly shim: string };
  readonly reason: string;
  readonly action: string | null;
  readonly limitation: string | null;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/**
 * The two calls this component makes, named.
 *
 * `hc<ApiType>` types them off the daemon's own chained routes; this interface
 * is the shape those calls have, declared so the casts below are one narrow
 * readable statement rather than a `never` at each call site — the same seam
 * `../views/ProjectsView.vue` draws.
 */
interface ComposerApi {
  readonly providers: { readonly routes: { readonly $get: () => Promise<HttpAnswer> } };
  readonly projects: { readonly $get: () => Promise<HttpAnswer> };
  readonly runs: {
    readonly $post: (
      args: { json: unknown },
      init: { headers: Record<string, string> },
    ) => Promise<HttpAnswer>;
  };
}

interface HttpAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

const ui = useUiStore();
const router = useRouter();
const api = useApiClient() as never as ComposerApi;

const open = computed(() => ui.isOverlayOpen(COMPOSER_OVERLAY));

const shape = ref<Shape>('text');
const text = ref('');
const path = ref('');
const url = ref('');
const projects = ref<readonly ProjectRow[]>([]);
const projectId = ref('');
const providers = ref<readonly ProviderRow[]>([]);
const providerId = ref('');
const error = ref<string | null>(null);
/**
 * The run a refusal named (AC5).
 *
 * A refused run **exists**: its `task.submitted` and its `run.aborted` are in
 * the ledger, and the id is how an operator reaches them six weeks later. A
 * composer that treated a refusal as "nothing happened" would leave that row
 * unreachable from the browser entirely.
 */
const refusedRunId = ref<string | null>(null);
const submitting = ref(false);

const promptBox = ref<HTMLTextAreaElement | null>(null);

const project = computed(() => projects.value.find((row) => row.id === projectId.value) ?? null);
const chosen = computed(() => providers.value.find((row) => row.id === providerId.value) ?? null);

/** The daemon's own sentence, or a fallback for a failure with no envelope. */
async function refusalOf(response: HttpAnswer): Promise<{ message: string; runId: string | null }> {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; detail?: { runId?: unknown } };
    };
    const message = body.error?.message;
    const runId = body.error?.detail?.runId;
    return {
      message:
        typeof message === 'string' && message !== ''
          ? message
          : `the daemon refused this run with ${response.status} and said nothing about why`,
      runId: typeof runId === 'string' ? runId : null,
    };
  } catch {
    return { message: `the daemon refused this run with ${response.status}`, runId: null };
  }
}

async function load(): Promise<void> {
  const [projectsAnswer, providersAnswer] = await Promise.all([
    api.projects.$get(),
    api.providers.routes.$get(),
  ]);

  if (projectsAnswer.ok) {
    projects.value = ((await projectsAnswer.json()) as { projects: ProjectRow[] }).projects;
    if (projectId.value === '') projectId.value = projects.value[0]?.id ?? '';
  }
  if (providersAnswer.ok) {
    providers.value = ((await providersAnswer.json()) as { providers: ProviderRow[] }).providers;
    // The **first** row, and that is load-bearing: `GET /api/providers` orders
    // them the way admission would choose, so preselecting the first is
    // preselecting what a submission with no `provider` field would land on. A
    // different default here would be the picker quietly disagreeing with
    // admission before anybody had touched it.
    if (providerId.value === '')
      providerId.value = providers.value.find((r) => r.available)?.id ?? '';
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = null;
  refusedRunId.value = null;
  void load();
  // Focus is *in* the box the moment it opens (AC7). A composer that needs a
  // click before it will take a keystroke is not keyboard-first.
  void nextTick(() => promptBox.value?.focus());
});

/** The `input` field of the body, or `null` when there is nothing to submit. */
function inputOf(): { kind: Shape; text?: string; path?: string; url?: string } | null {
  switch (shape.value) {
    case 'text': {
      const value = text.value.trim();
      return value === '' ? null : { kind: 'text', text: value };
    }
    case 'file': {
      const value = path.value.trim();
      return value === '' ? null : { kind: 'file', path: value };
    }
    case 'issue': {
      const value = url.value.trim();
      return value === '' ? null : { kind: 'issue', url: value };
    }
  }
}

async function submit(): Promise<void> {
  // AC-side of EPIC-22-S32: a second submit while the first is in flight is
  // dropped. One request rather than two-with-a-key, because the cheapest way
  // to make a double-click one run is not to send the second one.
  if (submitting.value) return;

  error.value = null;
  refusedRunId.value = null;

  const input = inputOf();
  if (input === null) {
    // The cheapest refusal is the one that costs no round trip.
    error.value = 'Type a prompt, name a file in the project, or paste an issue reference first.';
    return;
  }

  const target = project.value;
  if (target === null) {
    error.value =
      'This run needs a project. Create one on the Projects page and point it at a git ' +
      'repository on this machine.';
    return;
  }

  const agent = chosen.value;
  if (agent === null || !agent.available) {
    // AC3 — a dead end is labelled before it is walked into, and selecting one
    // anyway costs no request. The reason is the daemon's, not this file's.
    error.value =
      agent === null
        ? 'Choose an adapter this machine can use.'
        : `${agent.id} cannot serve a run here. ${agent.reason}`;
    return;
  }

  submitting.value = true;
  try {
    const response = await api.runs.$post(
      {
        json: {
          input,
          cwd: target.path,
          projectId: target.id,
          // The same default `deflow run` uses. A composer that offered every
          // permission level as a dropdown would be asking an operator to make
          // a safety decision in the same breath as a prompt.
          permission: 'worktree',
          provider: agent.id,
        },
      },
      { headers: { 'Idempotency-Key': idempotencyKey() } },
    );

    if (!response.ok) {
      // AC5 — verbatim. `deflow run` and this box refuse the same machine with
      // the same words because neither of them writes those words.
      const refusal = await refusalOf(response);
      error.value = refusal.message;
      refusedRunId.value = refusal.runId;
      return;
    }

    const created = (await response.json()) as { runId: string };
    ui.closeOverlay(COMPOSER_OVERLAY);
    text.value = '';
    path.value = '';
    url.value = '';
    // AC4 — the operator is taken to the thing they just started, in this same
    // document: the run's feed opens on arrival and the first frame renders.
    await router.push({ name: 'run-plan', params: { runId: created.runId } });
  } catch (cause) {
    // A draft is not retyped because a socket failed.
    error.value = `the daemon could not be reached: ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  } finally {
    submitting.value = false;
  }
}

/**
 * A fresh key per submission attempt.
 *
 * Belt and braces beside the in-flight guard above: the guard stops a double
 * chord in one tab, and this is what makes a retry after a *timeout* — where
 * the first request may well have been received — cost one run rather than two.
 */
const idempotencyKey = (): string =>
  `composer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function onKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
  event.preventDefault();
  void submit();
}
</script>

<template>
  <section
    v-if="open"
    class="composer"
    data-composer
    data-overlay="composer"
    role="dialog"
    aria-modal="true"
    aria-labelledby="DeFlow-composer-title"
    @keydown="onKeydown"
  >
    <form class="composer__form" @submit.prevent="submit">
      <h2 id="DeFlow-composer-title" class="composer__title">Start a run</h2>

      <div class="composer__shapes" role="group" aria-label="What this run is about">
        <button
          v-for="kind in SHAPES"
          :key="kind"
          type="button"
          class="composer__shape"
          :data-composer-shape="kind"
          :aria-pressed="shape === kind"
          @click="shape = kind"
        >
          {{ kind }}
        </button>
      </div>

      <label v-if="shape === 'text'" class="composer__field">
        <span>Prompt</span>
        <textarea
          ref="promptBox"
          v-model="text"
          data-composer-text
          rows="4"
          spellcheck="false"
          placeholder="What should this run do?"
        />
      </label>

      <!--
        AC1 — the path the operator typed, sent as typed. Nothing here reads a
        file: `input.path` is resolved and contained by intake, which is the
        boundary that owns that check.
      -->
      <label v-else-if="shape === 'file'" class="composer__field">
        <span>A file inside the project</span>
        <input v-model="path" data-composer-path type="text" autocomplete="off" spellcheck="false">
      </label>

      <label v-else class="composer__field">
        <span>An issue reference</span>
        <input v-model="url" data-composer-url type="text" autocomplete="off" spellcheck="false">
      </label>

      <label class="composer__field">
        <span>Project</span>
        <select v-model="projectId" data-composer-project>
          <option v-for="row in projects" :key="row.id" :value="row.id">
            {{ row.name }}
            — {{ row.path }}
          </option>
        </select>
      </label>

      <!--
        AC2, AC3 — the picker. Every row is the daemon's answer: whether it is
        available, by which route, why not, and what to run about it. Nothing on
        this list is computed in the browser.
      -->
      <fieldset class="composer__providers" data-composer-providers>
        <legend>Adapter</legend>
        <p v-if="providers.length === 0" class="composer__providers-empty">
          This daemon has not been told which machine it is on, so it cannot say which adapters are
          usable here. Start it with <code>deflow up</code>.
        </p>
        <ul v-else class="composer__provider-rows">
          <li
            v-for="row in providers"
            :key="row.id"
            class="composer__provider"
            :data-provider-row="row.id"
            :data-provider-available="String(row.available)"
            :data-provider-route="row.route ?? ''"
          >
            <label class="composer__provider-head">
              <input
                v-model="providerId"
                data-provider-select
                type="radio"
                name="DeFlow-composer-provider"
                :value="row.id"
                :disabled="!row.available"
              >
              <span class="composer__provider-id">{{ row.id }}</span>
              <span class="composer__provider-route">
                {{ row.route === null ? 'unavailable' : `${routeLabel(row.route)} route` }}
              </span>
            </label>
            <p class="composer__provider-reason">{{ row.reason }}</p>
            <p v-if="row.limitation" class="composer__provider-limit">{{ row.limitation }}</p>
            <p v-if="row.action" class="composer__provider-action">
              <code>{{ row.action }}</code>
            </p>
          </li>
        </ul>
      </fieldset>

      <div class="composer__actions">
        <button type="submit" data-composer-submit :disabled="submitting">Start run</button>
        <span class="composer__hint">⌘/Ctrl + Enter</span>
      </div>

      <!--
        AC5 — the daemon's sentence, rendered as it arrived. `deflow run` and
        this box say the same thing about the same machine because neither of
        them composes it.
      -->
      <p v-if="error" class="composer__error" data-composer-error role="alert">{{ error }}</p>
      <p v-if="refusedRunId" class="composer__refused" data-composer-refused-run>
        The run exists and was aborted: <code>{{ refusedRunId }}</code>
      </p>
    </form>
  </section>
</template>

<style scoped>
.composer {
  position: fixed;
  top: 10vh;
  left: 50%;
  translate: -50% 0;
  width: min(46rem, 92vw);
  max-height: 80vh;
  overflow: auto;
  z-index: 40;
  border: 1px solid var(--edge, rgb(0 0 0 / 20%));
  border-radius: 0.6rem;
  background: var(--surface-raised, canvas);
  box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 25%);
}

.composer__form {
  display: grid;
  gap: 0.6rem;
  padding: 0.9rem 1rem 1.1rem;
}

.composer__title {
  font-size: 1rem;
  margin: 0;
}

.composer__shapes {
  display: flex;
  gap: 0.35rem;
}

.composer__shape {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--edge, rgb(0 0 0 / 20%));
  border-radius: 999px;
  background: var(--surface, transparent);
  color: inherit;
  font-size: 0.8em;
}

.composer__shape[aria-pressed="true"] {
  border-color: currentcolor;
  font-weight: 600;
}

.composer__field {
  display: grid;
  gap: 0.2rem;
  font-size: 0.85em;
}

.composer__providers {
  border: 1px solid var(--edge, rgb(0 0 0 / 15%));
  border-radius: 0.4rem;
  padding: 0.5rem 0.6rem;
  font-size: 0.8em;
}

.composer__provider-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.composer__provider-head {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
}

.composer__provider-id {
  font-weight: 600;
}

/* State is carried by words as well as by colour: the route, the reason and
   the command are always text, and the dimming is an extra cue rather than the
   only one. */
.composer__provider[data-provider-available="false"] {
  opacity: 0.75;
}

.composer__provider-reason,
.composer__provider-limit,
.composer__provider-action,
.composer__providers-empty {
  margin: 0.15rem 0 0 1.3rem;
  opacity: 0.85;
}

.composer__actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.composer__hint {
  font-size: 0.75em;
  opacity: 0.65;
}

.composer__error {
  margin: 0;
  color: var(--ink-danger, var(--ink-warn, inherit));
  white-space: pre-wrap;
}

.composer__refused {
  margin: 0;
  font-size: 0.8em;
  opacity: 0.8;
}
</style>
