/**
 * KAR-16.4 — the run store is a thin reactive shell over the seven projections,
 * and it forgets (docs/12-frontend-architecture.md §3.3, §4, §5).
 *
 * Verifies: EPIC-16-S25, EPIC-16-S26, EPIC-16-S28, EPIC-16-S29 · AC1–AC5, AC7
 *
 * The four memory rules are all cheap on day one and miserable to retrofit, and
 * every one of them is invisible in a code review of a passing build — which is
 * why each has an assertion here rather than a paragraph:
 *
 * - **Apply and drop.** A `WeakRef` to an envelope the debug ring has rolled
 *   past is collectable after a forced GC — a real one, through the browser
 *   provider's own CDP session. Without a real collection the claim is
 *   untestable, and a test that asserted
 *   "no other structure *appears* to hold it" would pass for a build holding
 *   every envelope in a closure.
 * - **Cap the per-node collections.** Five thousand `node.progress` events for
 *   one node leave the store holding the same number of objects as one did.
 * - **`shallowRef`, mutate in place, bump.** The container is not reactive, the
 *   `Map` is mutated rather than reassigned, and a dependent `computed` still
 *   re-evaluates — the three halves of rule 3, which is the one people get
 *   backwards.
 * - **Scrub from a snapshot.** On a run of ten thousand events, dragging to
 *   plan v2 issues one `…/snapshot?seq=6` and applies **zero** events below it.
 *
 * The events are real: built through `parseEvent`, so the store is exercised
 * against the shape the wire actually carries rather than against a convenient
 * literal that a payload change would leave passing.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, expect, it, describe as suite } from 'vitest';
import { cdp } from 'vitest/browser';
import { computed, isProxy, isReactive, isRef, isShallow } from 'vue';
import {
  API_BASE,
  type Asked,
  daemonFetch,
  PLAN_VERSIONS,
  RUN,
  snapshotsIn,
  THREE_PATCHES,
} from '../../test/three-patches.ts';
import { createClient } from '../api/client.ts';
import { DEBUG_RING_CAP } from '../ledger/ring.ts';
import { useRunStore } from './useRunStore.ts';

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
  if (parsed.status !== 'ok') {
    throw new Error(`the spec built an envelope this build cannot read: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
};

const progress = (seq: number, node = 'n-impl-1'): Event =>
  envelope(seq, 'node.progress', 1, { node, attempt: 1, phase: 'running', message: `tick ${seq}` });

const scheduled = (seq: number, node: string): Event =>
  envelope(seq, 'node.scheduled', 1, { node, provider: 'claude', permission: 'read' });

beforeEach(() => {
  setActivePinia(createPinia());
});

const opened = () => {
  const store = useRunStore();
  store.open(RUN);
  return store;
};

suite('AC1 — applyEvent applies, advances, bumps and rings', () => {
  it('folds the envelope into every projection that claims its kind', () => {
    const store = opened();

    store.applyEvent(scheduled(1, 'n-impl-1'));
    store.applyEvent(
      envelope(2, 'fact.written', 1, {
        fact: {
          id: 'fact_7840fc76d0aec49888de749c90',
          key: 'finding/auth-uses-jwt',
          kind: 'finding',
          schemaId: 'DeFlow.finding.v1',
          value: { text: 'auth is a bearer JWT' },
          provenance: {
            byNode: 'n-impl-1',
            byProvider: 'claude-code',
            byModel: 'sonnet-4-6',
            fromEvidence: [],
            atEvent: 2,
            at: '2026-08-06T14:11:33.000Z',
            confidence: 'verified',
          },
        },
      }),
    );

    expect(store.plan.nodes.has('n-impl-1')).toBe(true);
    expect(store.blackboard.facts.size).toBe(1);
  });

  it('advances seq and the applied count, and reports the drop of a duplicate', () => {
    const store = opened();

    expect(store.applyEvent(progress(4))).toBe(true);
    expect(store.applyEvent(progress(4))).toBe(false);
    expect(store.applyEvent(progress(9))).toBe(true);

    // `>` and never `previous + 1`: 4, 9 is a healthy log, and the hole belongs
    // to another run in the same directory (docs/11 §4.2).
    expect(store.seq).toBe(9);
    expect(store.applied).toBe(2);
  });

  it('bumps only the counters of the projections that claim the kind', () => {
    const store = opened();
    const before = {
      plan: store.version('plan'),
      timeline: store.version('timeline'),
      cost: store.version('cost'),
    };

    // `node.progress` is claimed by `plan` alone (see ../ledger/projections/kinds.ts).
    store.applyEvent(progress(1));

    expect(store.version('plan')).toBe(before.plan + 1);
    expect(store.version('timeline')).toBe(before.timeline);
    expect(store.version('cost')).toBe(before.cost);
  });

  it('bumps nothing for a kind no view projects, and still advances', () => {
    const store = opened();
    const before = store.version('plan');

    store.applyEvent(envelope(3, 'run.paused', 1, { by: 'user' }));

    expect(store.seq).toBe(3);
    expect(store.version('plan')).toBe(before);
  });

  it('drops an envelope belonging to a run this store is not showing', () => {
    const store = opened();

    const other = parseEvent({
      seq: 5,
      runId: 'run_20260806T141133Z_000000',
      ts: 1,
      kind: 'run.paused',
      v: 1,
      epoch: 7,
      payload: { by: 'user' },
    });
    if (other.status !== 'ok') throw new Error('fixture envelope is unreadable');

    expect(store.applyEvent(other.event)).toBe(false);
    expect(store.seq).toBe(0);
  });

  it('retains no reference to an envelope the ring has rolled past', async () => {
    const store = opened();

    // Applied, then buried under a full ring's worth of successors. Held only
    // through the WeakRef from here on: the local binding is dropped before the
    // collection, or this test would be measuring its own stack frame.
    let doomed: Event | null = progress(1);
    const seen = new WeakRef(doomed);
    store.applyEvent(doomed);
    doomed = null;

    for (let seq = 2; seq <= DEBUG_RING_CAP + 50; seq += 1) store.applyEvent(progress(seq));

    expect(store.ring.size).toBe(DEBUG_RING_CAP);
    expect(await collected(seen)).toBe(true);
  });
});

suite('AC2 — the debug ring is the only place a raw envelope lives', () => {
  it('holds exactly its cap after ten thousand events, with the oldest advancing', () => {
    const store = opened();

    for (let seq = 1; seq <= 10_000; seq += 1) store.applyEvent(progress(seq));

    expect(store.ring.size).toBe(DEBUG_RING_CAP);
    expect(store.ring.oldest()?.seq).toBe(10_000 - DEBUG_RING_CAP + 1);
    expect(store.ring.newest()?.seq).toBe(10_000);
    expect(store.applied).toBe(10_000);
  });

  it('reports the ring through a counter, so a debug pane is not deep-reactive', () => {
    const store = opened();
    const length = computed(() => {
      void store.ringVersion;
      return store.ring.size;
    });

    expect(length.value).toBe(0);
    store.applyEvent(progress(1));
    expect(length.value).toBe(1);
  });
});

suite('AC3 — no store array accumulates node.progress (EPIC-16-S26)', () => {
  it('leaves the per-node object count a function of node count, not event count', () => {
    const store = opened();
    for (const [index, node] of ['n-a', 'n-b', 'n-c'].entries()) {
      store.applyEvent(scheduled(index + 1, node));
    }

    const after3 = store.counts();
    for (let seq = 10; seq < 5_010; seq += 1) store.applyEvent(progress(seq, 'n-a'));
    const after5000 = store.counts();

    expect(after3.nodes).toBe(3);
    expect(after5000.nodes).toBe(after3.nodes);
    // The ring is the *only* thing that grew, and it is bounded.
    expect(after5000.events).toBe(DEBUG_RING_CAP);
  });

  it('keeps the last progress message rather than a list of them', () => {
    const store = opened();
    store.applyEvent(scheduled(1, 'n-a'));

    store.applyEvent(progress(2, 'n-a'));
    store.applyEvent(progress(3, 'n-a'));

    const node = store.plan.nodes.get('n-a');
    expect(node?.progressMessage).toBe('tick 3');
    // Nothing on the node is an unbounded collection: every array-valued field
    // it has is bounded by the plan, and `node.progress` contributes to none.
    const arrays = Object.entries(node ?? {}).filter(([, value]) => Array.isArray(value));
    expect(arrays).toEqual([]);
  });
});

suite('AC4 — every projection container is a shallowRef (EPIC-16-S28)', () => {
  it('exposes a state that Vue never walked', () => {
    const store = opened();
    store.applyEvent(scheduled(1, 'n-a'));

    expect(isReactive(store.plan)).toBe(false);
    expect(isProxy(store.plan)).toBe(false);
    expect(isReactive(store.timeline)).toBe(false);
    // The container itself is a shallow ref, not a deep one.
    expect(isShallow(store.containerFor('plan'))).toBe(true);
    expect(isRef(store.containerFor('plan'))).toBe(true);
  });

  it('mutates the underlying Map in place and bumps a counter, rather than reassigning', () => {
    const store = opened();
    store.applyEvent(scheduled(1, 'n-a'));

    const state = store.plan;
    const nodes = state.nodes;
    const node = nodes.get('n-a');

    let evaluations = 0;
    const phases = computed(() => {
      evaluations += 1;
      void store.version('plan');
      return [...store.plan.nodes.values()].map((one) => one.phase);
    });
    expect(phases.value).toEqual([null]);
    expect(evaluations).toBe(1);

    store.applyEvent(progress(2, 'n-a'));

    // The dependent computed re-evaluated…
    expect(phases.value).toEqual(['running']);
    expect(evaluations).toBe(2);
    // …and nothing was reassigned to make it: reassigning a 2,000-entry array on
    // every `node.progress` event is worse than the deep reactivity it avoids.
    expect(store.plan).toBe(state);
    expect(store.plan.nodes).toBe(nodes);
    expect(store.plan.nodes.get('n-a')).toBe(node);
  });

  it('does not re-evaluate a dependent computed when an unrelated projection moves', () => {
    const store = opened();
    let evaluations = 0;
    const spans = computed(() => {
      evaluations += 1;
      void store.version('timeline');
      return store.timeline.spans.size;
    });
    expect(spans.value).toBe(0);

    store.applyEvent(progress(1, 'n-a'));

    expect(spans.value).toBe(0);
    expect(evaluations).toBe(1);
  });
});

suite('AC5 — nothing the store hands out is a Vue proxy (EPIC-16-S28)', () => {
  it('hands out raw view models and raw arrays', () => {
    const store = opened();
    store.applyEvent(scheduled(1, 'n-a'));
    store.applyEvent(
      envelope(2, 'node.started', 2, {
        node: 'n-a',
        attempt: 1,
        ikey: `${RUN}/n-a/1/0`,
        binary: { path: '/usr/local/bin/claude', version: '1.2.3', sha256: 'b'.repeat(64) },
      }),
    );

    const walked = [
      store.planNodes,
      store.planEdges,
      store.timelineSpans,
      ...store.planNodes,
      ...store.planEdges,
      ...store.timelineSpans,
    ];

    for (const payload of walked) expect(isProxy(payload)).toBe(false);
    expect(store.planNodes.length).toBe(1);
    expect(store.timelineSpans.length).toBe(1);
  });

  it('marks what it adopts, so a foreign library never meets a proxy through a reactive()', () => {
    const store = opened();
    const terminal = {
      id: 't1',
      disposed: false,
      dispose() {
        this.disposed = true;
      },
    };

    const adopted = store.adoptTerminal('n-a', terminal);

    expect(adopted).toBe(terminal);
    expect(isProxy(adopted)).toBe(false);
    // markRaw is what survives being put inside a reactive() by a component.
    expect(isProxy(store.adopt({ elk: true }))).toBe(false);
    expect(store.counts().terminals).toBe(1);
  });

  it('disposes every terminal it adopted, and counts none afterwards', () => {
    const store = opened();
    const one = {
      disposed: false,
      dispose() {
        this.disposed = true;
      },
    };
    const two = {
      disposed: false,
      dispose() {
        this.disposed = true;
      },
    };
    store.adoptTerminal('n-a', one);
    store.adoptTerminal('n-b', two);

    store.disposeTerminal('n-a');
    store.close();

    expect(one.disposed).toBe(true);
    expect(two.disposed).toBe(true);
    expect(store.counts().terminals).toBe(0);
  });
});

suite('AC7 — scrubbing hydrates from the snapshot endpoint (EPIC-16-S29)', () => {
  /** Ten thousand events: the four real plan versions, then a long tail. */
  const bigRun = () => {
    const rows = [...THREE_PATCHES];
    for (let seq = 16; rows.length < 10_000; seq += 1) {
      rows.push({
        seq,
        runId: RUN,
        ts: 1_754_140_000_000 + seq,
        kind: 'node.progress',
        v: 1,
        epoch: 7,
        payload: { node: 'n-impl-1', attempt: 1, phase: 'running' },
      });
    }
    return rows;
  };

  const openedOnBigRun = () => {
    const asked: Asked[] = [];
    const store = useRunStore();
    store.open(RUN, {
      client: createClient({ baseUrl: API_BASE, fetch: daemonFetch(asked, bigRun()) }),
    });
    return { store, asked };
  };

  it('issues one snapshot request at the version’s seq and no events read', async () => {
    const { store, asked } = openedOnBigRun();
    const v2 = PLAN_VERSIONS[1];

    const position = await store.scrubTo(v2.seq);

    expect(snapshotsIn(asked).map((one) => one.seq)).toEqual([String(v2.seq)]);
    expect(asked.filter((one) => one.path.endsWith('/events'))).toEqual([]);
    expect(position?.seq).toBe(v2.seq);
    expect(store.runState?.planVersion).toBe(2);
  });

  it('applies zero events below the snapshot seq when the tail arrives', async () => {
    const { store } = openedOnBigRun();
    const v2 = PLAN_VERSIONS[1];
    await store.scrubTo(v2.seq);

    // Everything the run ever emitted, offered to the store the way a
    // subscribe-backfill offers it. A build that folded from zero to reach the
    // position would swallow all ten thousand.
    let applied = 0;
    for (const row of bigRun()) {
      const parsed = parseEvent(row);
      if (parsed.status !== 'ok') continue;
      if (store.applyEvent(parsed.event)) applied += 1;
    }

    expect(store.hydratedFromSeq).toBe(v2.seq);
    expect(store.lowestSeqAppliedSinceHydrate).toBeGreaterThan(v2.seq);
    expect(applied).toBeLessThan(10_000);
    expect(store.seq).toBeGreaterThan(v2.seq);
  });

  it('resets the projections to the hydrated position rather than folding over them', async () => {
    const { store } = openedOnBigRun();
    for (const row of bigRun().slice(0, 40)) {
      const parsed = parseEvent(row);
      if (parsed.status === 'ok') store.applyEvent(parsed.event);
    }
    expect(store.seq).toBeGreaterThan(10);

    await store.scrubTo(PLAN_VERSIONS[0].seq);

    expect(store.seq).toBe(PLAN_VERSIONS[0].seq);
    expect(store.plan.nodes.size).toBe(0);
    expect(store.ring.size).toBe(0);
  });

  it('answers head, so returning to live is the same one request', async () => {
    const { store, asked } = openedOnBigRun();

    const position = await store.scrubTo('head');

    expect(snapshotsIn(asked).map((one) => one.seq)).toEqual(['head']);
    expect(position?.seq).toBe(bigRun().at(-1)?.seq);
  });
});

/**
 * Whether `ref`'s referent has been collected, after a **real** collection.
 *
 * `HeapProfiler.collectGarbage` over the CDP session the browser provider
 * already holds, rather than `--js-flags=--expose-gc` on the launch: it needs
 * no flag on the shared browser instance every other spec in this project runs
 * in, and it is the same full collection.
 *
 * Retried rather than asserted once, because a value can still be reachable
 * from a stale register or an inline cache on the first pass — a single attempt
 * is the classic flaky retention test.
 */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  const session = cdp();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await session.send('HeapProfiler.collectGarbage');
    if (ref.deref() === undefined) return true;
    // Yield, so a collection scheduled asynchronously has somewhere to run.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return ref.deref() === undefined;
}
