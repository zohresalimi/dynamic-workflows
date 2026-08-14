<script setup lang="ts">
/**
 * KAR-19.12 AC6 — the run header's fourth surface: what this run is waiting for.
 *
 * The sibling of `./RunProviderBanner.vue`, written to the same rule and for
 * the same kind of reason. On 2026-08-14 a run stopped at its F1.3 gate,
 * offered four options, and the operator's terminal said nothing for nine
 * minutes; the tab was no better — the run list said *needs a decision* and the
 * run itself showed a graph of a plan that did not exist yet. This is the tab
 * saying what is waiting, what it will accept and how to answer it.
 *
 * Props rather than a store read, unlike the provider banner: the gate is
 * needed by a component test that renders it against four fixed options, and a
 * component whose only input is a global store cannot be rendered without one.
 * `App.vue` supplies `useRunStore().openGate`, which is the store's own read of
 * the `gates` projection — the tab's existing fold of
 * `human.requested`/`human.responded`.
 *
 * Renders nothing at all when no gate is open. An empty banner saying "not
 * waiting" would be a sentence about the absence of a fact, and this surface
 * only reports facts.
 *
 * Verifies: EPIC-19-S82 · AC6
 */
const props = defineProps<{
  readonly runId: string;
  readonly gate: {
    readonly node: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  } | null;
}>();

/**
 * The command that answers this gate, spelled so it can be selected and pasted.
 *
 * The **first** option is the one shown, for the reason the terminal's block
 * shows it: a line has to name one, and the gate's own order is §1.3's order.
 * Every option is listed immediately above it, so an operator changing one word
 * is doing so having read all of them.
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
      <span class="run-gate__node">{{ gate.node }}</span>
      <span class="run-gate__wait">is waiting for you</span>
    </p>
    <ul class="run-gate__options">
      <li v-for="option in gate.options" :key="option.id" class="run-gate__option">
        <code class="run-gate__id">{{ option.id }}</code>
        <span>{{ option.label }}</span>
      </li>
    </ul>
    <p class="run-gate__answer">
      Answer it from a terminal with <code>{{ answerCommand() }}</code>
    </p>
  </section>
</template>

<style scoped>
.run-gate {
  border: 1px solid var(--ink-warn, var(--border, rgb(0 0 0 / 20%)));
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  margin: 0;
  font-size: 0.8125rem;
}

.run-gate__head {
  display: flex;
  gap: 0.5rem;
  margin: 0 0 0.375rem;
}

.run-gate__node {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
}

.run-gate__wait {
  color: var(--ink-warn, var(--ink-muted));
}

.run-gate__options {
  list-style: none;
  margin: 0 0 0.375rem;
  padding: 0;
  display: grid;
  gap: 0.125rem;
}

.run-gate__option {
  display: grid;
  grid-template-columns: 6rem 1fr;
  gap: 0.5rem;
}

.run-gate__id {
  font-family: var(--font-mono, monospace);
}

.run-gate__answer {
  margin: 0;
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}
</style>
