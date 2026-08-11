<script setup lang="ts">
/**
 * KAR-17.9 — F10.4's memory and data-flow graph.
 *
 * Verifies: EPIC-17-S33 · AC1–AC7
 *
 * **This view ships because the measurement said it could.** It was `Blocked`
 * by design until `docs/measurements/vue-flow-400.md` existed and its numbers
 * supported a second Vue Flow surface; they do — 404 nodes inside two frames at
 * the 95th percentile with culling off — and the decision is recorded there
 * beside the number rather than here (EPIC-17-S34).
 *
 * The design decision the roadmap's four arguments turn on is made in
 * **product**, not in rendering ([12 §6.4](../../../../docs/12-frontend-architecture.md)):
 * the default view is one bubble per producing node with a fact count, and a
 * producer's facts appear only when the operator asks for them, one bounded
 * page at a time. The question this answers is *"which node produced the wrong
 * assumption?"*, and the answer to that is never *"here are 3,000 dots"*.
 *
 * **It joins and it renders. It does not reduce.** The aggregation, the paging
 * and the taint marks are `../ledger/projections/memory-graph.ts`'s, asserted
 * without a browser; this file owns three joins that belong above any single
 * projection:
 *
 * 1. **The plan's own titles and states** on the bubbles, so a producer reads
 *    as the node it is rather than as an id.
 * 2. **The complete consumer set**, which is a *request* and not a projection:
 *    `fact.read` events this tab never saw — because it joined mid-run — are
 *    exactly the ones an inference from local edges would miss, so AC3 asks the
 *    daemon (`GET /api/runs/:id/facts/:factId/consumers`).
 * 3. **The expansion state**, which belongs to this tab and to the URL, not to
 *    the ledger.
 *
 * It renders through `GraphCanvas` and imports no renderer of its own —
 * `packages/web/scripts/check-graph-facade.ts` fails `pnpm lint` otherwise —
 * which is what keeps the `sigma` + `graphology` escape hatch a one-file change
 * if a run ever arrives whose expanded graph genuinely needs it.
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { useRunFeed } from '../app/useRunFeed.ts';
import GraphCanvas from '../components/graph/GraphCanvas.vue';
import MemoryNode from '../components/graph/MemoryNode.vue';
import type { FactVM } from '../ledger/projections/blackboard.ts';
import {
  MEMORY_EXPANDED_CAP,
  type MemoryNodeVM,
  memoryGraph,
} from '../ledger/projections/memory-graph.ts';
import { useRunStore } from '../stores/useRunStore.ts';

const props = defineProps<{
  /** From `/runs/:runId/memory`. */
  readonly runId?: string;
}>();

const run = useRunStore();
const route = useRoute();
const router = useRouter();
const client = useApiClient();

const runId = computed<string | null>(() => props.runId ?? null);
const { status } = useRunFeed(runId);

/** Which producers are open, and at which page. This tab's state, not the run's. */
const expanded = ref(new Set<string>());
const pages = ref(new Map<string, number>());

/**
 * The graph.
 *
 * `run.version('blackboard')` is the dependency: the projections mutate their
 * state in place and the store bumps one integer per projection, so a
 * `computed` that only read `run.blackboard` would never recompute
 * (docs/12 §3.3). The plan's nodes are passed in so a bubble carries the
 * node's own title and display state.
 */
const graph = computed(() => {
  void run.version('blackboard');
  void run.version('plan');
  return memoryGraph(run.blackboard, {
    expanded: expanded.value,
    pages: pages.value,
    plan: new Map(run.planNodes.map((node) => [node.id, node] as const)),
  });
});

const nodes = computed(() => graph.value.nodes);
const edges = computed(() => graph.value.edges);

const bodies = computed<ReadonlyMap<string, MemoryNodeVM>>(
  () => new Map(nodes.value.map((node) => [node.id, node] as const)),
);

/** The selected graph node — `node:<id>` or `fact:<factId>` — from the URL. */
const selected = computed<string | null>(() =>
  typeof route.query['at'] === 'string' ? route.query['at'] : null,
);

/** The fact whose detail panel is open, if the selection is a fact. */
const openFact = computed<FactVM | null>(() => {
  void run.version('blackboard');
  const at = selected.value;
  if (at === null || !at.startsWith('fact:')) return null;
  return run.blackboard.facts.get(at.slice('fact:'.length)) ?? null;
});

function select(id: string): void {
  if (id === selected.value) return;
  void router.replace({ query: { ...route.query, at: id } });
}

function toggle(node: string): void {
  const next = new Set(expanded.value);
  if (next.has(node)) next.delete(node);
  else next.add(node);
  expanded.value = next;
}

function turn(detail: { node: string; by: number }): void {
  const next = new Map(pages.value);
  next.set(detail.node, Math.max(0, (next.get(detail.node) ?? 0) + detail.by));
  pages.value = next;
}

// ── the consumer set, which is a request ────────────────────────────────────

/** One row of `GET /api/runs/:id/facts/:factId/consumers`. */
interface ConsumerRow {
  readonly node: string;
  readonly firstReadSeq: number;
  readonly reads: number;
}

const consumers = ref<readonly ConsumerRow[]>([]);
const consumersFailure = ref<string | null>(null);

/**
 * Asks the daemon who read the open fact.
 *
 * Deliberately **not** a `@pinia/colada` query: *"if the answer changes because
 * an event was appended, it is a projection; if it changes because a file on
 * disk changed, it is a query"* (`../api/queries.ts`), and a consumer set
 * changes on the next `fact.read`. Putting it behind a fetch cache would mean
 * two sources of truth that disagree for as long as the stale window.
 */
watch(
  [runId, openFact],
  async ([id, fact]) => {
    consumers.value = [];
    consumersFailure.value = null;
    if (id === null || fact === null) return;
    try {
      const response = await client.runs[':id'].facts[':factId'].consumers.$get({
        param: { id, factId: fact.id },
      });
      if (!response.ok) {
        consumersFailure.value = `the daemon refused this consumer set with ${String(
          response.status,
        )}`;
        return;
      }
      consumers.value = (await response.json()) as readonly ConsumerRow[];
    } catch (error) {
      consumersFailure.value = error instanceof Error ? error.message : String(error);
    }
  },
  { immediate: true },
);
</script>

<template>
  <section class="memory" aria-label="Memory and data-flow graph">
    <header class="memory__head">
      <h1 class="memory__title">Blackboard</h1>
      <p class="memory__summary" data-memory-summary>
        {{ graph.facts }}
        fact{{ graph.facts === 1 ? '' : 's' }}
        from
        {{ nodes.filter((node) => node.memory.factCount > 0).length }}
        node{{ nodes.filter((node) => node.memory.factCount > 0).length === 1 ? '' : 's' }}. Facts
        are shown one writer at a time — open a node to read them.
      </p>
      <p v-if="graph.truncated" class="memory__truncated" data-memory-truncated>
        Showing {{ MEMORY_EXPANDED_CAP }} facts. Close a node to open another.
      </p>
    </header>

    <div class="memory__canvas">
      <GraphCanvas
        :nodes="nodes"
        :edges="edges"
        :selected="selected"
        @select="select"
        @activate="select"
      >
        <template #node="{ node, selected: isSelected }">
          <MemoryNode
            v-if="bodies.get(node.id) !== undefined"
            :node="bodies.get(node.id) as MemoryNodeVM"
            :selected="isSelected"
            @toggle="toggle"
            @page="turn"
          />
        </template>
      </GraphCanvas>
    </div>

    <!--
      AC3 — the provenance an operator arrived for, beside the consumer set the
      daemon answered with. The two halves come from different places on
      purpose: provenance travels *on* the fact, and "who used it" is a query.
    -->
    <aside
      v-if="openFact !== null"
      class="memory__detail"
      :data-fact-detail="openFact.id"
      aria-label="Fact provenance"
    >
      <h2 class="memory__detail-title">
        <code>{{ openFact.key }}</code>
        <button type="button" class="memory__close" @click="select('')">Close</button>
      </h2>

      <dl class="memory__provenance">
        <dt>Written by</dt>
        <dd data-provenance-node>
          {{ openFact.provenance.byNode }}
          ({{ openFact.provenance.byProvider }},
          {{ openFact.provenance.byModel }})
        </dd>
        <dt>At</dt>
        <dd data-provenance-at>
          {{ openFact.provenance.at }}
          (event {{ openFact.provenance.atEvent }})
        </dd>
        <dt>Confidence</dt>
        <dd data-provenance-confidence>{{ openFact.provenance.confidence }}</dd>
        <dt>Evidence</dt>
        <dd>
          <ul class="memory__evidence">
            <li v-for="handle in openFact.provenance.fromEvidence" :key="handle">
              <code data-evidence-handle>{{ handle }}</code>
            </li>
            <li v-if="openFact.provenance.fromEvidence.length === 0">
              None recorded — this fact was asserted rather than evidenced.
            </li>
          </ul>
        </dd>
      </dl>

      <p v-if="openFact.invalid !== null" class="memory__invalid" data-fact-invalid>
        Invalidated by <code>{{ openFact.invalid.by }}</code> at event
        {{ openFact.invalid.seq }}: {{ openFact.invalid.reason }}
      </p>
      <ul v-if="openFact.invalid !== null" class="memory__taints">
        <li v-for="node in openFact.invalid.taints" :key="node" :data-taint-node="node">
          <code>{{ node }}</code>
          consumed it before it was withdrawn
        </li>
      </ul>

      <h3 class="memory__detail-subtitle">Read by</h3>
      <p v-if="consumersFailure !== null" class="memory__failure" data-consumers-failure>
        {{ consumersFailure }}
      </p>
      <ul class="memory__consumers">
        <li v-for="row in consumers" :key="row.node" :data-fact-consumer="row.node">
          <code>{{ row.node }}</code>
          — {{ row.reads }} read{{ row.reads === 1 ? '' : 's' }}, first at event
          {{ row.firstReadSeq }}
        </li>
        <li v-if="consumers.length === 0 && consumersFailure === null" data-no-consumers>
          Nothing has read this fact.
        </li>
      </ul>
    </aside>

    <p v-if="graph.facts === 0" class="memory__empty">
      <template v-if="runId === null">
        No run open. Open one at <code>/runs/&lt;runId&gt;/memory</code>.
      </template>
      <template v-else-if="status === 'hydrating'">Reading the run's ledger…</template>
      <template v-else>
        No facts yet. The blackboard fills as nodes write what they learned.
      </template>
    </p>
  </section>
</template>

<style scoped>
.memory {
  display: grid;
  grid-template-rows: auto 1fr;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.75rem;
  height: 100%;
  min-height: 20rem;
  padding: 0.75rem;
}

.memory__head {
  grid-column: 1 / -1;
  display: grid;
  gap: 0.2rem;
}

.memory__title {
  margin: 0;
  font-size: 1.05rem;
}

.memory__summary,
.memory__truncated {
  margin: 0;
  color: var(--ink-muted);
  font-size: 0.85rem;
}

.memory__canvas {
  position: relative;
  min-height: 18rem;
}

.memory__detail {
  width: min(24rem, 40vw);
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-raised);
  font-size: 0.85rem;
}

.memory__detail-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  overflow-wrap: anywhere;
}

.memory__detail-subtitle {
  margin: 0.75rem 0 0.25rem;
  font-size: 0.9rem;
}

.memory__close {
  border: 1px solid var(--edge);
  border-radius: 0.35rem;
  background: var(--surface);
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  padding: 0.1rem 0.4rem;
  cursor: pointer;
}

.memory__provenance {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.2rem 0.5rem;
  margin: 0;
}

.memory__provenance dt {
  color: var(--ink-muted);
}

.memory__provenance dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.memory__evidence,
.memory__taints,
.memory__consumers {
  margin: 0;
  padding-left: 1rem;
  overflow-wrap: anywhere;
}

.memory__invalid {
  margin: 0.6rem 0 0.2rem;
  color: var(--state-failed);
}

.memory__failure {
  margin: 0;
  color: var(--state-failed);
}

.memory__empty {
  grid-column: 1 / -1;
  color: var(--ink-muted);
  text-align: center;
}
</style>
