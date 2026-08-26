/**
 * KAR-16.1 — panel layout, selection and overlays: the state that is **not**
 * derived from the ledger (docs/12-frontend-architecture.md §3.2).
 *
 * The run store next door (KAR-16.4) is a projection of the event log and may
 * hold nothing that did not arrive as an `EventEnvelope`. This one is the
 * opposite: which node the operator has selected, which overlays are stacked
 * and which plan version the scrubber sits on are facts about *this tab*, they
 * survive no reload, and they belong to nobody's ledger.
 *
 * The keyboard map (../app/keyboard.ts) drives this store and nothing else, so
 * every key in the map is testable without a component and every component
 * renders from state rather than from a key handler.
 *
 * `shallowRef` for the two collections, per docs/12 §4: they are replaced
 * wholesale by a projection, never mutated in place, and deep reactivity over
 * a 400-node array is the single most likely way to miss NF3.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type { NodeStatus } from '../ledger/types.ts';
import type { DisplayState } from '../lib/state-palette.ts';
import { displayStateOf } from '../lib/state-palette.ts';

/**
 * A node as the shell needs it: enough to render a chip, announce a label and
 * move a selection through. The plan graph's full view-model is KAR-16.3's.
 */
export interface GraphNode {
  readonly id: string;
  readonly title: string;
  readonly status: NodeStatus;
}

/**
 * KAR-28.2 AC5 — the two things the workflows screen's primary panel can be.
 *
 * A closed vocabulary rather than a boolean, because `graph: false` is not a
 * description of a screen and a third panel would arrive as a second boolean
 * that can disagree with the first.
 */
export const RUN_PANELS = ['agents', 'graph'] as const;

export type RunPanel = (typeof RUN_PANELS)[number];

export const useUiStore = defineStore('ui', () => {
  const nodes = shallowRef<readonly GraphNode[]>([]);
  const selectedNodeId = ref<string | null>(null);
  const inspectedNodeId = ref<string | null>(null);

  /**
   * KAR-28.2 AC5 — which panel the workflows screen is showing.
   *
   * `agents` by default, which is the decision the story records: the list is
   * what the screen shows, and dependency shape is occasionally the right
   * question rather than the default one.
   *
   * It belongs here for exactly the reason at the top of this file — it is a
   * fact about *this tab*, it belongs to nobody's ledger, and the run store
   * next door may hold nothing that did not arrive as an event. "Persists for
   * the session" is what this store already is: the choice survives every
   * navigation inside the application, including leaving the screen and coming
   * back, and it does not survive a reload, where the run is being rebuilt from
   * its ledger anyway.
   */
  const runPanel = ref<RunPanel>('agents');

  /**
   * Which attempt of the inspected node the panel is showing, or `null` for
   * "the latest" (KAR-17.3 AC6).
   *
   * `null` rather than a number, because the panel opens before anybody knows
   * how many attempts there are — and a default of `0` would open every
   * retried node on its *first* attempt, which is the one an operator chasing a
   * bad diff is least likely to want.
   */
  const inspectedAttempt = ref<number | null>(null);

  /** The attempt the inspected one is being compared against. `null` = none. */
  const comparedAttempt = ref<number | null>(null);

  /**
   * The `seq` the debug ring is parked on (KAR-17.3 AC7).
   *
   * Tab-local like everything else here: it is where this operator clicked, it
   * survives no reload, and it belongs to nobody's ledger. The *envelope* it
   * names lives in the run store's ring — this is only the cursor onto it.
   */
  const selectedEventSeq = ref<number | null>(null);

  /**
   * Overlays, innermost last.
   *
   * A stack rather than a set of booleans, because `Esc` closes *the topmost
   * and only the topmost* (AC7), and booleans cannot answer which that is.
   */
  const overlays = ref<string[]>([]);

  const planVersions = shallowRef<readonly number[]>([]);
  const planVersion = ref<number | null>(null);

  /**
   * How the operator last moved the scrubber: by **stepping** (`←`/`→`) or by
   * **picking** a version off the rail.
   *
   * The plan-evolution view needs the difference and cannot recover it from the
   * version alone (KAR-17.2 AC3). Stepping between the two halves of one patch
   * has to stay on that patch's union layout, so that nothing moves; clicking a
   * tick is a jump to *that version*, and shows the patch that produced it.
   * Both can land on the same number, and they mean different things.
   */
  const planMove = ref<'select' | 'step'>('select');

  /**
   * KAR-17.5 AC9 — xterm's `screenReaderMode`, **off by default**.
   *
   * It is not a default anybody should pay for silently: it makes the terminal
   * maintain a parallel live-region representation of the buffer, on a stream
   * that can produce megabytes, and the cost is proportional to the output
   * rather than to the viewport. So it is a setting the operator turns on —
   * which is also why it lives here rather than in a component: it is a fact
   * about *this tab*, it survives no reload, and it belongs to nobody's ledger.
   *
   * The panel's accessible story without it is the archive viewer, which is
   * ordinary DOM text, and the typed ACP list, which is ordinary DOM
   * everything.
   */
  const screenReaderMode = ref(false);

  function setScreenReaderMode(on: boolean): void {
    screenReaderMode.value = on;
  }

  const selectedNode = computed<GraphNode | null>(
    () => nodes.value.find((node) => node.id === selectedNodeId.value) ?? null,
  );

  const stateOf = (node: GraphNode): DisplayState => displayStateOf(node.status);

  function setNodes(next: readonly GraphNode[]): void {
    nodes.value = next;
    // A selection that survived a replan pointing at a node the new plan does
    // not contain is how `Enter` opens an inspector on nothing.
    if (!next.some((node) => node.id === selectedNodeId.value)) selectedNodeId.value = null;
    if (!next.some((node) => node.id === inspectedNodeId.value)) {
      inspectedNodeId.value = null;
      // The attempt belongs to the node. Leaving `2` behind for a node the new
      // plan does not have is how an inspector opens on attempt 2 of something
      // that ran once.
      resetAttempt();
    }
  }

  function resetAttempt(): void {
    inspectedAttempt.value = null;
    comparedAttempt.value = null;
  }

  function selectNode(id: string | null): void {
    selectedNodeId.value = id;
  }

  /** KAR-28.2 AC5 — the operator chose a panel. */
  function showRunPanel(panel: RunPanel): void {
    runPanel.value = panel;
  }

  /**
   * `j` and `k`. Clamped rather than wrapping: a selection that jumps from the
   * last node back to the first looks, on a 400-node graph, exactly like the
   * key not having worked.
   */
  function moveSelection(delta: number): void {
    const list = nodes.value;
    if (list.length === 0) return;

    const current = list.findIndex((node) => node.id === selectedNodeId.value);
    const next = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), list.length - 1);
    selectedNodeId.value = list[next]?.id ?? null;
  }

  function openOverlay(name: string): void {
    if (!overlays.value.includes(name)) overlays.value = [...overlays.value, name];
  }

  function closeOverlay(name: string): void {
    overlays.value = overlays.value.filter((open) => open !== name);
  }

  function closeTopOverlay(): string | null {
    const top = overlays.value.at(-1) ?? null;
    if (top !== null) overlays.value = overlays.value.slice(0, -1);
    return top;
  }

  const isOverlayOpen = (name: string): boolean => overlays.value.includes(name);

  /** `Enter`. Opens on the selected node, and on nothing otherwise. */
  function inspectSelected(overlay: string): boolean {
    if (selectedNodeId.value === null) return false;
    inspectedNodeId.value = selectedNodeId.value;
    resetAttempt();
    openOverlay(overlay);
    return true;
  }

  /**
   * Moves the open inspector to another node — the provenance table's *"each
   * row links to the writing node's inspector"* (KAR-17.3 AC8).
   *
   * The attempt and the comparison are reset with it: they were coordinates in
   * the node being left, and carrying "attempt 2, compared with 1" onto a node
   * that ran once renders an empty panel that looks like a bug.
   */
  function inspectNodeById(id: string): void {
    inspectedNodeId.value = id;
    selectedNodeId.value = id;
    resetAttempt();
  }

  /** Which attempt the panel shows. `null` returns it to "the latest". */
  function inspectAttempt(attempt: number | null): void {
    inspectedAttempt.value = attempt;
  }

  /** Which attempt to diff the shown one against. `null` closes the compare. */
  function compareAttempt(attempt: number | null): void {
    comparedAttempt.value = attempt;
  }

  /** Parks the debug ring on the event that produced a displayed value. */
  function selectEvent(seq: number | null): void {
    selectedEventSeq.value = seq;
  }

  function setPlanVersions(versions: readonly number[]): void {
    planVersions.value = versions;
    if (planVersion.value === null || !versions.includes(planVersion.value)) {
      planVersion.value = versions.at(-1) ?? null;
    }
  }

  function selectPlanVersion(version: number | null): void {
    planMove.value = 'select';
    planVersion.value = version;
  }

  /** `←` / `→`. Clamped at both ends: there is no version either side. */
  function stepPlanVersion(delta: number): void {
    const versions = planVersions.value;
    if (versions.length === 0) return;

    const current = versions.indexOf(planVersion.value ?? Number.NaN);
    const next = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), versions.length - 1);
    planMove.value = 'step';
    planVersion.value = versions[next] ?? null;
  }

  return {
    nodes,
    selectedNodeId,
    selectedNode,
    inspectedNodeId,
    inspectedAttempt,
    comparedAttempt,
    selectedEventSeq,
    overlays,
    planVersions,
    planVersion,
    planMove,
    runPanel,
    showRunPanel,
    screenReaderMode,
    setScreenReaderMode,
    stateOf,
    setNodes,
    selectNode,
    moveSelection,
    openOverlay,
    closeOverlay,
    closeTopOverlay,
    isOverlayOpen,
    inspectSelected,
    inspectNodeById,
    inspectAttempt,
    compareAttempt,
    selectEvent,
    setPlanVersions,
    selectPlanVersion,
    stepPlanVersion,
  };
});

export type UiStore = ReturnType<typeof useUiStore>;
