<script setup lang="ts">
/**
 * F10.2's plan-evolution scrubber (docs/12-frontend-architecture.md §6.2).
 *
 * This view is where EPIC-15-S47's two deferred lines land: *"the tab remains
 * responsive throughout"* and *"the rendered diff for each step matches the
 * plans/diff response for the same pair"*. Both are consequences of one rule,
 * which is the rule the snapshot endpoint was built to make keepable:
 *
 * > **Nothing here is derived in the tab.**
 *
 * - Each position is `createScrubber(...).positionAt(seq)` — one
 *   `…/snapshot?seq=<N>` request, from `../api/scrub.ts`, which is the only way
 *   either client materialises the state at a `seq`. This view writes no second
 *   client and folds no events.
 * - Each step's diff is `GET …/plans/diff?from=N&to=M`. It is emphatically
 *   *not* computed from the two snapshots this view already holds, even though
 *   it could be: `diffPlanGraphs` is `@DeFlow/daemon`'s, it is what the
 *   endpoint runs, and two implementations of a diff is two answers to
 *   "what changed".
 * - The version rail is `GET …/plans`, which is a grouped, bounded statement:
 *   forty rows for a nine-hour run with forty replans, against forty thousand
 *   folded events the other way.
 *
 * The responsiveness claim follows from that, and is measured rather than
 * asserted: the drag issues four requests and renders four documents, so the
 * main thread does no work proportional to the run's length at any point.
 *
 * `←` / `→` step the rail through the shared UI store, so the keyboard map
 * (../app/keyboard.ts) needs to know nothing about this view.
 */
import { computed, ref, watch } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { createScrubber, type ScrubPosition } from '../api/scrub.ts';
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

interface ChangedNode {
  readonly id: string;
  readonly patch: readonly { readonly op: string; readonly path: string }[];
}

interface PlanEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

interface PlanDiff {
  readonly from: number;
  readonly to: number;
  readonly nodes: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly ChangedNode[];
    readonly unchanged: readonly string[];
  };
  readonly edges: { readonly added: readonly PlanEdge[]; readonly removed: readonly PlanEdge[] };
  readonly reason: string | null;
  readonly decision: string | null;
}

const rail = ref<readonly PlanVersionRow[]>([]);
const position = ref<ScrubPosition | null>(null);
const diff = ref<PlanDiff | null>(null);
const failure = ref<string | null>(null);

/**
 * The version `position` and `diff` describe.
 *
 * Held beside them rather than inferred, so that a position still in flight
 * renders as "…" instead of as the *previous* version's `seq` under the new
 * version's label. That mislabelling is invisible on a fast local daemon and
 * wrong every time.
 */
const shownVersion = ref<number | null>(null);

const runId = computed(() => props.runId ?? '');

/**
 * One scrubber per run, and it is the cache: positions are held by the `seq`
 * they *reflect*, so dragging back over ground already covered is free and
 * dragging onto a `seq` this run never committed still lands on the state the
 * server says it lands on.
 */
const scrubber = computed(() =>
  runId.value === '' ? null : createScrubber(client, runId.value, { replayWindow: 0 }),
);

const seqOf = (version: number): number | null =>
  rail.value.find((row) => row.version === version)?.seq ?? null;

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

async function loadDiff(to: number): Promise<void> {
  const from = to - 1;
  if (from < 1) {
    // v1 has no predecessor: the initial compile is not a patch, and inventing
    // a diff against the empty graph would render every node as "added".
    diff.value = null;
    return;
  }

  try {
    const response = await client.runs[':id'].plans.diff.$get({
      param: { id: runId.value },
      query: { from: String(from), to: String(to) },
    });
    diff.value = response.ok ? ((await response.json()) as PlanDiff) : null;
  } catch {
    diff.value = null;
  }
}

/**
 * Everything one scrub position needs, in one place: the state at that
 * version's `seq` and the diff that produced it.
 *
 * They are awaited together rather than in sequence so a drag costs one round
 * trip's latency rather than two — the request pattern is what the endpoint
 * bought, and serialising it would hand half of it back.
 */
async function goTo(version: number): Promise<void> {
  const seq = seqOf(version);
  const current = scrubber.value;
  if (seq === null || current === null) return;

  shownVersion.value = null;
  let reached: ScrubPosition;
  try {
    [reached] = await Promise.all([current.positionAt(seq), loadDiff(version)]);
  } catch (cause) {
    failure.value = `plan v${version} could not be hydrated (${String(cause)})`;
    return;
  }

  // A drag that outran this request has already asked for somewhere else;
  // landing the stale answer would show the operator a version they left.
  if (ui.planVersion !== version) return;
  position.value = reached;
  shownVersion.value = version;
}

watch(runId, loadRail, { immediate: true });
watch(
  () => ui.planVersion,
  (version) => {
    if (version !== null) void goTo(version);
  },
  { immediate: true },
);

const edgeId = (edge: PlanEdge) => `${edge.from}→${edge.to}:${edge.kind}`;

/** The position, only while it is the one the rail is pointing at. */
const settledPosition = computed(() =>
  shownVersion.value !== null && shownVersion.value === ui.planVersion ? position.value : null,
);

/** Likewise: a diff belongs to a pair, and a stale one mislabels the pair. */
const settledDiff = computed(() =>
  shownVersion.value !== null && shownVersion.value === ui.planVersion ? diff.value : null,
);

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
    ...current.edges.added.map((edge) => ({ kind: 'edge-added', id: edgeId(edge), note: 'added' })),
    ...current.edges.removed.map((edge) => ({
      kind: 'edge-removed',
      id: edgeId(edge),
      note: 'removed',
    })),
  ];
});
</script>

<template>
  <section class="plan-evolution" aria-label="Plan evolution">
    <h1 class="plan-evolution__title">Plan evolution</h1>
    <p class="plan-evolution__run">{{ runId || 'no run selected' }}</p>
    <p v-if="failure" class="plan-evolution__failure" role="alert">{{ failure }}</p>

    <!--
      The rail. Each marker is a real button, so the whole scrubber is reachable
      by Tab as well as by the `←` / `→` map, and each carries the version it
      names as data rather than as a position on screen.
    -->
    <ol class="version-rail" aria-label="Plan versions">
      <li v-for="row in rail" :key="row.version">
        <button
          class="version-rail__marker"
          type="button"
          :data-rail-version="row.version"
          :aria-current="row.version === ui.planVersion ? 'true' : undefined"
          @click="ui.selectPlanVersion(row.version)"
        >
          v{{ row.version }}
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

.plan-evolution__position {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
}

.version-rail {
  display: flex;
  gap: 0.35rem;
  list-style: none;
}

.version-rail__marker {
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  background: var(--surface-raised);
  color: inherit;
}

.version-rail__marker[aria-current="true"] {
  border-color: var(--focus-ring);
  background: color-mix(in oklch, var(--focus-ring) 18%, var(--surface-raised));
}

.diff__title {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.9rem;
  font-weight: 600;
}

.diff__decision,
.diff__reason {
  font-size: 0.8rem;
  font-weight: 400;
  color: var(--ink-muted);
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
