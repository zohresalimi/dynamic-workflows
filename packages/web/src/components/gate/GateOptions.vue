<script setup lang="ts">
/**
 * KAR-25.7 — `RunGateBanner.vue`'s answer path, extracted for two more
 * surfaces (`../frame/ApprovalsMenu.vue`, `../NodeInspector.vue`).
 *
 * `RunGateBanner`'s own header comment names four responsibilities; this file
 * is responsibilities 2 and 3 — offering every option the daemon offered, in
 * its words, and answering through the one path (`answerGate` →
 * `gateAnswerRequest`) — carved out so three surfaces stop being one file
 * copied twice. Responsibilities 1 (the prompt) and 4 (nothing about whether
 * the gate is still open) stay with each caller: the prompt is rendered
 * differently by each surface — `RunGateBanner`'s `<pre>` block for a whole
 * rendered spec, a line inside `ApprovalsMenu`'s popover, a section beside
 * `NodeInspector`'s other panels — and "still open" is a `v-if` every caller
 * already has to make on its own gate source before this component is even
 * mounted.
 *
 * ## The rule this file exists to keep true on three surfaces, not one
 *
 * The F1.3 spec gate's `edit` is the one option no surface can answer by
 * naming it (`gateAnswerRequest` returns `null` for it) — `SPEC_EDIT_NEEDS_A_
 * DOCUMENT` is rendered beside it, unsubmittable, rather than hidden, because
 * an operator who read the terminal's four-option block would go looking for
 * the fourth. KAR-22.5 wrote that rule once for the run's own gate panel;
 * KAR-25.7 AC4/EPIC-25-S47 is that rule holding on the other two.
 *
 * ## `stale`, and why it is not the "did I already answer" flag this story
 * forbids
 *
 * `stale` is set **only** when the daemon refuses this component's own POST
 * with `already_answered` (409) — it is a rendering of the daemon's refusal,
 * one instance's memory of one request it made, never a substitute for the
 * ledger. The panel still waits for the `human.responded` frame to make the
 * gate actually close (the caller's `v-if`, not this component's `stale`).
 * `sending` is the ordinary in-flight guard against a double click on one
 * request — about one POST, not about whether the gate is open.
 */
import { gateAnswerRequest, SPEC_EDIT_NEEDS_A_DOCUMENT } from '@DeFlow/core';
import { ref, watch } from 'vue';
import { answerGate } from '../../api/answer-gate.ts';
import { useApiClient } from '../../api/provide.ts';

const props = defineProps<{
  readonly runId: string;
  readonly gate: {
    readonly node: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  };
}>();

const api = useApiClient();

/** `reject`'s reason, `inject`'s guidance, or a note on any option. */
const note = ref('');
/** The daemon's own sentence when it refused, never a paraphrase of one. */
const error = ref<string | null>(null);
/** See the header comment — the daemon's own `already_answered` refusal, not
 * a stand-in for the ledger clearing this gate. */
const stale = ref(false);
/** The option in flight, so a double-press cannot send a second answer. */
const sending = ref<string | null>(null);

// A different gate is a different question: nothing about the last one
// carries over, least of all a refusal that was about a decision already
// made.
watch(
  () => props.gate.node,
  () => {
    note.value = '';
    error.value = null;
    stale.value = false;
    sending.value = null;
  },
);

/** Whether any endpoint answers this gate with this option. @see AC4. */
const answerable = (optionId: string): boolean =>
  gateAnswerRequest({ runId: props.runId, gate: props.gate.node, optionId }) !== null;

async function answer(optionId: string): Promise<void> {
  if (stale.value || sending.value !== null || !answerable(optionId)) return;

  sending.value = optionId;
  error.value = null;
  try {
    const outcome = await answerGate(api, {
      runId: props.runId,
      gate: props.gate.node,
      optionId,
      // The empty string is passed on rather than withheld: a rejection with
      // no reason is refused by the route in the route's own words, and a
      // client-side guess at what it wanted would be a second wording of one
      // rule (docs/11 §11).
      text: note.value.trim(),
    });
    if (outcome.ok) return;
    error.value = outcome.message;
    // A gate somebody already answered is not a retry. The first answer
    // stands, and every button here is now about a decision that is made.
    if (outcome.code === 'already_answered') stale.value = true;
  } catch (thrown) {
    error.value = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    sending.value = null;
  }
}
</script>

<template>
  <div class="gate-options" data-gate-options>
    <ul v-if="!stale" class="gate-options__list">
      <li v-for="option in gate.options" :key="option.id" class="gate-options__item">
        <button
          type="button"
          class="gate-options__button"
          :data-gate-option="option.id"
          :disabled="!answerable(option.id) || sending !== null"
          @click="answer(option.id)"
        >
          <code class="gate-options__id">{{ option.id }}</code>
          <span>{{ option.label }}</span>
        </button>
        <!--
          AC4 — an option this surface cannot carry says so, in the one
          exported sentence `deflow answer` prints for it.
        -->
        <span
          v-if="!answerable(option.id)"
          class="gate-options__why"
          :data-gate-option-reason="option.id"
        >
          {{ SPEC_EDIT_NEEDS_A_DOCUMENT }}
        </span>
      </li>
    </ul>

    <label v-if="!stale" class="gate-options__note">
      <span class="gate-options__note-label">A note, or the reason for a rejection</span>
      <textarea v-model="note" class="gate-options__note-box" rows="2" data-gate-text></textarea>
    </label>

    <p v-if="error" class="gate-options__error" data-gate-error role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.gate-options {
  display: grid;
  gap: 0.375rem;
}

.gate-options__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.25rem;
}

.gate-options__item {
  display: grid;
  gap: 0.25rem;
}

.gate-options__button {
  display: grid;
  grid-template-columns: 6rem 1fr;
  gap: 0.5rem;
  align-items: baseline;
  text-align: left;
  font: inherit;
  color: inherit;
  background: none;
  border: 1px solid var(--edge, rgb(0 0 0 / 12%));
  border-radius: 0.25rem;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}

.gate-options__button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.gate-options__id {
  font-family: var(--font-mono, monospace);
}

/* Always a sentence: the dimmed button is an extra cue, never the carrier
   (docs/12 §9.2). */
.gate-options__why {
  color: var(--ink-muted);
  padding-left: 0.5rem;
}

.gate-options__note {
  display: grid;
  gap: 0.125rem;
}

.gate-options__note-label {
  color: var(--ink-muted);
}

.gate-options__note-box {
  font: inherit;
  width: 100%;
  resize: vertical;
}

.gate-options__error {
  margin: 0;
  color: var(--ink-warn, inherit);
}
</style>
