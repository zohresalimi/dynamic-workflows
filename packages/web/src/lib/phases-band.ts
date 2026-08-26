/**
 * KAR-28.6 — the phases band's rows: this run's shape, and the work inside the
 * phase you are looking at.
 *
 * Verifies: EPIC-28-S23, EPIC-28-S24 · AC1, AC2, AC4
 *
 * The band under the agent list used to be *other runs' history*. It shows this
 * run's phases now, and the split between what this file computes and what it is
 * handed is the whole design of the story — so it is stated here rather than
 * discovered later:
 *
 * - **Membership comes from the daemon.** `runPhases()` in `@DeFlow/core`
 *   (KAR-28.5, ADR 0018) is the only thing that can answer *which nodes are in a
 *   phase*: containment is a property of the plan **document** — a `map`'s
 *   `body` template, an inline subgraph's own nodes — and the tab's plan
 *   projection is deliberately flat (`../ledger/projections/plan.ts` keeps one
 *   VM per node id and no nesting at all). A band that re-derived it here would
 *   be exactly the projection-invented-inside-a-component that KAR-28.5 was
 *   split off to prevent, and it would promote every `body` template to a phase
 *   of its own.
 * - **State and counts are folded here, off the stream.** Not because a second
 *   opinion is wanted, but because the alternative is a request per frame, and
 *   *"a workspace that re-read an endpoint per frame would look identical and
 *   fall over on a real run"* is an assertion `../views/project-workflows.test.ts`
 *   has been making since KAR-22.3. So the counts move with `node.completed` in
 *   the tick it arrives, through `foldPhaseItems` — **core's own function**, the
 *   very one `runPhases` folds with. One rule with two callers, so a band
 *   reading `3/7` beside a list showing four passed nodes is not a shape this
 *   code can take.
 *
 * ## Nothing is invented (AC4)
 *
 * A phase's title is the plan node's own. Its counts are ids that exist. There
 * is no percentage, no estimate of what is left, no per-agent token figure and
 * no throughput — `test/no-context-window-table.test.ts` states the standing
 * rule and this band is a surface it applies to squarely: the blueprint's
 * `31/75 · 12k tok/s` is two facts DeFlow holds and one it does not.
 */
import { foldPhaseItems, type NodeStatus, type PhaseState } from '@DeFlow/core';
import type { NodeBodyVM } from '../components/graph/node-body.ts';
import { type DisplayState, NODE_STATUS_DISPLAY, STATE_LABELS } from './state-palette.ts';

/**
 * One phase as the daemon answers it, in the tab's own vocabulary.
 *
 * A structural subset of `@DeFlow/core`'s `RunPhase`: the fields this surface
 * reads, with `NodeId` widened to `string` because nothing in `packages/web`
 * holds the brand (docs/12 §3.3 — components receive view models, and a branded
 * id crossing the wire arrives as JSON like everything else).
 *
 * The server's own `state`, `completed` and `total` are **deliberately not**
 * here. They are true at the instant of the fetch and stale one frame later; the
 * band folds live ones from the same membership, which is the module note's
 * whole subject.
 */
export interface PhaseShape {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly nodes: readonly string[];
}

/** The projection's answer for a run: why it has this shape, and what it is. */
export interface PhasesShape {
  readonly basis: 'plan' | 'no-plan';
  readonly phases: readonly PhaseShape[];
}

/** One row of the phases column. */
export interface PhaseRowVM {
  readonly id: string;
  /** The plan node's own `title`, verbatim. Never composed here. */
  readonly title: string;
  readonly type: string;
  /** The domain word, from core's fold. */
  readonly state: PhaseState;
  /** The same fact in the palette's seven, for colour and glyph. */
  readonly display: DisplayState;
  /** The text half of colour + glyph + text (docs/12 §9.2). */
  readonly stateLabel: string;
  readonly completed: number;
  readonly total: number;
  /** `3/7` — the two counts, printed as counts. Never a percentage. */
  readonly counts: string;
  /** The work items, in plan order — the daemon's list, passed through. */
  readonly nodes: readonly string[];
}

/** One item of work inside the selected phase. */
export interface PhaseWorkVM {
  readonly id: string;
  /** The node's title where the tab holds one, else the id it was given. */
  readonly title: string;
  readonly state: DisplayState;
  readonly stateLabel: string;
  /**
   * The shared body's own formatted elapsed, or `null` for a work item the tab
   * has never seen an event or a plan document for.
   *
   * Read off `NodeBodyVM` rather than formatted here for the reason
   * `TaskBoard.vue` gives about the same field: a duration formatted twice is
   * two answers to one question, and the band would read `3.0 s` beside a row
   * reading `3 s`.
   */
  readonly elapsed: string | null;
}

/**
 * How a phase's five states read in the seven-colour palette.
 *
 * The fourth and last of these tables (`NODE_STATUS_DISPLAY`,
 * `RUN_STATUS_DISPLAY`, `SPAN_OUTCOME_DISPLAY` are the others), and it agrees
 * with them by construction where the words overlap: a phase whose work all
 * completed is `passed`, one the operator cancelled is `abandoned` and never
 * `failed`. Total over `PhaseState`, so a sixth phase state is a compile error
 * here rather than an uncoloured chip.
 *
 * It lives beside the rows it colours rather than in `./state-palette.ts`
 * because a `PhaseState` is not a node, a run or an attempt — it is this band's
 * own domain word, and the palette module's three tables are all about things
 * more than one surface paints.
 */
export const PHASE_STATE_DISPLAY: Record<PhaseState, DisplayState> = {
  pending: 'pending',
  running: 'running',
  complete: 'passed',
  failed: 'failed',
  cancelled: 'abandoned',
};

/**
 * The band's phase rows: the daemon's membership, folded against the statuses
 * this tab holds right now.
 *
 * `statuses` is the plan projection's own list — `useRunStore().planNodes` —
 * rather than a map built by the caller, so there is one place that decides what
 * "the status of a work item" means. A work item the tab has no node for folds
 * as `undefined`, which is exactly what `runPhases` passes to the same function
 * for a node the ledger has recorded nothing about.
 */
export function phaseRows(
  phases: readonly PhaseShape[],
  statuses: readonly { readonly id: string; readonly status: NodeStatus }[],
): readonly PhaseRowVM[] {
  const held = new Map<string, NodeStatus>(statuses.map((node) => [node.id, node.status]));

  return phases.map((phase) => {
    const fold = foldPhaseItems(phase.nodes.map((id) => held.get(id)));
    const display = PHASE_STATE_DISPLAY[fold.state];
    return {
      id: phase.id,
      title: phase.title,
      type: phase.type,
      state: fold.state,
      display,
      stateLabel: STATE_LABELS[display],
      completed: fold.completed,
      total: fold.total,
      counts: `${fold.completed}/${fold.total}`,
      nodes: phase.nodes,
    };
  });
}

/**
 * AC2 — the phase an operator lands on: **the one the run is in**.
 *
 * Three arms, and each is a fact rather than a preference:
 *
 * 1. The first phase with work in flight. On a run mid-execution that is the
 *    answer to "where is it", which is the question the band exists for.
 * 2. Otherwise the **last** phase anything has happened to. A finished run lands
 *    on its final phase and a failed one lands where it stopped — in both cases
 *    the place the operator is about to look at.
 * 3. Otherwise the first phase, because a run that has not started anything is
 *    about to start there.
 *
 * `null` only when there are no phases at all, which is `basis: 'no-plan'`.
 */
export function currentPhaseId(rows: readonly PhaseRowVM[]): string | null {
  const running = rows.find((row) => row.state === 'running');
  if (running !== undefined) return running.id;

  const touched = rows.findLast((row) => row.state !== 'pending');
  return touched?.id ?? rows[0]?.id ?? null;
}

/**
 * The work in one phase, in the plan's own order.
 *
 * The bodies are `useNodeBodies()`'s — the same objects the agent list and the
 * canvas draw — so a work row and the row above it cannot describe one node two
 * ways. A work item with no body yet is still listed, under the id the plan gave
 * it: dropping it would make the list shorter than the `n/m` beside it for no
 * reason a reader could see, and the id is a recorded fact.
 */
export function phaseWork(
  nodes: readonly string[],
  bodies: ReadonlyMap<string, NodeBodyVM>,
): readonly PhaseWorkVM[] {
  return nodes.map((id) => {
    const body = bodies.get(id);
    if (body === undefined) {
      return {
        id,
        title: id,
        state: NODE_STATUS_DISPLAY.scheduled,
        stateLabel: STATE_LABELS[NODE_STATUS_DISPLAY.scheduled],
        elapsed: null,
      };
    }
    return {
      id,
      title: body.title,
      state: body.state,
      stateLabel: body.stateLabel,
      elapsed: body.elapsed,
    };
  });
}

/**
 * The `phases` field of `GET /api/runs/:id`, or `null` if it cannot be read.
 *
 * Skipped rather than guessed at, the same discipline `../lib/turn-activity.ts`
 * applies to a frame it does not understand: a daemon that answered a shape this
 * build does not know leaves the band off the screen, and never invents a phase
 * to fill it.
 */
export function readPhases(payload: unknown): PhasesShape | null {
  const field = (payload as { readonly phases?: unknown } | null)?.phases;
  const shape = field as { readonly basis?: unknown; readonly phases?: unknown } | undefined;
  if (shape === undefined || shape === null) return null;
  if (shape.basis !== 'plan' && shape.basis !== 'no-plan') return null;
  if (!Array.isArray(shape.phases)) return null;

  const phases: PhaseShape[] = [];
  for (const entry of shape.phases as readonly unknown[]) {
    const phase = entry as {
      readonly id?: unknown;
      readonly title?: unknown;
      readonly type?: unknown;
      readonly nodes?: unknown;
    };
    if (typeof phase.id !== 'string' || typeof phase.title !== 'string') continue;
    if (typeof phase.type !== 'string' || !Array.isArray(phase.nodes)) continue;
    phases.push({
      id: phase.id,
      title: phase.title,
      type: phase.type,
      nodes: (phase.nodes as readonly unknown[]).filter(
        (id): id is string => typeof id === 'string',
      ),
    });
  }

  return { basis: shape.basis, phases };
}
