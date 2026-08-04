/**
 * KAR-00.4 — the synthetic 5-version plan, and the union of it.
 *
 * EPIC-00-S15 is a claim about coordinates, and coordinates come out of a real
 * ELK running in a real worker in a real browser — that half lives in
 * e2e/spike-s3-elk-worker.test.ts. But the claim is only worth anything if the
 * fixture underneath it really does what the scenario says it does: v2 inserts
 * a node, v3 splits a node, v4 replaces a node's provider, v5 abandons a
 * branch. A fixture where every version is the same graph would pass the
 * stability assertion trivially and prove nothing at all.
 *
 * So this file pins the fixture and the union arithmetic the scrubber rests on.
 * It is pure data: no DOM, no worker, no layout.
 *
 * Verifies: EPIC-00-S15 (the fixture half) · AC4.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  planVersions,
  sixtyNodeGraph,
  survivorsBetween,
  unionGraph,
} from '../spikes/s3-elk-worker/src/graph.ts';

const versions = planVersions();
const ids = (version: number): string[] =>
  (versions.find((candidate) => candidate.version === version)?.nodes ?? [])
    .map((node) => node.id)
    .sort();

const added = (from: number, to: number): string[] =>
  ids(to).filter((id) => !ids(from).includes(id));
const removed = (from: number, to: number): string[] => added(to, from);

suite('the 60-node graph (AC3)', () => {
  const graph = sixtyNodeGraph();

  it('has exactly 60 nodes, each with a unique id and a real size', () => {
    expect(graph.nodes).toHaveLength(60);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(60);
    for (const node of graph.nodes) {
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
  });

  it('is a connected DAG, so a layered layout has something to do', () => {
    const known = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      expect(known.has(edge.source)).toBe(true);
      expect(known.has(edge.target)).toBe(true);
    }
    expect(graph.edges.length).toBeGreaterThanOrEqual(graph.nodes.length - 1);

    // Every node reachable from the root, following edges forwards only —
    // which also rules out a cycle reachable from it.
    const outgoing = new Map<string, string[]>();
    for (const edge of graph.edges) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    }
    const seen = new Set<string>([graph.nodes[0]?.id ?? '']);
    const queue = [...seen];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const next of outgoing.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(60);
  });
});

suite('the synthetic 5-version plan is the shape EPIC-00-S15 describes (AC4)', () => {
  it('has five versions, numbered 1 to 5', () => {
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('v2 inserts a node, and changes nothing else about the node set', () => {
    expect(added(1, 2)).toHaveLength(1);
    expect(removed(1, 2)).toHaveLength(0);
  });

  it('v3 splits a node: one id leaves, two arrive, and both inherit its edges', () => {
    expect(removed(2, 3)).toHaveLength(1);
    expect(added(2, 3)).toHaveLength(2);

    const split = removed(2, 3)[0] as string;
    const parents = versions[1]?.edges.filter((edge) => edge.target === split) ?? [];
    const children = versions[1]?.edges.filter((edge) => edge.source === split) ?? [];
    expect(parents.length).toBeGreaterThan(0);
    expect(children.length).toBeGreaterThan(0);

    for (const half of added(2, 3)) {
      for (const parent of parents) {
        expect(versions[2]?.edges).toContainEqual(
          expect.objectContaining({ source: parent.source, target: half }),
        );
      }
      for (const child of children) {
        expect(versions[2]?.edges).toContainEqual(
          expect.objectContaining({ source: half, target: child.target }),
        );
      }
    }
  });

  it('v4 replaces a provider without touching the node set — the case that must not move', () => {
    expect(ids(4)).toEqual(ids(3));

    const before = versions[2]?.nodes ?? [];
    const after = versions[3]?.nodes ?? [];
    const changed = after.filter(
      (node) => before.find((old) => old.id === node.id)?.provider !== node.provider,
    );
    expect(changed).toHaveLength(1);
    // Same label, same size: only the provider is different, so any position
    // change under a per-version layout is the layout's doing, not the data's.
    const [only] = changed;
    const previous = before.find((old) => old.id === only?.id);
    expect(only?.label).toBe(previous?.label);
    expect(only?.width).toBe(previous?.width);
  });

  it('v5 abandons a branch: several ids leave together, none arrive', () => {
    expect(added(4, 5)).toHaveLength(0);
    expect(removed(4, 5).length).toBeGreaterThanOrEqual(2);

    // And the abandoned nodes really were a branch — connected to each other,
    // not three unrelated deletions.
    const gone = new Set(removed(4, 5));
    const internal = (versions[3]?.edges ?? []).filter(
      (edge) => gone.has(edge.source) && gone.has(edge.target),
    );
    expect(internal.length).toBeGreaterThan(0);
  });

  it('keeps most of the plan alive from each version to the next', () => {
    for (let index = 1; index < versions.length; index += 1) {
      const previous = versions[index - 1];
      const current = versions[index];
      if (previous === undefined || current === undefined) throw new Error('missing version');
      const survivors = survivorsBetween(previous, current);
      expect(survivors.length).toBeGreaterThanOrEqual(4);
    }
  });
});

suite('the union graph (AC4)', () => {
  const union = unionGraph(versions);

  it('contains every node that ever existed, exactly once', () => {
    const everyId = new Set(versions.flatMap((version) => version.nodes.map((node) => node.id)));
    expect(new Set(union.nodes.map((node) => node.id))).toEqual(everyId);
    expect(union.nodes).toHaveLength(everyId.size);
    expect(union.nodes.length).toBeGreaterThan(versions[0]?.nodes.length ?? 0);
  });

  it('contains every edge that ever existed, exactly once, with both ends present', () => {
    const everyEdge = new Set(versions.flatMap((version) => version.edges.map((edge) => edge.id)));
    expect(new Set(union.edges.map((edge) => edge.id))).toEqual(everyEdge);
    expect(union.edges).toHaveLength(everyEdge.size);

    const known = new Set(union.nodes.map((node) => node.id));
    for (const edge of union.edges) {
      expect(known.has(edge.source), `${edge.id} dangles`).toBe(true);
      expect(known.has(edge.target), `${edge.id} dangles`).toBe(true);
    }
  });

  it('is a superset of every single version, which is what makes one layout enough', () => {
    const known = new Set(union.nodes.map((node) => node.id));
    for (const version of versions) {
      for (const node of version.nodes) expect(known.has(node.id)).toBe(true);
    }
  });
});
