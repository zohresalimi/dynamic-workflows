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
 * ## `compact`, and the one thing it must not cost
 *
 * The redesign gives the project's workflows view a real gate card
 * (`./gate/GateDecisionCard.vue`) — the page's one raised object, with the
 * spec laid out beside the buttons. On *that* route this band would be the
 * same gate said twice, a hairline strip repeating what a card below it says
 * in full, which is exactly what system law 4 forbids. So `compact` renders
 * one line and a link to the card's anchor instead.
 *
 * Everywhere else the band is unchanged in substance: the node, every option,
 * and the terminal equivalent. That is KAR-22.5 AC1's contract — a gate is
 * answerable *from anywhere*, not only from the run's own screen — and
 * `compact` is a claim about duplication on one route, never a claim that the
 * answer path went away. The `<pre>` of the whole rendered spec is the one
 * thing the full form drops: a band above the router outlet is not where a
 * 2 KB document is read, and `data-run-gate-prompt` now belongs to the card
 * that lays it out.
 *
 * Verifies: EPIC-19-S82, EPIC-22-S58, EPIC-22-S59, EPIC-22-S61, EPIC-22-S62,
 * EPIC-22-S65, EPIC-22-S67 · KAR-19.12 AC6 · KAR-22.5 AC1–AC6, AC8
 */
import GateOptions from './gate/GateOptions.vue';

withDefaults(
  defineProps<{
    readonly runId: string;
    readonly gate: {
      readonly node: string;
      /** What the gate asked, verbatim from `human.requested` (AC3). */
      readonly prompt?: string;
      readonly options: readonly { readonly id: string; readonly label: string }[];
    } | null;
    /** The route below already shows this gate in full — see the header. */
    readonly compact?: boolean;
  }>(),
  { compact: false },
);
</script>

<template>
  <section
    v-if="gate"
    class="run-gate"
    :class="{ 'run-gate--compact': compact }"
    data-run-gate-banner
  >
    <p v-if="compact" class="run-gate__line">
      <span class="run-gate__node" data-run-gate-node>{{ gate.node }}</span>
      <span class="run-gate__wait">is waiting for you</span>
      <a class="run-gate__jump" href="#gate-decision">jump to decision</a>
    </p>

    <template v-else>
      <p class="run-gate__head">
        <span class="run-gate__node" data-run-gate-node>{{ gate.node }}</span>
        <span class="run-gate__wait">is waiting for you</span>
      </p>

      <GateOptions :run-id="runId" :gate="gate" />
    </template>
  </section>
</template>

<style scoped>
/*
 * System law 1 — a hairline band on the canvas, not a card. It is the shell's
 * announcement that something is waiting; the thing you *do* about it is a
 * raised card, and there is one of those per page.
 */
.run-gate {
  border: 1px solid var(--edge);
  border-left: 3px solid var(--state-awaiting-human); /* geometry — the waiting bar */
  border-radius: var(--radius-md);
  padding: 8px 12px; /* geometry — the band's own padding */
  margin: 0;
  background: var(--surface);
  font-size: var(--text-md);
  display: grid;
  gap: 6px; /* geometry — the band's own stack gap */
}

.run-gate--compact {
  padding: 6px 12px; /* geometry — one line's worth */
}

.run-gate__head,
.run-gate__line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px; /* geometry — the row's own gutter */
  margin: 0;
}

.run-gate__node {
  font-family: var(--font-mono);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.run-gate__wait {
  color: var(--ink-muted);
}

.run-gate__jump {
  margin-left: auto;
  font-size: var(--text-sm);
  color: var(--ink-muted);
}
</style>
