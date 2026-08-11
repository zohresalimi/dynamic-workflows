/**
 * KAR-17.1 AC4 — what a node body says, as a total function of four view
 * models.
 *
 * > A node body shows: type glyph, title, state, provider and model, permission
 * > level, a streaming badge while running, a gate verdict chip where one
 * > applies, elapsed time and cost so far.
 *
 * That list spans three projections — `plan.ts` for the node, `timeline.ts` for
 * how long it has been going, `cost.ts` for what it has spent, `gates.ts` for
 * whether a gate has spoken about it — so the join has to happen somewhere. It
 * happens **here**, in a pure function, rather than in the component's template,
 * for the same reason the projections are pure: a `v-if` chain that decides
 * whether "not priced" or "$0.00" is the honest answer is domain reasoning, and
 * domain reasoning inside a template is unreachable by anything except a
 * mounted browser.
 *
 * ## The rule this file exists to enforce
 *
 * **Every field is present and nothing renders as the empty string.** A node
 * exists in the plan before any `node.scheduled` says what will run it, so
 * `provider` is legitimately unknown for part of every node's life — and an
 * empty cell on a status board reads as *"there is nothing to say"* rather than
 * as *"nobody has said yet"*. The two are different facts and the operator is
 * entitled to be told which one they are looking at. `UNKNOWN` below is that
 * vocabulary, in one place, so the graph, the data-table twin and the
 * accessible name cannot drift into three different ways of saying "no".
 *
 * Nothing here imports Vue, and nothing here reads a clock: `now` is a
 * parameter. A body that called `Date.now()` would be untestable at any
 * elapsed time except the one the test happened to run at.
 */
import type {
  CostFigures,
  GateAttemptVM,
  PlanNodeVM,
  TimelineSpanVM,
  VerdictOutcome,
} from '../../ledger/vm.ts';
import type { DiffPointerVM } from '../../lib/review-index.ts';
import { type DisplayState, STATE_LABELS } from '../../lib/state-palette.ts';

/**
 * What the body says when it has nothing to say.
 *
 * Words rather than dashes, because these are read aloud: `ariaLabelOf` in
 * `./types.ts` already promises a screen reader `"no provider yet"` rather than
 * `"null"`, and the visible label has to be the same string or the accessible
 * name and the visible one disagree — which is a WCAG 2.5.3 failure of its own
 * and makes "click the node with no provider" an instruction nobody can follow.
 */
export const UNKNOWN = {
  /** Matches `ariaLabelOf`'s fallback exactly; the two are read together. */
  type: 'node',
  provider: 'no provider yet',
  model: 'no model reported',
  permission: 'no permission recorded',
  elapsed: 'not started',
} as const;

/** No measurement tier has priced this node's work. Not the same as `$0.00`. */
export const NOT_PRICED = 'not priced';

export interface NodeBodyVM {
  readonly id: string;
  readonly title: string;
  /** The plan's node type — the glyph is chosen from this. */
  readonly type: string;
  readonly state: DisplayState;
  /** The text half of colour + glyph + text, from the one palette. */
  readonly stateLabel: string;
  readonly provider: string;
  readonly model: string;
  readonly permission: string;
  readonly attempt: number;
  /** An agent is producing output right now. Drives the badge, not the colour. */
  readonly streaming: boolean;
  /** The live phase from `node.progress`. **Never** a state. */
  readonly phase: string | null;
  readonly progressMessage: string | null;
  /** The outcome of the last gate to judge this node's work, if any. */
  readonly verdict: VerdictOutcome | null;
  readonly verdictGate: string | null;
  /**
   * The file and line that verdict points at, where a finding located it.
   *
   * Two primitives rather than one object, and that is the memoisation
   * contract: `shallowUnchanged` in `../../stores/memoise.ts` compares field by
   * field, and a nested object would be a new reference on every tick — which
   * would re-render every node body once a second for the life of the run.
   */
  readonly verdictFile: string | null;
  readonly verdictLine: number | null;
  /** Human-readable elapsed time, or `UNKNOWN.elapsed`. */
  readonly elapsed: string;
  /** The same number, for a caller that wants to sort by it. */
  readonly elapsedMs: number | null;
  readonly cost: string;
}

export interface NodeBodyInput {
  readonly node: PlanNodeVM;
  /** The span for the attempt on screen, or `null` if it never started. */
  readonly span: TimelineSpanVM | null;
  /** The last gate attempt against this node, or `null` if none has run. */
  readonly verdict: GateAttemptVM | null;
  /** This node's bucket of `cost.ts`'s four figures, or `null` for none. */
  readonly spend: CostFigures | null;
  /**
   * Where that verdict points into the diff, from `../../lib/review-index.ts`.
   *
   * Optional because most callers of this function have no interest in the
   * review surface at all, and absent is the honest default: a verdict with no
   * located finding has no line to offer, and inventing one is AC3's red.
   */
  readonly pointer?: DiffPointerVM | null;
  /** ms epoch. Passed in — see the module note. */
  readonly now: number;
}

/**
 * How long an attempt has been going.
 *
 * A closed span is measured between its own two timestamps and **not** against
 * the clock: a completed node whose duration crept upwards every second would
 * be reporting the age of the run rather than the cost of the work. An open one
 * is measured to `now`, clamped at zero — the ledger's `ts` is the daemon's
 * clock and `now` is the tab's, and a browser a few seconds behind would
 * otherwise render a negative duration on a node that has just started.
 */
export function elapsedMsOf(span: TimelineSpanVM | null, now: number): number | null {
  if (span === null) return null;
  const end = span.endTs ?? now;
  return Math.max(0, end - span.startTs);
}

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/**
 * A duration a person can read at a glance, at three scales.
 *
 * Seconds keep a decimal because most nodes finish inside a minute and the
 * difference between 3 s and 3.4 s is the difference between two agents;
 * minutes and hours drop it, because nobody diagnosing a two-hour run cares
 * about a tenth of a second and the extra digits cost width on a node body that
 * has none to spare.
 */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m ${twoDigits(totalSeconds % 60)}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours}h ${twoDigits(Math.floor((totalSeconds % 3600) / 60))}m`;
}

/**
 * The money, in the vocabulary its owner uses.
 *
 * Four kinds of spend live behind `CostFigures` and the graph shows **one**:
 * what the vendor billed, if it has said, and DeFlow's own Tier-2 estimate
 * otherwise — marked as an estimate with a `~`, because "the vendor charged you
 * 42 cents" and "we counted tokens and think it was about 42 cents" are
 * different claims and a graph that rendered them identically would be losing
 * the distinction EPIC-14 exists to keep. The full breakdown, including the
 * subscription and API-key paths, is the inspector's (KAR-17.3).
 *
 * `null` — no tier has priced this at all — is `not priced` rather than
 * `$0.00`: a node that cost nothing and a node nobody could price are not the
 * same node, and only one of them is a defect.
 */
export function formatSpend(spend: CostFigures | null): string {
  if (spend === null) return NOT_PRICED;
  if (spend.vendorReported !== null) return `$${spend.vendorReported.toFixed(2)}`;
  if (spend.estimated !== null) return `~$${spend.estimated.toFixed(2)}`;
  return NOT_PRICED;
}

/**
 * The body, in full.
 *
 * `state` is copied from the node rather than re-derived: `plan.ts` already
 * mapped the domain's eight statuses through the palette's total record, and a
 * second mapping here is a second place for an eighth status to fall through to
 * `pending`.
 */
export function toNodeBody(input: NodeBodyInput): NodeBodyVM {
  const { node, span, verdict, spend, now, pointer } = input;
  const elapsedMs = elapsedMsOf(span, now);

  return {
    id: node.id,
    title: node.title,
    type: node.type ?? UNKNOWN.type,
    state: node.state,
    stateLabel: STATE_LABELS[node.state],
    provider: node.provider ?? UNKNOWN.provider,
    model: node.model ?? UNKNOWN.model,
    permission: node.permission ?? UNKNOWN.permission,
    attempt: node.attempt,
    streaming: node.state === 'running',
    phase: node.phase,
    progressMessage: node.progressMessage,
    verdict: verdict?.outcome ?? null,
    verdictGate: verdict?.gate ?? null,
    verdictFile: pointer?.file ?? null,
    verdictLine: pointer?.line ?? null,
    elapsed: elapsedMs === null ? UNKNOWN.elapsed : formatElapsed(elapsedMs),
    elapsedMs,
    cost: formatSpend(spend),
  };
}
