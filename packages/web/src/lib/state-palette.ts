/**
 * KAR-16.1 — one state palette, seven views
 * (docs/12-frontend-architecture.md §9.1, §9.2).
 *
 * The palette is **CSS custom properties, not Tailwind classes**, and this
 * module is the only place that knows their names. Vue Flow node borders, Gantt
 * bars, context-budget segments, gate chips, criteria rows, the version rail
 * and the memory graph all ask `stateVar()` for a colour, which means dark mode
 * is seven redefinitions under `.dark` rather than an audit of nine views, and
 * a state added to the domain is a compile error here rather than an unstyled
 * chip somewhere nobody looks.
 *
 * **Colour is never the only signal.** Every state carries a colour, a glyph
 * and a text label — WCAG 1.4.1, and also simply better for a status board,
 * because roughly 8% of male engineers will otherwise misread the graph. The
 * label lives here beside the colour so the two cannot be defined in different
 * files and drift; the glyph is a component's job (`../components/StateChip.vue`)
 * because it is markup.
 *
 * The seven display states are **not** `@DeFlow/core`'s eight `NodeStatus`
 * values. The domain distinguishes things the scheduler acts on — `scheduled`
 * and `awaiting-retry` are different admissibility questions — that an operator
 * reading a graph does not need distinguished by hue. `NODE_STATUS_DISPLAY` is
 * that mapping, and it is a total `Record` over `NodeStatus` on purpose: a
 * ninth domain status fails the build here.
 */
import type { NodeStatus, RunStatus } from '@DeFlow/core';
import type { SpanOutcome } from '../ledger/vm.ts';

/**
 * The seven states F10.1 names, in the order a run moves through them.
 *
 * The order is the one the legend and the keyboard-reachable data table render
 * in, so it is stated once rather than sorted differently per view.
 */
export const DISPLAY_STATES = [
  'pending',
  'running',
  'blocked',
  'passed',
  'failed',
  'abandoned',
  'awaiting-human',
] as const;

export type DisplayState = (typeof DISPLAY_STATES)[number];

/**
 * The text half of "colour + glyph + text label".
 *
 * These are the strings a screen reader announces and the strings the chip
 * renders, deliberately the same ones: an accessible name that differs from the
 * visible label is its own WCAG failure (2.5.3) and makes "press the Failed
 * filter" an instruction nobody can follow.
 */
export const STATE_LABELS: Record<DisplayState, string> = {
  pending: 'Pending',
  running: 'Running',
  blocked: 'Blocked',
  passed: 'Passed',
  failed: 'Failed',
  abandoned: 'Abandoned',
  'awaiting-human': 'Awaiting human',
};

/**
 * How the domain's eight statuses read on a status board.
 *
 * - `scheduled` and `awaiting-retry` are both **pending**: one has not started
 *   and one will start again, and neither is a distinction the graph makes with
 *   colour. The inspector says which.
 * - `suspended` is **awaiting-human** because that is what a suspension is for
 *   here — the node asked for something and cannot proceed until it arrives.
 * - `blocked` is its own state rather than pending: it is done *to* the node by
 *   the scheduler, on evidence from outside it (D14), and an operator looking
 *   for why nothing is moving needs to see it.
 * - `cancelled` is **abandoned**, never folded into `failed`: a run's history
 *   has to be able to say "the operator stopped this" rather than "the agent
 *   broke", and a palette that cannot express that makes every kill-switch stop
 *   look like an incident afterwards.
 */
export const NODE_STATUS_DISPLAY: Record<NodeStatus, DisplayState> = {
  scheduled: 'pending',
  'awaiting-retry': 'pending',
  running: 'running',
  blocked: 'blocked',
  suspended: 'awaiting-human',
  completed: 'passed',
  failed: 'failed',
  cancelled: 'abandoned',
};

/** The display state a domain node status renders as. */
export function displayStateOf(status: NodeStatus): DisplayState {
  return NODE_STATUS_DISPLAY[status];
}

/**
 * The custom property a surface should paint with — never a literal colour.
 *
 * Returned as `var(--state-…)` rather than as the name, because the only
 * correct thing to do with it is put it in a style, and handing back the bare
 * name invites somebody to build a class name out of it instead.
 */
export function stateVar(state: DisplayState): string {
  return `var(--state-${state})`;
}

/**
 * KAR-24.4 — the same mapping one domain over: a **run**'s status, in the seven
 * display colours.
 *
 * It sits beside `NODE_STATUS_DISPLAY` rather than in the one component that
 * currently needs it, for the reason that file exists at all: the moment a
 * second surface paints a run's status — a row in the run list, a tab title, a
 * notification — a local copy is two tables that drift, and the drift shows up
 * as two words on one screen disagreeing about whether a run is finished.
 *
 * Total over `RunStatus` on purpose: a tenth run status is a compile error
 * here rather than an uncoloured dot somebody notices in a screenshot.
 */
export const RUN_STATUS_DISPLAY: Record<RunStatus, DisplayState> = {
  created: 'pending',
  'awaiting-spec-approval': 'awaiting-human',
  'spec-approved': 'pending',
  running: 'running',
  paused: 'blocked',
  'needs-human': 'awaiting-human',
  cancelling: 'blocked',
  completed: 'passed',
  aborted: 'abandoned',
};

/**
 * KAR-28.2 — and once more for an **attempt**, which is what a timeline span is
 * (`../ledger/projections/timeline.ts`).
 *
 * The agent list renders a retried step as one row per attempt, and the rows
 * for the attempts that are over have no `NodeStatus` to read: the plan
 * projection keeps one status per *node*, and that status describes the latest
 * attempt only. What a superseded attempt has is its span's `outcome`, so this
 * is the third and last table that turns a domain word into a display state.
 *
 * The three answers are deliberately the ones `NODE_STATUS_DISPLAY` gives for
 * the terminal statuses that produce them — `completed → passed`,
 * `failed → failed`, `cancelled → abandoned` — so a node and its own last
 * attempt cannot be painted two colours on one screen. Total over
 * `SpanOutcome`: a fourth way for an attempt to end is a compile error here.
 */
export const SPAN_OUTCOME_DISPLAY: Record<SpanOutcome, DisplayState> = {
  passed: 'passed',
  failed: 'failed',
  cancelled: 'abandoned',
};
