<script setup lang="ts">
/**
 * KAR-25.3 — the *Providers & runtimes* panel: `../../views/SettingsView.vue`'s
 * top slot, filled. Blueprint: `docs/design/expected/EPIC-25/06-settings.png`,
 * top panel.
 *
 * **This file owns its own `UiPanel`**, unlike `./ConnectorsPanel.vue` (which
 * `SettingsView.vue` wraps in one). The blueprint puts Rescan in the panel
 * header's own action slot, and `UiPanel`'s `#action` is only reachable by
 * whoever renders the `<UiPanel>` tag — so the button and the state it
 * disables while a rescan is in flight have to live in the same file, and
 * that file has to be this one rather than the view above it.
 *
 * Verifies: EPIC-25-S14, EPIC-25-S15, EPIC-25-S16, EPIC-25-S20, EPIC-25-S21 ·
 * AC1, AC2, AC3, AC4, AC7, AC8
 *
 * ## Two producers, on purpose, exactly the way `../../../daemon/src/http/api.ts`
 * (its own "the first two rows look like one endpoint split in half" comment)
 * insists they stay
 *
 * `providersQuery(client)` — `GET /providers` — is the row: name, install
 * state, `enabled`, `source`, `binaryPath`. It is the **sanctioned, shared**
 * query (`../../api/queries.ts`), the same one `AppRail.vue`'s RUNTIMES glance
 * reads, so AC8 ("the rail and this panel never disagree") is a property of
 * both reading one Pinia-Colada cache entry rather than something this file
 * has to keep in step by hand.
 *
 * `GET /providers/routes` is fetched separately, deliberately outside Colada
 * (the same choice `../RunComposer.vue` already made for its picker): it is
 * the one place `providerVerdict`'s sentence and `action` — the install
 * command — actually live, and merging the two routes into one would be the
 * two-producers-one-endpoint hazard `api.ts` names by name. Toggling refetches
 * both, so the health line and the toggle state move together.
 *
 * ## `known: false` is a third state, not a synonym for "empty"
 *
 * `packages/daemon/src/main.ts` — what `pnpm dev` runs — boots with no
 * `providerRoots`, and `GET /providers/routes` answers that honestly:
 * `{ providers: [], known: false }`, never a row this file could read a
 * verdict off. `routesKnown` carries that bit; every row's health line
 * branches on it before falling back to anything, so a daemon that has not
 * been told which machine it is on renders as exactly that — not as "not
 * installed", which `GET /providers`' own `installed: false` would make a
 * false claim about a state nobody actually checked.
 *
 * ## What AC1 asks for that this row cannot carry
 *
 * *"the models it reports"* — nothing in DeFlow reports a model anywhere
 * (`live-chain.ts`'s `PROVIDER_DEFAULT_MODEL` is the literal string
 * `'provider-default'`, and `test/no-context-window-table.test.ts` forbids a
 * model/context table by name). No models column is rendered. *"its endpoint
 * or binary path"* — there is no endpoint concept in this build (adapters are
 * spawned children over stdio, not HTTP clients); the binary path is rendered,
 * from `GET /providers`' own `binaryPath` field. Both omissions are recorded
 * in KAR-25.3's own "amended after implementation" note in the epic file
 * rather than silently dropped.
 *
 * ## AC4 — detected, not added
 *
 * Every row `source` is `'detected'`: registering an endpoint-shaped runtime
 * ("add") is new adapter machinery — a runtime kind, a route kind, an HTTP
 * transport, a non-spawn probe — not a form plus a route, and KAR-25.3 defers
 * it to a story of its own (the epic file's amendment). So this panel offers
 * disable only, with the one-sentence reason AC4 asks for, and never a remove
 * control — there is nothing here that could ever be `source: 'added'`. The
 * field is still read off the wire rather than assumed, so the day "add"
 * ships, this file's branch is already the one that has to change.
 *
 * ## AC2 — single-flight is a client-side guard
 *
 * The daemon's own `runProviderDoctor` (`../../../daemon/src/providers/doctor.ts`)
 * joins a second caller into the probe already running, which stops the
 * daemon spawning a second set of children — but the *HTTP request* is still
 * made and still awaits the shared promise. `rescanning` is what stops the
 * second request from ever leaving this tab, which is EPIC-25-S15's literal
 * claim.
 *
 * ## AC7 — install command, no install button
 *
 * `route.action` is `providerVerdict().action` — the daemon's own sentence,
 * rendered **verbatim** with a copy control, never composed here. There is no
 * button anywhere on this row that would run it: `deflow doctor` and
 * `installCommand`'s `npm install -g` template both spawn a global package
 * manager, and a browser tab triggering that is a shell in a web page, which
 * the epic's own scope note rules out by name.
 */
import { useQuery } from '@pinia/colada';
import { computed, onMounted, ref } from 'vue';
import { useApiClient } from '../../api/provide.ts';
import { type ProviderRow, providersQuery } from '../../api/queries.ts';
import { UiButton, UiIconTile, UiPanel, UiToggle } from '../ui/index.ts';

/** One row of `GET /api/providers/routes` — the daemon's own health sentence
 *  and install command, matching `../RunComposer.vue`'s own `ProviderRow`. */
interface RouteRow {
  readonly id: string;
  readonly available: boolean;
  readonly reason: string;
  readonly action: string | null;
}

interface HttpAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

/** The three calls this panel makes, narrowed the way `../RunComposer.vue`'s
 *  own `ComposerApi` is. */
interface RuntimesApi {
  readonly providers: {
    readonly routes: { readonly $get: () => Promise<HttpAnswer> };
    readonly doctor: { readonly $post: () => Promise<HttpAnswer> };
    readonly ':provider': {
      readonly $patch: (
        args: { param: { provider: string } },
        init: { headers: Record<string, string>; init: { body: string } },
      ) => Promise<HttpAnswer>;
    };
  };
}

const client = useApiClient();
const api = client as never as RuntimesApi;

// AC8 — the shared, sanctioned query: this is the same cache entry
// `AppRail.vue`'s RUNTIMES glance reads.
const { data: providers, refetch: refetchProviders } = useQuery(providersQuery(client));

const routes = ref<readonly RouteRow[]>([]);
// KAR-25.3 AC1 — `GET /providers/routes`' own `known` field, not inferred from
// whether `routes` came back empty. `known: false` means this daemon booted
// with no `providerRoots` and has no honest basis for a per-row verdict at
// all (`../../../daemon/src/http/api.ts`'s own comment on the route) — it is
// not the same fact as "nothing is installed", and conflating the two is
// exactly the composed-in-the-browser claim this AC forbids.
const routesKnown = ref(true);

async function loadRoutes(): Promise<void> {
  const response = await api.providers.routes.$get();
  if (!response.ok) return;
  const body = (await response.json()) as { providers?: unknown; known?: unknown };
  routes.value = Array.isArray(body.providers) ? (body.providers as RouteRow[]) : [];
  routesKnown.value = body.known !== false;
}

onMounted(() => void loadRoutes());

const routeById = computed(() => new Map(routes.value.map((row) => [row.id, row])));

interface Row extends ProviderRow {
  readonly route: RouteRow | null;
}

const rows = computed<readonly Row[]>(() =>
  (providers.value ?? []).map((row) => ({
    ...row,
    route: routeById.value.get(row.provider) ?? null,
  })),
);

// AC2 — the client-side half of single-flight: the daemon's own doctor joins
// a second caller into the probe already running, but the request itself
// still leaves the tab unless this stops it (see header comment).
const rescanning = ref(false);
const rescanError = ref<string | null>(null);

async function rescan(): Promise<void> {
  if (rescanning.value) return;
  rescanning.value = true;
  rescanError.value = null;
  try {
    const response = await api.providers.doctor.$post();
    if (!response.ok) {
      rescanError.value = `the daemon refused to rescan with ${response.status}`;
      return;
    }
    // AC2 — re-render from the doctor's own result: the doctor writes the very
    // manifest rows `GET /providers` reads, so refetching the shared query is
    // "its result", not a second fact.
    await Promise.all([refetchProviders(), loadRoutes()]);
  } finally {
    rescanning.value = false;
  }
}

/** Providers this toggle request is in flight for — guards a double click on
 *  one row from firing two `PATCH`es. */
const toggling = ref<ReadonlySet<string>>(new Set());
const toggleError = ref<string | null>(null);

async function setEnabled(provider: string, enabled: boolean): Promise<void> {
  if (toggling.value.has(provider)) return;
  toggling.value = new Set([...toggling.value, provider]);
  toggleError.value = null;
  try {
    const response = await api.providers[':provider'].$patch(
      { param: { provider } },
      {
        headers: { 'content-type': 'application/json' },
        init: { body: JSON.stringify({ enabled }) },
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: unknown };
      } | null;
      toggleError.value =
        typeof body?.error?.message === 'string'
          ? body.error.message
          : `the daemon refused this change with ${response.status}`;
      return;
    }
    // AC3 — one fact, and every reader of it moves together: the picker's
    // `available`, admission's next decision and this row's own `enabled` are
    // all a re-read of the same settings table, so both requests below are
    // what makes "the picker and this page agree" true rather than assumed.
    await Promise.all([refetchProviders(), loadRoutes()]);
  } finally {
    const next = new Set([...toggling.value]);
    next.delete(provider);
    toggling.value = next;
  }
}

const copyStatus = ref<Record<string, string>>({});

async function copyInstallCommand(provider: string, command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    copyStatus.value = { ...copyStatus.value, [provider]: 'Copied.' };
  } catch (error) {
    copyStatus.value = {
      ...copyStatus.value,
      [provider]: `Could not copy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Two initials for the icon tile, matching `ConnectorsPanel.vue`'s own. */
function initials(id: string): string {
  return id.slice(0, 2).toUpperCase();
}
</script>

<template>
  <UiPanel title="Providers & runtimes" data-panel="providers">
    <template #action>
      <UiButton
        variant="secondary"
        size="sm"
        data-runtime-rescan
        :disabled="rescanning"
        @click="rescan"
      >
        {{ rescanning ? 'Rescanning…' : 'Rescan' }}
      </UiButton>
    </template>

    <div class="runtimes">
      <template v-if="providers && providers.length > 0">
        <ul class="runtimes__rows">
          <li
            v-for="row in rows"
            :key="row.provider"
            class="runtime"
            :data-runtime-row="row.provider"
            :data-runtime-source="row.source"
            :data-runtime-enabled="String(row.enabled)"
          >
            <div class="runtime__row">
              <UiIconTile size="md" class="runtime__tile">{{ initials(row.provider) }}</UiIconTile>

              <div class="runtime__heading">
                <h3 class="runtime__name">{{ row.provider }}</h3>
                <!-- AC1 — the binary path this daemon would spawn, or an
                     honest dash: there is no endpoint concept to fall back to
                     (see header comment). -->
                <p class="runtime__detail">{{ row.binaryPath ?? '—' }}</p>
                <!-- AC1 — the daemon's own health sentence, verbatim, from the
                     route reducer's own verdict (`providerVerdict().detail`).
                     Nothing here composes, shortens or colours a word of it —
                     the dot is the only presentation this file adds, and it
                     is derived from the same `available` boolean the sentence
                     itself explains, never a second fact. -->
                <p
                  v-if="row.route"
                  class="runtime__health"
                  :data-runtime-available="row.route.available"
                >
                  <span class="runtime__health-dot" aria-hidden="true" />
                  {{ row.route.reason }}
                </p>
                <!-- AC1 — `known: false` (`../../../daemon/src/http/api.ts`'s
                     `GET /providers/routes`): this daemon was never told which
                     machine it is on, so it has no basis for a verdict on any
                     row, and saying "not installed" here would be inventing
                     an answer the daemon itself refuses to give. This is the
                     one sentence on the panel that names a *client* fact (no
                     route report reached this tab) rather than paraphrasing a
                     daemon one, which is why it is worded as an absence of
                     information rather than as a health verdict. -->
                <p
                  v-else-if="!routesKnown"
                  class="runtime__health"
                  data-runtime-available="unknown"
                  data-runtime-routes-unknown
                >
                  <span class="runtime__health-dot" aria-hidden="true" />
                  This daemon started without knowing this machine's PATH, so it cannot say whether
                  {{ row.provider }}
                  is installed or usable.
                </p>
              </div>

              <!-- AC1 — "enabled"/"disabled" are UI chrome, not a composed
                   health verdict: `row.enabled` is the daemon's own field
                   (`GET /providers`), and `UiToggle`'s `aria-checked` binds to
                   it directly — an assistive-tech user already gets the real
                   state from that, per WCAG 2.5.3. This label just gives the
                   same fact a visible word, the same choice
                   `SettingsView.vue`'s "Disable auto-compaction" toggle makes
                   for its own boolean, and the words themselves carry no fact
                   the daemon did not already supply as a boolean. -->
              <UiToggle
                :model-value="row.enabled"
                :label="row.enabled ? 'enabled' : 'disabled'"
                data-runtime-toggle
                :disabled="toggling.has(row.provider)"
                @update:model-value="(value) => setEnabled(row.provider, value)"
              />
            </div>

            <!-- AC4 — detected cannot be removed. There is no remove control
                 on this row at all (see header comment), and this is the one
                 sentence saying why. -->
            <p v-if="row.source === 'detected'" class="runtime__note" data-runtime-cannot-remove>
              Detected on this machine — DeFlow can disable it here but not remove it. Removing a
              runtime DeFlow can still see installed would misreport what is actually on this
              machine.
            </p>

            <!-- AC7 — the install command, verbatim, with a copy control and
                 no button that would run it. -->
            <div
              v-if="!row.installed && row.route?.action"
              class="runtime__install"
              data-runtime-install
            >
              <code class="runtime__command">{{ row.route.action }}</code>
              <UiButton
                variant="ghost"
                size="sm"
                data-runtime-copy-install
                @click="copyInstallCommand(row.provider, row.route.action)"
              >
                Copy
              </UiButton>
              <span v-if="copyStatus[row.provider]" class="runtime__copy-status" aria-live="polite">
                {{ copyStatus[row.provider] }}
              </span>
            </div>
          </li>
        </ul>

        <p v-if="toggleError" class="runtimes__error" role="alert">{{ toggleError }}</p>
        <p v-if="rescanError" class="runtimes__error" role="alert">{{ rescanError }}</p>
      </template>

      <p v-else class="runtimes__empty">No runtimes reported by this machine.</p>
    </div>
  </UiPanel>
</template>

<style scoped>
.runtimes {
  display: flex;
  flex-direction: column;
  gap: 4px; /* geometry — row-to-row rhythm */
}

.runtimes__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}

.runtime {
  display: grid;
  gap: 6px; /* geometry — row's own internal stack gap */
  padding: 12px 0; /* geometry — matches ConnectorsPanel's own row padding */
  border-bottom: 1px solid var(--edge);
}

.runtime:last-child {
  border-bottom: none;
}

.runtime__row {
  display: flex;
  align-items: flex-start;
  gap: 10px; /* geometry — tile-to-heading gutter */
}

.runtime__tile {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
}

.runtime__heading {
  flex: 1;
  min-width: 0;
}

.runtime__name {
  font-size: var(--text-md);
  font-weight: 600;
  margin: 0;
}

.runtime__detail {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
  margin: 2px 0 0; /* geometry — name-to-detail gap */
}

.runtime__health {
  display: flex;
  align-items: baseline;
  gap: 6px; /* geometry — dot-to-sentence gutter */
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 4px 0 0; /* geometry — detail-to-health gap */
  max-width: 60ch;
}

.runtime__health-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--state-blocked);
  transform: translateY(-1px); /* geometry — optical alignment with the first line */
}

.runtime__health[data-runtime-available="true"] .runtime__health-dot {
  background: var(--state-passed);
}

.runtime__note {
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 0;
  max-width: 70ch;
}

.runtime__install {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — command-to-button gutter */
  flex-wrap: wrap;
}

.runtime__command {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-inset);
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-xs);
  padding: 3px 6px; /* geometry — inline code chip padding */
}

.runtime__copy-status {
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.runtimes__error {
  color: var(--state-failed);
  font-size: var(--text-sm);
  margin: 4px 0 0; /* geometry — rows-to-error gap */
}

.runtimes__empty {
  color: var(--ink-muted);
  font-size: var(--text-base);
  margin: 0;
}
</style>
