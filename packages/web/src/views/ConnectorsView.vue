<script setup lang="ts">
/**
 * KAR-22.4 — the connectors screen.
 *
 * **This screen has no token field, and that is its most important property.**
 * DeFlow has no registered OAuth application with GitHub, so it cannot own a
 * one-click authorisation button. The tempting way to fill that gap is a box
 * that says "paste a personal access token", and the moment one exists DeFlow
 * holds a credential and ADR-0003 is over. There is no `<input>` on this page
 * at all; `connectors.test.ts` asserts that over the whole screen rather than
 * over the row, because the box would arrive somewhere nobody was looking.
 *
 * What replaces it is the truth, rendered: whose application authorises, where
 * the token lives, who holds it, what DeFlow stores, and — in words — why
 * connecting takes one command rather than one button. All five sentences come
 * from the daemon's service descriptor, so this file composes none of them;
 * a page that wrote its own paragraph about ADR-0003 would be a second
 * description of one decision, free to drift from the first.
 *
 * ## KAR-22.6 — the row that has nothing to offer
 *
 * A third service arrived that DeFlow **cannot connect at all**: Linear
 * publishes no first-party tool that would hold the credential, so connecting
 * it would mean DeFlow holding one. The rendering failure that would undo the
 * daemon's honest refusal is a button on that row — the page can offer the
 * click even when the route refuses it, and an operator who clicks and gets a
 * 422 reads a bug rather than a decision. So `authorisation.kind` decides what
 * a row shows: a service with no route gets its paragraph and **no button and
 * no link**, and `connectors.test.ts` asserts both absences.
 *
 * The authorisation link is likewise conditional on there being a URL. `acli`'s
 * `--web` login opens Atlassian's own page and DeFlow is not in that
 * conversation, so it does not know the address — and a link it guessed would
 * be a 404 rendered as a promise.
 *
 * ## KAR-24.8 AC2 — the "Issue tracker" panel treatment
 *
 * Direction A draws its issue-tracker binding as one raised panel holding a
 * row per service: a tinted `UiIconTile`, the service's name, a detail line
 * and an action button labelled with the state a click would move the row to
 * — never a bare "Toggle" (EPIC-24-S31). That structure replaces this file's
 * bespoke `<ul>`/`<dl>` markup below, but nothing it renders changes: every
 * sentence, every `data-connector-*` hook and the no-button/no-link rule
 * KAR-22.6 depends on are unchanged, because `connectors.test.ts` still reads
 * this screen the same way and its behavioural assertions are a fixed point
 * this restyle does not get to move.
 *
 * `connectorTone()` and `connectorTint()` below are presentation only, in the
 * same spirit as `ProjectsView.vue`'s `healthTone()`: they turn a state the
 * daemon already sent into which token paints the row, and invent no new
 * fact. The credential facts (authorised by / held by / stored in / what
 * DeFlow keeps) move into `UiMetaRow`, the library's own label/value row,
 * rather than a hand-built `<dl>`.
 *
 * Everything else follows `ProjectsView.vue`'s discipline: the view decides
 * nothing, hides nothing, and renders the sentence it was given.
 *
 * Verifies: EPIC-22-S48, EPIC-22-S54, EPIC-22-S68, EPIC-22-S70 · KAR-22.4 AC1,
 * AC2, AC5 · KAR-22.6 AC1, AC2 · KAR-24.8 AC2, AC4
 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { MAIN_CONTENT_ID } from '../app/ids.ts';
import {
  UiButton,
  UiChip,
  UiEmptyState,
  UiIconTile,
  UiMetaRow,
  UiPanel,
} from '../components/ui/index.ts';

const props = defineProps<{ projectId: string }>();

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
        /** `null` when DeFlow does not know the address of the page the command opens. */
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

/**
 * The three calls this screen makes, named — the seam `ProjectsView.vue` and
 * `RunComposer.vue` both draw, so the `hc<ApiType>` casts are one readable
 * statement rather than a `never` at each call site.
 */
interface ConnectorsApi {
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

const api = useApiClient() as never as ConnectorsApi;

const services = ref<readonly ConnectorRow[]>([]);
/** What a removal said it did — and did not do. Cleared by the next action. */
const removed = ref<{ readonly command: string | null; readonly affects: string } | null>(null);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  const response = await api.projects[':id'].connectors.$get({ param: { id: props.projectId } });
  if (!response.ok) {
    error.value = 'This project’s connectors could not be read.';
    return;
  }
  services.value = ((await response.json()) as { services: ConnectorRow[] }).services;
}

async function connect(service: string): Promise<void> {
  removed.value = null;
  error.value = null;
  // The response carries the state that follows, but the screen re-reads rather
  // than patching one row from it: `connected` and the *live* state are two
  // different facts, and a page that inferred the second from the first would
  // show "connected" to somebody who has not run `gh auth login` yet.
  await api.projects[':id'].connectors[':service'].$post({
    param: { id: props.projectId, service },
  });
  await load();
}

async function remove(service: string): Promise<void> {
  error.value = null;
  const response = await api.projects[':id'].connectors[':service'].$delete({
    param: { id: props.projectId, service },
  });
  if (response.ok) {
    const body = (await response.json()) as {
      revoke: { command: string | null; affects: string };
    };
    // AC5 — the operator's own revocation command, in the daemon's words. This
    // page never runs it: that credential is shared with every other tool on
    // the machine, and signing them all out is not DeFlow's decision to make.
    removed.value = body.revoke;
  }
  await load();
}

/**
 * KAR-24.8 AC2 — which token paints a row's tile and state chip, derived from
 * facts the daemon already sent rather than a new one. A service DeFlow
 * cannot reach at all (`authorisation.kind === 'unavailable'`) is neutral
 * rather than a warning: there is nothing an operator can do about it, so
 * colouring it like an actionable problem would be a false urgency the
 * daemon never claimed.
 */
function connectorTone(service: ConnectorRow): 'ok' | 'warn' | 'neutral' {
  if (service.authorisation.kind === 'unavailable') return 'neutral';
  return service.connected ? 'ok' : 'warn';
}

/** The icon tile's tint, one `--state-*` token mixed onto the control surface. */
function connectorTint(service: ConnectorRow): string {
  const tone = connectorTone(service);
  if (tone === 'ok') return 'color-mix(in oklab, var(--state-passed) 22%, var(--surface-control))';
  if (tone === 'warn')
    return 'color-mix(in oklab, var(--state-blocked) 22%, var(--surface-control))';
  return 'var(--surface-control)';
}

/** Up to two initials for the icon tile, the way `ProjectsView.vue`'s cards do it. */
function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0], words[words.length - 1]] : [label];
  return letters
    .map((word) => word?.[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

onMounted(() => void load());
</script>

<template>
  <main :id="MAIN_CONTENT_ID" class="connectors" data-connectors>
    <header class="connectors__head">
      <div>
        <h1 class="connectors__title">Connectors</h1>
        <p class="connectors__lede">
          A connector lets this project’s composer offer real issues to pick from. Nothing here is
          required: pasting an issue reference works with no connector at all.
        </p>
      </div>
      <RouterLink
        class="connectors__back"
        :to="{ name: 'project-workspace', params: { projectId } }"
      >
        Back to the project
      </RouterLink>
    </header>

    <p v-if="error" class="connectors__error" role="alert">{{ error }}</p>

    <p v-if="removed" class="connectors__removed" data-connector-removed>
      DeFlow will no longer use this service for this project. Your credential was not touched — it
      is yours.
      <template v-if="removed.command">
        To revoke it, run <code>{{ removed.command }}</code>.
      </template>
      {{ removed.affects }}
    </p>

    <!-- KAR-24.8 AC2 — one UiPanel, one row per connector. -->
    <UiPanel title="Connectors" class="connectors__panel">
      <UiEmptyState
        v-if="services.length === 0"
        title="No connector services registered"
        hint="This build ships with none configured. Pasting an issue reference still works with no connector at all."
        class="connectors__empty"
      />

      <ul v-else class="connectors__rows">
        <li
          v-for="service in services"
          :key="service.id"
          class="connector"
          :data-connector-row="service.id"
          :data-connector-state="service.state.state"
          :data-connector-connected="String(service.connected)"
        >
          <div class="connector__row">
            <UiIconTile size="md" :tint="connectorTint(service)" class="connector__tile">
              {{ initials(service.label) }}
            </UiIconTile>

            <div class="connector__heading">
              <div class="connector__heading-top">
                <h2 class="connector__label">{{ service.label }}</h2>
                <UiChip :variant="connectorTone(service)" mono>{{ service.state.state }}</UiChip>
                <span v-if="service.state.account" class="connector__account">
                  {{ service.state.account }}
                </span>
              </div>
              <!-- The daemon's sentence, rendered as it arrived (AC1, AC4). -->
              <p class="connector__detail">{{ service.state.message }}</p>
            </div>

            <div class="connector__actions">
              <!--
                KAR-24.8 AC2 — the button's label is the state it will move the
                row to, never a bare "Toggle". KAR-22.6 AC2 stays intact: no
                button at all on a service DeFlow cannot reach.
              -->
              <UiButton
                v-if="!service.connected && service.authorisation.kind === 'command'"
                variant="primary"
                size="sm"
                data-connector-connect
                @click="connect(service.id)"
              >
                Connect
              </UiButton>
              <UiButton
                v-else-if="service.connected"
                variant="secondary"
                size="sm"
                data-connector-remove
                @click="remove(service.id)"
              >
                Disconnect
              </UiButton>
              <span v-if="service.connectedAt" class="connector__since">
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

          <!--
            KAR-22.4 AC1's amendment, on the screen rather than only in the epic
            file: the command, the service's own authorisation page, and the
            reason there is no single button.

            KAR-22.6 AC2's other half sits in the `v-else`: a service DeFlow
            cannot connect says so here, in the place the command would have
            been, and offers nothing to press.
          -->
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

          <!-- AC1, AC2 — where the token lives and who holds it, in the daemon's words. -->
          <div class="connector__credential">
            <UiMetaRow
              label="Authorised by"
              :value="service.credential.authorisedBy"
              :mono="false"
            />
            <UiMetaRow label="Held by" :value="service.credential.holder" :mono="false" />
            <UiMetaRow label="Stored in" :value="service.credential.livesIn" :mono="false" />
            <UiMetaRow
              label="DeFlow keeps"
              :value="service.credential.deflowStores"
              :mono="false"
            />
          </div>
        </li>
      </ul>
    </UiPanel>
  </main>
</template>

<style scoped>
.connectors {
  padding: 16px; /* geometry — matches ProjectsView's own page padding */
  display: grid;
  gap: 16px; /* geometry — header-to-panel gap */
}

.connectors__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px; /* geometry — matches ProjectsView's header gutter */
}

.connectors__title {
  font-size: var(--text-2xl);
  margin: 0;
}

.connectors__lede {
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 5px 0 0; /* geometry — title-to-lede gap */
  max-width: 60ch;
}

.connectors__back {
  flex: none;
  font-size: var(--text-base);
  color: var(--ink-muted);
}

.connectors__back:hover {
  color: var(--ink);
}

.connectors__error {
  color: var(--state-failed);
  margin: 0;
}

.connectors__removed {
  color: var(--ink-muted);
  font-size: var(--text-sm);
  margin: 0;
  max-width: 60ch;
}

.connectors__empty {
  margin: 14px; /* geometry — matches the panel's own row padding */
}

.connectors__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.connector {
  display: grid;
  gap: 8px; /* geometry — the row's own internal stack gap */
  padding: 12px 14px; /* geometry — matches UiMetaRow's own row padding */
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
