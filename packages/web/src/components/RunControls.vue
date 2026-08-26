<script setup lang="ts">
/**
 * KAR-27.7 — pause, resume and stop, on the run surface.
 *
 * Verifies: EPIC-27-S34, EPIC-27-S35, EPIC-27-S36, EPIC-27-S37 · AC1–AC5
 *
 * The endpoints have existed since KAR-15.5 and, until this component, nothing
 * on any frame surface called them: on 2026-08-25 the owner asked for the
 * control three times in one session, and every stop performed that day was
 * performed from a shell, against a hand-copied secret. KAR-19.6's own guard —
 * `test/no-curl-to-stop-a-run.test.ts` — says a capability reachable only that
 * way is not a capability, which is why this paragraph does not spell it out.
 *
 * ## What it decides, which is nothing
 *
 * Which controls exist and whether each is enabled is `../lib/run-controls.ts`,
 * and that module asks the daemon's own `planRunControl`. What request each one
 * makes is `../api/run-control.ts`. What this file adds is the three things
 * that are genuinely a component's: the buttons, the confirmation in front of
 * the irreversible one, and the in-flight guard that stops a double-press being
 * two requests.
 *
 * ## `status` is a prop, and that is the point (AC2)
 *
 * The state on screen comes from the ledger, so this component holds no fold of
 * its own and — critically — does **not** move to `paused` because a `POST`
 * returned `200`. It re-renders when the run's projection says `run.paused`
 * arrived, which is the same moment the run list, `deflow status` and another
 * operator's tab move. An optimistic flip would be this surface claiming a
 * state the drive has not reached, which is exactly the class of lie the
 * ledger-first rule exists to prevent.
 *
 * ## Why the confirmation is a modal and pause has none (AC4)
 *
 * Stop is not reversible and its cost — a truncated transcript — is invisible
 * at the moment of pressing, so it is a `UiModal`: Reka's focus trap, `Esc` and
 * focus return come with it (docs/12 §9.3), which is most of AC5 for free.
 * Pause is reversible by the button that replaces it, and a dialog in front of
 * a reversible action is a dialog people learn to dismiss without reading.
 */
import type { RunStatus } from '@DeFlow/core';
import { computed, ref, watch } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { sendRunControl } from '../api/run-control.ts';
import {
  cooperativeStopHint,
  type RunControlAction,
  type RunControlOffer,
  runControlOffers,
  STOP_CONFIRMATION,
} from '../lib/run-controls.ts';
import { UiButton, UiModal } from './ui/index.ts';

const props = defineProps<{
  readonly runId: string;
  /**
   * The run's status as the ledger reduced it, or `null` before anything is
   * known. Required-and-nullable rather than optional for the reason
   * `./RunHeader.vue`'s own props are: `null` is the honest value for "nothing
   * has told us yet", and it is a value rather than an absence.
   */
  readonly status: RunStatus | null;
}>();

const api = useApiClient();

const offers = computed<readonly RunControlOffer[]>(() => runControlOffers(props.status));
/** Only the ones with something to say — a reason line per refused control. */
const refusedOffers = computed(() => offers.value.filter((offer) => offer.reason !== null));

/** The action in flight, so a double-press cannot send a second request. */
const sending = ref<RunControlAction | null>(null);
/** The daemon's own sentence when it refused, never a paraphrase of one. */
const error = ref<string | null>(null);
/** Whether the stop confirmation is open. Nothing is sent while it is. */
const confirming = ref(false);

// A different run is a different question, and a refusal about the last one
// says nothing about this one.
watch(
  () => props.runId,
  () => {
    sending.value = null;
    error.value = null;
    confirming.value = false;
  },
);

function press(offer: RunControlOffer): void {
  if (!offer.enabled || sending.value !== null) return;
  if (offer.action === 'stop') {
    confirming.value = true;
    return;
  }
  void send(offer.action);
}

function confirmStop(): void {
  confirming.value = false;
  void send('stop');
}

async function send(action: RunControlAction): Promise<void> {
  sending.value = action;
  error.value = null;
  try {
    const outcome = await sendRunControl(api, props.runId, action);
    if (outcome.ok) return;
    error.value = outcome.message;
  } catch (thrown) {
    error.value = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    sending.value = null;
  }
}

/** The id of a control's reason line, so the button can point at it. */
const reasonId = (action: RunControlAction): string => `run-control-reason-${action}`;
</script>

<template>
  <div
    v-if="offers.length > 0"
    class="run-controls"
    data-run-controls
    role="group"
    aria-label="Run controls"
  >
    <div class="run-controls__row">
      <UiButton
        v-for="offer in offers"
        :key="offer.action"
        :variant="offer.action === 'stop' ? 'danger' : 'secondary'"
        :data-run-control="offer.action"
        :aria-label="offer.name"
        :aria-describedby="offer.reason === null ? undefined : reasonId(offer.action)"
        :disabled="!offer.enabled || sending !== null"
        @click="press(offer)"
      >
        {{ offer.label }}
      </UiButton>
    </div>

    <!--
      AC3 — the dimmed button is the extra cue and the sentence is the carrier
      (docs/12 §9.2). The words are the daemon's own refusal, so what an
      operator reads before pressing is what they would have read after.
    -->
    <p
      v-for="offer in refusedOffers"
      :id="reasonId(offer.action)"
      :key="`why-${offer.action}`"
      class="run-controls__why"
      :data-run-control-reason="offer.action"
    >
      {{ offer.reason }}
    </p>

    <!-- AC2 — a refusal is shown, never swallowed. -->
    <p v-if="error" class="run-controls__error" data-run-control-error role="alert">{{ error }}</p>

    <UiModal :open="confirming" :title="STOP_CONFIRMATION.title" @close="confirming = false">
      <div data-run-control-confirm>
        <p class="run-controls__warning">{{ STOP_CONFIRMATION.warning }}</p>
        <p class="run-controls__warning">{{ STOP_CONFIRMATION.irreversible }}</p>
        <p class="run-controls__hint">{{ cooperativeStopHint(runId) }}</p>
      </div>
      <template #footer>
        <UiButton size="md" data-run-control-confirm-cancel @click="confirming = false"
          >{{ STOP_CONFIRMATION.cancelLabel }}</UiButton
        >
        <UiButton variant="danger" size="md" data-run-control-confirm-accept @click="confirmStop"
          >{{ STOP_CONFIRMATION.confirmLabel }}</UiButton
        >
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.run-controls {
  display: grid;
  gap: 6px; /* geometry — the row-to-reason gap */
  min-width: 0;
}

.run-controls__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px; /* geometry — button-to-button gutter */
}

/* Always a sentence: the dimmed button is an extra cue, never the carrier. */
.run-controls__why {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}

.run-controls__error {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--state-failed);
  overflow-wrap: anywhere;
}

.run-controls__warning {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ink);
}

.run-controls__hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}
</style>
