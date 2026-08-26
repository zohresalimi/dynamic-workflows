/**
 * KAR-28.2 AC1, AC2, AC4 — the run's agents, as a list.
 *
 * Verifies: EPIC-28-S07, EPIC-28-S08, EPIC-28-S09, EPIC-28-S12 · AC1, AC2, AC4
 *
 * The workflows screen's primary panel is a list of the run's agents, and this
 * is the shape of that list. It is a pure function for the same reason
 * `../components/graph/node-body.ts` is: *"is the failed first attempt still
 * readable after the second one passed"* is a question about a function, and a
 * question about a function that can only be asked by mounting a page gets
 * asked once.
 *
 * ## What this module is allowed to be, and what it is not
 *
 * It is **not a second model of the run** (AC4). It takes the shared
 * `NodeBodyVM` map — the very object `../app/useNodeBodies.ts` hands the graph,
 * memoised by content, in the tick the graph is drawing — and returns rows that
 * *hold* those bodies rather than copies of them. Everything the eight columns
 * show for the row that **is** a node is read straight off its body, so the list
 * and the canvas cannot print one node two ways (EPIC-28-S12).
 *
 * The two facts it adds are the two the bodies genuinely do not carry:
 *
 * 1. **One row per attempt.** A `NodeBodyVM` describes a node, and a node has
 *    exactly one current attempt; the previous ones are in the timeline's spans
 *    — a span *is* an attempt, opened by `node.started` and closed by the
 *    terminal event. So a retried step becomes one row per span, and the rows
 *    for the attempts that are over read their state, their duration and their
 *    money off their own span. That is the thing AC2 exists to replace: an
 *    attempt history collapsed into one row shows `passed` and loses the ninety
 *    seconds spent finding out the first way would not work.
 * 2. **The hierarchy.** A fan-out materialises its children into the plan as
 *    real nodes named `<parent>--<child>` — `@DeFlow/core`'s `mapChildId`, and
 *    docs/04-domain-model.md §3 on why they have to exist as nodes at all. That
 *    naming is the *only* spawn relationship anything in this build records, so
 *    it is the only one read here: `parentOf` claims a parent when the plan
 *    actually holds a node by that name and claims none otherwise. A run with
 *    no fan-out comes back flat, every row at depth `0`, and the list draws no
 *    hierarchy chrome over a hierarchy that is not there (EPIC-28-S09).
 *
 * ## Three things it deliberately does not know
 *
 * - **A duration or a price of its own.** `formatElapsed` and `formatSpend` are
 *   imported from the node body rather than restated, so `3.4 s` and `~$0.07`
 *   have one spelling on this screen (EPIC-28-S12).
 * - **Which model ran attempt 1.** The plan projection keeps one provider and
 *   one model per *node*, not one per attempt, so an attempt row shows the
 *   node's and does not pretend to know better. Inventing a per-attempt answer
 *   from a field that does not have one is the kind of plausible lie the whole
 *   `UNKNOWN` vocabulary next door exists to avoid.
 * - **What a sub-agent inside a turn did.** A vendor's own `Task`-tool
 *   sub-agents appear in a turn's activity frames and in no projection, so they
 *   are not nodes and there is nothing here to nest them under. When a
 *   projection records them this function grows a second parent source; until
 *   then it has one.
 */

import { formatElapsed, formatSpend, type NodeBodyVM } from '../components/graph/node-body.ts';
import { attemptKey } from '../ledger/projections/cost.ts';
import type { TimelineSpanVM } from '../ledger/vm.ts';
import { type DisplayState, SPAN_OUTCOME_DISPLAY, STATE_LABELS } from './state-palette.ts';

/**
 * What an attempt's row says when the ledger never closed its span.
 *
 * `not started` — the node body's word for a node that has no span at all —
 * would be a lie about an attempt that demonstrably started, and `0.0 s` would
 * be a measurement nobody took. This is the only string this module owns.
 */
export const UNFINISHED = 'not finished';

/**
 * The separator `mapChildId` joins a parent to its child with. Stated here as
 * the thing being *parsed* — core owns the spelling, this reads it back.
 */
const CHILD_SEPARATOR = '--';

export interface AgentRowVM {
  /** `${nodeId}#${attempt}` — the ledger's own attempt key, so one row has one name. */
  readonly key: string;
  readonly nodeId: string;
  /** The ledger's attempt number, counted from zero. */
  readonly attempt: number;
  /** The same attempt as a person counts them: `try #1` is `attempt` 0. */
  readonly tryNumber: number;
  /** The node's title, plus `— try #n` when there is more than one attempt. */
  readonly title: string;
  readonly type: string;
  readonly state: DisplayState;
  readonly stateLabel: string;
  readonly provider: string;
  readonly model: string;
  readonly permission: string;
  readonly elapsed: string;
  readonly cost: string;
  /** `0` for a node nothing spawned; `1` for a fan-out's child, and so on. */
  readonly depth: number;
  readonly parentId: string | null;
  /** Whether this row is the node's latest attempt — the one the graph draws. */
  readonly current: boolean;
  /**
   * The shared body this row belongs to — **the** object, not a copy of it.
   *
   * Carried so a row can open the node it describes without the list holding a
   * second index of the run, and so `expect(row.body).toBe(bodies.get(id))` is
   * a statement a test can make about AC4.
   */
  readonly body: NodeBodyVM;
}

export interface AgentRowsInput {
  /** The shared bodies, in the plan's own order (`../app/useNodeBodies.ts`). */
  readonly bodies: ReadonlyMap<string, NodeBodyVM>;
  /** Every attempt's span, in any order. Spans for absent nodes are ignored. */
  readonly spans: readonly TimelineSpanVM[];
}

/**
 * The node that spawned `id`, if the plan holds one.
 *
 * The **longest** matching prefix, so `fan--a--b` belongs to `fan--a` when that
 * node exists and to `fan` when it does not. A name that merely contains the
 * separator — `orphan--child` in a plan with no `orphan` — has no parent: the
 * relationship is a fact about the plan, not about the string.
 */
export function parentOf(id: string, ids: ReadonlySet<string>): string | null {
  let at = id.lastIndexOf(CHILD_SEPARATOR);
  while (at > 0) {
    const candidate = id.slice(0, at);
    if (ids.has(candidate)) return candidate;
    at = id.lastIndexOf(CHILD_SEPARATOR, at - 1);
  }
  return null;
}

/**
 * Every span, grouped by node and sorted oldest attempt first.
 *
 * Grouped once rather than filtered per node: `stress-400` has four hundred
 * nodes and a span each, and a filter inside the node loop is a hundred and
 * sixty thousand comparisons on every tick that changes anything.
 */
function attemptsByNode(
  spans: readonly TimelineSpanVM[],
): ReadonlyMap<string, readonly TimelineSpanVM[]> {
  const grouped = new Map<string, TimelineSpanVM[]>();
  for (const span of spans) {
    const held = grouped.get(span.nodeId);
    if (held === undefined) grouped.set(span.nodeId, [span]);
    else held.push(span);
  }
  for (const [nodeId, held] of grouped) {
    grouped.set(
      nodeId,
      held.toSorted((left, right) => left.attempt - right.attempt),
    );
  }
  return grouped;
}

/**
 * How long a finished attempt took, measured between its own two timestamps.
 *
 * Never against the wall clock: a superseded attempt's duration is a closed
 * fact, and one that crept upwards every second would be reporting the age of
 * the run rather than the cost of the work (the same rule `elapsedMsOf` states
 * next door for the open case).
 */
function elapsedOfSpan(span: TimelineSpanVM): string {
  return span.endTs === null ? UNFINISHED : formatElapsed(Math.max(0, span.endTs - span.startTs));
}

/** The display state of an attempt that is over — or `running`, if it is not. */
function stateOfSpan(span: TimelineSpanVM): DisplayState {
  return span.outcome === null ? 'running' : SPAN_OUTCOME_DISPLAY[span.outcome];
}

function rowsForNode(
  body: NodeBodyVM,
  spans: readonly TimelineSpanVM[],
  depth: number,
  parentId: string | null,
): readonly AgentRowVM[] {
  const shape = { depth, parentId, body, nodeId: body.id, type: body.type };

  /** The node's own facts — the eight the graph is drawing in this tick. */
  const asNode = (attempt: number, title: string): AgentRowVM => ({
    ...shape,
    key: attemptKey(body.id, attempt),
    attempt,
    tryNumber: attempt + 1,
    title,
    state: body.state,
    stateLabel: body.stateLabel,
    provider: body.provider,
    model: body.model,
    permission: body.permission,
    elapsed: body.elapsed,
    cost: body.cost,
    current: true,
  });

  // Nothing started, or started exactly once: the node and the attempt are the
  // same thing, and labelling a step `try #1` when there was only ever one
  // reads as a warning about a step that is perfectly fine.
  if (spans.length <= 1) {
    return [asNode(spans[0]?.attempt ?? body.attempt, body.title)];
  }

  const latest = spans[spans.length - 1]?.attempt;
  return spans.map((span) => {
    const title = `${body.title} — try #${span.attempt + 1}`;
    if (span.attempt === latest) return asNode(span.attempt, title);

    const state = stateOfSpan(span);
    return {
      ...shape,
      key: attemptKey(body.id, span.attempt),
      attempt: span.attempt,
      tryNumber: span.attempt + 1,
      title,
      state,
      stateLabel: STATE_LABELS[state],
      // The node's, not the attempt's: see the module note on what the ledger
      // records per node and what it records per attempt.
      provider: body.provider,
      model: body.model,
      permission: body.permission,
      elapsed: elapsedOfSpan(span),
      cost: formatSpend(span.costUsd),
      current: false,
    };
  });
}

/**
 * The list: every node of the plan, in the plan's order, each expanded into its
 * attempts and each followed immediately by the nodes it spawned.
 */
export function agentRows(input: AgentRowsInput): readonly AgentRowVM[] {
  const { bodies, spans } = input;
  const ids = new Set(bodies.keys());

  /** Children, in their parent's own plan order. Absent for a childless node. */
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const parents = new Map<string, string | null>();

  for (const id of bodies.keys()) {
    const parent = parentOf(id, ids);
    parents.set(id, parent);
    if (parent === null) {
      roots.push(id);
      continue;
    }
    const held = children.get(parent);
    if (held === undefined) children.set(parent, [id]);
    else held.push(id);
  }

  const attempts = attemptsByNode(spans);
  const rows: AgentRowVM[] = [];

  /**
   * Depth-first, so a child is drawn directly under the node that spawned it
   * even when the plan lists something else between them. Iterative rather than
   * recursive because a fan-out is the one place this list gets deep, and
   * `stress-400`'s four hundred children are a stack frame each.
   */
  const stack: { id: string; depth: number }[] = roots.map((id) => ({ id, depth: 0 })).toReversed();

  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const body = bodies.get(next.id);
    if (body === undefined) continue;

    rows.push(
      ...rowsForNode(body, attempts.get(next.id) ?? [], next.depth, parents.get(next.id) ?? null),
    );

    const mine = children.get(next.id);
    if (mine === undefined) continue;
    for (const child of mine.toReversed()) stack.push({ id: child, depth: next.depth + 1 });
  }

  return rows;
}
