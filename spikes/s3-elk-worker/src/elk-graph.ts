/**
 * Translating this spike's plain plan graphs into ELK's shape and back.
 *
 * Kept apart from `./graph.ts` so that module can stay import-free and be read
 * by the Node-side unit slice; everything in here names an elkjs type.
 */
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api.js';
import type { PlanGraph } from './graph.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Positions = Record<string, Point>;

/** One set of options for every layout in the spike, so runs are comparable. */
export const BASE_OPTIONS: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '24',
  'elk.layered.spacing.nodeNodeBetweenLayers': '48',
};

export function toElk(
  graph: PlanGraph,
  perNode: Record<string, LayoutOptions> = {},
  extraRootOptions: LayoutOptions = {},
): ElkNode {
  return {
    id: 'root',
    layoutOptions: { ...BASE_OPTIONS, ...extraRootOptions },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
      ...(perNode[node.id] === undefined ? {} : { layoutOptions: perNode[node.id] }),
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
}

export function positionsOf(laidOut: ElkNode): Positions {
  const out: Positions = {};
  for (const child of laidOut.children ?? []) {
    out[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }
  return out;
}

/**
 * Which layer a node landed in, inferred from its x coordinate — the rank of
 * that x among the distinct x values in the layout. ELK does not report layer
 * indices, and for a left-to-right layered drawing the x column *is* the layer.
 */
export function layerOf(positions: Positions, id: string): number {
  const columns = [...new Set(Object.values(positions).map((point) => point.x))].sort(
    (left, right) => left - right,
  );
  return columns.indexOf(positions[id]?.x ?? Number.NaN);
}
