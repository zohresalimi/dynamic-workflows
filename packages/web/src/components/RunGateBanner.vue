<script setup lang="ts">
/**
 * KAR-19.12 AC6 and KAR-22.5 — what this run is waiting for, and the buttons
 * that answer it.
 *
 * On 2026-08-14 a run stopped at its F1.3 gate, offered four options, and the
 * operator's terminal said nothing for nine minutes; the tab was no better —
 * the run list said *needs a decision* and the run itself showed a graph of a
 * plan that did not exist yet. KAR-19.12 made this say what was waiting. On
 * 2026-08-15 the same gate stopped KAR-22.3's own by-hand acceptance, because
 * saying what is waiting and being able to answer it are different things: the
 * only way through was `deflow answer` in a terminal, which is precisely the
 * terminal EPIC-22 exists to make optional.
 *
 * ## The four things this file is responsible for
 *
 * 1. **Saying what is being asked.** The node, and the gate's own `prompt` —
 *    which for the F1.3 gate *is* the rendered spec (`renderSpecForReview`), so
 *    an operator reads the goal, the scope, the criteria and the failure modes
 *    before pressing anything (AC3). Verbatim: re-rendering it from
 *    `run.created.spec` would be a second renderer of one document, and the two
 *    would disagree the first time a run was amended.
 * 2. **Offering every option the daemon offered, in its words.** The labels are
 *    `SPEC_APPROVAL_OPTIONS`' and the plan's; nothing here rewrites them (R4).
 * 3. **Answering through one path.** `answerGate` → `gateAnswerRequest`, which
 *    is the same function `deflow answer` routes with. The F1.3 gate's `edit`
 *    is the one option no surface can answer by naming it, so it is rendered
 *    unsubmittable with `SPEC_EDIT_NEEDS_A_DOCUMENT` beside it rather than
 *    hidden — the daemon offered four, and an operator who read the terminal
 *    block would go looking for the fourth (AC4).
 * 4. **Nothing about whether the gate is still open.** That is the ledger's:
 *    this renders while `gate` is non-null, and `gate` is
 *    `useRunStore().openGate`, the tab's fold of
 *    `human.requested`/`human.responded`. So an answer from the CLI, from
 *    another tab or from this one clears the panel by exactly the same route —
 *    the `human.responded` frame — and there is no "did my own request
 *    succeed" special case to get wrong (AC5, AC6).
 *
 * Props rather than a store read, unlike the provider banner: the gate is
 * needed by a component test that renders it against four fixed options, and a
 * component whose only input is a global store cannot be rendered without one.
 *
 * Renders nothing at all when no gate is open. An empty banner saying "not
 * waiting" would be a sentence about the absence of a fact, and this surface
 * only reports facts.
 *
 * Verifies: EPIC-19-S82, EPIC-22-S58, EPIC-22-S59, EPIC-22-S61, EPIC-22-S62,
 * EPIC-22-S65, EPIC-22-S67 · KAR-19.12 AC6 · KAR-22.5 AC1–AC6, AC8
 */
import { gateAnswerRequest, SPEC_EDIT_NEEDS_A_DOCUMENT } from '@DeFlow/core';
import { ref, watch } from 'vue';
import { answerGate } from '../api/answer-gate.ts';
import { useApiClient } from '../api/provide.ts';

const props = defineProps<{
  readonly runId: string;
  readonly gate: {
    readonly node: string;
    /** What the gate asked, verbatim from `human.requested` (AC3). */
    readonly prompt?: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  } | null;
}>();

const api = useApiClient();

/** `reject`'s reason, `inject`'s guidance, or a note on any option. */
const note = ref('');
/** The daemon's own sentence when it refused, never a paraphrase of one. */
const error = ref<string | null>(null);
/**
 * Whether the daemon has told us this gate is already answered.
 *
 * The options come off the screen when it has (AC6). The panel itself stays,
 * carrying the explanation, until the `human.responded` frame arrives and the
 * store reports no open gate — which is the same thing clearing it for every
 * other tab.
 */
const stale = ref(false);
/** The option in flight, so a double-press cannot send a second answer. */
const sending = ref<string | null>(null);

// A different gate is a different question: nothing about the last one carries
// over, least of all a refusal that was about a decision already made.
watch(
  () => props.gate?.node ?? null,
  () => {
    note.value = '';
    error.value = null;
    stale.value = false;
    sending.value = null;
  },
);

/** Whether any endpoint answers this gate with this option. @see AC4. */
const answerable = (optionId: string): boolean =>
  props.gate !== null &&
  gateAnswerRequest({ runId: props.runId, gate: props.gate.node, optionId }) !== null;

async function answer(optionId: string): Promise<void> {
  const gate = props.gate;
  if (gate === null || stale.value || sending.value !== null || !answerable(optionId)) return;

  sending.value = optionId;
  error.value = null;
  try {
    const outcome = await answerGate(api, {
      runId: props.runId,
      gate: gate.node,
      optionId,
      // The empty string is passed on rather than withheld: a rejection with no
      // reason is refused by the route in the route's own words, and a
      // client-side guess at what it wanted would be a second wording of one
      // rule (docs/11 §11).
      text: note.value.trim(),
    });
    if (outcome.ok) return;
    error.value = outcome.message;
    // A gate somebody already answered is not a retry. The first answer stands,
    // and every button on this panel is now about a decision that is made.
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
 * Kept beside the buttons rather than replaced by them: the two surfaces are
 * one answer path (`gateAnswerRequest`), and an operator who is already in a
 * terminal should not have to come here. The **first** option is the one shown,
 * for the reason the terminal's block shows it: a line has to name one, and the
 * gate's own order is §1.3's order.
 */
const answerCommand = (): string =>
  props.gate === null
    ? ''
    : `deflow answer ${props.runId} --gate ${props.gate.node} --option ${
        props.gate.options[0]?.id ?? '<option>'
      }`;
</script>

<template>
  <section v-if="gate" class="run-gate" data-run-gate-banner>
    <p class="run-gate__head">
      <span class="run-gate__node" data-run-gate-node>{{ gate.node }}</span>
      <span class="run-gate__wait">is waiting for you</span>
    </p>

    <!--
      AC3 — what is being asked, in the gate's own words. For the F1.3 gate this
      is the whole rendered spec, which is why it is a `<pre>` with a scroll of
      its own rather than a paragraph.
    -->
    <pre v-if="gate.prompt" class="run-gate__prompt" data-run-gate-prompt>{{ gate.prompt }}</pre>

    <ul v-if="!stale" class="run-gate__options">
      <li v-for="option in gate.options" :key="option.id" class="run-gate__option">
        <button
          type="button"
          class="run-gate__button"
          :data-gate-option="option.id"
          :disabled="!answerable(option.id) || sending !== null"
          @click="answer(option.id)"
        >
          <code class="run-gate__id">{{ option.id }}</code>
          <span>{{ option.label }}</span>
        </button>
        <!--
          AC4 — an option this surface cannot carry says so, in the one exported
          sentence `deflow answer` prints for it.
        -->
        <span
          v-if="!answerable(option.id)"
          class="run-gate__why"
          :data-gate-option-reason="option.id"
        >
          {{ SPEC_EDIT_NEEDS_A_DOCUMENT }}
        </span>
      </li>
    </ul>

    <label v-if="!stale" class="run-gate__note">
      <span class="run-gate__note-label">A note, or the reason for a rejection</span>
      <textarea v-model="note" class="run-gate__note-box" rows="2" data-gate-text></textarea>
    </label>

    <p v-if="error" class="run-gate__error" data-gate-error role="alert">{{ error }}</p>

    <p class="run-gate__answer">Or from a terminal: <code>{{ answerCommand() }}</code></p>
  </section>
</template>

<style scoped>
.run-gate {
  border: 1px solid var(--ink-warn, var(--border, rgb(0 0 0 / 20%)));
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  margin: 0;
  font-size: 0.8125rem;
  display: grid;
  gap: 0.375rem;
}

.run-gate__head {
  display: flex;
  gap: 0.5rem;
  margin: 0;
}

.run-gate__node {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
}

.run-gate__wait {
  color: var(--ink-warn, var(--ink-muted));
}

.run-gate__prompt {
  margin: 0;
  max-height: 14rem;
  overflow: auto;
  white-space: pre-wrap;
  font-family: var(--font-mono, monospace);
  font-size: 0.95em;
  background: var(--surface-sunken, transparent);
  border-radius: 0.25rem;
  padding: 0.5rem;
}

.run-gate__options {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.25rem;
}

.run-gate__option {
  display: grid;
  gap: 0.25rem;
}

.run-gate__button {
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

.run-gate__button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.run-gate__id {
  font-family: var(--font-mono, monospace);
}

/* Always a sentence: the dimmed button is an extra cue, never the carrier
   (docs/12 §9.2). */
.run-gate__why {
  color: var(--ink-muted);
  padding-left: 0.5rem;
}

.run-gate__note {
  display: grid;
  gap: 0.125rem;
}

.run-gate__note-label {
  color: var(--ink-muted);
}

.run-gate__note-box {
  font: inherit;
  width: 100%;
  resize: vertical;
}

.run-gate__error {
  margin: 0;
  color: var(--ink-warn, inherit);
}

.run-gate__answer {
  margin: 0;
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}
</style>
