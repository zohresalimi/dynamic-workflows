<script setup lang="ts">
/**
 * KAR-17.1 — F10.1's live plan graph. The landing view, and the shell the
 * other eight views hang off.
 *
 * Verifies: EPIC-17-S1, EPIC-17-S2, EPIC-17-S3, EPIC-16-S1 (the two rendering
 * clauses EPIC-16 could not close) · AC1–AC7, AC10
 *
 * This view renders **through `GraphCanvas`** and imports no renderer of its
 * own; `packages/web/scripts/check-graph-facade.ts` fails `pnpm lint` if any
 * view ever reaches past it (KAR-16.6 AC1). What that buys is the thing the
 * roadmap asks for: Vue Flow is the largest third-party risk in this frontend,
 * and replacing it is a change to one directory rather than to every view that
 * ever drew a node.
 *
 * ## What this view is responsible for, and what it is not
 *
 * **It joins and it renders. It does not reduce.** Every value on screen came
 * off a projection through `useRunStore`'s selectors, and the one piece of
 * arithmetic here is `toNodeBody`, which is a pure function in a file of its
 * own with its own spec. There is deliberately no `if` about an event kind
 * anywhere below.
 *
 * **It owns the run's connection** (`../app/useRunFeed.ts`). EPIC-16 shipped
 * `openLedgerStream`, `useRunStore.applyEvent` and this view with no wire
 * between any two of them, so the application opened against a real replay and
 * drew an empty graph however deep the ledger was. The wire is one composable
 * and it is the first thing this view does.
 *
 * **It keeps the shell's UI store in step with the plan.** The keyboard map
 * (`j`/`k`/`Enter`), the Cmd-K jumper and the inspector all read `useUiStore`,
 * which holds the operator's *selection* rather than the ledger's *nodes* —
 * so the plan's node list is pushed into it whenever the plan changes. That is
 * the whole of AC7's traversal: no key handler lives in this file, because a
 * handler bound to a view stops working on every other route (KAR-16.1 AC7).
 *
 * ## The two performance rules this view has to keep
 *
 * 1. **Body objects are memoised by content**, and the memoisation is
 *    `../app/useNodeBodies.ts`'s rather than this file's — because KAR-22.3's
 *    task board renders the *same* join in a different shape, and two copies
 *    of it would be two caches, two tickers and two chances to diverge. The
 *    board and this view hold one array, which is what makes "the board and the
 *    graph cannot disagree" a property rather than an intention (KAR-22.3 AC3).
 * 2. **Nothing here writes a transform or triggers a layout.** Both belong to
 *    the facade, which relays out on the graph's *shape* and not on its
 *    contents (KAR-17.1 AC3).
 */
// The plain-string form, not the branded `SPEC_GATE_NODE`: this view is in the
// landing route's eager graph, and `spec-approval.ts` reaches `ids.ts` and
// through it the whole of zod, which
// `packages/web/test/integration/bundle-budget.test.ts` forbids in the initial
// chunk. `spec-gate-node.ts` exists for exactly this comparison.
import { SPEC_GATE_NODE_ID } from '@DeFlow/core';
import { computed, watch } from 'vue';
import { type LocationQueryRaw, useRoute, useRouter } from 'vue-router';
import { useNodeBodies } from '../app/useNodeBodies.ts';
import { useRunFeed } from '../app/useRunFeed.ts';
import GraphCanvas from '../components/graph/GraphCanvas.vue';
import GraphEmptyNote from '../components/graph/GraphEmptyNote.vue';
import type { NodeBodyVM } from '../components/graph/node-body.ts';
import PlanNode from '../components/graph/PlanNode.vue';
import { useRunStore } from '../stores/useRunStore.ts';
import { useUiStore } from '../stores/useUiStore.ts';

const props = defineProps<{
  /** From `/runs/:runId`. Absent on the bare landing route. */
  readonly runId?: string;
}>();

const ui = useUiStore();
const run = useRunStore();
const route = useRoute();
const router = useRouter();

const runId = computed<string | null>(() => props.runId ?? null);
const { status } = useRunFeed(runId);

/** KAR-25.1 — whether this graph is open at its project-less legacy URL,
 * decided once here rather than per node. See `PlanNode.vue`'s `legacy` prop. */
const legacy = computed(() => typeof route.params['projectId'] !== 'string');

const nodes = computed(() => run.planNodes);
const edges = computed(() => run.planEdges);

/**
 * KAR-27.3 AC4 — which pre-execution state this run is in, for the empty note.
 *
 * The same derivation `ProjectWorkflowsView` makes, and it has to be: the two
 * views mount the same component precisely so an operator moving between them
 * is not told two different things about one run.
 */
const planActivity = computed<'framing' | 'recon' | 'planner' | 'awaiting-spec-approval' | null>(
  () => {
    const turn = run.liveTurnInFlight;
    if (turn !== null) return turn.node;
    return run.openGate?.node === SPEC_GATE_NODE_ID ? 'awaiting-spec-approval' : null;
  },
);

/**
 * The bodies — the shared join, not one of this view's own.
 *
 * @see ../app/useNodeBodies.ts for why there is exactly one of these per store.
 */
const bodies = useNodeBodies();

/** The two already-formatted columns the data-table twin renders (AC10). */
const costs = computed(
  () => new Map([...bodies.value].map(([id, body]) => [id, body.cost] as const)),
);
const durations = computed(
  () => new Map([...bodies.value].map(([id, body]) => [id, body.elapsed] as const)),
);

/**
 * The plan, in the shell's vocabulary.
 *
 * `useUiStore` holds what belongs to *this tab* — the selection, the overlay
 * stack — and it needs the node list to move a selection through it. Pushed
 * from here rather than read from the run store by the store itself, because a
 * UI store that imported a projection would no longer be the half of the split
 * that has nothing to do with the ledger (docs/12 §3.2).
 */
watch(
  nodes,
  (list) => {
    ui.setNodes(list.map((node) => ({ id: node.id, title: node.title, status: node.status })));
  },
  { immediate: true },
);

/**
 * AC7 — the selection, in the URL.
 *
 * `replace` and not `push`: a graph you cannot press Back out of is a graph
 * whose history is thirty entries deep after a minute of holding `j`. What the
 * URL buys is the other direction — a link to a position in a run that opens
 * on the node the sender was looking at, which is half of what makes a
 * five-minute diagnosis shareable (PRD §12).
 */
watch(
  () => ui.selectedNodeId,
  (selected) => {
    const current = route.query['node'];
    if ((selected ?? undefined) === current) return;
    void router.replace({
      query: selected === null ? omitNode(route.query) : { ...route.query, node: selected },
    });
  },
);

function omitNode(query: LocationQueryRaw): LocationQueryRaw {
  const { node: _dropped, ...rest } = query;
  return rest;
}

/**
 * And back the other way, once the plan holding that node has arrived.
 *
 * The node named in the URL is almost never in the store when the view mounts —
 * the graph is hydrated from the daemon a moment later — so this watches the
 * plan rather than the route: the link selects its node as soon as there is a
 * node to select, and says nothing if the run never contained one.
 */
watch(
  [nodes, () => route.query['node']],
  ([list, wanted]) => {
    if (typeof wanted !== 'string' || wanted === ui.selectedNodeId) return;
    if (list.some((node) => node.id === wanted)) ui.selectNode(wanted);
  },
  { immediate: true },
);
</script>

<template>
  <section class="plan-graph" aria-label="Plan graph">
    <GraphCanvas
      :nodes="nodes"
      :edges="edges"
      :selected="ui.selectedNodeId"
      :costs="costs"
      :durations="durations"
      @select="(id: string) => ui.selectNode(id)"
      @activate="(id: string) => { ui.selectNode(id); ui.inspectSelected('inspector'); }"
    >
      <template #node="{ node, selected }">
        <PlanNode
          v-if="bodies.get(node.id) !== undefined"
          :body="bodies.get(node.id) as NodeBodyVM"
          :selected="selected"
          :run-id="runId"
          :legacy="legacy"
        />
      </template>
    </GraphCanvas>

    <!--
      The four sentences moved into `../components/graph/GraphEmptyNote.vue`
      so the project view's pending strip can say the same ones rather than
      spelling a second copy of them. Nothing about *when* they appear moved:
      that is still this view's `nodes.length === 0`, and the placement below
      is still this view's own.
    -->
    <p v-if="nodes.length === 0" class="plan-graph__empty">
      <GraphEmptyNote :run-id="runId" :status="status" :activity="planActivity" />
    </p>
  </section>
</template>

<style scoped>
.plan-graph {
  position: relative;
  height: 100%;
  min-height: 20rem;
}

.plan-graph__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  color: var(--ink-muted);
  pointer-events: none;
  text-align: center;
}

/*
 * The reduced-motion override for `.vue-flow__node` deliberately does NOT live
 * here. It is in ../styles/theme.css, after the `@import` of the renderer's own
 * stylesheet, because a scoped `:deep()` rule would have to out-specify a
 * third-party sheet whose import order this component does not control — and
 * "the media query wraps the wrong rule" is exactly the failure AC8's test is
 * written against.
 */
</style>
