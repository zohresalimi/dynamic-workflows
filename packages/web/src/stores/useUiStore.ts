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

export const useUiStore = defineStore('ui', () => {
  const nodes = shallowRef<readonly GraphNode[]>([]);
  const selectedNodeId = ref<string | null>(null);
  const inspectedNodeId = ref<string | null>(null);

  /**
   * Overlays, innermost last.
   *
   * A stack rather than a set of booleans, because `Esc` closes *the topmost
   * and only the topmost* (AC7), and booleans cannot answer which that is.
   */
  const overlays = ref<string[]>([]);

  const planVersions = shallowRef<readonly number[]>([]);
  const planVersion = ref<number | null>(null);

  const selectedNode = computed<GraphNode | null>(
    () => nodes.value.find((node) => node.id === selectedNodeId.value) ?? null,
  );

  const stateOf = (node: GraphNode): DisplayState => displayStateOf(node.status);

  function setNodes(next: readonly GraphNode[]): void {
    nodes.value = next;
    // A selection that survived a replan pointing at a node the new plan does
    // not contain is how `Enter` opens an inspector on nothing.
    if (!next.some((node) => node.id === selectedNodeId.value)) selectedNodeId.value = null;
    if (!next.some((node) => node.id === inspectedNodeId.value)) inspectedNodeId.value = null;
  }

  function selectNode(id: string | null): void {
    selectedNodeId.value = id;
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
    openOverlay(overlay);
    return true;
  }

  function setPlanVersions(versions: readonly number[]): void {
    planVersions.value = versions;
    if (planVersion.value === null || !versions.includes(planVersion.value)) {
      planVersion.value = versions.at(-1) ?? null;
    }
  }

  function selectPlanVersion(version: number | null): void {
    planVersion.value = version;
  }

  /** `←` / `→`. Clamped at both ends: there is no version either side. */
  function stepPlanVersion(delta: number): void {
    const versions = planVersions.value;
    if (versions.length === 0) return;

    const current = versions.indexOf(planVersion.value ?? Number.NaN);
    const next = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), versions.length - 1);
    planVersion.value = versions[next] ?? null;
  }

  return {
    nodes,
    selectedNodeId,
    selectedNode,
    inspectedNodeId,
    overlays,
    planVersions,
    planVersion,
    stateOf,
    setNodes,
    selectNode,
    moveSelection,
    openOverlay,
    closeOverlay,
    closeTopOverlay,
    isOverlayOpen,
    inspectSelected,
    setPlanVersions,
    selectPlanVersion,
    stepPlanVersion,
  };
});

export type UiStore = ReturnType<typeof useUiStore>;
