<script setup lang="ts">
/**
 * What the graph says when it has no nodes to draw — extracted from
 * `../../views/PlanGraphView.vue` so that a second surface can say it too.
 *
 * The redesign gives a run that has stopped at its spec gate a slim strip
 * instead of an empty 3fr/2fr split, and that strip has to report the same
 * four states the canvas does: no run open, hydrating, reconnecting, or a run
 * whose plan has not been compiled yet. Two components spelling those four
 * sentences is how they start to disagree — one saying "Reconnecting…" while
 * the other still says "Reading the run's ledger…" for the same feed status —
 * so the sentences live here and both callers mount this.
 *
 * `PlanGraphView` keeps its own `v-if` on `nodes.length === 0` and its own
 * absolute-positioned placement: *where* the note sits is the caller's layout
 * problem, and this component takes no position of its own.
 *
 * ## KAR-27.3 AC4 — the last branch names the state it is in
 *
 * "No plan yet" was true and useless for the whole of a run's pre-execution
 * phase, which is minutes: framing, then a spec gate, then recon, then the
 * planner. An operator reading it could not tell an interrogation in progress
 * from a run that had stopped. `activity` is the ledger's answer to *which of
 * those it is*, derived by the caller from the run's own `preExecution` record,
 * and `null` — nothing in flight and no gate open — keeps the original
 * sentence, which is then the honest one.
 *
 * **"Reading the run's ledger…" stays exactly where it is**: on the hydrating
 * branch, which is the one place it is true. The 2026-08-23 report was that
 * sentence sitting under a run that had hydrated ten minutes earlier, and the
 * fix is that nothing else can reach it — not new copy on the same branch.
 */
defineProps<{
  /** The run on screen, or `null` on the project-less landing route. */
  readonly runId: string | null;
  /** `useRunFeed()`'s own status word for this run's subscription. */
  readonly status: string;
  /**
   * Which pre-execution state the run is in, from the ledger, or `null` when it
   * is in none of them.
   *
   * Spelled inline rather than imported: `<script setup>`'s prop compiler
   * resolves a literal union at the call site with no runtime cost, and an
   * alias from another package is a compile-time dependency this component does
   * not otherwise have.
   */
  readonly activity?: 'framing' | 'recon' | 'planner' | 'awaiting-spec-approval' | null;
}>();
</script>

<template>
  <span class="graph-empty" data-graph-empty>
    <template v-if="runId === null">
      No run open. Open one at <code>/runs/&lt;runId&gt;</code>, or start one with
      <code>deflow run</code>.
    </template>
    <template v-else-if="status === 'hydrating'">Reading the run's ledger…</template>
    <template v-else-if="status === 'reconnecting'">
      Reconnecting to the daemon. The graph is what this tab last saw.
    </template>
    <template v-else-if="activity === 'framing'">
      The framing agent is interrogating the task. A plan appears once the spec is agreed and
      compiled.
    </template>
    <template v-else-if="activity === 'awaiting-spec-approval'">
      The spec is written and waiting for your answer. Nothing is planned until you give it.
    </template>
    <template v-else-if="activity === 'recon'">
      Recon is surveying the repository, so the plan is written against what is actually there.
    </template>
    <template v-else-if="activity === 'planner'">
      The planner is compiling a plan from the spec and what recon found.
    </template>
    <template v-else>
      No plan yet. A run's graph appears here as soon as its first plan is compiled.
    </template>
  </span>
</template>

<style scoped>
.graph-empty {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
</style>
