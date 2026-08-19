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
 * 2. **Offering every option the daemon offered, in its words**, and
 * 3. **answering through one path** — `./gate/GateOptions.vue`'s job since
 *    KAR-25.7. The F1.3 gate's `edit` is the one option no surface can answer
 *    by naming it, rendered unsubmittable with `SPEC_EDIT_NEEDS_A_DOCUMENT`
 *    beside it rather than hidden — the daemon offered four, and an operator
 *    who read the terminal block would go looking for the fourth (AC4). This
 *    file owned both of these alone through KAR-22.5; KAR-25.7 pulled them
 *    into `GateOptions` so the topbar's approvals control and the node
 *    inspector could offer the same two things without copying this file's
 *    ~60 lines twice. Responsibility 4 below is what every extraction still
 *    inherits.
 * 4. **Nothing about whether the gate is still open.** That is the ledger's:
 *    this renders while `gate` is non-null, and `gate` is
 *    `useRunStore().openGate`, the tab's fold of
 *    `human.requested`/`human.responded`. So an answer from the CLI, from
 *    another tab or from this one clears the panel by exactly the same route —
 *    the `human.responded` frame — and there is no "did my own request
 *    succeed" special case to get wrong (AC5, AC6). `GateOptions` itself keeps
 *    no such flag either — see its own header comment on `stale`.
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
import GateOptions from './gate/GateOptions.vue';

const props = defineProps<{
  readonly runId: string;
  readonly gate: {
    readonly node: string;
    /** What the gate asked, verbatim from `human.requested` (AC3). */
    readonly prompt?: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  } | null;
}>();

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

    <GateOptions :run-id="runId" :gate="gate" />

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

.run-gate__answer {
  margin: 0;
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}
</style>
