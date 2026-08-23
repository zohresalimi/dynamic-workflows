<script setup lang="ts">
/**
 * KAR-25.7 AC1, AC2, AC5 — the topbar's approvals chip, turned into a control.
 *
 * Verifies: EPIC-25-S42, EPIC-25-S43, EPIC-25-S44, EPIC-25-S48, EPIC-25-S50
 *
 * `AppTopBar.vue`'s own docblock forbids it issuing a request of its own —
 * this component keeps that rule by reading `useApprovalsStore()` directly,
 * exactly as `RunStatusPill.vue` reads `useRunStore()` beside it. The store
 * is filled once, at the shell (`../../App.vue` → `../../app/useApprovals.ts`),
 * and stays live for the tab's whole life off the shared `?runs=*`
 * subscription — nothing here fetches, polls or re-fetches after an answer.
 *
 * **Absent, never an empty panel (AC2, EPIC-25-S44).** The `PopoverRoot`
 * itself is behind `v-if="store.count > 0"` — not a `v-show`, not a disabled
 * trigger — because a control that exists but reports nothing waiting is a
 * sentence about the absence of a fact, the same rule `RunGateBanner.vue`'s
 * own header states for itself.
 *
 * **Each entry answers in place.** `../gate/GateOptions.vue` is the same
 * component `RunGateBanner.vue` and `../NodeInspector.vue` mount — one
 * `gateAnswerRequest` path, three renderings. Nothing here special-cases "the
 * request I just sent": an entry disappears only when `useApprovalsStore`'s
 * fold of `human.responded` removes it (AC5, AC7), which is the same frame
 * that clears the run's own gate panel and the node inspector.
 *
 * **Each entry links to its run's gate.** `runRouteTo('run-plan', null, …)`
 * is the one existing way there without a `projectId` on this row — see
 * `packages/docs/delivery/epics/EPIC-25-frame-and-settings.md`'s KAR-25.7
 * notes on why that costs one extra hop through `createLegacyRunGuard` rather
 * than a daemon change.
 */
import { BellRing } from 'lucide-vue-next';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { RouterLink } from 'vue-router';
import { runRouteTo } from '../../router/legacy-run.ts';
import { useApprovalsStore } from '../../stores/useApprovalsStore.ts';
import GateOptions from '../gate/GateOptions.vue';
import { UiCard, UiChip } from '../ui/index.ts';

const store = useApprovalsStore();
</script>

<template>
  <PopoverRoot v-if="store.count > 0">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="approvals__trigger"
        data-approvals-trigger
        :data-approvals="store.count"
        :aria-label="`${store.count} waiting on you`"
      >
        <!--
          System law 4 — this is the topbar's whole statement about what is
          waiting: a *count*, across every run. `info` and not `warn`: the
          `--state-awaiting-human` token is the one this application already
          spends on "a human is being asked", and `warn` borrowed
          `--state-blocked`, which means something has gone wrong. Nothing has
          gone wrong when a gate opens — that is the gate working.
        -->
        <UiChip variant="info">
          <BellRing :size="14" aria-hidden="true" />
          {{ store.count }}
        </UiChip>
      </button>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent class="approvals__panel" align="end" :side-offset="6">
        <UiCard variant="raised" class="approvals__card">
          <!-- AC2 — one entry per waiting gate, naming its run and its node. -->
          <ul class="approvals__list" data-approvals-list>
            <li
              v-for="entry in store.entries"
              :key="`${entry.runId}:${entry.node}`"
              class="approvals__row"
              :data-approval-entry="entry.runId"
            >
              <RouterLink
                :to="runRouteTo('run-plan', null, { runId: entry.runId })"
                class="approvals__link"
                :data-approval-link="entry.runId"
              >
                <span class="approvals__run mono" data-approval-run>{{ entry.runId }}</span>
                <span class="approvals__node mono" data-approval-node>{{ entry.node }}</span>
              </RouterLink>
              <GateOptions
                :run-id="entry.runId"
                :gate="{ node: entry.node, options: entry.options }"
              />
            </li>
          </ul>
        </UiCard>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
.approvals__trigger {
  display: inline-flex;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
}

.approvals__panel {
  width: 22rem;
  max-width: min(22rem, 90vw);
  z-index: 20;
}

.approvals__card {
  padding: 0.5rem;
  box-shadow: var(--shadow-modal);
  max-height: 24rem;
  overflow-y: auto;
}

.approvals__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.approvals__row {
  display: grid;
  gap: 0.375rem;
  padding: 0.5rem;
  border-radius: var(--radius-md);
  background: var(--surface-inset);
}

.approvals__row + .approvals__row {
  border-top: 1px solid var(--edge);
  padding-top: 0.75rem;
}

.approvals__link {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.375rem;
  color: inherit;
  text-decoration: none;
}

.approvals__run {
  font-size: var(--text-xs);
  color: var(--ink-muted);
}

.approvals__node {
  font-weight: 600;
  color: var(--ink);
}

.approvals__link:hover .approvals__node {
  text-decoration: underline;
}
</style>
