<script setup lang="ts">
/**
 * KAR-19.10 AC4 — the run header's third surface: which agent this run is on.
 *
 * The 2026-08-13 session was spent debugging a run against an agent the
 * operator had not knowingly selected, because nothing said which one had been
 * chosen or by which route. The terminal says it now, `GET /api/runs/:id` says
 * it, and this is the tab saying it — from the same three facts, through the
 * same `announceProviderChoice`. Composing a friendlier sentence here would be
 * a third wording, and a third wording is a third thing to keep true.
 *
 * Renders nothing at all when no choice was recorded: a daemon booted without
 * `providerRoots` admitted the run because it had no basis on which to refuse,
 * and it has none on which to announce either. An empty banner claiming
 * "unknown provider" would be a fact this tab does not have.
 *
 * Verifies: EPIC-19-S67 · AC4
 */
import { announceProviderChoice } from '@DeFlow/core';
import { computed } from 'vue';
import { useRunStore } from '../stores/useRunStore.ts';

const run = useRunStore();

/** The projection's own counter, so this recomputes on a provider event only. */
const version = computed<number>(() => run.version('provider'));

const chosen = computed(() => {
  void version.value;
  return run.provider.chosen;
});

const announcement = computed<string | null>(() =>
  chosen.value === null ? null : announceProviderChoice(chosen.value),
);
</script>

<template>
  <p v-if="announcement !== null" class="run-provider" data-run-provider>
    <span class="run-provider__line">{{ announcement }}</span>
    <!--
      AC7 — what this machine will not be able to do, beside the choice rather
      than three minutes later at the first agent node.
    -->
    <span v-if="chosen?.limitation" class="run-provider__limitation" data-run-provider-limitation
      >{{ chosen.limitation }}</span
    >
  </p>
</template>

<style scoped>
.run-provider {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  font-size: 0.8125rem;
  color: var(--ink-muted);
}

.run-provider__line {
  font-family: var(--font-mono, monospace);
  overflow-wrap: anywhere;
}

.run-provider__limitation {
  color: var(--ink-warn, var(--ink-muted));
}
</style>
