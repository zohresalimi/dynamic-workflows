<script setup lang="ts">
/**
 * KAR-17.7 — F10.8's acceptance-criteria board.
 *
 * Verifies: EPIC-17-S28, EPIC-17-S29 · AC1–AC8
 *
 * *"The literal answer to 'has the requested outcome been achieved'"*
 * (docs/12-frontend-architecture.md §6.8). Everything this view knows about
 * *what* a criterion is doing is `../lib/criteria-board.ts`'s — the join, the
 * conflict flag, the headline, the markdown export — and everything here is
 * mounting it, listening for it to change, and wiring the two deep links a
 * colleague reading this board actually needs: into the diff at the finding's
 * line (AC3), and back out of a finding on that diff into this board's
 * matching criterion (`../components/review/ReviewFinding.vue`'s `criterionTo`).
 *
 * **It updates live because it is a query, not a snapshot** (AC6). There is no
 * fetch anywhere in this file: `board` is a `computed` that reads
 * `run.version('gates')`, so a `gate.evaluated` folded into the store — by the
 * real feed or, in a spec, by `run.applyEvent` directly — recomputes the join
 * on the next tick.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { type LocationQueryRaw, useRoute } from 'vue-router';
import { useRunFeed } from '../app/useRunFeed.ts';
import CriterionStatusChip from '../components/CriterionStatusChip.vue';
import type { FindingVM } from '../ledger/projections/gates.ts';
import {
  type CriteriaBoardVM,
  type CriterionVerdictVM,
  criteriaBoard,
  criteriaMarkdown,
  NO_GATE_MESSAGE,
} from '../lib/criteria-board.ts';
import { useRunStore } from '../stores/useRunStore.ts';

const props = defineProps<{
  /** From `/runs/:runId/criteria`. */
  readonly runId?: string;
}>();

const run = useRunStore();
const route = useRoute();

const runId = computed<string | null>(() => props.runId ?? null);
const { status } = useRunFeed(runId);

const board = computed<CriteriaBoardVM>(() => {
  // The projection's own counter — this recomputes when a `gate.evaluated` (or
  // a `run.created`) lands, and not on anything that leaves gates untouched.
  void run.version('gates');
  return criteriaBoard(run.gates);
});

/**
 * Which rows are open. A `reactive` `Set` rather than a `ref` one, so
 * `toggle()` below can mutate it in place — Vue's collection handlers make a
 * `Set.add`/`.delete` reactive the same way a plain object's property write
 * is, and a criterion opened while a live update is mid-flight must not be
 * clobbered by a fresh empty `Set` replacing this one.
 */
const expanded = reactive(new Set<string>());

function isExpanded(id: string): boolean {
  return expanded.has(id);
}

function toggle(id: string): void {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}

/**
 * `?criterion=` — the other end of `ReviewFinding.vue`'s `criterionTo`
 * (EPIC-17-S24's "and back again"). Opens that row and scrolls it on screen,
 * because a deep link that lands the operator above the fold has made them go
 * looking for the thing it promised to show them.
 */
watch(
  () => route.query['criterion'],
  async (value) => {
    if (typeof value !== 'string' || value === '') return;
    expanded.add(value);
    await nextTick();
    document
      .querySelector(`[data-criterion-row="${CSS.escape(value)}"]`)
      ?.scrollIntoView({ block: 'center' });
  },
  { immediate: true },
);

/** Where a finding's line opens (AC3) — the per-node diff, at its file and line. */
function diffTo(verdict: CriterionVerdictVM, finding: FindingVM): LocationQueryRaw | null {
  if (finding.location === null) return null;
  return {
    name: 'run-diff',
    params: { runId: runId.value },
    query: {
      scope: 'node',
      node: verdict.evaluatedNode,
      file: finding.location.file,
      line: String(finding.location.line),
    },
  } as unknown as LocationQueryRaw;
}

/** Where a verdict's own `seq` opens (AC3's "links to the gate.evaluated event"). */
function seqTo(seq: number): { query: LocationQueryRaw } {
  return { query: { ...(route.query as LocationQueryRaw), seq: String(seq) } };
}

const copyStatus = ref('');

/** AC8 — a PR-ready checklist, built from the same `board` the table renders. */
async function copyMarkdown(): Promise<void> {
  const markdown = criteriaMarkdown(board.value);
  try {
    await navigator.clipboard.writeText(markdown);
    copyStatus.value = `Copied ${String(board.value.total)} criteria to the clipboard as markdown.`;
  } catch (error) {
    copyStatus.value = `Could not copy to the clipboard: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}
</script>

<template>
  <section class="criteria" aria-label="Acceptance criteria board">
    <template v-if="runId === null">
      <p class="criteria__empty">
        No run open. Open one at <code>/runs/&lt;runId&gt;/criteria</code>.
      </p>
    </template>

    <template v-else>
      <header class="criteria__head" data-criteria-header>
        <p class="criteria__headline" data-criteria-headline>{{ board.headline }}</p>
        <ul class="criteria__counts" data-criteria-counts>
          <li :data-count="'satisfied'">satisfied: {{ board.counts.satisfied }}</li>
          <li :data-count="'unsatisfied'">unsatisfied: {{ board.counts.unsatisfied }}</li>
          <li :data-count="'unverifiable'">unverifiable: {{ board.counts.unverifiable }}</li>
        </ul>
        <button
          type="button"
          data-copy-markdown
          :disabled="board.total === 0"
          @click="copyMarkdown"
        >
          Copy as markdown
        </button>
        <p class="criteria__copy-status" aria-live="polite" data-copy-status>{{ copyStatus }}</p>
      </header>

      <p v-if="board.total === 0" class="criteria__empty">
        <template v-if="status === 'hydrating'">Reading the run's ledger…</template>
        <template v-else>This run's spec carries no acceptance criteria.</template>
      </p>

      <table v-else class="criteria__table" data-criteria-table>
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Statement</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row of board.rows" :key="row.id">
            <tr
              class="criteria__row"
              :data-criterion-row="row.id"
              :data-criterion-conflict="String(row.conflict)"
            >
              <td>
                <button
                  type="button"
                  class="criteria__toggle"
                  :aria-expanded="isExpanded(row.id)"
                  :data-criterion-toggle="row.id"
                  @click="toggle(row.id)"
                >
                  <span aria-hidden="true">{{ isExpanded(row.id) ? '▾' : '▸' }}</span>
                  <code data-criterion-id>{{ row.id }}</code>
                </button>
              </td>
              <td>{{ row.statement ?? '(no statement recorded)' }}</td>
              <td>
                <CriterionStatusChip :status="row.status" />
                <span v-if="row.conflict" class="criteria__conflict" data-conflict-flag>
                  ⚠ conflicting verdicts
                </span>
              </td>
            </tr>
            <tr
              v-if="isExpanded(row.id)"
              class="criteria__detail-row"
              :data-criterion-detail="row.id"
            >
              <td colspan="3">
                <p v-if="row.unmapped" class="criteria__no-gate" data-no-gate-message>
                  {{ NO_GATE_MESSAGE }}
                </p>

                <article
                  v-for="verdict of row.evidence"
                  :key="`${verdict.gate}-${verdict.seq}`"
                  class="criteria__evidence"
                  data-criterion-evidence
                  :data-gate="verdict.gate"
                  :data-outcome="verdict.outcome"
                >
                  <header class="criteria__evidence-head">
                    <span data-evidence-gate>{{ verdict.gate }}</span>
                    <span data-evidence-outcome>{{ verdict.outcome }}</span>
                    <RouterLink :to="seqTo(verdict.seq)" data-seq-link
                      >seq {{ verdict.seq }}</RouterLink
                    >
                  </header>
                  <p class="criteria__evidence-summary" data-evidence-summary>
                    {{ verdict.summary }}
                  </p>

                  <ul v-if="verdict.findings.length > 0" class="criteria__findings">
                    <li
                      v-for="finding of verdict.findings"
                      :key="finding.id"
                      data-evidence-finding
                      :data-finding-id="finding.id"
                    >
                      <p data-finding-message>{{ finding.message }}</p>
                      <RouterLink
                        v-if="diffTo(verdict, finding) !== null"
                        :to="diffTo(verdict, finding) as LocationQueryRaw"
                        data-diff-link
                      >
                        {{ finding.location?.file }}:{{ finding.location?.line }}
                      </RouterLink>
                    </li>
                  </ul>
                </article>

                <p
                  v-if="row.evidence.length === 0 && !row.unmapped"
                  class="criteria__no-evidence"
                  data-no-evidence
                >
                  No gate has judged this criterion yet.
                </p>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </template>
  </section>
</template>

<style scoped>
.criteria {
  display: grid;
  gap: 0.75rem;
  padding: 0.75rem;
  block-size: 100%;
  overflow-y: auto;
  align-content: start;
}

.criteria__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.75rem;
}

.criteria__headline {
  margin: 0;
  font-weight: 600;
}

.criteria__counts {
  display: flex;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--ink-muted);
  font-size: 0.8125rem;
}

.criteria__copy-status {
  margin: 0;
  color: var(--ink-muted);
  font-size: 0.75rem;
}

.criteria__table {
  border-collapse: collapse;
  inline-size: 100%;
  font-size: 0.875rem;
}

.criteria__table th {
  text-align: start;
  color: var(--ink-muted);
  font-weight: 500;
  font-size: 0.75rem;
  padding-block-end: 0.35rem;
  border-block-end: 1px solid var(--edge);
}

.criteria__row td {
  padding: 0.4rem 0.5rem 0.4rem 0;
  border-block-end: 1px solid var(--edge);
  vertical-align: top;
}

.criteria__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: ui-monospace, monospace;
}

.criteria__conflict {
  margin-inline-start: 0.5rem;
  color: var(--state-awaiting-human);
  font-size: 0.75rem;
}

.criteria__detail-row td {
  padding: 0.5rem;
  background: var(--surface-raised);
  border-block-end: 1px solid var(--edge);
}

.criteria__no-gate {
  margin: 0 0 0.5rem;
  color: var(--state-awaiting-human);
  font-weight: 600;
}

.criteria__evidence {
  display: grid;
  gap: 0.25rem;
  padding: 0.4rem 0;
  border-block-start: 1px dashed var(--edge);
}

.criteria__evidence:first-child {
  border-block-start: none;
}

.criteria__evidence-head {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.75rem;
  color: var(--ink-muted);
}

.criteria__evidence-summary {
  margin: 0;
}

.criteria__findings {
  display: grid;
  gap: 0.35rem;
  margin: 0.25rem 0 0;
  padding: 0;
  list-style: none;
}

.criteria__empty {
  color: var(--ink-muted);
  font-size: 0.8125rem;
}
</style>
