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
 * Everything else follows `ProjectsView.vue`'s discipline: the view decides
 * nothing, hides nothing, and renders the sentence it was given.
 *
 * Verifies: EPIC-22-S48, EPIC-22-S54, EPIC-22-S68 · AC1, AC2, AC5
 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { MAIN_CONTENT_ID } from '../app/ids.ts';

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
    readonly revoke: { readonly command: string; readonly affects: string };
  };
  readonly authorisation: {
    readonly command: string;
    readonly url: string;
    readonly whyNotOneClick: string;
  };
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
const removed = ref<{ readonly command: string; readonly affects: string } | null>(null);
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
      revoke: { command: string; affects: string };
    };
    // AC5 — the operator's own revocation command, in the daemon's words. This
    // page never runs it: that credential is shared with every other tool on
    // the machine, and signing them all out is not DeFlow's decision to make.
    removed.value = body.revoke;
  }
  await load();
}

onMounted(() => void load());
</script>

<template>
  <main :id="MAIN_CONTENT_ID" class="connectors" data-connectors>
    <header class="connectors__head">
      <h1 class="connectors__title">Connectors</h1>
      <RouterLink :to="{ name: 'project-workspace', params: { projectId } }">
        Back to the project
      </RouterLink>
    </header>

    <p class="connectors__lede">
      A connector lets this project’s composer offer real issues to pick from. Nothing here is
      required: pasting an issue reference works with no connector at all.
    </p>

    <p v-if="error" class="connectors__error" role="alert">{{ error }}</p>

    <p v-if="removed" class="connectors__removed" data-connector-removed>
      DeFlow will no longer use this service for this project. Your credential was not touched — it
      is yours. To revoke it, run <code>{{ removed.command }}</code>. {{ removed.affects }}
    </p>

    <ul class="connectors__rows">
      <li
        v-for="service in services"
        :key="service.id"
        class="connector"
        :data-connector-row="service.id"
        :data-connector-state="service.state.state"
        :data-connector-connected="String(service.connected)"
      >
        <div class="connector__head">
          <h2 class="connector__label">{{ service.label }}</h2>
          <span class="connector__state">{{ service.state.state }}</span>
          <span v-if="service.state.account" class="connector__account">
            {{ service.state.account }}
          </span>
        </div>

        <!-- The daemon's sentence, rendered as it arrived (AC1, AC4). -->
        <p class="connector__message">{{ service.state.message }}</p>
        <p v-if="service.state.scopes.length > 0" class="connector__scopes">
          Granted scopes: {{ service.state.scopes.join(', ') }}
        </p>
        <p v-if="service.state.action" class="connector__action">
          <code>{{ service.state.action }}</code>
        </p>

        <!--
          AC1's amendment, on the screen rather than only in the epic file: the
          command, the service's own authorisation page, and the reason there is
          no single button.
        -->
        <section class="connector__authorise">
          <p class="connector__why">{{ service.authorisation.whyNotOneClick }}</p>
          <p class="connector__command"><code>{{ service.authorisation.command }}</code></p>
          <a
            class="connector__link"
            data-connector-authorise
            :href="service.authorisation.url"
            rel="noreferrer noopener"
            target="_blank"
          >
            Open {{ service.label }}’s own authorisation page
          </a>
        </section>

        <!-- AC1, AC2 — where the token lives and who holds it, in the daemon's words. -->
        <dl class="connector__credential">
          <dt>Authorised by</dt>
          <dd>{{ service.credential.authorisedBy }}</dd>
          <dt>Held by</dt>
          <dd>{{ service.credential.holder }}</dd>
          <dt>Stored in</dt>
          <dd>{{ service.credential.livesIn }}</dd>
          <dt>What DeFlow keeps</dt>
          <dd>{{ service.credential.deflowStores }}</dd>
        </dl>

        <div class="connector__actions">
          <button
            v-if="!service.connected"
            type="button"
            data-connector-connect
            @click="connect(service.id)"
          >
            Use {{ service.label }} for this project
          </button>
          <button v-else type="button" data-connector-remove @click="remove(service.id)">
            Stop using {{ service.label }} here
          </button>
          <span v-if="service.connectedAt" class="connector__since">
            in use since {{ service.connectedAt }}
          </span>
        </div>
      </li>
    </ul>

    <p v-if="services.length === 0" class="connectors__empty">
      This build registers no connector services.
    </p>
  </main>
</template>

<style scoped>
.connectors {
  padding: 1rem 1.2rem 2rem;
  display: grid;
  gap: 0.8rem;
}

.connectors__head {
  display: flex;
  align-items: baseline;
  gap: 0.8rem;
}

.connectors__title {
  font-size: 1.1rem;
  margin: 0;
}

.connectors__lede,
.connectors__removed,
.connectors__error,
.connectors__empty {
  margin: 0;
  max-width: 60ch;
}

.connectors__error {
  color: var(--ink-danger, var(--ink-warn, inherit));
}

.connectors__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.9rem;
}

.connector {
  border: 1px solid var(--edge, rgb(0 0 0 / 15%));
  border-radius: 0.5rem;
  padding: 0.7rem 0.9rem;
  display: grid;
  gap: 0.4rem;
}

.connector__head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.connector__label {
  font-size: 1rem;
  margin: 0;
}

/* State is carried by the word as well as by any styling: `not-authorised` and
   `missing-scope` are different problems and must not read as one colour. */
.connector__state {
  font-size: 0.8em;
  border: 1px solid currentcolor;
  border-radius: 999px;
  padding: 0 0.5em;
}

.connector__message,
.connector__scopes,
.connector__action,
.connector__why,
.connector__command {
  margin: 0;
  max-width: 70ch;
}

.connector__scopes,
.connector__since {
  font-size: 0.85em;
  opacity: 0.8;
}

.connector__authorise {
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem 0.6rem;
  border-left: 3px solid var(--edge, rgb(0 0 0 / 20%));
}

.connector__credential {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.15rem 0.7rem;
  margin: 0;
  font-size: 0.85em;
}

.connector__credential dt {
  font-weight: 600;
}

.connector__credential dd {
  margin: 0;
  max-width: 70ch;
}

.connector__actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
</style>
