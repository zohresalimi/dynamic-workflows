<script setup lang="ts">
/**
 * KAR-17.2 — F10.2's plan-evolution scrubber, and the marquee feature
 * (docs/12-frontend-architecture.md §6.2).
 *
 * Verifies: EPIC-17-S5, EPIC-17-S6, EPIC-17-S7, EPIC-17-S8, EPIC-17-S9,
 * EPIC-17-S10, EPIC-15-S47 (the two lines deferred to this epic) ·
 * AC1–AC9
 *
 * > *"Why is there a step here that I didn't ask for?"* — answered in one
 * > click, instead of by reading a log.
 *
 * ## Nothing here is derived in the tab
 *
 * The rule KAR-15.7's snapshot endpoint was built to make keepable, and it is
 * what EPIC-15-S47 asserts directly:
 *
 * - Each **position** is `createScrubber(...).positionAt(seq)` — one
 *   `…/snapshot?seq=<N>` request, from `../api/scrub.ts`, which is the only way
 *   either client materialises the state at a `seq`. This view writes no second
 *   client and folds no events, so scrubbing a 10,000-event run applies zero
 *   events below the snapshot `seq` in the browser (AC7).
 * - Each **plan document** is `GET …/plans/:version`, which is content-addressed
 *   and `immutable`: version 3 of a run's plan is the same bytes for as long as
 *   the ledger exists. That is where both versions' node and edge documents come
 *   from, and it is why the union graph costs two cacheable reads rather than a
 *   fold.
 * - Each step's **diff** is `GET …/plans/diff?from=N&to=M`. Emphatically *not*
 *   computed from the two documents this view is already holding, even though it
 *   could be: `diffPlanGraphs` is `@DeFlow/daemon`'s, it is what the endpoint
 *   runs, and two implementations of a diff is two answers to "what changed".
 * - The **rail** is `GET …/plans` for the versions and `GET …/patches` for the
 *   marks that are not versions — the proposals that were recorded and refused
 *   (AC1). A rail built from versions alone cannot show a refusal, and a planner
 *   looping on one refused change is exactly the pattern the rail exists to
 *   surface.
 *
 * ## The one thing this view computes for itself, and why
 *
 * **The union layout** (`../components/graph/union-layout.ts`), because the
 * server computes no coordinates — it returns a `unionLayoutKey` and nothing
 * else. Every node and edge in *either* version is laid out once and both
 * versions render at those coordinates, so **nothing moves as you scrub**
 * (AC3). That property is the whole value of the view: on a real 40-node replan
 * a reflow between adjacent versions is larger than the eye can track, and the
 * operator ends up diffing by hand, which is the thing this exists to remove.
 *
 * ## Two modes, and the secondary one stays secondary
 *
 * Stepping between **adjacent** versions is the primary path and always uses the
 * union layout. Comparing two versions that are **not** adjacent (AC8) is a
 * different pair, so it is a different union and therefore a full reflow, with
 * the renderer's own transform transition as the FLIP — and it is labelled as a
 * comparison so an operator can tell which mode they are in. Under
 * `prefers-reduced-motion: reduce` the animation does not play and the
 * comparison renders directly.
 */
import { useMediaQuery } from '@vueuse/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { createScrubber, type ScrubPosition } from '../api/scrub.ts';
import GraphCanvas from '../components/graph/GraphCanvas.vue';
import PlanDiffNode from '../components/graph/PlanDiffNode.vue';
import { createUnionLayoutCache, type UnionPositions } from '../components/graph/union-layout.ts';
import type { PlanNodeVM } from '../ledger/vm.ts';
import {
  type DiffClass,
  edgeClassesOf,
  nodeClassesOf,
  type PlanDiffDocument,
  type PlanGraphShape,
  type PlanVersionGraph,
  type PlanVersionNodeVM,
  patchOfChangedNode,
  planGraphVMs,
  unionGraphOf,
} from '../lib/plan-diff.ts';
import { describeOperations, escalationIn } from '../lib/plan-patch.ts';
import { useUiStore } from '../stores/useUiStore.ts';

const props = defineProps<{ readonly runId?: string }>();

const ui = useUiStore();
const client = useApiClient();

interface PlanVersionRow {
  readonly version: number;
  readonly seq: number;
  readonly planHash: string;
  readonly decision: string | null;
  readonly reason: string | null;
}

/** One row of `GET …/patches`: a proposal, and what became of it. */
interface PlanPatchRow {
  readonly patchId: string;
  readonly seq: number;
  readonly reason: string;
  readonly proposedBy: string | null;
  readonly outcome: 'applied' | 'rejected' | 'queued' | 'pending';
  readonly decidedSeq: number | null;
  readonly version: number | null;
  readonly decision: string | null;
  readonly rule: string | null;
  readonly by: string | null;
}

interface PlanEdgeShape {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

const rail = ref<readonly PlanVersionRow[]>([]);
const patches = ref<readonly PlanPatchRow[]>([]);
const position = ref<ScrubPosition | null>(null);
const diff = ref<PlanDiffDocument | null>(null);
const failure = ref<string | null>(null);

/** The two versions' plan documents, in the view-model vocabulary. */
const beforeGraph = ref<PlanVersionGraph>({ nodes: [], edges: [] });
const afterGraph = ref<PlanVersionGraph>({ nodes: [], edges: [] });
const positions = ref<UnionPositions | null>(null);

/** Which changed node's field-level patch is open, and which mark's proposal. */
const openPatchNode = ref<string | null>(null);
const openRejection = ref<string | null>(null);

/**
 * The version the operator chose to compare *from*, or `null` for stepping.
 *
 * Held rather than derived, because "compare v1 with v4" and "step from v3 to
 * v4" are different intentions that can both be true of the same `to`, and a
 * view that inferred it would drop the operator back into stepping the moment
 * `to - 1` happened to be selected.
 */
const compareFrom = ref<number | null>(null);

/**
 * The version `position`, `diff` and the graph describe.
 *
 * Held beside them rather than inferred, so that a position still in flight
 * renders as "…" instead of as the *previous* version's `seq` under the new
 * version's label. That mislabelling is invisible on a fast local daemon and
 * wrong every time.
 */
const shownVersion = ref<number | null>(null);
const shownPair = ref<string | null>(null);

const runId = computed(() => props.runId ?? '');

/** AC8's third scenario: the FLIP does not play when motion is not wanted. */
const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

/**
 * One scrubber per run, and it is the cache: positions are held by the `seq`
 * they *reflect*, so dragging back over ground already covered is free and
 * dragging onto a `seq` this run never committed still lands on the state the
 * server says it lands on.
 */
const scrubber = computed(() =>
  runId.value === '' ? null : createScrubber(client, runId.value, { replayWindow: 0 }),
);

/**
 * The union layouts, one per version pair.
 *
 * Owned by the view rather than by the canvas, because the canvas lays out the
 * graph it is *given* and the whole point here is that two different graphs are
 * drawn at one set of coordinates (AC3, AC6).
 */
const layouts = createUnionLayoutCache();
onBeforeUnmount(() => layouts.dispose());

/** The plan documents already fetched, by version. Immutable, so forever. */
const documents = new Map<number, PlanVersionGraph>();

const seqOf = (version: number): number | null =>
  rail.value.find((row) => row.version === version)?.seq ?? null;

const at = computed(() => ui.planVersion);

/**
 * The **transition** on screen: two versions, laid out once, both rendered at
 * those coordinates.
 *
 * The single most important state in this view, and the one thing that must not
 * be derived from the position alone. A pair derived as `(v - 1, v)` recomputes
 * on every step, which means a new union, a new layout and a graph that reflows
 * on every keystroke — the failure the whole story is written against.
 *
 * So the pair **persists while the operator moves between its two endpoints**:
 * `→` from v3 to v4 and `←` back again stay inside the pair `(3, 4)`, which is
 * one ELK call and byte-identical coordinates both ways (AC3, AC6). Moving to a
 * version outside it rebases to the transition that *produced* that version.
 */
const pair = ref<{ readonly lower: number; readonly upper: number } | null>(null);

/** The transition that produced `version` — or the one ahead, at the first. */
function transitionFor(version: number): { lower: number; upper: number } | null {
  const has = (candidate: number) => rail.value.some((row) => row.version === candidate);
  if (has(version - 1)) return { lower: version - 1, upper: version };
  if (has(version + 1)) return { lower: version, upper: version + 1 };
  return null;
}

const isEndpoint = (version: number): boolean =>
  pair.value !== null && (version === pair.value.lower || version === pair.value.upper);

/** `step` for an adjacent pair, `compare` when the operator asked for one. */
const mode = computed<'step' | 'compare'>(() =>
  compareFrom.value !== null && compareFrom.value !== (at.value ?? 0) - 1 ? 'compare' : 'step',
);

/** True while the operator is standing on the newer half of the transition. */
const onNewer = computed(() => pair.value !== null && at.value === pair.value.upper);

/** The versions a comparison may start from: everything before the position. */
const comparableVersions = computed(() =>
  rail.value.filter((row) => at.value !== null && row.version < at.value),
);

/**
 * The version rail.
 *
 * Every failure lands in `failure` and is rendered, rather than escaping into
 * an unhandled rejection inside a watcher: the daemon can be restarting, the
 * run can have been reaped, and a scrubber that answers a dead run with a
 * silent blank panel is indistinguishable from one that is still loading.
 */
async function loadRail(): Promise<void> {
  if (runId.value === '') return;
  try {
    const response = await client.runs[':id'].plans.$get({
      param: { id: runId.value },
      // The daemon's own bound applies: the rail is a grouped, bounded
      // statement rather than a fold, and asking for "all of them" is how a
      // nine-hour run with forty replans becomes a scroll nobody reads.
      query: { limit: undefined },
    });
    if (!response.ok) {
      failure.value = `the version rail could not be read (${response.status})`;
      return;
    }
    rail.value = (await response.json()) as readonly PlanVersionRow[];
    failure.value = null;
    ui.setPlanVersions(rail.value.map((row) => row.version));
  } catch (cause) {
    failure.value = `the version rail could not be read (${String(cause)})`;
  }
}

/**
 * AC1's other half: the proposals that never became versions.
 *
 * A failure here is **not** a rendered error. The rail is still a rail without
 * its refusals — an older daemon has no such route at all — and blanking the
 * marquee view over a supplementary read would be a worse answer than showing
 * the versions.
 */
async function loadPatches(): Promise<void> {
  if (runId.value === '') return;
  try {
    const response = await client.runs[':id'].patches.$get({
      param: { id: runId.value },
      query: { limit: undefined },
    });
    patches.value = response.ok ? ((await response.json()) as readonly PlanPatchRow[]) : [];
  } catch {
    patches.value = [];
  }
}

/** The immutable plan document at `version`, fetched once and kept. */
async function documentAt(version: number): Promise<PlanVersionGraph> {
  const held = documents.get(version);
  if (held !== undefined) return held;

  try {
    const response = await client.runs[':id'].plans[':version'].$get({
      param: { id: runId.value, version: String(version) },
    });
    const graph = response.ok
      ? planGraphVMs((await response.json()) as PlanGraphShape)
      : { nodes: [], edges: [] };
    documents.set(version, graph);
    return graph;
  } catch {
    return { nodes: [], edges: [] };
  }
}

async function loadDiff(from: number | null, to: number): Promise<PlanDiffDocument | null> {
  if (from === null) {
    // v1 has no predecessor: the initial compile is not a patch, and inventing
    // a diff against the empty graph would render every node as "added".
    return null;
  }

  try {
    const response = await client.runs[':id'].plans.diff.$get({
      param: { id: runId.value },
      query: { from: String(from), to: String(to) },
    });
    return response.ok ? ((await response.json()) as PlanDiffDocument) : null;
  } catch {
    return null;
  }
}

/**
 * Everything one scrub position needs, in one place: the state at that
 * version's `seq`, both versions' plan documents, and the diff between them.
 *
 * Awaited together rather than in sequence so a step costs one round trip's
 * latency rather than four — and every one of them is either already cached in
 * this tab or `immutable` on the wire.
 */
async function goTo(
  version: number,
  showing: { lower: number; upper: number } | null,
): Promise<void> {
  const seq = seqOf(version);
  const current = scrubber.value;
  if (seq === null || current === null) return;

  const key = showing === null ? `${version}:${version}` : `${showing.lower}:${showing.upper}`;
  /** Still the position and pair this call was made for? */
  const stillWanted = () =>
    ui.planVersion === version &&
    (showing === null
      ? pair.value === null
      : pair.value?.lower === showing.lower && pair.value.upper === showing.upper);

  shownVersion.value = null;
  shownPair.value = null;
  openPatchNode.value = null;

  let reached: ScrubPosition;
  let nextDiff: PlanDiffDocument | null;
  let older: PlanVersionGraph;
  let newer: PlanVersionGraph;
  try {
    [reached, nextDiff, older, newer] = await Promise.all([
      current.positionAt(seq),
      showing === null ? Promise.resolve(null) : loadDiff(showing.lower, showing.upper),
      documentAt(showing?.lower ?? version),
      documentAt(showing?.upper ?? version),
    ]);
  } catch (cause) {
    failure.value = `plan v${version} could not be hydrated (${String(cause)})`;
    return;
  }

  // A step that outran this request has already asked for somewhere else;
  // landing the stale answer would show the operator a version they left.
  if (!stillWanted()) return;

  position.value = reached;
  diff.value = nextDiff;
  beforeGraph.value = older;
  afterGraph.value = newer;

  const union = unionGraphOf(
    older,
    newer,
    // The server's key, which names the pair and never coordinates (KAR-11.5
    // AC4). The fallback is only for a version with no transition at all.
    nextDiff?.unionLayoutKey ?? `${runId.value}:union:${key}`,
  );
  let laidOut: UnionPositions;
  try {
    laidOut = await layouts.positionsFor(
      union.key,
      union.nodes as readonly PlanNodeVM[],
      union.edges,
    );
  } catch {
    // A worker that failed to start must not blank the view: the diff table
    // below is the same information in a form that needs no layout at all.
    laidOut = new Map();
  }

  if (!stillWanted()) return;
  positions.value = laidOut;
  shownVersion.value = version;
  shownPair.value = key;
}

watch(
  runId,
  () => {
    documents.clear();
    pair.value = null;
    void loadRail();
    void loadPatches();
  },
  { immediate: true },
);

/**
 * Where a move lands the transition.
 *
 * **Inside the pair, the pair does not move.** That is the whole of AC3 and
 * half of AC6: `←` and `→` between v3 and v4 both stay on the transition
 * `(3, 4)`, so both versions render at the coordinates ELK produced once for
 * their union, and re-scrubbing costs no worker message at all. A move to a
 * version the pair does not contain rebases onto the transition that produced
 * it — which is the next patch along, and a new union by construction.
 */
watch(at, (version) => {
  openRejection.value = null;
  // A move ends a comparison. "Compare v1 with v4" is a statement about v4, and
  // carrying it onto v2 would silently compare a pair nobody asked for — which
  // is the way a secondary mode stops being secondary.
  compareFrom.value = null;
  if (version === null) return;
  // A **step** between the two halves of one transition stays on it: that is
  // one union, one ELK call and byte-identical coordinates both ways (AC3,
  // AC6). A **pick** off the rail is a jump to that version, and shows the
  // patch that produced it — which is what EPIC-15-S47 asserts and what makes
  // "drag back to v1" mean the plan as approved rather than wherever the
  // previous pair happened to reach.
  if (ui.planMove === 'step' && isEndpoint(version)) return;
  pair.value = transitionFor(version);
});

watch(
  [at, pair, compareFrom],
  ([version]) => {
    if (version !== null) void goTo(version, pair.value);
  },
  { immediate: true },
);

/** The position, only while it is the one the rail is pointing at. */
const settled = computed(
  () => shownVersion.value !== null && shownVersion.value === ui.planVersion,
);

const settledPosition = computed(() => (settled.value ? position.value : null));
/** Likewise: a diff belongs to a pair, and a stale one mislabels the pair. */
const settledDiff = computed(() => (settled.value ? diff.value : null));

/** The union graph currently on screen. */
const union = computed(() =>
  unionGraphOf(beforeGraph.value, afterGraph.value, shownPair.value ?? ''),
);

/**
 * What is actually **drawn**, which is not the whole union at both ends of it.
 *
 * The union is the *layout* — every node in either version, placed once, so
 * nothing moves (AC3). The *drawing* is the version the operator is standing on:
 *
 * - On the **newer** half, the whole union: the version's own nodes, plus the
 *   nodes the patch removed, rendered in place at reduced opacity. A node that
 *   simply vanished would be indistinguishable from one that moved off screen,
 *   which is why the union includes both versions in the first place (AC4).
 * - On the **older** half, that version and nothing else — *"the plan exactly as
 *   it was approved, and no other nodes"* (AC2). The nodes the next patch is
 *   about to add have not been added yet, and drawing them here would be a
 *   picture of a plan nobody ever ran.
 *
 * Stepping between the two therefore adds and removes boxes without moving a
 * single one of the boxes that survive, which is the whole trick.
 */
const drawnNodes = computed<readonly PlanVersionNodeVM[]>(() => {
  if (!settled.value) return [];
  if (onNewer.value || pair.value === null) return union.value.nodes;
  const here = new Set(beforeGraph.value.nodes.map((node) => node.id));
  return union.value.nodes.filter((node) => here.has(node.id));
});

const unionNodes = computed<readonly PlanNodeVM[]>(() => drawnNodes.value as readonly PlanNodeVM[]);

const unionEdges = computed(() => {
  if (!settled.value) return [];
  if (onNewer.value || pair.value === null) return union.value.edges;
  const drawn = new Set(drawnNodes.value.map((node) => node.id));
  return union.value.edges.filter((edge) => drawn.has(edge.from) && drawn.has(edge.to));
});

/** The `positions` binding, present only once there is a layout to bind. */
const placement = computed(() => (positions.value === null ? {} : { positions: positions.value }));

/**
 * Every union node's class.
 *
 * A version with no predecessor has no diff, and every node in it is
 * `unchanged` — *"the plan exactly as it was approved"*. Calling them `added`
 * would be a diff against the empty graph, which is a statement about nothing.
 */
const nodeClasses = computed<ReadonlyMap<string, DiffClass>>(() => {
  const document = settledDiff.value;
  // On the older half of a transition the patch has not happened yet, so
  // nothing carries a mark: the diff is what the operator sees when they step
  // *forward* into it, which is what makes the step legible as a change.
  if (document === null || !onNewer.value) return new Map();
  return nodeClassesOf(document);
});

const edgeClasses = computed<ReadonlyMap<string, DiffClass>>(() => {
  const document = settledDiff.value;
  if (document === null || !onNewer.value) return new Map();
  return edgeClassesOf(document, union.value);
});

const classOf = (nodeId: string): DiffClass => nodeClasses.value.get(nodeId) ?? 'unchanged';

const nodeById = computed(() => new Map(union.value.nodes.map((node) => [node.id, node] as const)));

const diffNode = (node: PlanNodeVM): PlanVersionNodeVM =>
  nodeById.value.get(node.id) ?? { ...node, derivedFrom: [] };

/**
 * What the reason panel says.
 *
 * AC2 — *"the reason panel always shows the `reason` string from the
 * `plan.patched` event for the transition being viewed"*. The transition being
 * viewed is the one that produced the version the operator is standing on, and
 * the string comes off `GET …/plans`, which joins it in verbatim from the
 * proposal. Never summarised: the reason is the human half of the answer, and
 * the whole diagnostic value of the panel is that it can disagree with the
 * machine diff beside it.
 */
const transition = computed(() => {
  const version = at.value;
  if (version === null) return null;
  const row = rail.value.find((one) => one.version === version) ?? null;
  const showing = pair.value;
  return {
    version,
    row,
    pair: showing === null ? `${version}:${version}` : `${showing.lower}:${showing.upper}`,
    compare: mode.value === 'compare' ? showing : null,
  };
});

/** The tick colour for a decision — a custom property, never a literal. */
function tickColour(decision: string | null): string {
  switch (decision) {
    case 'auto':
      return 'var(--state-running)';
    case 'approved':
      return 'var(--state-passed)';
    case 'rejected':
      return 'var(--state-failed)';
    case 'queued':
      return 'var(--state-awaiting-human)';
    default:
      return 'var(--edge)';
  }
}

/** AC5's field-level panel, for the changed node the operator clicked. */
const openPatch = computed(() => {
  const nodeId = openPatchNode.value;
  const document = settledDiff.value;
  if (nodeId === null || document === null) return null;

  const operations = patchOfChangedNode(document, nodeId);
  if (operations === null) return null;

  const before = beforeGraph.value.nodes.find((node) => node.id === nodeId)?.permission ?? null;
  return {
    nodeId,
    lines: describeOperations(operations, before),
    escalation: escalationIn(operations, before),
    reason: document.reason,
    decision: document.decision,
    patchId: patchIdFor(document.to),
  };
});

/** The patch that produced a version, for the panel's NF10 deep link. */
function patchIdFor(version: number): string | null {
  return patches.value.find((row) => row.version === version)?.patchId ?? null;
}

const rejections = computed(() => patches.value.filter((row) => row.outcome === 'rejected'));

const openRejectionRow = computed(
  () => rejections.value.find((row) => row.patchId === openRejection.value) ?? null,
);

/**
 * AC8's secondary mode, entered explicitly and never by accident.
 *
 * It sets the pair directly rather than letting the position watcher derive it:
 * the position has not moved, so nothing else would notice. A non-adjacent pair
 * is a different union and therefore a full reflow — which is exactly why this
 * is a deliberate control and not something stepping can wander into.
 */
function onCompareFrom(event: Event): void {
  const chosen = Number((event.target as HTMLSelectElement).value);
  const version = at.value;
  if (!Number.isInteger(chosen) || version === null) return;
  compareFrom.value = chosen;
  pair.value = { lower: Math.min(chosen, version), upper: Math.max(chosen, version) };
}

const edgeRowId = (edge: PlanEdgeShape) => `${edge.from}→${edge.to}:${edge.kind}`;

const nodeRows = computed(() => {
  const current = settledDiff.value;
  if (current === null) return [];
  return [
    ...current.nodes.added.map((id) => ({ kind: 'node-added', id, note: 'added' })),
    ...current.nodes.removed.map((id) => ({ kind: 'node-removed', id, note: 'removed' })),
    ...current.nodes.changed.map((node) => ({
      kind: 'node-changed',
      id: node.id,
      note: node.patch.map((operation) => `${operation.op} ${operation.path}`).join(', '),
    })),
    ...current.nodes.unchanged.map((id) => ({ kind: 'node-unchanged', id, note: 'unchanged' })),
  ];
});

const edgeRows = computed(() => {
  const current = settledDiff.value;
  if (current === null) return [];
  return [
    ...current.edges.added.map((edge) => ({
      kind: 'edge-added',
      id: edgeRowId(edge as PlanEdgeShape),
      note: 'added',
    })),
    ...current.edges.removed.map((edge) => ({
      kind: 'edge-removed',
      id: edgeRowId(edge as PlanEdgeShape),
      note: 'removed',
    })),
  ];
});
</script>

<template>
  <section
    class="plan-evolution"
    aria-label="Plan evolution"
    :data-scrub-mode="mode"
    :data-flip="reduceMotion ? 'off' : 'on'"
  >
    <h1 class="plan-evolution__title">Plan evolution</h1>
    <p class="plan-evolution__run">{{ runId || 'no run selected' }}</p>
    <p v-if="failure" class="plan-evolution__failure" role="alert">{{ failure }}</p>

    <!--
      The rail. Every mark is a real button, so the whole scrubber is reachable
      by Tab as well as by the `←` / `→` map, and each carries what it names as
      data rather than as a position on screen.
    -->
    <ol class="version-rail" aria-label="Plan versions">
      <li v-for="row in rail" :key="`v${row.version}`">
        <button
          class="version-rail__marker"
          type="button"
          data-rail-kind="version"
          :data-rail-version="row.version"
          :data-seq="row.seq"
          :data-plan-hash="row.planHash"
          :data-decision="row.decision ?? 'none'"
          :style="{ '--tick': tickColour(row.decision) }"
          :aria-current="row.version === ui.planVersion ? 'true' : undefined"
          :aria-label="`Plan v${row.version}, ${row.decision ?? 'the initial compile'}, at seq ${row.seq}`"
          @click="ui.selectPlanVersion(row.version)"
        >
          v{{ row.version }}
        </button>
      </li>

      <!--
        AC1 — the proposals that were refused. Square rather than round, and
        carrying a "✕" rather than a version number: a mark that differed only
        by hue would be a mark 8% of readers cannot find.
      -->
      <li v-for="row in rejections" :key="row.patchId">
        <button
          class="version-rail__rejected"
          type="button"
          data-rail-kind="rejected"
          :data-rail-rejected="row.patchId"
          :data-seq="row.seq"
          :data-rule="row.rule ?? ''"
          :data-by="row.by ?? ''"
          :style="{ '--tick': tickColour('rejected') }"
          :aria-label="`Refused proposal ${row.patchId}, by ${row.by ?? 'policy'}, rule ${row.rule ?? 'unnamed'}`"
          @click="openRejection = row.patchId"
        >
          ✕
        </button>
      </li>
    </ol>

    <p
      v-if="ui.planVersion !== null"
      class="plan-evolution__position"
      :data-scrub-version="ui.planVersion"
      :data-scrub-seq="settledPosition?.seq ?? ''"
    >
      <span>Plan v{{ ui.planVersion }}</span>
      <span class="plan-evolution__seq">at seq {{ settledPosition?.seq ?? '…' }}</span>
      <span class="plan-evolution__hydration">
        hydrated by {{ settledPosition?.hydratedBy ?? '…' }}
      </span>
    </p>

    <!--
      AC8's secondary mode, and it is deliberately a small control off to one
      side: stepping is the primary path, and a comparison picker given equal
      weight is an invitation to reach for the reflow that the union layout
      exists to avoid.
    -->
    <p v-if="comparableVersions.length > 0" class="plan-evolution__compare">
      <label :for="'compare-from'">Compare with</label>
      <select
        id="compare-from"
        data-compare-from
        :value="String(compareFrom ?? pair?.lower ?? '')"
        @change="onCompareFrom"
      >
        <option v-for="row in comparableVersions" :key="row.version" :value="String(row.version)">
          v{{ row.version }}
        </option>
      </select>
    </p>

    <!--
      AC2 — the reason, verbatim from the `plan.patched` event's own `reason`
      field, for the transition being viewed. Never a summary: the reason is
      what makes the machine diff diagnostic.
    -->
    <section v-if="transition" class="reason" data-reason-panel :data-transition="transition.pair">
      <h2 class="reason__title">
        <template v-if="transition.compare">
          Comparing v{{ transition.compare.lower }}
          with v{{ transition.compare.upper }}
        </template>
        <template v-else>Plan v{{ transition.version }}</template>
      </h2>
      <p class="reason__body">
        <span class="reason__decision"
          >{{ transition.row?.decision ?? 'the initial compile' }}</span
        >
        <span class="reason__reason"
          >{{ transition.row?.reason ?? 'the initial plan, proposed by the planner' }}</span
        >
      </p>
    </section>

    <div class="plan-evolution__graph">
      <!--
        `v-bind` rather than `:positions`, and it is not a style choice: under
        `exactOptionalPropertyTypes` an absent prop and a prop holding
        `undefined` are different types, so "no layout yet" has to be an absent
        *binding*. The canvas runs no layout of its own once it is given one.
      -->
      <GraphCanvas :nodes="unionNodes" :edges="unionEdges" v-bind="placement">
        <template #node="{ node, selected }">
          <PlanDiffNode
            :node="diffNode(node)"
            :diff-class="classOf(node.id)"
            :selected="selected"
            @open="(id: string) => (openPatchNode = id)"
          />
        </template>
      </GraphCanvas>
    </div>

    <!--
      AC5 — the machine diff beside the human reason. The two answer different
      questions: the reason says what the planner *intended*, the patch says
      what actually *moved*, and the two disagreeing is itself a finding.
    -->
    <section
      v-if="openPatch"
      class="patch"
      data-patch-panel
      :data-patch-node="openPatch.nodeId"
      aria-label="Field-level patch"
    >
      <h2 class="patch__title">
        Why <code>{{ openPatch.nodeId }}</code> changed
        <button type="button" class="patch__close" @click="openPatchNode = null">Close</button>
      </h2>

      <p v-if="openPatch.escalation" class="patch__escalation" data-patch-escalation>
        Permission escalated from {{ openPatch.escalation.from }} to {{ openPatch.escalation.to }} —
        which is what the patch policy gates on.
      </p>

      <ul class="patch__ops">
        <li v-for="(line, index) in openPatch.lines" :key="`${line.op}${line.path}${index}`">
          <pre data-patch-op :data-patch-escalates="line.escalates ? 'true' : 'false'">{{
            line.text
          }}</pre>
        </li>
      </ul>

      <p class="patch__reason">
        <span class="patch__decision">{{ openPatch.decision ?? 'no decision recorded' }}</span>
        <span>{{ openPatch.reason ?? 'no reason recorded' }}</span>
        <code v-if="openPatch.patchId">{{ openPatch.patchId }}</code>
      </p>
    </section>

    <!--
      AC1 — what a refusal was, when the operator asks. The proposal is recorded
      even though it never became a version, which is the property of the ledger
      this panel makes visible.
    -->
    <section
      v-if="openRejectionRow"
      class="rejected"
      data-rejected-panel
      aria-label="Refused proposal"
    >
      <h2 class="rejected__title">
        Proposed and refused
        <button type="button" class="patch__close" @click="openRejection = null">Close</button>
      </h2>
      <p class="rejected__reason">{{ openRejectionRow.reason }}</p>
      <p class="rejected__rule">
        refused by <strong>{{ openRejectionRow.by ?? 'policy' }}</strong> under
        <code>{{ openRejectionRow.rule ?? 'an unnamed rule' }}</code>
        at seq {{ openRejectionRow.decidedSeq ?? openRejectionRow.seq }}
      </p>
      <p class="rejected__note">The plan version did not advance across it.</p>
    </section>

    <!--
      The same diff, as a list. It is the accessible twin of the drawing and it
      is what EPIC-15-S47 asserts the endpoint's answer against — a form that
      needs no layout, so it is also what remains when the ELK worker cannot
      start.
    -->
    <section
      v-if="settledDiff"
      class="diff"
      :data-diff-pair="`${settledDiff.from}:${settledDiff.to}`"
    >
      <h2 class="diff__title">
        v{{ settledDiff.from }}
        → v{{ settledDiff.to }}
        <span v-if="settledDiff.decision" class="diff__decision">{{ settledDiff.decision }}</span>
        <span v-if="settledDiff.reason" class="diff__reason">{{ settledDiff.reason }}</span>
      </h2>

      <ul class="diff__rows">
        <li
          v-for="row in [...nodeRows, ...edgeRows]"
          :key="`${row.kind}:${row.id}`"
          :data-diff-row="row.kind"
          :data-diff-id="row.id"
          class="diff__row"
        >
          <code>{{ row.id }}</code>
          <span class="diff__note">{{ row.note }}</span>
          <span
            v-if="edgeClasses.get(`${row.id}`)"
            class="diff__edge-class"
            :data-edge-class="edgeClasses.get(`${row.id}`)"
          />
        </li>
      </ul>
    </section>

    <p v-else-if="settledPosition" class="plan-evolution__first">
      v1 is the initial compile; there is no earlier version to diff it against.
    </p>
  </section>
</template>

<style scoped>
.plan-evolution {
  display: grid;
  gap: 0.75rem;
  align-content: start;
}

.plan-evolution__title {
  font-size: 1rem;
  font-weight: 650;
}

.plan-evolution__run,
.plan-evolution__seq,
.plan-evolution__hydration {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  color: var(--ink-muted);
}

.plan-evolution__position,
.plan-evolution__compare {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
}

/*
 * A definite height, and it is load-bearing: Vue Flow sizes itself at 100% of
 * its parent, and a percentage against an `auto` grid row resolves to zero —
 * which renders nothing and warns into a console nobody is reading.
 */
.plan-evolution__graph {
  height: 26rem;
  min-height: 26rem;
}

.version-rail {
  display: flex;
  gap: 0.35rem;
  align-items: center;
  list-style: none;
}

.version-rail__marker,
.version-rail__rejected {
  padding: 0.25rem 0.6rem;
  border: 2px solid var(--tick, var(--edge));
  background: var(--surface-raised);
  color: inherit;
}

.version-rail__marker {
  border-radius: 999px;
}

/*
 * Square, not round. The shape is the non-colour signal: a refusal has to be
 * findable on the rail without reading its colour, and it is the one mark an
 * operator is scanning for when a run did something they did not ask for.
 */
.version-rail__rejected {
  border-radius: 0.2rem;
  border-style: dashed;
  font-weight: 700;
}

.version-rail__marker[aria-current="true"] {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.reason__title {
  font-size: 0.9rem;
  font-weight: 600;
}

.reason__body,
.patch__reason {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.85rem;
}

.reason__decision,
.patch__decision,
.diff__decision {
  padding: 0 0.35rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  font-size: 0.75rem;
}

.reason__reason,
.diff__reason {
  color: var(--ink-muted);
}

.patch__title,
.rejected__title {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.9rem;
  font-weight: 600;
}

.patch__ops {
  display: grid;
  gap: 0.3rem;
  list-style: none;
}

.patch__ops pre {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--edge);
  border-radius: 0.35rem;
  background: var(--surface-raised);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  white-space: pre-wrap;
}

.patch__escalation {
  padding: 0.3rem 0.5rem;
  border: 2px dashed var(--state-failed);
  border-radius: 0.35rem;
  font-size: 0.8rem;
}

.patch__close {
  padding: 0 0.4rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: 0.7rem;
  font-weight: 400;
}

.rejected__reason,
.rejected__rule,
.rejected__note {
  font-size: 0.85rem;
}

.rejected__note {
  color: var(--ink-muted);
}

.diff__title {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.9rem;
  font-weight: 600;
}

.diff__rows {
  display: grid;
  gap: 0.15rem;
  margin-top: 0.4rem;
  list-style: none;
}

.diff__row {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  font-size: 0.85rem;
}

.diff__row[data-diff-row="node-added"] code,
.diff__row[data-diff-row="edge-added"] code {
  color: var(--state-passed);
}

.diff__row[data-diff-row="node-removed"] code,
.diff__row[data-diff-row="edge-removed"] code {
  color: var(--state-abandoned);
}

.diff__row[data-diff-row="node-changed"] code {
  color: var(--state-running);
}

.diff__note {
  color: var(--ink-muted);
}

.plan-evolution__failure {
  color: var(--state-failed);
}

.plan-evolution__first {
  color: var(--ink-muted);
  font-size: 0.85rem;
}
</style>
