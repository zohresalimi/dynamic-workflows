/**
 * The scratch app. Everything it can do is reachable from `globalThis.__s3`,
 * because the thing driving it is `e2e/spike-s3-elk-worker.test.ts` in a real
 * Chromium against the built `dist/`, not a person.
 *
 * The heartbeat is the AC3 instrument: a plain 10 ms `setInterval` on the main
 * thread, started before anything else happens and never stopped. If ELK were
 * running on the main thread it could not tick, and the counter is read either
 * side of the layout call.
 */
import { createEngine, elkAvailable, lastWorkerUrl } from 'elk-engine';
import { layerOf, type Positions, positionsOf, toElk } from './elk-graph.ts';
import {
  type PlanGraph,
  type PlanVersion,
  planVersions,
  sixtyNodeGraph,
  unionGraph,
} from './graph.ts';

let ticks = 0;
setInterval(() => {
  ticks += 1;
}, 10);

let engine: ReturnType<typeof createEngine> | null = null;
const elk = (): ReturnType<typeof createEngine> => {
  engine ??= createEngine();
  return engine;
};

const versions: PlanVersion[] = planVersions();
const container = document.getElementById('graph') as HTMLDivElement;

/** Filled by `prepare()`: one map per version, whatever the mechanism was. */
let byVersion = new Map<number, Positions>();

function render(version: number): void {
  const plan = versions.find((candidate) => candidate.version === version);
  const positions = byVersion.get(version) ?? {};
  container.replaceChildren();
  for (const node of plan?.nodes ?? []) {
    const point = positions[node.id];
    if (point === undefined) continue;
    const element = document.createElement('div');
    element.className = 'node';
    element.dataset.nodeId = node.id;
    element.textContent = `${node.label} · ${node.provider}`;
    element.style.left = `${point.x}px`;
    element.style.top = `${point.y}px`;
    element.style.width = `${node.width}px`;
    element.style.height = `${node.height}px`;
    container.append(element);
  }
}

/** Read back out of the DOM, so what is asserted is what was drawn. */
function domPositions(): Positions {
  const base = container.getBoundingClientRect();
  const out: Positions = {};
  for (const element of container.querySelectorAll<HTMLElement>('[data-node-id]')) {
    const id = element.dataset.nodeId;
    if (id === undefined) continue;
    const box = element.getBoundingClientRect();
    out[id] = { x: box.left - base.left, y: box.top - base.top };
  }
  return out;
}

async function layoutGraph(graph: PlanGraph): Promise<Positions> {
  return positionsOf(await elk().layout(toElk(graph)));
}

/**
 * The two mechanisms, side by side. `union` lays the union of all five versions
 * out **once** and each version is then a subset of that one result — which is
 * why nothing can move. `per-version` is the obvious alternative, laid out five
 * times, and it is here to be measured rather than to be argued about.
 */
async function prepare(mode: 'union' | 'per-version'): Promise<void> {
  byVersion = new Map();
  if (mode === 'union') {
    const once = await layoutGraph(unionGraph(versions));
    for (const version of versions) byVersion.set(version.version, once);
    return;
  }
  for (const version of versions) {
    byVersion.set(version.version, await layoutGraph(version));
  }
}

const LAYER_CHOICE = 'org.eclipse.elk.layered.layering.layerChoiceConstraint';
const POSITION_CHOICE = 'org.eclipse.elk.layered.crossingMinimization.positionChoiceConstraint';

interface ConstraintProbe {
  targetNode: string;
  baselineLayer: number;
  requestedLayer: number;
  optionIsKnown: boolean;
  baseline: Positions;
  withoutInteractive: Positions;
  withInteractive: Positions;
  withInteractiveStrategy: Positions;
  interactiveStrategyNoConstraint: Positions;
  semiInteractivePosition: Positions;
  layers: Record<string, number>;
  errors: string[];
}

/**
 * The recipe that circulates online, tried on 0.12.0 rather than believed.
 *
 * `layerChoiceConstraint` and `positionChoiceConstraint` are set on a node that
 * the unconstrained layout puts somewhere else, so an effect would be visible;
 * then the same thing with `org.eclipse.elk.interactiveLayout` turned on; then
 * the `semiInteractive` variant, which the research says reads
 * `org.eclipse.elk.position` instead. Each result is returned, none is judged
 * here.
 */
async function constraintProbe(): Promise<ConstraintProbe> {
  const errors: string[] = [];
  const probe: PlanGraph = {
    nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id,
      label: id,
      provider: 'claude-code',
      width: 120,
      height: 44,
    })),
    edges: [
      { id: 'a->b', source: 'a', target: 'b' },
      { id: 'b->c', source: 'b', target: 'c' },
      { id: 'c->d', source: 'c', target: 'd' },
      { id: 'a->e', source: 'a', target: 'e' },
      { id: 'e->d', source: 'e', target: 'd' },
    ],
  };

  const run = async (
    perNode: Record<string, Record<string, string>>,
    root: Record<string, string> = {},
  ): Promise<Positions> => {
    try {
      return positionsOf(await elk().layout(toElk(probe, perNode, root)));
    } catch (error) {
      errors.push(String(error));
      return {};
    }
  };

  const baseline = await run({});
  const target = 'e';
  const baselineLayer = layerOf(baseline, target);
  const requestedLayer = baselineLayer === 1 ? 2 : 1;

  const constrained = {
    [target]: { [LAYER_CHOICE]: String(requestedLayer), [POSITION_CHOICE]: '0' },
  };

  // Asked of ELK itself, not of a blog post: is this option id one it knows?
  // Without this, "the constraint had no effect" would be indistinguishable
  // from "the constraint was misspelt and thrown away by the parser".
  const known = await elk()
    .knownLayoutOptions()
    .then((options) => options.map((option) => option.id))
    .catch((error) => {
      errors.push(String(error));
      return [] as (string | undefined)[];
    });

  const withoutInteractive = await run(constrained);
  const withInteractive = await run(constrained, { 'org.eclipse.elk.interactiveLayout': 'true' });
  // The obvious next thing a developer tries when the previous line does
  // nothing: turn the layering strategy itself interactive.
  const interactiveStrategies = {
    'org.eclipse.elk.interactiveLayout': 'true',
    'org.eclipse.elk.layered.layering.strategy': 'INTERACTIVE',
    'org.eclipse.elk.layered.crossingMinimization.strategy': 'INTERACTIVE',
  };
  const withInteractiveStrategy = await run(constrained, interactiveStrategies);
  // The control. INTERACTIVE layering reads node coordinates, and these nodes
  // have none, so it redraws the graph whatever the constraints say. Without
  // this run, "the drawing changed" and "the constraint was honoured" are the
  // same observation — which is exactly the mistake the blog posts make.
  const interactiveStrategyNoConstraint = await run({}, interactiveStrategies);
  const semiInteractivePosition = await run(
    { [target]: { 'org.eclipse.elk.position': `(${requestedLayer},0)` } },
    {
      'org.eclipse.elk.interactiveLayout': 'true',
      'org.eclipse.elk.layered.crossingMinimization.semiInteractive': 'true',
    },
  );

  return {
    targetNode: target,
    baselineLayer,
    requestedLayer,
    optionIsKnown: known.includes(LAYER_CHOICE) && known.includes(POSITION_CHOICE),
    baseline,
    withoutInteractive,
    withInteractive,
    withInteractiveStrategy,
    interactiveStrategyNoConstraint,
    semiInteractivePosition,
    // Equal coordinates are weak evidence; "did the node land in the layer it
    // asked for" is the question, and it is the one recorded.
    layers: {
      baseline: baselineLayer,
      withoutInteractive: layerOf(withoutInteractive, target),
      withInteractive: layerOf(withInteractive, target),
      withInteractiveStrategy: layerOf(withInteractiveStrategy, target),
      interactiveStrategyNoConstraint: layerOf(interactiveStrategyNoConstraint, target),
      semiInteractivePosition: layerOf(semiInteractivePosition, target),
    },
    errors,
  };
}

/**
 * The documented fallback, executed. Dynamically imported so it is its own
 * chunk and the entry-chunk comparison stays about ELK.
 */
async function dagreSixty(): Promise<{ count: number; positions: Positions; version: string }> {
  const dagre = await import('@dagrejs/dagre');
  const graph = sixtyNodeGraph();
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR' });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) g.setNode(node.id, { width: node.width, height: node.height });
  for (const edge of graph.edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);

  const positions: Positions = {};
  for (const id of g.nodes()) {
    const node = g.node(id) as { x: number; y: number };
    positions[id] = { x: node.x, y: node.y };
  }
  return { count: Object.keys(positions).length, positions, version: dagre.version };
}

const api = {
  elkAvailable,
  async layoutSixty() {
    const before = ticks;
    const startedAt = performance.now();
    const positions = await layoutGraph(sixtyNodeGraph());
    return {
      count: Object.keys(positions).length,
      positions,
      heartbeatDelta: ticks - before,
      durationMs: performance.now() - startedAt,
      workerUrl: lastWorkerUrl(),
    };
  },
  prepare,
  showVersion: render,
  domPositions,
  constraintProbe,
  dagreSixty,
};

(globalThis as unknown as { __s3: typeof api }).__s3 = api;
