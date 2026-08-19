<script setup lang="ts">
/**
 * KAR-25.2 — `/settings`, filled in: one global page, and the way back home.
 *
 * Verifies: EPIC-25-S08, EPIC-25-S09, EPIC-25-S10, EPIC-25-S11 · AC1, AC2, AC3
 *
 * **It takes no props, reads no `projectId`.** No `defineProps`, no
 * `useRoute()` anywhere in this file — AC1 and EPIC-25-S09 both turn on that,
 * and the two panels this story does not own (*Providers & runtimes*, *Issue
 * tracker*) are real `UiPanel`s with real titles and an
 * `UiEmptyState` body naming the story that fills them, never a styled mock.
 *
 * ## *Execution defaults* has no workspace to be default to
 *
 * `GET /api/config` is workspace-scoped: it takes `?cwd=`, and the daemon
 * checks that value against the repositories it already holds a run for
 * (`packages/daemon/src/http/api.ts`'s `workspaceRoot`). There is no
 * machine-wide config document. A page that never reads `projectId` therefore
 * has no `cwd` handed to it by the route, and *Execution defaults* cannot ask
 * "which file" without being told.
 *
 * The fix is not to smuggle the route's `projectId` in through a side door —
 * that would make this page's rendering depend on whether a project happens
 * to be open, which is exactly what AC1 and EPIC-25-S08 (“the same three
 * panels render, with the same values” whether or not a project is open)
 * forbid. Instead the panel holds its **own** selection, sourced from
 * `GET /api/projects` — a request with no project segment in its path, so
 * EPIC-25-S09's rule about the requests this view makes still holds — and
 * starts every mount with nothing chosen. That is what makes the two halves
 * of S08 true at once: the panel's rendering is a function of a picker inside
 * it, not of the route, so it renders identically whichever route got you
 * here. Mirrors the precedent KAR-25.4 AC6 sets for the *Issue tracker*
 * panel: name the workspace being edited, offer an explicit picker, and
 * render an explanatory empty state — not a disabled form — when none is
 * chosen.
 *
 * The picker is a plain `<select>`, not a `ui/` primitive: the library has no
 * select control (fifteen primitives, and `UiField` is a text input), and
 * `RunComposer.vue`'s own project picker is the same plain `<select>` for the
 * same reason — reported rather than smuggled in as a sixteenth component.
 *
 * ## What renders, and why only that
 *
 * Every field in `06-settings.png`'s *Execution defaults* — Temperature, Max
 * steps per node, Parallel nodes, Token budget per run, Require approval
 * before writes — has no home in `DeFlowConfigSchema`
 * (`packages/core/src/deflow-config.ts`). None of the five is rendered (AC3).
 * What renders instead is exactly what the schema and the response hold:
 * `context.inlineThresholdBytes`, `budget.run`/`budget.node`'s ceilings,
 * and, per provider id present in `config.providers`, `pinReinjectTurns`,
 * `autocompactPct` and `disableAutoCompact`. `constraints` and
 * `policy.patch.rules` are structured documents with no scalar edit path, so
 * they render as read-only counts (`UiMetaRow`), not as a control that would
 * pretend to edit a rule table one field at a time.
 *
 * **A field absent from this response renders no control at all** — not a
 * blank or disabled one (EPIC-25-S10). That includes a per-provider field
 * this particular provider's entry happens not to set: `claude` having
 * `pinReinjectTurns` and no `autocompactPct` renders one `UiField`, not two.
 * Rendering the second, blank, would be a soft form of inventing a value the
 * file never gave.
 *
 * ## The write
 *
 * `PATCH /api/config?cwd=` merges **shallowly at the top level**
 * (`{...loadWorkspaceConfig(cwd), ...body}`): a body key you send replaces
 * that whole top-level value, and a key you omit is left as the server had
 * it. So every submit here rebuilds the *one* top-level key it is changing —
 * `providers`, `context` or `budget` — from the last `GET`, with the edited
 * leaf spliced in, and sends nothing else. `submitProviderField` sending
 * `{ providers: { claude: { pinReinjectTurns: 9 } } }` alone would delete
 * every sibling provider and every sibling field under `claude`; it instead
 * sends the whole `providers` record, all of it read from `doc.value`.
 *
 * A rejected patch changes nothing on disk and comes back with the daemon's
 * own words: `error.message`, plus zod's own `error.detail.reason` on the
 * `schema_violation` path. `writeError` renders exactly that, the way
 * `RunComposer.vue`'s `refusalOf()` renders a run refusal (EPIC-25-S11). The
 * body goes through `init` rather than a typed `json` slot: `/config`'s PATCH
 * reads it with `c.req.json()` and no validator, so `hc<ApiType>` infers no
 * JSON input for it — the same gap `packages/cli/src/run/cancel.ts` reports
 * for `/runs/:id/cancel`, not a second protocol invented here.
 *
 * A successful patch calls the sanctioned query's own `refetch()` rather than
 * patching local state from the response: the GET this view already trusts
 * is the one source of "what is on disk", and re-reading it after a write
 * that just changed the disk is that same trust, not a second one.
 */
import { useQuery } from '@pinia/colada';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { configQuery } from '../api/queries.ts';
import { MAIN_CONTENT_ID } from '../app/ids.ts';
import {
  UiEmptyState,
  UiField,
  UiMetaRow,
  UiMeter,
  UiPanel,
  UiSectionLabel,
  UiToggle,
} from '../components/ui/index.ts';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

interface HttpAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

/**
 * The two calls this view makes beyond the sanctioned `configQuery` —
 * narrowed the way `ConnectorsView.vue`'s `ConnectorsApi` and
 * `RunComposer.vue`'s `ComposerApi` are, so a caller reads the shape it
 * actually uses rather than the whole of `hc<ApiType>`.
 */
interface SettingsApi {
  readonly projects: { readonly $get: () => Promise<HttpAnswer> };
  readonly config: {
    readonly $patch: (
      args: { query: { cwd: string } },
      init: { headers: Record<string, string>; init: { body: string } },
    ) => Promise<HttpAnswer>;
  };
}

const client = useApiClient();
const api = client as never as SettingsApi;

const projects = ref<readonly ProjectRow[]>([]);

async function loadProjects(): Promise<void> {
  try {
    const response = await api.projects.$get();
    if (!response.ok) return;
    projects.value = ((await response.json()) as { projects: ProjectRow[] }).projects;
  } catch {
    // `ProjectSwitcher.vue`'s own rationale: this panel still renders — with
    // an empty picker — rather than taking the page down over a daemon that
    // is mid-restart.
  }
}

onMounted(() => void loadProjects());

/** The chosen workspace's `cwd`. Empty means nothing is chosen yet — the
 *  page's own starting state, on every mount, regardless of route. */
const cwd = ref('');

const {
  data: doc,
  error: readError,
  refetch,
} = useQuery(() => ({ ...configQuery(client, cwd.value), enabled: cwd.value !== '' }));

/** A record when `value` is a plain object, `null` otherwise — the guard
 *  every nested read below goes through, because `config` arrives as
 *  `Record<string, unknown>` off a `z.looseObject` and nothing past the top
 *  level is typed. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' ? value : null;
}

function boolAt(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

const config = computed(() => doc.value?.config ?? null);
const isEmptyConfig = computed(
  () => config.value === null || Object.keys(config.value).length === 0,
);

const contextObj = computed(() => asRecord(config.value?.['context']));
const budgetObj = computed(() => asRecord(config.value?.['budget']));
const budgetRunObj = computed(() => asRecord(budgetObj.value?.['run'] ?? null));
const budgetNodeObj = computed(() => asRecord(budgetObj.value?.['node'] ?? null));
const providersObj = computed(() => asRecord(config.value?.['providers']) ?? {});
const providerIds = computed(() => Object.keys(providersObj.value));

const inlineThresholdBytes = computed(() => numberAt(contextObj.value, 'inlineThresholdBytes'));
const runCostUsd = computed(() => numberAt(budgetRunObj.value, 'costUsd'));
const runWallclockMs = computed(() => numberAt(budgetRunObj.value, 'wallclockMs'));
const nodeCostUsd = computed(() => numberAt(budgetNodeObj.value, 'costUsd'));
const nodeWallclockMs = computed(() => numberAt(budgetNodeObj.value, 'wallclockMs'));

function providerRecord(id: string): Record<string, unknown> | null {
  return asRecord(providersObj.value[id]);
}
function providerPinReinjectTurns(id: string): number | null {
  return numberAt(providerRecord(id), 'pinReinjectTurns');
}
function providerAutocompactPct(id: string): number | null {
  return numberAt(providerRecord(id), 'autocompactPct');
}
function providerDisableAutoCompact(id: string): boolean | null {
  return boolAt(providerRecord(id), 'disableAutoCompact');
}

const constraintsCount = computed(() => {
  const value = config.value?.['constraints'];
  return Array.isArray(value) ? value.length : null;
});
const patchRulesCount = computed(() => {
  const rules = asRecord(config.value?.['policy'])?.['patch'];
  const table = asRecord(rules)?.['rules'];
  return Array.isArray(table) ? table.length : null;
});

/** The editable strings every `UiField` binds to — `UiField`'s `modelValue`
 *  is a `string`, so every number below is round-tripped through one.
 *  Reseeded from the server whenever the loaded document changes, including
 *  right after a successful write's own `refetch()`. */
const draft = reactive({
  inlineThresholdBytes: '',
  runCostUsd: '',
  runWallclockMs: '',
  nodeCostUsd: '',
  nodeWallclockMs: '',
});
const providerDraft = reactive<
  Record<string, { pinReinjectTurns: string; autocompactPct: string }>
>({});

watch(
  doc,
  () => {
    draft.inlineThresholdBytes = inlineThresholdBytes.value?.toString() ?? '';
    draft.runCostUsd = runCostUsd.value?.toString() ?? '';
    draft.runWallclockMs = runWallclockMs.value?.toString() ?? '';
    draft.nodeCostUsd = nodeCostUsd.value?.toString() ?? '';
    draft.nodeWallclockMs = nodeWallclockMs.value?.toString() ?? '';

    for (const key of Object.keys(providerDraft)) delete providerDraft[key];
    for (const id of providerIds.value) {
      providerDraft[id] = {
        pinReinjectTurns: providerPinReinjectTurns(id)?.toString() ?? '',
        autocompactPct: providerAutocompactPct(id)?.toString() ?? '',
      };
    }
  },
  { immediate: true },
);

const writeError = ref<string | null>(null);

/**
 * One top-level key of the config document, replaced wholesale — the shallow
 * merge this route performs means anything not sent here is left as the
 * server already had it (see the header comment).
 */
async function patchTopLevel(key: string, value: unknown): Promise<void> {
  if (cwd.value === '') return;
  writeError.value = null;

  const response = await api.config.$patch(
    { query: { cwd: cwd.value } },
    {
      headers: { 'content-type': 'application/json' },
      init: { body: JSON.stringify({ [key]: value }) },
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown; detail?: { reason?: unknown } };
    } | null;
    const message =
      typeof body?.error?.message === 'string'
        ? body.error.message
        : `the daemon refused this change with ${response.status}`;
    const reason =
      typeof body?.error?.detail?.reason === 'string' ? body.error.detail.reason : null;
    writeError.value = reason === null ? message : `${message}: ${reason}`;
    return;
  }

  await refetch();
}

async function submitContext(): Promise<void> {
  const parsed = Number(draft.inlineThresholdBytes);
  if (!Number.isFinite(parsed)) {
    writeError.value = 'Inline threshold (bytes) has to be a number.';
    return;
  }
  await patchTopLevel('context', { ...contextObj.value, inlineThresholdBytes: parsed });
}

async function submitBudget(
  scope: 'run' | 'node',
  field: 'costUsd' | 'wallclockMs',
): Promise<void> {
  const raw =
    scope === 'run'
      ? field === 'costUsd'
        ? draft.runCostUsd
        : draft.runWallclockMs
      : field === 'costUsd'
        ? draft.nodeCostUsd
        : draft.nodeWallclockMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    writeError.value = 'That ceiling has to be a number.';
    return;
  }
  const currentScope = scope === 'run' ? budgetRunObj.value : budgetNodeObj.value;
  await patchTopLevel('budget', {
    ...budgetObj.value,
    [scope]: { ...currentScope, [field]: parsed },
  });
}

async function submitProviderField(
  id: string,
  field: 'pinReinjectTurns' | 'autocompactPct',
): Promise<void> {
  const raw = providerDraft[id]?.[field] ?? '';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    writeError.value = 'That value has to be a number.';
    return;
  }
  await patchTopLevel('providers', {
    ...providersObj.value,
    [id]: { ...providerRecord(id), [field]: parsed },
  });
}

async function submitProviderToggle(id: string, value: boolean): Promise<void> {
  await patchTopLevel('providers', {
    ...providersObj.value,
    [id]: { ...providerRecord(id), disableAutoCompact: value },
  });
}
</script>

<template>
  <main :id="MAIN_CONTENT_ID" class="settings" data-settings>
    <header class="settings__head">
      <h1 class="settings__title">Settings</h1>
      <p class="settings__subtitle">Everything here applies to this machine, not to one project.</p>
    </header>

    <!-- KAR-25.3's panel. A real title, an honest empty body: see the header
         comment and `UiEmptyState`'s own docblock for why this never reads as
         a styled stand-in for the finished panel. -->
    <UiPanel title="Providers & runtimes" data-panel="providers">
      <UiEmptyState
        title="No runtimes listed yet"
        hint="This panel is filled by KAR-25.3, which reads GET /api/providers."
      />
    </UiPanel>

    <div class="settings__row">
      <!-- KAR-25.4's panel. -->
      <UiPanel title="Issue tracker" data-panel="issue-tracker">
        <UiEmptyState
          title="No connectors here yet"
          hint="This panel is filled by KAR-25.4, which moves the connectors screen into settings."
        />
      </UiPanel>

      <UiPanel title="Execution defaults" data-panel="execution-defaults">
        <p class="settings__panel-note">
          Applied to new nodes unless overridden. These are one workspace's
          <code>.DeFlow/config.yaml</code>
          values, not a machine default.
        </p>

        <label class="settings__picker">
          <UiSectionLabel as="span">workspace</UiSectionLabel>
          <select v-model="cwd" class="settings__control" data-settings-workspace>
            <option value="">Choose a workspace…</option>
            <option v-for="project in projects" :key="project.id" :value="project.path">
              {{ project.name }}
              — {{ project.path }}
            </option>
          </select>
        </label>

        <UiEmptyState
          v-if="cwd === ''"
          title="No workspace chosen"
          hint="Pick a project above to see its .DeFlow/config.yaml."
        />
        <p v-else-if="readError" class="settings__error" data-config-error>
          This workspace's config could not be read: {{ readError.message }}
        </p>
        <UiEmptyState
          v-else-if="doc && isEmptyConfig"
          title="No .DeFlow/config.yaml values"
          :hint="`${doc.cwd} has no config file, or an empty one — every value DeFlow uses here is its own default.`"
        />
        <template v-else-if="doc">
          <div class="settings__groups">
            <section v-if="inlineThresholdBytes !== null" class="settings__group">
              <UiSectionLabel as="h3">Context</UiSectionLabel>
              <UiField
                data-field="context.inlineThresholdBytes"
                label="Inline threshold (bytes)"
                mono
                v-model="draft.inlineThresholdBytes"
                @focusout="submitContext"
                @keydown.enter="submitContext"
              />
            </section>

            <section v-if="runCostUsd !== null || runWallclockMs !== null" class="settings__group">
              <UiSectionLabel as="h3">Budget — run</UiSectionLabel>
              <UiField
                v-if="runCostUsd !== null"
                data-field="budget.run.costUsd"
                label="Run cost ceiling (USD)"
                mono
                v-model="draft.runCostUsd"
                @focusout="submitBudget('run', 'costUsd')"
                @keydown.enter="submitBudget('run', 'costUsd')"
              />
              <UiField
                v-if="runWallclockMs !== null"
                data-field="budget.run.wallclockMs"
                label="Run wallclock ceiling (ms)"
                mono
                v-model="draft.runWallclockMs"
                @focusout="submitBudget('run', 'wallclockMs')"
                @keydown.enter="submitBudget('run', 'wallclockMs')"
              />
            </section>

            <section
              v-if="nodeCostUsd !== null || nodeWallclockMs !== null"
              class="settings__group"
            >
              <UiSectionLabel as="h3">Budget — node</UiSectionLabel>
              <UiField
                v-if="nodeCostUsd !== null"
                data-field="budget.node.costUsd"
                label="Node cost ceiling (USD)"
                mono
                v-model="draft.nodeCostUsd"
                @focusout="submitBudget('node', 'costUsd')"
                @keydown.enter="submitBudget('node', 'costUsd')"
              />
              <UiField
                v-if="nodeWallclockMs !== null"
                data-field="budget.node.wallclockMs"
                label="Node wallclock ceiling (ms)"
                mono
                v-model="draft.nodeWallclockMs"
                @focusout="submitBudget('node', 'wallclockMs')"
                @keydown.enter="submitBudget('node', 'wallclockMs')"
              />
            </section>

            <section
              v-for="id in providerIds"
              :key="id"
              class="settings__group"
              :data-provider-group="id"
            >
              <UiSectionLabel as="h3">{{ id }}</UiSectionLabel>
              <UiField
                v-if="providerPinReinjectTurns(id) !== null"
                :data-field="`providers.${id}.pinReinjectTurns`"
                label="Pin reinject turns"
                mono
                v-model="providerDraft[id]!.pinReinjectTurns"
                @focusout="submitProviderField(id, 'pinReinjectTurns')"
                @keydown.enter="submitProviderField(id, 'pinReinjectTurns')"
              />
              <div v-if="providerAutocompactPct(id) !== null" class="settings__meter-row">
                <UiField
                  :data-field="`providers.${id}.autocompactPct`"
                  label="Autocompaction threshold (%)"
                  mono
                  v-model="providerDraft[id]!.autocompactPct"
                  @focusout="submitProviderField(id, 'autocompactPct')"
                  @keydown.enter="submitProviderField(id, 'autocompactPct')"
                />
                <!-- Displays the server's last-confirmed value, not the
                     in-progress draft: the field edits, the meter reflects
                     what is actually on disk (see UiMeter's own docblock —
                     it is `role="progressbar"`, not a slider). -->
                <UiMeter
                  :pct="providerAutocompactPct(id) ?? 0"
                  :ariaLabel="`${id}’s autocompaction threshold`"
                />
              </div>
              <UiToggle
                v-if="providerDisableAutoCompact(id) !== null"
                :data-field="`providers.${id}.disableAutoCompact`"
                label="Disable auto-compaction"
                :model-value="providerDisableAutoCompact(id) ?? false"
                @update:model-value="(value) => submitProviderToggle(id, value)"
              />
            </section>
          </div>

          <UiMetaRow
            v-if="constraintsCount !== null"
            label="Constraints"
            :value="`${constraintsCount} declared`"
            :mono="false"
          />
          <UiMetaRow
            v-if="patchRulesCount !== null"
            label="Patch rules"
            :value="`${patchRulesCount} rules`"
            :mono="false"
          />
        </template>

        <p v-if="writeError" class="settings__error" data-config-error>{{ writeError }}</p>
      </UiPanel>
    </div>
  </main>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px; /* geometry — the page's own panel rhythm */
  padding: 16px; /* geometry — matches ProjectsView's own page padding */
}

.settings__head {
  display: flex;
  flex-direction: column;
  gap: 4px; /* geometry — title-to-subtitle gap */
}

.settings__title {
  font-size: var(--text-xl);
  margin: 0;
}

.settings__subtitle {
  font-size: var(--text-base);
  color: var(--ink-muted);
  margin: 0;
}

.settings__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px; /* geometry — matches the page's own rhythm */
}

/* The same 820px breakpoint `AppRail.vue` and `AppTopBar.vue` already pair
   on for the rail/topbar-nav swap, reused rather than a third number. */
@media (max-width: 820px) {
  .settings__row {
    grid-template-columns: 1fr;
  }
}

.settings__panel-note {
  font-size: var(--text-base);
  color: var(--ink-muted);
  margin: 0 0 12px; /* geometry — note-to-picker gap */
}

.settings__panel-note code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.settings__picker {
  display: flex;
  flex-direction: column;
  gap: 6px; /* geometry — matches UiField's own caption-to-control gap */
  margin: 0 0 14px; /* geometry — picker-to-body gap */
}

.settings__control {
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

.settings__groups {
  display: flex;
  flex-direction: column;
  gap: 16px; /* geometry — the gap between Context / Budget / provider groups */
}

.settings__group {
  display: flex;
  flex-direction: column;
  gap: 10px; /* geometry — label-to-fields, field-to-field gap */
}

.settings__meter-row {
  display: flex;
  flex-direction: column;
  gap: 6px; /* geometry — field-to-meter gap */
}

.settings__error {
  color: var(--state-failed);
  font-size: var(--text-sm);
  margin: 12px 0 0; /* geometry — body-to-refusal gap */
}
</style>
