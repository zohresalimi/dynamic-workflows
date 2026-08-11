/**
 * KAR-17.2 — the union graph and the four-way join, tests 2, 3 and 5 of the
 * story's plan.
 *
 * Verifies: EPIC-17-S6 (scenario 2), EPIC-17-S7 (scenarios 2 and 4) · AC3, AC4
 *
 * Pure: no mount, no DOM, no fetch. They run in the `web` project only because
 * everything under `packages/web/src` outside `ledger/projections/` does
 * (`test/web-suite-split.test.ts`), and they cost milliseconds there.
 *
 * The one thing these must **not** drift into is a second implementation of the
 * diff. `GET /api/runs/:id/plans/diff` is the answer to "what changed"
 * (KAR-11.6's `diffPlanGraphs`, server-side), and `../views/plan-evolution.test.ts`
 * already asserts the view renders that document rather than one of its own.
 * What is under test here is the *join*: taking the endpoint's four id lists and
 * two edge lists and attaching them to a union graph the tab lays out once.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  edgeClassesOf,
  nodeClassesOf,
  patchOfChangedNode,
  planGraphVMs,
  unionEdgeId,
  unionGraphOf,
} from './plan-diff.ts';

interface NodeDoc {
  readonly id: string;
  readonly title: string;
  readonly type?: string;
  readonly permission?: string;
  readonly provider?: { readonly prefer: readonly string[] };
  readonly derivedFrom?: readonly string[];
}

const node = (id: string, extra: Partial<NodeDoc> = {}): NodeDoc => ({
  id,
  title: `Do ${id}`,
  type: 'agent',
  permission: 'read',
  ...extra,
});

const edge = (from: string, to: string, kind: 'control' | 'data' = 'control') => ({
  from,
  to,
  kind,
});

const graph = (nodes: readonly NodeDoc[], edges: readonly ReturnType<typeof edge>[]) => ({
  nodes,
  edges,
});

/** v1: recon → impl. v2 inserts a review after impl and re-routes impl. */
const V1 = graph([node('recon'), node('impl')], [edge('recon', 'impl')]);
const V2 = graph(
  [node('recon'), node('impl', { provider: { prefer: ['codex'] } }), node('review')],
  [edge('recon', 'impl'), edge('impl', 'review')],
);

/** The endpoint's document for that pair, exactly as `/plans/diff` returns it. */
const DIFF_1_2 = {
  from: 1,
  to: 2,
  nodes: {
    added: ['review'],
    removed: [],
    changed: [
      { id: 'impl', patch: [{ op: 'replace', path: '/provider/prefer/0', value: 'codex' }] },
    ],
    unchanged: ['recon'],
  },
  edges: { added: [edge('impl', 'review')], removed: [] },
  unionLayoutKey: 'run_x:union:v1-v2',
  reason: 'a security review is required',
  decision: 'auto',
} as const;

suite('AC4 — the union graph is every node and edge in either version', () => {
  it('unions the two versions’ node ids, and nothing else (test 5)', () => {
    const union = unionGraphOf(planGraphVMs(V1), planGraphVMs(V2), DIFF_1_2.unionLayoutKey);

    expect(union.nodes.map((one) => one.id)).toEqual(['recon', 'impl', 'review']);
    expect(union.key).toBe('run_x:union:v1-v2');
  });

  it('keeps a node the newer version dropped, so a removal has somewhere to render', () => {
    // v2' abandons `impl`: it is gone from the newer version and must still be
    // in the union, or "removed nodes render in place" has no place to render.
    const dropped = graph([node('recon'), node('review')], []);
    const union = unionGraphOf(planGraphVMs(V1), planGraphVMs(dropped), 'k');

    expect(union.nodes.map((one) => one.id)).toEqual(['recon', 'impl', 'review']);
  });

  it('unions edges under `${source}->${target}` and never twice (test 2)', () => {
    const union = unionGraphOf(planGraphVMs(V1), planGraphVMs(V2), 'k');

    expect(union.edges.map((one) => one.id)).toEqual([
      unionEdgeId('recon', 'impl'),
      unionEdgeId('impl', 'review'),
    ]);
    expect(unionEdgeId('recon', 'impl')).toBe('recon->impl');
  });

  it('collapses an edge whose kind changed into one union edge, not two', () => {
    // The layout needs one edge per ordered pair. Two overlapping edges between
    // the same two boxes is a drawing that says nothing and measures wrong.
    const before = graph([node('a'), node('b')], [edge('a', 'b', 'control')]);
    const after = graph([node('a'), node('b')], [edge('a', 'b', 'data')]);

    expect(unionGraphOf(planGraphVMs(before), planGraphVMs(after), 'k').edges).toHaveLength(1);
  });

  it('is deterministic: the same input lays out to the same input (test 5)', () => {
    const once = unionGraphOf(planGraphVMs(V1), planGraphVMs(V2), 'k');
    const twice = unionGraphOf(planGraphVMs(V1), planGraphVMs(V2), 'k');

    expect(once.nodes.map((one) => one.id)).toEqual(twice.nodes.map((one) => one.id));
    expect(once.edges.map((one) => one.id)).toEqual(twice.edges.map((one) => one.id));
  });

  it('carries the older version’s node document for a node only it has', () => {
    // A removed node still has to render a title and a type: the union takes it
    // from the version that still had it rather than drawing an empty box.
    const dropped = graph([node('recon')], []);
    const union = unionGraphOf(planGraphVMs(V1), planGraphVMs(dropped), 'k');

    expect(union.nodes.find((one) => one.id === 'impl')?.title).toBe('Do impl');
  });

  it('shows a split node’s `derivedFrom`, which is how a split reads as one (AC9)', () => {
    const split = graph(
      [
        node('recon'),
        node('impl-a', { derivedFrom: ['impl'] }),
        node('impl-b', { derivedFrom: ['impl'] }),
      ],
      [],
    );
    const union = unionGraphOf(planGraphVMs(V1), planGraphVMs(split), 'k');

    expect(union.nodes.find((one) => one.id === 'impl-a')?.derivedFrom).toEqual(['impl']);
  });
});

suite('AC4 — the classification is the endpoint’s, joined by id', () => {
  it('gives every union node exactly one of the four classes (test 2)', () => {
    const classes = nodeClassesOf(DIFF_1_2);

    expect(classes.get('review')).toBe('added');
    expect(classes.get('impl')).toBe('changed');
    expect(classes.get('recon')).toBe('unchanged');
    expect(classes.size).toBe(3);
  });

  it('classifies a removal, which is the class with nowhere else to come from', () => {
    const classes = nodeClassesOf({
      ...DIFF_1_2,
      nodes: { added: [], removed: ['impl'], changed: [], unchanged: ['recon'] },
    });

    expect(classes.get('impl')).toBe('removed');
  });

  it('is keyed by nodeId, so reordering either version changes nothing (test 3)', () => {
    // EPIC-17-S6's identity contract: `nodeId` is the planner's and is stable
    // across patches, and is *never* derived from position or label. A version
    // whose two nodes arrived in the other order is the same plan.
    const swapped = graph([...V2.nodes].toReversed(), V2.edges);
    const straight = unionGraphOf(planGraphVMs(V1), planGraphVMs(V2), 'k');
    const reversed = unionGraphOf(planGraphVMs(V1), planGraphVMs(swapped), 'k');

    expect(new Set(straight.nodes.map((one) => one.id))).toEqual(
      new Set(reversed.nodes.map((one) => one.id)),
    );
    // And the classes do not move at all, because they never looked at order.
    expect([...nodeClassesOf(DIFF_1_2)]).toEqual([...nodeClassesOf(DIFF_1_2)]);
    expect(nodeClassesOf(DIFF_1_2).get('impl')).toBe('changed');
  });

  it('classifies edges under the same identity the union used (test 2)', () => {
    const union = unionGraphOf(planGraphVMs(V1), planGraphVMs(V2), 'k');
    const classes = edgeClassesOf(DIFF_1_2, union);

    expect(classes.get('impl->review')).toBe('added');
    expect(classes.get('recon->impl')).toBe('unchanged');
  });

  it('classifies a removed edge as removed rather than dropping it', () => {
    const union = unionGraphOf(planGraphVMs(V1), planGraphVMs(graph(V1.nodes, [])), 'k');
    const classes = edgeClassesOf(
      { ...DIFF_1_2, edges: { added: [], removed: [edge('recon', 'impl')] } },
      union,
    );

    expect(classes.get('recon->impl')).toBe('removed');
  });
});

suite('AC5 — the field-level patch comes off the document, as objects', () => {
  it('hands back the RFC 6902 operations for a changed node (test 4)', () => {
    expect(patchOfChangedNode(DIFF_1_2, 'impl')).toEqual([
      { op: 'replace', path: '/provider/prefer/0', value: 'codex' },
    ]);
  });

  it('answers null for a node that did not change, rather than an empty patch', () => {
    // An empty array reads as "it changed, and the change was nothing", which is
    // exactly the wrong thing to open a "why did this change" panel on.
    expect(patchOfChangedNode(DIFF_1_2, 'recon')).toBeNull();
  });
});
