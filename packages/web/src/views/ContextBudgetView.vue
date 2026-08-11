<script setup lang="ts">
/**
 * KAR-17.4 — F10.5's context budget view.
 *
 * Verifies: EPIC-17-S17, EPIC-17-S18, EPIC-17-S19, EPIC-17-S32 · AC1–AC10
 *
 * The reason this view is one of the three the roadmap names as carrying the
 * diagnosis metric: compaction *actively deletes governance constraints from
 * context, causing unsafe tool calls* — a mechanism distinct from ordinary
 * long-context attention dilution, and the reason F6.6's pinned set exists at
 * all. This is where it becomes visible.
 *
 * **It joins and it renders. It does not reduce.** The stack, the budget line,
 * the compaction marks and the gap are `../lib/context-budget.ts`; the
 * projection under that is `../ledger/projections/context.ts`; and this file is
 * the two joins neither of them may do for itself:
 *
 * 1. **The typed failure beside the violation** (AC6). `pin.integrity_violated`
 *    lands in the *context* projection and `node.failed` lands in the *plan*
 *    projection, and the seven projections never read one another (KAR-16.3).
 *    The join has to happen above both, which is here.
 * 2. **The click-through** (AC7). A segment opens the node inspector on that
 *    segment, which is a selection in `useUiStore` plus the segment id in the
 *    URL — so the position is linkable, which is half of what makes a
 *    five-minute diagnosis shareable (PRD §12).
 */
import { computed } from 'vue';
import { type LocationQueryRaw, useRoute, useRouter } from 'vue-router';
import { useRunFeed } from '../app/useRunFeed.ts';
import ContextBudgetChart from '../components/ContextBudgetChart.vue';
import { type BudgetChartVM, type BudgetFailureVM, budgetChart } from '../lib/context-budget.ts';
import { useRunStore } from '../stores/useRunStore.ts';
import { useUiStore } from '../stores/useUiStore.ts';

const props = defineProps<{
  /** From `/runs/:runId/context`. */
  readonly runId?: string;
}>();

const run = useRunStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

const runId = computed<string | null>(() => props.runId ?? null);
const { status } = useRunFeed(runId);

/**
 * Every node's latest typed failure, keyed by the invocation it ended.
 *
 * The plan projection keeps the latest failure per node and stamps it with the
 * attempt it belongs to, so the key is exact rather than "the node failed at
 * some point" — an invocation that succeeded on attempt 2 must not inherit
 * attempt 1's reason.
 */
const failures = computed<ReadonlyMap<string, BudgetFailureVM>>(() => {
  const found = new Map<string, BudgetFailureVM>();
  for (const node of run.planNodes) {
    const failure = node.failure;
    if (failure === null) continue;
    found.set(`${node.id}#${failure.attempt}`, {
      reason: failure.reason,
      class: failure.class,
      message: failure.message,
      evidence: failure.evidence,
    });
  }
  return found;
});

const chart = computed<BudgetChartVM>(() => {
  // The projection's own counter, so this recomputes when a packet, a
  // compaction or a violation arrives and not when anything else does.
  void run.version('context');
  return budgetChart(run.context, failures.value);
});

/**
 * AC7 — open the inspector on the segment that was clicked.
 *
 * `replace` rather than `push`, for the same reason the graph's selection is:
 * a panel you cannot press Back out of is a history thirty entries deep after a
 * minute of clicking around a stack.
 */
function inspect(target: {
  readonly nodeId: string;
  readonly attempt: number;
  readonly segmentId: string;
}): void {
  ui.selectNode(target.nodeId);
  ui.inspectSelected('inspector');
  void router.replace({
    query: {
      ...(route.query as LocationQueryRaw),
      node: target.nodeId,
      attempt: String(target.attempt),
      segment: target.segmentId,
    },
  });
}
</script>

<template>
  <section class="context-budget" aria-label="Context budget">
    <ContextBudgetChart v-if="chart.bars.length > 0" :chart="chart" @inspect="inspect" />

    <p v-else class="context-budget__empty">
      <template v-if="runId === null">
        No run open. Open one at <code>/runs/&lt;runId&gt;/context</code>.
      </template>
      <template v-else-if="status === 'hydrating'">Reading the run's ledger…</template>
      <template v-else-if="status === 'reconnecting'">
        Reconnecting to the daemon. This is what the tab last saw.
      </template>
      <template v-else>
        No context packet yet. A bar appears here for every node invocation the run assembles a
        packet for.
      </template>
    </p>
  </section>
</template>

<style scoped>
.context-budget {
  block-size: 100%;
  overflow-y: auto;
}

.context-budget__empty {
  display: grid;
  place-content: center;
  min-block-size: 12rem;
  color: var(--ink-muted);
  text-align: center;
}
</style>
