<script setup lang="ts">
/**
 * KAR-22.2 — the composer: the thing that makes the control center a control
 * center rather than a viewer.
 * KAR-25.5 AC1, AC2, AC8 — moved out of `UiModal` and out of `App.vue`'s
 * global mount, onto its own route: `/projects/:projectId/new-run`
 * (`../views/NewRunView.vue` owns the page frame around this file; this file
 * is the composer bar itself). Every behaviour below predates this story and
 * is untouched by it: the three intake shapes, the picker that reduces
 * `GET /api/providers/routes` and nothing else, the verbatim refusal, and the
 * `⌘/Ctrl+Enter` submit chord. `composer.test.ts` is the contract for that,
 * and it changed only where an assertion named a selector or a route.
 *
 * Three constraints shape the *behaviour*, and all three come from defects
 * this project has already paid for.
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
 * ## Why not `UiModal` any more, and who owns Escape now
 *
 * KAR-24.8 AC1 put this on `UiModal` for its chrome, which brought a focus
 * trap, `Esc`-to-close and a `role="dialog"` along for free. KAR-25.5 AC1
 * asks for the opposite: no dialog role, no focus trap, `Esc` does nothing.
 * There is no local replacement for any of that, and none is needed — a page
 * has nothing to trap focus inside of and nothing for `Esc` to dismiss. This
 * file lays no `role="dialog"`/`aria-modal`/`aria-labelledby` and installs no
 * `Escape` handler; `../app/keyboard.ts:68-73` already returns before
 * `preventDefault` when `ui.overlays.length === 0`, and the composer stopped
 * being one of those the moment it stopped being an overlay (`COMPOSER_OVERLAY`
 * is gone — see `../app/ids.ts`'s history). The one keyboard handler this file
 * still installs is `onKeydown` below, and it answers a **different** key —
 * `⌘/Ctrl+Enter` — which no primitive owns.
 *
 * **The project is the route, not a field in this form.** The old `<select
 * data-composer-project>` is gone: `projectId` arrives as a prop from
 * `NewRunView.vue`, which took it from `route.params.projectId`. A select
 * here would be a second source of truth for a fact the URL already carries,
 * and would let an operator on `/projects/A/new-run` submit against project B.
 *
 * **The `c` keyboard route and the topbar button** both still do one thing —
 * navigate here — but neither lives in this file any more: the former is
 * `../app/keyboard.ts`, the latter is `AppTopBar`'s `@open-composer`, and both
 * now go through `App.vue`'s `openComposer()`, which is the one place that
 * decides "this project" versus "the chooser, with a reason" (AC3).
 *
 * Verifies: EPIC-22-S18, EPIC-22-S19, EPIC-22-S22, EPIC-22-S23, EPIC-22-S25,
 * EPIC-22-S28, EPIC-22-S29, EPIC-22-S30, EPIC-22-S32, EPIC-24-S30 · AC1, AC2,
 * AC4, AC5, AC6, AC8 · KAR-25.5
 */
import { type ProviderRoute, routeLabel } from '@DeFlow/core';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { PROMPT_INPUT_ID } from '../app/ids.ts';
import { UiButton, UiCard, UiChip, UiSectionLabel } from './ui/index.ts';

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

/** One issue from a connected service, in the one vocabulary (KAR-22.4 AC3). */
interface IssueRow {
  readonly key: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

/**
 * One entry of the picker: an issue, and which connector it came from
 * (KAR-22.6 AC3).
 *
 * The service travels with the row rather than being inferred from the key,
 * because two trackers' keys can look alike and a picker that leaves an
 * operator guessing where a row came from is one they have to double-check.
 */
interface PickerRow extends IssueRow {
  readonly service: string;
  readonly serviceLabel: string;
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
  readonly projects: {
    readonly $get: () => Promise<HttpAnswer>;
    readonly ':id': {
      readonly connectors: {
        readonly $get: (args: { param: { id: string } }) => Promise<HttpAnswer>;
        readonly ':service': {
          readonly issues: {
            readonly $get: (args: {
              param: { id: string; service: string };
              query: { q: string };
            }) => Promise<HttpAnswer>;
          };
        };
      };
    };
  };
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

const props = defineProps<{
  /** From `/projects/:projectId/new-run` (`NewRunView.vue`, `props: true`). */
  readonly projectId: string;
}>();

const router = useRouter();
const api = useApiClient() as never as ComposerApi;

const shape = ref<Shape>('text');
const text = ref('');
const path = ref('');
const url = ref('');
const projects = ref<readonly ProjectRow[]>([]);
const projectsLoaded = ref(false);
const providers = ref<readonly ProviderRow[]>([]);
const providerId = ref('');
/**
 * KAR-22.4 AC3, KAR-22.6 AC3 — the connected services for the selected project,
 * and their issues.
 *
 * Empty means "no connector", and that is the state most machines are in: the
 * picker simply does not appear and the box below it is what it always was.
 * The list **adds** to the paste path and never replaces it (AC6), because an
 * operator with a URL in their clipboard may well be pointing at a repository
 * this connector cannot see at all.
 *
 * A *list* rather than the first connected service, which is what KAR-22.4
 * shipped when there was only one that could be connected. With two, taking the
 * first would silently hide half of what the operator connected — and the
 * failure is invisible, because the list still looks full.
 */
const connectedServices = ref<readonly { readonly id: string; readonly label: string }[]>([]);
const issues = ref<readonly PickerRow[]>([]);
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

const project = computed(() => projects.value.find((row) => row.id === props.projectId) ?? null);
const chosen = computed(() => providers.value.find((row) => row.id === providerId.value) ?? null);

/**
 * KAR-25.5 AC4 — usable first, then the rest, which is the one grouping
 * `GET /api/providers/routes` actually supports: the daemon already orders
 * usable adapters ahead of the rest (`usableProviders()`'s own order), so
 * this is that ordering made visible as two labelled sections rather than a
 * provider/vendor taxonomy the wire shape does not carry. See this file's
 * companion story notes for what the blueprint's model names, vendor groups
 * and context-window figures cannot be: none of them are on this row, and
 * `test/no-context-window-table.test.ts` forbids inventing the last one.
 */
const usableProviders = computed(() => providers.value.filter((row) => row.available));
const unusableProviders = computed(() => providers.value.filter((row) => !row.available));

/** The issue chip's own label: the connected service's name once there is
 * exactly one, and the generic word otherwise — never a name this component
 * invented for a service it has not been told about. */
const issueShapeLabel = computed(() =>
  connectedServices.value.length === 1 ? (connectedServices.value[0]?.label ?? 'Issue') : 'Issue',
);

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
  }
  projectsLoaded.value = true;
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
  void loadConnector();
}

/**
 * Which service this project has connected, if any.
 *
 * Read from the daemon rather than remembered: a connector removed in another
 * tab must not leave a picker behind that submits against a service DeFlow no
 * longer uses. Fetched once the project is known — up front, not only once the
 * operator picks the `issue` shape — because the shape chip itself names the
 * connected service (KAR-25.5's "Linear ⌄"-style label) and needs the answer
 * before anything is selected.
 */
async function loadConnector(): Promise<void> {
  connectedServices.value = [];
  issues.value = [];
  const target = project.value;
  if (target === null) return;

  const response = await api.projects[':id'].connectors.$get({ param: { id: target.id } });
  if (!response.ok) return;
  const body = (await response.json()) as {
    services: readonly { id: string; label: string; connected: boolean }[];
  };
  connectedServices.value = body.services
    .filter((service) => service.connected)
    .map((service) => ({ id: service.id, label: service.label }));
}

/**
 * This project's issues matching whatever is in the box.
 *
 * The term goes to the *service* — the daemon passes it to `gh` — rather than
 * to a filter here, so a repository with three hundred issues is a search
 * rather than three hundred rows on the wire.
 */
async function loadIssues(): Promise<void> {
  const target = project.value;
  const services = connectedServices.value;
  if (target === null || services.length === 0) return;

  const typed = url.value.trim();
  // A pasted reference is not a search term: an operator who has a URL in the
  // box has already answered the question the list exists to ask.
  const q = typed.startsWith('http') ? '' : typed;

  // One request per connected service, in parallel and in the daemon's order.
  // A service that fails contributes nothing rather than emptying the list:
  // an unreachable Jira must not take a working GitHub down with it.
  const answers = await Promise.all(
    services.map(async (service) => {
      const response = await api.projects[':id'].connectors[':service'].issues.$get({
        param: { id: target.id, service: service.id },
        query: { q },
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { issues: IssueRow[] };
      return body.issues.map(
        (issue): PickerRow => ({ ...issue, service: service.id, serviceLabel: service.label }),
      );
    }),
  );
  issues.value = answers.flat();
}

watch(shape, (kind) => {
  if (kind === 'issue' && connectedServices.value.length > 0) void loadIssues();
});
watch(url, () => {
  if (shape.value === 'issue' && connectedServices.value.length > 0) void loadIssues();
});

/**
 * KAR-25.5 AC5 — focus is *in* the box the moment the route is entered, and
 * again on a project switch that reuses this instance (`NewRunView.vue`'s own
 * `projectId` prop changes without a remount when only the route param does).
 * A composer that needs a click before it will take a keystroke is not
 * keyboard-first.
 */
onMounted(() => {
  error.value = null;
  refusedRunId.value = null;
  void load();
  void nextTick(() => promptBox.value?.focus());
});

watch(
  () => props.projectId,
  () => {
    error.value = null;
    refusedRunId.value = null;
    void loadConnector();
    void nextTick(() => promptBox.value?.focus());
  },
);

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
    // Belt and braces: the route requires a `:projectId`, but a well-formed id
    // naming no project on this machine is a real case (a stale bookmark, a
    // project removed in another tab) and the composer must not pretend it is
    // the empty-select refusal this line used to be.
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
    text.value = '';
    path.value = '';
    url.value = '';
    // AC8 — the operator is taken to the thing they just started, in this same
    // document: the run's feed opens on arrival and the first frame renders.
    // `target.id` is already in hand above (it is what the POST body's
    // `projectId` was built from), so this invents no data.
    await router.push({
      name: 'run-plan',
      params: { projectId: target.id, runId: created.runId },
    });
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

/**
 * `⌘/Ctrl+Enter`, from anywhere inside the form. One handler is enough now:
 * the Run button reaches the form by `form="DeFlow-composer-form"` but is
 * still a descendant of the page, not of a modal footer rendered as the
 * form's sibling — the reason KAR-24.8's version bound this twice is gone
 * along with `UiModal`.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
  event.preventDefault();
  void submit();
}
</script>

<template>
  <!--
    KAR-25.5 — a well-formed id naming no project on this machine (a stale
    bookmark, a project removed in another tab) gets a sentence and a way
    back, never a composer bar with an empty picker and nothing to submit
    against.
  -->
  <p
    v-if="projectsLoaded && project === null"
    class="composer-missing"
    data-composer-missing-project
  >
    No project with that id on this machine.
    <RouterLink :to="{ name: 'projects' }">Go to the project chooser</RouterLink>
  </p>

  <UiCard v-else variant="raised" class="composer">
    <form
      id="DeFlow-composer-form"
      class="composer__form"
      data-composer
      @submit.prevent="submit"
      @keydown="onKeydown"
    >
      <textarea
        :id="PROMPT_INPUT_ID"
        ref="promptBox"
        v-model="text"
        class="composer__prompt"
        data-composer-text
        rows="3"
        spellcheck="false"
        placeholder="Describe the change — or attach an issue and let the agent scope it."
      />

      <!--
        AC1 — the path the operator typed, sent as typed. Nothing here reads a
        file: `input.path` is resolved and contained by intake, which is the
        boundary that owns that check.
      -->
      <label v-if="shape === 'file'" class="composer__secondary composer__field">
        <UiSectionLabel as="span" class="composer__caption"
          >A file inside the project</UiSectionLabel
        >
        <input
          v-model="path"
          class="composer__control"
          data-composer-path
          type="text"
          autocomplete="off"
          spellcheck="false"
        >
      </label>

      <!--
        AC3, AC6 — the paste box is always here, and the list is *extra*. An
        operator with a URL in their clipboard is never worse off for having
        connected a service, including when the URL points somewhere that
        service cannot see.
      -->
      <div v-else-if="shape === 'issue'" class="composer__secondary">
        <label class="composer__field">
          <UiSectionLabel as="span" class="composer__caption">
            {{ connectedServices.length === 0 ? 'An issue reference' : 'Search issues, or paste a reference' }}
          </UiSectionLabel>
          <input
            v-model="url"
            class="composer__control"
            data-composer-url
            type="text"
            autocomplete="off"
            spellcheck="false"
          >
        </label>

        <ul v-if="issues.length > 0" class="composer__issues" data-composer-issues>
          <li v-for="issue in issues" :key="`${issue.service}:${issue.key}`">
            <button
              type="button"
              class="composer__issue"
              data-composer-issue
              :data-composer-issue-key="issue.key"
              :data-composer-issue-service="issue.service"
              @click="url = issue.url"
            >
              <span class="composer__issue-key">{{ issue.key }}</span>
              <span class="composer__issue-title">{{ issue.title }}</span>
              <span class="composer__issue-state">{{ issue.state }}</span>
              <!--
                KAR-22.6 AC3 — which tracker this came from. Rendered whenever
                there is more than one, because with one it is noise and with two
                it is the difference between picking and guessing.
              -->
              <span v-if="connectedServices.length > 1" class="composer__issue-service">
                {{ issue.serviceLabel }}
              </span>
            </button>
          </li>
        </ul>
      </div>

      <div class="composer__hairline" />

      <div class="composer__row">
        <!--
          KAR-25.5 — the source picker, left. `text | file | issue`, exactly the
          shapes `POST /api/runs` accepts — a compact chip group rather than the
          modal's pill row, but the same three `data-composer-shape` buttons.
        -->
        <div class="composer__source" role="group" aria-label="What this run is about">
          <button
            v-for="kind in SHAPES"
            :key="kind"
            type="button"
            class="composer__shape"
            :data-composer-shape="kind"
            :aria-pressed="shape === kind"
            @click="shape = kind"
          >
            <UiChip :variant="shape === kind ? 'accent' : 'neutral'">
              {{ kind === 'issue' ? issueShapeLabel : kind }}
            </UiChip>
          </button>
        </div>

        <div class="composer__actions">
          <!--
            AC2, AC4 — the adapter picker. Every row is the daemon's answer:
            whether it is available, by which route, why not, and what to run
            about it. Nothing on this list is computed in the browser.
            `force-mount` keeps the rows in the document even while the popover
            reads as closed, so a per-row disabled selectable control is always
            reachable rather than appearing only after an operator opens the
            trigger — the same shape the picker has always had, now inside a
            popover instead of always laid out on the page.
          -->
          <PopoverRoot>
            <PopoverTrigger as-child>
              <UiButton type="button" variant="ghost" size="sm" data-composer-provider-trigger>
                {{ chosen?.id ?? 'Choose adapter' }}
              </UiButton>
            </PopoverTrigger>
            <PopoverPortal :force-mount="true">
              <PopoverContent
                class="composer__providers-panel"
                align="end"
                :side-offset="6"
                :force-mount="true"
              >
                <UiCard variant="raised" class="composer__providers-card">
                  <fieldset class="composer__providers" data-composer-providers>
                    <legend class="composer__caption">
                      <UiSectionLabel as="span">Adapter</UiSectionLabel>
                    </legend>
                    <p v-if="providers.length === 0" class="composer__providers-empty">
                      This daemon has not been told which machine it is on, so it cannot say which
                      adapters are usable here. Start it with <code>deflow up</code>.
                    </p>
                    <template v-else>
                      <UiSectionLabel
                        v-if="usableProviders.length > 0"
                        as="p"
                        class="composer__providers-group"
                      >
                        Usable here
                      </UiSectionLabel>
                      <ul v-if="usableProviders.length > 0" class="composer__provider-rows">
                        <li
                          v-for="row in usableProviders"
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
                          <p v-if="row.limitation" class="composer__provider-limit">
                            {{ row.limitation }}
                          </p>
                          <p v-if="row.action" class="composer__provider-action">
                            <code>{{ row.action }}</code>
                          </p>
                        </li>
                      </ul>

                      <UiSectionLabel
                        v-if="unusableProviders.length > 0"
                        as="p"
                        class="composer__providers-group"
                      >
                        Not usable here
                      </UiSectionLabel>
                      <ul v-if="unusableProviders.length > 0" class="composer__provider-rows">
                        <li
                          v-for="row in unusableProviders"
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
                          <p v-if="row.limitation" class="composer__provider-limit">
                            {{ row.limitation }}
                          </p>
                          <p v-if="row.action" class="composer__provider-action">
                            <code>{{ row.action }}</code>
                          </p>
                        </li>
                      </ul>
                    </template>
                  </fieldset>
                </UiCard>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>

          <UiButton
            type="submit"
            form="DeFlow-composer-form"
            variant="primary"
            size="sm"
            data-composer-submit
            :disabled="submitting"
          >
            Run <span class="composer__chord" aria-hidden="true">⌘↵</span>
          </UiButton>
        </div>
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
  </UiCard>
</template>

<style scoped>
.composer {
  width: 100%;
}

.composer-missing {
  color: var(--ink-muted);
}

.composer__form {
  display: flex;
  flex-direction: column;
  gap: 12px; /* geometry — the bar's own section gap */
}

.composer__prompt {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  border: none;
  background: transparent;
  color: var(--ink);
  font-family: inherit;
  font-size: var(--text-lg);
  padding: 0;
  /* AC7 — no `outline: none` here: the repository-wide guard
     (test/ui-foundation.test.ts, checkNoFocusOutlineNone) forbids it, and the
     global `:focus-visible` rule (theme.css) already rings this element like
     every other. */
}

.composer__secondary {
  display: flex;
  flex-direction: column;
  gap: 10px; /* geometry — field-to-issue-list gap */
}

.composer__field {
  display: flex;
  flex-direction: column;
  gap: 6px; /* geometry — matches UiField's caption-to-control gap */
}

.composer__caption {
  display: block;
}

.composer__control {
  box-sizing: border-box;
  width: 100%;
  background: var(--surface-inset);
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  padding: 9px 11px; /* geometry — matches UiField's own input padding */
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--text-md);
}

.composer__hairline {
  border-top: 1px solid var(--edge);
}

.composer__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px; /* geometry — source-to-actions gutter */
}

.composer__source {
  display: flex;
  gap: 6px; /* geometry — the chip group's own gutter */
}

.composer__shape {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.composer__actions {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — adapter-trigger-to-run gutter */
}

.composer__chord {
  font-size: var(--text-xs);
  opacity: 0.8;
}

.composer__issues {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 3px; /* geometry — the issue list's own row gutter */
  max-height: 12rem;
  overflow: auto;
}

.composer__issue {
  display: flex;
  align-items: baseline;
  gap: 8px; /* geometry — the issue row's own gutter */
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 5px 8px; /* geometry — the issue row's own padding */
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  cursor: pointer;
}

.composer__issue:hover,
.composer__issue:focus-visible {
  border-color: var(--edge-control);
  background: var(--surface-inset);
}

.composer__issue-key {
  font-family: var(--font-mono);
  font-weight: 600;
  white-space: nowrap;
}

.composer__issue-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer__issue-state,
.composer__issue-service {
  color: var(--ink-faint);
  white-space: nowrap;
}

.composer__providers-panel {
  width: 22rem;
  max-width: min(22rem, 90vw);
  z-index: 20;
}

/*
 * `force-mount` keeps this content in the document at every popover state, so
 * the closed state has to actually look closed rather than sitting open on
 * the page underneath the trigger.
 */
.composer__providers-panel[data-state="closed"] {
  display: none;
}

.composer__providers-card {
  padding: 0;
  box-shadow: var(--shadow-modal);
  max-height: 24rem;
  overflow-y: auto;
}

.composer__providers {
  border: none;
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 11px 12px; /* geometry — matches UiPanel's own header padding */
  margin: 0;
}

.composer__providers-group {
  margin: 10px 0 4px; /* geometry — group-label-to-list gap */
}

.composer__provider-rows {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 10px; /* geometry — the provider list's own row gutter */
}

.composer__provider-head {
  display: flex;
  align-items: baseline;
  gap: 8px; /* geometry — radio-to-label gutter */
  cursor: pointer;
}

.composer__provider-id {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--ink);
}

.composer__provider-route {
  font-size: var(--text-sm);
  color: var(--ink-muted);
}

/* State is carried by words as well as by colour: the route, the reason and
   the command are always text, and the dimming is an extra cue rather than the
   only one. */
.composer__provider[data-provider-available="false"] {
  opacity: 0.6;
}

.composer__provider-reason,
.composer__provider-limit,
.composer__provider-action,
.composer__providers-empty {
  margin: 4px 0 0 20px; /* geometry — aligns under the radio's label text */
  font-size: var(--text-sm);
  color: var(--ink-muted);
}

.composer__error {
  margin: 0;
  color: var(--state-failed);
  white-space: pre-wrap;
  font-size: var(--text-sm);
}

.composer__refused {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ink-muted);
}
</style>
