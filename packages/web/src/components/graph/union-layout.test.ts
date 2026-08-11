/**
 * KAR-17.2 — the union layout, computed once per version pair, tests 6 and 8 of
 * the story's plan.
 *
 * Verifies: EPIC-17-S6, EPIC-17-S11 · AC3, AC6
 *
 * ## Why the counter is on `Worker.prototype.postMessage`
 *
 * AC6 says *"asserted by counting worker messages"*, and it says it that way for
 * a reason: a counter on this module's own `positionsFor` proves the cache
 * returns early, and proves nothing at all about whether ELK ran. The real ELK
 * engine lives behind `elk-api.js` in a worker (`./layout.ts`), so the honest
 * probe is the message that crosses to it. This spec patches `postMessage` on
 * the prototype for the length of one test, drives the **real** engine, and
 * asserts a *delta* rather than an absolute — elkjs's own protocol chatter is
 * its business, and a spec that pinned the exact number would be a spec about
 * elkjs 0.12.0's internals rather than about this cache.
 *
 * ## EPIC-17-S11
 *
 * The interactive-constraint recipe (`layering.layerChoiceConstraint`,
 * `crossingMinimization.positionChoiceConstraint`) does not work as commonly
 * written and is not what this view rests on. That is asserted here as an
 * absence, in the options the union layout actually sends, so the recipe cannot
 * be reintroduced from a search result without a test going red.
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import { planGraphVMs, unionGraphOf } from '../../lib/plan-diff.ts';
import { createLayoutEngine, type LayoutEngine } from './layout.ts';
import {
  createUnionLayoutCache,
  UNION_LAYOUT_OPTIONS,
  type UnionLayoutCache,
} from './union-layout.ts';

const node = (id: string) => ({ id, title: `Do ${id}`, type: 'agent' });

/** v3 and v4 of a plan: same four nodes, one of them re-routed. */
const V3 = {
  nodes: [node('recon'), node('impl-cart'), node('impl-pay'), node('review')],
  edges: [
    { from: 'recon', to: 'impl-cart' },
    { from: 'recon', to: 'impl-pay' },
    { from: 'impl-cart', to: 'review' },
    { from: 'impl-pay', to: 'review' },
  ],
};
const V4 = V3;
/** A different pair: v4 → v5 drops the review. */
const V5 = { nodes: V3.nodes.slice(0, 3), edges: V3.edges.slice(0, 2) };

const unionOf = (before: typeof V3, after: typeof V3, key: string) =>
  unionGraphOf(planGraphVMs(before), planGraphVMs(after), key);

let engine: LayoutEngine;
let cache: UnionLayoutCache;
let posted: number;
let restore: () => void;

/** Counts every message this page sends to any worker, for the test's duration. */
function countWorkerMessages(): () => void {
  const original = Worker.prototype.postMessage;
  posted = 0;
  Worker.prototype.postMessage = function patched(this: Worker, ...args: unknown[]) {
    posted += 1;
    return (original as (...rest: unknown[]) => void).apply(this, args);
  } as typeof Worker.prototype.postMessage;
  return () => {
    Worker.prototype.postMessage = original;
  };
}

beforeEach(() => {
  restore = countWorkerMessages();
  engine = createLayoutEngine();
  cache = createUnionLayoutCache(engine);
});

afterEach(() => {
  cache.dispose();
  restore();
});

const layout = (union: ReturnType<typeof unionOf>) =>
  cache.positionsFor(
    union.key,
    union.nodes as readonly PlanNodeVM[],
    union.edges as readonly PlanEdgeVM[],
  );

suite('AC6 — one layout per version pair, and no more', () => {
  it('sends no further worker message when the same pair is re-scrubbed (test 8)', async () => {
    const pair = unionOf(V3, V4, 'run_x:union:v3-v4');

    await layout(pair);
    const afterFirst = posted;
    expect(afterFirst).toBeGreaterThan(0);

    // v3 → v4 → v3 → v4, which is what an operator stepping back and forth
    // across one patch actually does.
    await layout(pair);
    await layout(pair);
    await layout(pair);

    expect(posted - afterFirst).toBe(0);
    expect(cache.layouts).toBe(1);
  });

  it('lays a different pair out, because a cache that never misses is a bug', async () => {
    await layout(unionOf(V3, V4, 'run_x:union:v3-v4'));
    const afterFirst = posted;

    await layout(unionOf(V4, V5, 'run_x:union:v4-v5'));

    expect(posted).toBeGreaterThan(afterFirst);
    expect(cache.layouts).toBe(2);
  });

  it('shares one layout between callers that ask at the same instant', async () => {
    // A fast scrub asks again before the first answer lands. Without an
    // in-flight entry that is two ELK calls for one pair, and the cache reports
    // a hit rate that looks fine.
    const pair = unionOf(V3, V4, 'run_x:union:v3-v4');
    const [left, right] = await Promise.all([layout(pair), layout(pair)]);

    expect(cache.layouts).toBe(1);
    expect(left).toBe(right);
  });

  it('hands back the identical map, so a re-render cannot move a node', async () => {
    const pair = unionOf(V3, V4, 'run_x:union:v3-v4');

    expect(await layout(pair)).toBe(await layout(pair));
  });
});

suite('AC3 — nothing moves: both versions read the same coordinates', () => {
  it('gives every node in either version a position (test 6)', async () => {
    const positions = await layout(unionOf(V3, V5, 'run_x:union:v3-v5'));

    // `review` is in v3 and not in v5, and it still has coordinates — which is
    // what "removed nodes render in place" needs in order to mean anything.
    for (const id of ['recon', 'impl-cart', 'impl-pay', 'review']) {
      expect(positions.get(id), `no position for ${id}`).toBeDefined();
    }
  });

  it('returns numerically identical coordinates on every read of the pair', async () => {
    const pair = unionOf(V3, V4, 'run_x:union:v3-v4');
    const first = await layout(pair);
    const coordinates = [...first].map(([id, at]) => [id, at.x, at.y]);

    const second = await layout(pair);

    expect([...second].map(([id, at]) => [id, at.x, at.y])).toEqual(coordinates);
  });
});

suite('EPIC-17-S11 — the interactive-ELK experiment is not what this rests on', () => {
  it('sends none of the three constraint options the circulating recipe uses', () => {
    const keys = Object.keys(UNION_LAYOUT_OPTIONS).join(' ');

    expect(keys).not.toContain('interactiveLayout');
    expect(keys).not.toContain('layerChoiceConstraint');
    expect(keys).not.toContain('positionChoiceConstraint');
    expect(keys).not.toContain('elk.position');
  });

  it('still satisfies AC3 with the experiment absent, which is the whole claim', async () => {
    // The union graph, laid out once, is sufficient on its own. If this passes
    // with no constraint options anywhere, disabling the experiment changes no
    // acceptance criterion of this story — which is exactly what S11 asserts.
    const pair = unionOf(V3, V5, 'run_x:union:v3-v5');
    const first = await layout(pair);

    expect(first.size).toBe(4);
    expect(await layout(pair)).toBe(first);
  });
});

suite('KAR-16.4’s memory rule — the cache is bounded', () => {
  it('forgets the oldest pair rather than growing with the run’s replan count', async () => {
    for (let version = 1; version <= cache.capacity + 1; version += 1) {
      await layout(unionOf(V3, V4, `run_x:union:v${version}-v${version + 1}`));
    }

    expect(cache.size).toBe(cache.capacity);
  });
});
