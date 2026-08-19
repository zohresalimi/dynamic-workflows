<script setup lang="ts">
/**
 * KAR-25.4 — the *Issue tracker* panel, filled: `../../views/SettingsView.vue`'s
 * "Issue tracker" slot, moved off `/projects/:projectId/connectors`
 * (`../../views/ConnectorsView.vue`, now deleted) and onto `/settings`.
 *
 * Verifies: EPIC-25-S22 … EPIC-25-S29 · AC1–AC7
 *
 * ## The defect, and the fix that is not a daemon fix
 *
 * The owner's screenshot showed one row reading `not-installed`, offering
 * "Disconnect", and saying "in use since 2026-08-18…" — three claims that
 * contradict each other. `../../lib/connector-status.ts`'s own header comment
 * has the full account; the short version is that the daemon reports two
 * independent facts (the CLI's live state on this machine, and whether *this
 * project* has a row binding it to the service) and the old screen painted
 * them as one. `resolveConnectorStatus()` is the one place they are folded
 * into a single status word and a single permitted action, and this file's
 * only job is to render exactly that — never `service.state.state` and
 * `service.connected` side by side again (AC1).
 *
 * ## The move creates a question KAR-22.4 never had to answer: which project?
 *
 * `GET /api/projects/:id/connectors` — the only route that returns a
 * service's credential and authorisation prose — takes a project id, and
 * `/settings` is global (KAR-25.2 AC1): it never reads one. So this panel
 * holds its **own** project picker, starting unchosen on every mount, for the
 * same reason `SettingsView.vue`'s own *Execution defaults* panel does (see
 * that file's header comment) — the page's rendering must not depend on
 * whether a project happened to be open on the route that led here.
 *
 * That picker chooses which project a Connect or Disconnect click *binds*.
 * It is deliberately a second concept from "which project's rows are shown
 * right now": `credential` and `authorisation` are properties of the
 * *service* (GitHub, Jira, Linear), not of any one project's binding, and
 * `state` is a fact about this machine's CLI — probed with a project's
 * `repoPath` as its working directory, but not meaningfully different from
 * one project to the next for the same CLI on the same machine. So even with
 * no project explicitly chosen for binding, this panel still shows every
 * service's facts (EPIC-25-S28) — sourced from whichever project the list
 * happens to have first, purely as a place to run the probe from. What it
 * does **not** do without an explicit choice is trust that project's
 * `connected` / `connectedAt` as if they answered "is *the* project bound":
 * `effectiveProjectId` decides which project's rows to fetch, but `bound`
 * below is forced to `false` — and every action to `'none'` — until
 * `selectedProjectId` is something the operator actually picked (AC6). A
 * Connect button wired to a project nobody chose would bind the wrong one the
 * moment two projects exist.
 */
import { computed, ref, watch } from 'vue';
import { useApiClient } from '../../api/provide.ts';
import { type ConnectorAction, resolveConnectorStatus } from '../../lib/connector-status.ts';
import {
  UiButton,
  UiChip,
  UiEmptyState,
  UiIconTile,
  UiMetaRow,
  UiSectionLabel,
} from '../ui/index.ts';

interface ProjectOption {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

const props = defineProps<{
  readonly projects: readonly ProjectOption[];
}>();

interface ConnectorState {
  readonly state: string;
  readonly account: string | null;
  readonly scopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly message: string;
  readonly action: string | null;
}

interface ConnectorRow {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly connectedAt: string | null;
  readonly state: ConnectorState;
  readonly credential: {
    readonly authorisedBy: string;
    readonly holder: string;
    readonly livesIn: string;
    readonly deflowStores: string;
    readonly revoke: { readonly command: string | null; readonly affects: string };
  };
  readonly authorisation:
    | {
        readonly kind: 'command';
        readonly command: string;
        readonly url: string | null;
        readonly whyNotOneClick: string;
      }
    | { readonly kind: 'unavailable'; readonly whyNotConnectable: string };
}

interface Answer {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

/** The three calls this panel makes, named the way `ConnectorsView.vue`'s own
 *  `ConnectorsApi` was — see that file's history for the pattern. */
interface IssueTrackerApi {
  readonly projects: {
    readonly ':id': {
      readonly connectors: {
        readonly $get: (args: { param: { id: string } }) => Promise<Answer>;
        readonly ':service': {
          readonly $post: (args: { param: { id: string; service: string } }) => Promise<Answer>;
          readonly $delete: (args: { param: { id: string; service: string } }) => Promise<Answer>;
        };
      };
    };
  };
}

const api = useApiClient() as never as IssueTrackerApi;

/** The binding target. Empty means nothing is chosen yet — the panel's own
 *  starting state on every mount, regardless of route (see header comment). */
const selectedProjectId = ref('');
const services = ref<readonly ConnectorRow[]>([]);
const removed = ref<{ readonly command: string | null; readonly affects: string } | null>(null);
const error = ref<string | null>(null);

/**
 * Guards `load()` against a stale response. `effectiveProjectId` can change
 * twice before either `GET` resolves — the picker moving A -> B while A's
 * request is still in flight — and with no guard the *later-arriving*
 * response wins regardless of which project it was for, so a slow response
 * for A can land after B's fast one and overwrite `services.value` with A's
 * `connected`/`connectedAt`. `resolvedFor()`'s `bound` and the "in use
 * since" line both trust `service.connected` once a project is selected, so
 * that would render A's binding under B: the exact contradiction this panel
 * exists to remove (header comment), reintroduced as a race.
 *
 * A request token, bumped on every call and compared when the response
 * comes back, is the smallest fix that closes it: `load()` is the only
 * writer of `services.value`, so refusing to write from any call that is no
 * longer the latest one is sufficient — there is no second place a stale
 * project's data could enter. Carrying the loaded-for id alongside
 * `services.value` and gating `bound` on it would also work, but it is a
 * second field to keep in sync everywhere `services.value` is read, for the
 * same guarantee this one counter already gives at the single place that
 * writes it.
 */
let loadToken = 0;

/** Which project's rows this panel is currently showing: the operator's own
 *  choice if they made one, otherwise the first project on the list, purely
 *  so a service's credential facts have somewhere to be read from. Never used
 *  to infer a binding — see the header comment. */
const effectiveProjectId = computed<string | null>(() =>
  selectedProjectId.value !== '' ? selectedProjectId.value : (props.projects[0]?.id ?? null),
);

async function load(id: string): Promise<void> {
  const token = ++loadToken;
  error.value = null;
  const response = await api.projects[':id'].connectors.$get({ param: { id } });
  // A newer `load()` has since started — this response belongs to a project
  // the picker has already moved past. Neither `services.value` nor
  // `error.value` may be written from it (see the field's own comment).
  if (token !== loadToken) return;
  if (!response.ok) {
    error.value = 'This project’s connectors could not be read.';
    services.value = [];
    return;
  }
  // `Array.isArray` rather than trusting the response's declared shape: a
  // preview fetch runs against whichever project happens to be first, on
  // every mount, so a malformed or unexpected body must degrade to "nothing
  // to show" rather than crash the whole settings page over one panel.
  const body = (await response.json()) as { services?: unknown };
  // Checked a second time: reading the body is its own suspension point, so a
  // newer `load()` can start between the check above and this line. The window
  // is a body parse rather than a round trip, which is narrower but not empty —
  // and a guard that holds for the wide case and not the narrow one is the kind
  // that looks correct in review and fails in the field.
  if (token !== loadToken) return;
  services.value = Array.isArray(body.services) ? (body.services as ConnectorRow[]) : [];
}

watch(
  effectiveProjectId,
  (id) => {
    if (id === null) {
      services.value = [];
      return;
    }
    void load(id);
  },
  { immediate: true },
);

async function connect(serviceId: string): Promise<void> {
  // AC6 — no action this panel offers ever fires without an explicit choice,
  // whatever a caller passes: the template already hides the button, this is
  // the second guard for the same rule.
  if (selectedProjectId.value === '') return;
  removed.value = null;
  error.value = null;
  await api.projects[':id'].connectors[':service'].$post({
    param: { id: selectedProjectId.value, service: serviceId },
  });
  await load(selectedProjectId.value);
}

async function remove(serviceId: string): Promise<void> {
  if (selectedProjectId.value === '') return;
  error.value = null;
  const response = await api.projects[':id'].connectors[':service'].$delete({
    param: { id: selectedProjectId.value, service: serviceId },
  });
  if (response.ok) {
    const body = (await response.json()) as {
      revoke: { command: string | null; affects: string };
    };
    removed.value = body.revoke;
  }
  await load(selectedProjectId.value);
}

/**
 * `service`'s one resolved status and one permitted action (AC1). `bound` is
 * the row's `connected` fact **only** when the operator explicitly chose the
 * project it came from — never the preview project's own binding, which
 * would answer a question about the wrong project (header comment).
 */
function resolvedFor(service: ConnectorRow): {
  readonly status: string;
  readonly action: ConnectorAction;
} {
  const bound = selectedProjectId.value !== '' && service.connected;
  return resolveConnectorStatus({
    connected: bound,
    state: service.state,
    authorisation: service.authorisation,
  });
}

/** Up to two initials for the icon tile, matching `ProjectsView.vue`'s cards. */
function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0], words[words.length - 1]] : [label];
  return letters
    .map((word) => word?.[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** The chip's tone — presentation only, derived from the resolved status
 *  rather than a new fact (`ConnectorsView.vue`'s own `connectorTone()`). */
function tone(service: ConnectorRow): 'ok' | 'warn' | 'neutral' {
  const resolved = resolvedFor(service);
  if (resolved.status === 'cannot be connected') return 'neutral';
  if (resolved.status === 'connected') return 'ok';
  if (resolved.status === 'available') return 'neutral';
  return 'warn';
}

function tint(service: ConnectorRow): string {
  const t = tone(service);
  if (t === 'ok') return 'color-mix(in oklab, var(--state-passed) 22%, var(--surface-control))';
  if (t === 'warn') return 'color-mix(in oklab, var(--state-blocked) 22%, var(--surface-control))';
  return 'var(--surface-control)';
}
</script>

<template>
  <div class="issue-tracker" data-issue-tracker>
    <label class="issue-tracker__picker">
      <UiSectionLabel as="span">project</UiSectionLabel>
      <select v-model="selectedProjectId" class="issue-tracker__control" data-issue-tracker-project>
        <option value="">Choose a project to bind…</option>
        <option v-for="project in projects" :key="project.id" :value="project.id">
          {{ project.name }}
          — {{ project.path }}
        </option>
      </select>
    </label>

    <!-- AC6, EPIC-25-S28 — the per-project fact this global page cannot make
         up on its own. Rows still render below (facts, not bindings). -->
    <p v-if="selectedProjectId === ''" class="issue-tracker__note" data-issue-tracker-no-project>
      Binding a service to a project needs a project chosen above — these facts are the same for
      every project, but connecting or disconnecting is not, so it stays off until one is picked.
    </p>

    <p v-if="error" class="issue-tracker__error" role="alert">{{ error }}</p>

    <p v-if="removed" class="issue-tracker__removed" data-connector-removed>
      DeFlow will no longer use this service for this project. Your credential was not touched — it
      is yours.
      <template v-if="removed.command">
        To revoke it, run <code>{{ removed.command }}</code>.
      </template>
      {{ removed.affects }}
    </p>

    <UiEmptyState
      v-if="projects.length === 0"
      title="No projects yet"
      hint="Connectors bind per project. Create a project first, then come back here to connect its issue tracker."
    />

    <ul v-else-if="services.length > 0" class="issue-tracker__rows">
      <li
        v-for="service in services"
        :key="service.id"
        class="connector"
        :data-connector-row="service.id"
        :data-connector-state="service.state.state"
        :data-connector-connected="String(service.connected)"
        :data-connector-status="resolvedFor(service).status"
        :data-connector-action="selectedProjectId === '' ? 'none' : resolvedFor(service).action"
      >
        <div class="connector__row">
          <UiIconTile size="md" :tint="tint(service)" class="connector__tile">
            {{ initials(service.label) }}
          </UiIconTile>

          <div class="connector__heading">
            <div class="connector__heading-top">
              <h3 class="connector__label">{{ service.label }}</h3>
              <!-- AC1 — one resolved status word, never state and binding
                   rendered as two separate claims. -->
              <UiChip :variant="tone(service)" mono>{{ resolvedFor(service).status }}</UiChip>
              <span v-if="service.state.account" class="connector__account">
                {{ service.state.account }}
              </span>
            </div>
            <!-- The daemon's own sentence, rendered as it arrived. -->
            <p class="connector__detail">{{ service.state.message }}</p>
          </div>

          <div class="connector__actions">
            <UiButton
              v-if="selectedProjectId !== '' && resolvedFor(service).action === 'connect'"
              variant="primary"
              size="sm"
              data-connector-connect
              @click="connect(service.id)"
            >
              Connect
            </UiButton>
            <UiButton
              v-else-if="selectedProjectId !== '' && resolvedFor(service).action === 'disconnect'"
              variant="secondary"
              size="sm"
              data-connector-remove
              @click="remove(service.id)"
            >
              Disconnect
            </UiButton>
            <!-- AC2 — no "in use since" line without an explicit, bound
                 project: the preview project's own timestamp is not this
                 panel's to show until the operator chose it. -->
            <span
              v-if="selectedProjectId !== '' && service.connected && service.connectedAt"
              class="connector__since"
            >
              in use since {{ service.connectedAt }}
            </span>
          </div>
        </div>

        <p v-if="service.state.scopes.length > 0" class="connector__scopes">
          Granted scopes: {{ service.state.scopes.join(', ') }}
        </p>
        <p v-if="service.state.action" class="connector__action">
          <code>{{ service.state.action }}</code>
        </p>

        <!-- KAR-22.6 AC2, unchanged by the move: a service with no
             authorisation route gets its paragraph and no button and no
             link. -->
        <section
          v-if="service.authorisation.kind === 'command'"
          class="connector__authorise"
          data-connector-authorisation="command"
        >
          <p class="connector__why">{{ service.authorisation.whyNotOneClick }}</p>
          <p class="connector__command"><code>{{ service.authorisation.command }}</code></p>
          <a
            v-if="service.authorisation.url"
            class="connector__link"
            data-connector-authorise
            :href="service.authorisation.url"
            rel="noreferrer noopener"
            target="_blank"
          >
            Open {{ service.label }}’s own authorisation page
          </a>
        </section>
        <section v-else class="connector__authorise" data-connector-authorisation="unavailable">
          <p class="connector__why">{{ service.authorisation.whyNotConnectable }}</p>
        </section>

        <!-- KAR-22.4 AC1, AC2 — where the token lives and who holds it, in
             the daemon's own words, unchanged by the move. -->
        <div class="connector__credential">
          <UiMetaRow label="Authorised by" :value="service.credential.authorisedBy" :mono="false" />
          <UiMetaRow label="Held by" :value="service.credential.holder" :mono="false" />
          <UiMetaRow label="Stored in" :value="service.credential.livesIn" :mono="false" />
          <UiMetaRow label="DeFlow keeps" :value="service.credential.deflowStores" :mono="false" />
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.issue-tracker {
  display: grid;
  gap: 10px; /* geometry — picker-to-note-to-rows stack gap */
}

.issue-tracker__picker {
  display: flex;
  flex-direction: column;
  gap: 6px; /* geometry — matches SettingsView's own picker */
}

.issue-tracker__control {
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

.issue-tracker__note {
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 0;
  max-width: 60ch;
}

.issue-tracker__error {
  color: var(--state-failed);
  margin: 0;
}

.issue-tracker__removed {
  color: var(--ink-muted);
  font-size: var(--text-sm);
  margin: 0;
  max-width: 60ch;
}

.issue-tracker__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}

.connector {
  display: grid;
  gap: 8px; /* geometry — the row's own internal stack gap */
  padding: 12px 0; /* geometry — matches UiMetaRow's own row padding, minus its own side padding */
  border-bottom: 1px solid var(--edge);
}

.connector:last-child {
  border-bottom: none;
}

.connector__row {
  display: flex;
  align-items: flex-start;
  gap: 10px; /* geometry — tile-to-heading gutter */
}

.connector__tile {
  margin-top: 1px; /* geometry — optical alignment with the name's cap-height */
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
}

.connector__heading {
  flex: 1;
  min-width: 0;
}

.connector__heading-top {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — name-to-chip gutter */
}

.connector__label {
  font-size: var(--text-md);
  font-weight: 600;
  margin: 0;
}

.connector__account {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.connector__detail {
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 3px 0 0; /* geometry — name-to-detail gap */
  max-width: 70ch;
}

.connector__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — button-to-timestamp gutter */
}

.connector__since {
  font-size: var(--text-xs);
  color: var(--ink-faint);
  white-space: nowrap;
}

.connector__scopes,
.connector__action {
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 0;
  max-width: 70ch;
}

.connector__authorise {
  display: grid;
  gap: 4px; /* geometry — the authorisation block's own stack gap */
  padding: 8px 10px; /* geometry — the authorisation block's own padding */
  border-left: 2px solid var(--edge-strong);
  font-size: var(--text-sm);
}

.connector__why,
.connector__command {
  margin: 0;
  max-width: 70ch;
  color: var(--ink-muted);
}

.connector__link {
  color: var(--state-running);
  font-size: var(--text-sm);
}

.connector__credential {
  border-top: 1px solid var(--edge);
}
</style>
