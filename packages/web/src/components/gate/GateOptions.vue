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
 *
 * ## What the redesign changed here, and what it deliberately did not
 *
 * **Not changed: the answer flow.** These are still direct-answer buttons —
 * press an option and the POST goes. A select-then-confirm step would be a
 * behaviour change, and this pass is a restyle.
 *
 * **Changed: which option looks like the action.** The first option the daemon
 * offers is §1.3's own first option, and it is now the card's one
 * `UiButton variant="primary"` — the single place `--accent` is spent on this
 * surface (system law 3). The rest are full-width secondary rows. The lime
 * *border* the default option used to carry is gone: an outline in the accent
 * hue on something that is not the primary action is the accent leaking into a
 * second meaning, which is exactly what law 3 forbids. Any transient
 * highlight is `--select-edge` and `--select-tint` — hueless, like every other
 * selection in the application.
 *
 * **Changed: the CLI equivalent moved in here**, from `../RunGateBanner.vue`,
 * and folded into a disclosure. It belongs beside the buttons rather than
 * beside one caller of them: three surfaces mount this component, and only one
 * of them was offering "or from a terminal". It is collapsed by default
 * because a person who is already in the tab has the buttons; `UiDisclosure`
 * keeps its content in the document while closed, so the command is still in
 * `textContent` and still findable with the browser's own find-in-page.
 */
import { gateAnswerRequest, SPEC_EDIT_NEEDS_A_DOCUMENT } from '@DeFlow/core';
import { ref, watch } from 'vue';
import { answerGate } from '../../api/answer-gate.ts';
import { useApiClient } from '../../api/provide.ts';
import { UiButton, UiChip, UiDisclosure, UiSectionLabel } from '../ui/index.ts';

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

/**
 * The command that answers this gate, spelled so it can be selected and pasted.
 *
 * Moved here from `../RunGateBanner.vue` unchanged — same string, same reason:
 * the two surfaces are one answer path (`gateAnswerRequest`), and an operator
 * who is already in a terminal should not have to come here. The **first**
 * option is the one shown, for the reason the terminal's own block shows it: a
 * line has to name one, and the gate's order is §1.3's order.
 */
const answerCommand = (): string =>
  `deflow answer ${props.runId} --gate ${props.gate.node} --option ${
    props.gate.options[0]?.id ?? '<option>'
  }`;
</script>

<template>
  <div class="gate-options" data-gate-options>
    <UiSectionLabel class="gate-options__caption">Your decision</UiSectionLabel>

    <ul v-if="!stale" class="gate-options__list">
      <li
        v-for="(option, index) in gate.options"
        :key="option.id"
        class="gate-options__item"
        :data-first="index === 0 || undefined"
      >
        <UiButton
          class="gate-options__button"
          :variant="index === 0 ? 'primary' : 'secondary'"
          size="md"
          :data-gate-option="option.id"
          :disabled="!answerable(option.id) || sending !== null"
          @click="answer(option.id)"
        >
          <UiChip class="gate-options__id" mono size="xs">{{ option.id }}</UiChip>
          <span class="gate-options__label">{{ option.label }}</span>
        </UiButton>
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
      <span class="gate-options__note-label">Note — optional, recorded in the ledger</span>
      <textarea v-model="note" class="gate-options__note-box" rows="2" data-gate-text></textarea>
    </label>

    <p v-if="error" class="gate-options__error" data-gate-error role="alert">{{ error }}</p>

    <UiDisclosure class="gate-options__cli" label="Answer from a terminal">
      <code class="gate-options__command">{{ answerCommand() }}</code>
    </UiDisclosure>
  </div>
</template>

<style scoped>
.gate-options {
  display: grid;
  gap: 10px; /* geometry — the decision column's own stack gap */
  min-width: 0;
}

.gate-options__caption {
  margin: 0;
}

.gate-options__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px; /* geometry — option-to-option gap */
}

.gate-options__item {
  display: grid;
  gap: 4px; /* geometry — button-to-reason gap */
  min-width: 0;
}

/* A thin rule under the primary option: the first option is the action, the
   rest are the alternatives, and one hairline says so without a second box
   (system law 1). */
.gate-options__item[data-first] {
  padding-bottom: 6px; /* geometry — the rule's breathing room */
  border-bottom: 1px solid var(--edge);
}

/* Full-width rows reading left to right — `UiButton` centres its slot, which
   is right for a toolbar button and wrong for a list of decisions. */
.gate-options__button {
  width: 100%;
  justify-content: flex-start;
  text-align: left;
}

/* The option's id is a machine-owned string, so it is mono and it is a chip
   (law 2) — the label beside it is the words a person reads. */
.gate-options__id {
  flex: none;
}

.gate-options__label {
  min-width: 0;
  overflow-wrap: anywhere;
}

/*
 * Law 3 — a keyboard or transient highlight is neutral. It used to be the
 * accent hue, which made "this is where you are" and "this is the action"
 * the same colour.
 */
.gate-options__button:focus-visible {
  border-left: 2px solid var(--select-edge);
  background: var(--select-tint);
}

/* Always a sentence: the dimmed button is an extra cue, never the carrier
   (docs/12 §9.2). */
.gate-options__why {
  color: var(--ink-muted);
  font-size: var(--text-xs);
  padding-left: 2px; /* geometry — aligns the reason under its button's edge */
}

.gate-options__note {
  display: grid;
  gap: 4px; /* geometry — label-to-field gap */
}

.gate-options__note-label {
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.gate-options__note-box {
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--ink);
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 6px 8px; /* geometry — the field's own padding */
  background: var(--surface-control);
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-sm);
}

.gate-options__error {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--state-failed);
}

.gate-options__cli {
  min-width: 0;
}

/* Law 1 — the disclosure opens *inside* this column, so it drops its own
   panel chrome and the command carries the code ground instead. */
.gate-options__cli :deep(.ui-disclosure__body) {
  background: transparent;
  border: none;
  padding: 0;
}

.gate-options__command {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-strong);
  background: var(--surface-code);
  border-radius: var(--radius-sm);
  padding: 8px; /* geometry — the code box's own padding */
  overflow-wrap: anywhere;
  user-select: all;
}
</style>
