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
 * Everywhere else the band is unchanged in substance: the node, the whole
 * rendered spec, every option, and the terminal equivalent. That is KAR-22.5
 * AC1's contract — a gate is answerable *from anywhere*, not only from the
 * run's own screen — and `compact` is a claim about duplication on one route,
 * never a claim that anything else went away.
 *
 * The spec itself is the part that had to move rather than vanish. A band
 * above the router outlet is not where 2 KB of document is *laid out* — the
 * card does that, section by section — but AC3's red condition is an operator
 * approving a document nobody put on screen, and eight run routes
 * (`run-plan`, `run-timeline`, `run-diff`, `run-context`, `run-criteria`,
 * `run-node-output`, `run-memory`, `plan-evolution`) mount this band and no
 * card. So the full form keeps `<pre data-run-gate-prompt>` verbatim, folded
 * into a `UiDisclosure` exactly as the terminal equivalent is a few lines
 * below: collapsed, so the band stays a band, but never unmounted — the text
 * is in `textContent`, reachable by find-in-page, and one click from being
 * read. `compact` is the only form without it, because on that one route the
 * card beside it owns `data-run-gate-prompt`.
 *
 * Verifies: EPIC-19-S82, EPIC-22-S58, EPIC-22-S59, EPIC-22-S61, EPIC-22-S62,
 * EPIC-22-S65, EPIC-22-S67 · KAR-19.12 AC6 · KAR-22.5 AC1–AC6, AC8
 */
import GateOptions from './gate/GateOptions.vue';
import { UiDisclosure } from './ui/index.ts';

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

      <!--
        AC3 — what is being asked, in the gate's own words. For the F1.3 gate
        this is the whole rendered spec, which is why it is a `<pre>` with a
        scroll of its own rather than a paragraph. Collapsed by default so the
        band stays a band; `UiDisclosure` keeps it mounted, so the spec is in
        `textContent` and findable whether or not it is open.
      -->
      <UiDisclosure v-if="gate.prompt" label="Read what was asked">
        <pre class="run-gate__prompt" data-run-gate-prompt>{{ gate.prompt }}</pre>
      </UiDisclosure>

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

/*
 * The spec, when the band is the only thing on the route showing it. Layer 2
 * on the band's own surface with no border of its own — the band already has
 * one, and law 1 does not spend a second wall inside it. Same treatment as
 * `./gate/SpecEvidence.vue`'s own fallback `<pre>`, one rung smaller because
 * this is a band and that is a card.
 */
.run-gate__prompt {
  margin: 6px 0 0; /* geometry — clears the disclosure's trigger */
  max-height: 14rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--ink-strong);
  background: var(--surface-inset);
  border-radius: var(--radius-sm);
  padding: 10px; /* geometry — the code block's own padding */
}
</style>
