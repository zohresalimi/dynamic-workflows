/**
 * KAR-16.4 test plan #6 — 400 nodes, one changes, one subtree re-renders.
 *
 * Verifies: EPIC-16-S28 (scenario 2) · AC3, AC4
 *
 * > Given a `node.progress` event for one node in a 400-node graph
 * > Then the projection mutates the underlying `Map` entry in place
 * > And an integer version ref is incremented
 * > And the computed that derives the view array reads that counter
 * > And **no 400-entry array is reassigned**
 *
 * `../stores/useRunStore.test.ts` asserts the store side of that — the `Map`
 * identity survives, the container is a `shallowRef`, the counter drives a
 * dependent `computed`. This file asserts the part only a renderer can answer:
 * that Vue's diff actually stops at the one node. A store can satisfy every
 * identity assertion and still re-render four hundred components if the
 * per-node component takes a prop that is recreated on every recompute.
 *
 * The component is defined here rather than imported because the real graph
 * canvas is KAR-16.6's and does not exist yet — the *contract* it will be built
 * against does, and that contract is what this file pins: a keyed `v-for` over
 * `store.planNodes`, one child per `PlanNodeVM`, the VM passed by reference.
 * When `GraphCanvas` lands, its own spec inherits these assertions rather than
 * replacing them.
 *
 * Render counts are collected from `onUpdated` on the child, which fires once
 * per patched instance and not at all for an instance Vue skipped. That is the
 * only honest probe: a wall-clock measurement here would be measuring the
 * machine.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { defineComponent, h, onUpdated } from 'vue';
import { RUN } from '../../test/three-patches.ts';
import type { PlanNodeVM } from '../ledger/vm.ts';
import { type RunStore, useRunStore } from './useRunStore.ts';

const NODES = 400;

/** Every child instance's update count, by node id. */
const updates = new Map<string, number>();

const NodeChip = defineComponent({
  name: 'NodeChip',
  props: { node: { type: Object as () => PlanNodeVM, required: true } },
  setup(props) {
    onUpdated(() => {
      updates.set(props.node.id, (updates.get(props.node.id) ?? 0) + 1);
    });
    return () =>
      h('li', { 'data-node': props.node.id, 'data-phase': props.node.phase ?? '' }, [
        h('span', props.node.title),
        h('span', props.node.state),
      ]);
  },
});

/** The shape KAR-16.6's canvas is contracted to: keyed v-for, VM by reference. */
const NodeList = defineComponent({
  name: 'NodeList',
  props: { store: { type: Object as () => RunStore, required: true } },
  setup(props) {
    return () =>
      h(
        'ul',
        props.store.planNodes.map((node) => h(NodeChip, { key: node.id, node })),
      );
  },
});

const envelope = (seq: number, kind: string, v: number, payload: unknown): Event => {
  const parsed = parseEvent({
    seq,
    runId: RUN,
    ts: 1_754_140_000_000 + seq,
    kind,
    v,
    epoch: 7,
    payload,
  });
  if (parsed.status !== 'ok') throw new Error(`unreadable envelope: ${JSON.stringify(parsed)}`);
  return parsed.event;
};

const nodeId = (index: number) => `n-${String(index).padStart(3, '0')}`;

let store: RunStore;

beforeEach(() => {
  setActivePinia(createPinia());
  updates.clear();
  store = useRunStore();
  store.open(RUN);
  for (let index = 0; index < NODES; index += 1) {
    store.applyEvent(
      envelope(index + 1, 'node.scheduled', 1, {
        node: nodeId(index),
        provider: 'claude',
        permission: 'read',
      }),
    );
  }
});

suite('EPIC-16-S28 — a progress event on one node of four hundred', () => {
  it('renders all four hundred once', async () => {
    const screen = render(NodeList, { props: { store } });

    expect(screen.container.querySelectorAll('[data-node]')).toHaveLength(NODES);
    expect(updates.size).toBe(0);
  });

  it('updates exactly one subtree', async () => {
    const screen = render(NodeList, { props: { store } });

    store.applyEvent(
      envelope(1_000, 'node.progress', 1, {
        node: nodeId(7),
        attempt: 1,
        phase: 'running',
        message: 'compiling',
      }),
    );
    await settled();

    // The one node's DOM changed…
    expect(
      screen.container.querySelector(`[data-node="${nodeId(7)}"]`)?.getAttribute('data-phase'),
    ).toBe('running');
    // …and it is the only component instance Vue patched. A build that
    // reassigned the 400-entry array on every event patches all four hundred
    // and fails here while passing every other assertion in this epic.
    expect([...updates.keys()]).toEqual([nodeId(7)]);
    expect(updates.get(nodeId(7))).toBe(1);
  });

  it('patches one subtree per event, not one per node per event', async () => {
    render(NodeList, { props: { store } });

    for (const [index, node] of [3, 11, 200].entries()) {
      store.applyEvent(
        envelope(2_000 + index, 'node.progress', 1, {
          node: nodeId(node),
          attempt: 1,
          phase: 'running',
        }),
      );
      await settled();
    }

    expect([...updates.keys()].toSorted()).toEqual([nodeId(3), nodeId(11), nodeId(200)].toSorted());
    expect([...updates.values()]).toEqual([1, 1, 1]);
  });

  it('adds a node without re-rendering the four hundred already on screen', async () => {
    const screen = render(NodeList, { props: { store } });

    store.applyEvent(
      envelope(3_000, 'node.scheduled', 1, {
        node: 'n-late',
        provider: 'claude',
        permission: 'read',
      }),
    );
    await settled();

    expect(screen.container.querySelectorAll('[data-node]')).toHaveLength(NODES + 1);
    // The list itself re-rendered — it has one more child — but no existing
    // child instance was patched, because each one's prop is the same VM
    // object it already had.
    expect([...updates.keys()]).toEqual([]);
  });
});

/** One microtask plus one animation frame: Vue's queue, then the paint. */
async function settled(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
