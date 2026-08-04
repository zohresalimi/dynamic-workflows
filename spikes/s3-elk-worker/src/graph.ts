/**
 * The two fixtures this spike is about, and the union arithmetic the
 * plan-evolution scrubber (F10.2) rests on.
 *
 * Node built-ins only — in fact, no imports at all. This module is loaded three
 * times over: by the browser app through Vite, by the unit slice in Node, and
 * by nothing else. Keeping it free of DOM types, Vite types and elkjs types is
 * what lets `test/spike-s3-plan-versions.test.ts` assert on the fixture without
 * booting a browser.
 */

export interface PlanNode {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly width: number;
  readonly height: number;
}

export interface PlanEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface PlanGraph {
  readonly nodes: readonly PlanNode[];
  readonly edges: readonly PlanEdge[];
}

export interface PlanVersion extends PlanGraph {
  readonly version: number;
}

/** Stable, content-derived edge ids, so the union dedups without bookkeeping. */
function edge(source: string, target: string): PlanEdge {
  return { id: `${source}->${target}`, source, target };
}

function node(id: string, label: string, provider: string, width = 160): PlanNode {
  return { id, label, provider, width, height: 44 };
}

/**
 * Sixty nodes, deterministically: a ternary tree so a layered algorithm has
 * real layers to build, plus a few forward cross-edges so it also has crossings
 * to minimise. Every edge points from a lower index to a higher one, which
 * makes the whole thing a DAG by construction.
 */
export function sixtyNodeGraph(): PlanGraph {
  const nodes: PlanNode[] = [];
  const edges: PlanEdge[] = [];
  for (let index = 0; index < 60; index += 1) {
    const id = `n${String(index).padStart(2, '0')}`;
    nodes.push(
      node(
        id,
        `step ${index}`,
        index % 2 === 0 ? 'claude-code' : 'gemini-cli',
        120 + (index % 4) * 20,
      ),
    );
    if (index > 0) {
      const parent = `n${String(Math.floor((index - 1) / 3)).padStart(2, '0')}`;
      edges.push(edge(parent, id));
    }
    if (index > 10 && index % 7 === 0) {
      edges.push(edge(`n${String(index - 5).padStart(2, '0')}`, id));
    }
  }
  return { nodes, edges };
}

/**
 * A synthetic plan in five versions, shaped exactly as EPIC-00-S15 describes:
 * v2 inserts a node, v3 splits a node, v4 replaces a node's provider, and v5
 * abandons a branch. Each of those is a different kind of stress on a layout —
 * an insertion changes one layer's population, a split changes the node set
 * while keeping the edges, a provider swap changes nothing structural at all
 * (and must therefore move nothing), and an abandonment empties a whole subtree.
 */
export function planVersions(): PlanVersion[] {
  const intake = node('intake', 'intake', 'human');
  const plan = node('plan', 'plan', 'claude-code');
  const implement = node('implement', 'implement', 'claude-code');
  const verify = node('verify', 'verify', 'claude-code');
  const report = node('report', 'report', 'claude-code');
  const research = node('research', 'research', 'gemini-cli');
  const spike = node('spike', 'spike', 'gemini-cli');
  const review = node('review', 'review', 'claude-code');
  const frontend = node('implement.frontend', 'implement (frontend)', 'claude-code');
  const backend = node('implement.backend', 'implement (backend)', 'claude-code');

  const branch = [edge('intake', 'research'), edge('research', 'spike'), edge('spike', 'report')];

  const v1: PlanVersion = {
    version: 1,
    nodes: [intake, plan, implement, verify, report, research, spike],
    edges: [
      edge('intake', 'plan'),
      edge('plan', 'implement'),
      edge('implement', 'verify'),
      edge('verify', 'report'),
      ...branch,
    ],
  };

  // v2 — a review step is inserted between implement and verify.
  const v2: PlanVersion = {
    version: 2,
    nodes: [...v1.nodes, review],
    edges: [
      edge('intake', 'plan'),
      edge('plan', 'implement'),
      edge('implement', 'review'),
      edge('review', 'verify'),
      edge('verify', 'report'),
      ...branch,
    ],
  };

  // v3 — implement is split in two; both halves inherit its edges.
  const v3: PlanVersion = {
    version: 3,
    nodes: [...v2.nodes.filter((candidate) => candidate.id !== 'implement'), frontend, backend],
    edges: [
      edge('intake', 'plan'),
      edge('plan', 'implement.frontend'),
      edge('plan', 'implement.backend'),
      edge('implement.frontend', 'review'),
      edge('implement.backend', 'review'),
      edge('review', 'verify'),
      edge('verify', 'report'),
      ...branch,
    ],
  };

  // v4 — verify is re-assigned to a different provider. Nothing structural
  // changes, which is precisely why a per-version layout moving anything here
  // would be pure noise.
  const v4: PlanVersion = {
    version: 4,
    nodes: v3.nodes.map((candidate) =>
      candidate.id === 'verify' ? { ...candidate, provider: 'gemini-cli' } : candidate,
    ),
    edges: v3.edges,
  };

  // v5 — the research branch is abandoned.
  const abandoned = new Set(['research', 'spike']);
  const v5: PlanVersion = {
    version: 5,
    nodes: v4.nodes.filter((candidate) => !abandoned.has(candidate.id)),
    edges: v4.edges.filter(
      (candidate) => !abandoned.has(candidate.source) && !abandoned.has(candidate.target),
    ),
  };

  return [v1, v2, v3, v4, v5];
}

/** Every node and edge that ever existed, each exactly once. */
export function unionGraph(versions: readonly PlanVersion[]): PlanGraph {
  const nodes = new Map<string, PlanNode>();
  const edges = new Map<string, PlanEdge>();
  for (const version of versions) {
    for (const candidate of version.nodes)
      if (!nodes.has(candidate.id)) nodes.set(candidate.id, candidate);
    for (const candidate of version.edges)
      if (!edges.has(candidate.id)) edges.set(candidate.id, candidate);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** The ids present in both versions — the ones AC4 forbids from moving. */
export function survivorsBetween(before: PlanGraph, after: PlanGraph): string[] {
  const later = new Set(after.nodes.map((candidate) => candidate.id));
  return before.nodes.map((candidate) => candidate.id).filter((id) => later.has(id));
}
