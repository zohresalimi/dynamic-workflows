/**
 * KAR-21.1 AC3, AC4, AC7 — the frame, as a pure function of state.
 *
 * `(RunState, SessionState, Style) -> readonly string[]`, and every word of
 * that signature is load-bearing. No clock is read, no `process.*` is touched
 * and no I/O happens, so *"what would the operator see"* is an array a test can
 * compare — which is why not one scenario in this story is `manual`. The
 * elapsed time arrives inside `SessionState.nowMs`, measured by the caller
 * through its injected `Clock` (NF9), because a view that read the clock would
 * make every frame assertion a race.
 *
 * **Nothing here is a new rendering rule.** The status word is
 * `RUN_STATUS_LABELS`', the glyphs are `TRANSCRIPT_GLYPHS`', the duration is
 * `formatDuration`', the money is `formatCost`' — four cells, named, never
 * added across substances — and the gate sentence is `pendingGateSummary`'s,
 * the same one `deflow status` and the run API print. That is AC4, and it is
 * the epic's answer to its own biggest stated risk: this is a **composition**
 * of KAR-18.9's layer, not a second one beside it.
 *
 * **The lines it returns are already wrapped.** `render/screen.ts` counts the
 * rows a frame occupied so it can erase exactly that many, and a row that wraps
 * is one entry and two rows. Wrapping here rather than there is what keeps that
 * count honest — see the note on `occupiedRows`.
 */
import type { NodeState, NodeStatus, RunState } from '@DeFlow/core';
import { pendingGate, pendingGateSummary, RUN_STATUS_LABELS } from '@DeFlow/core';
import { PART_SEPARATORS, TRANSCRIPT_GLYPHS, type TranscriptGlyph } from '../../render/glyphs.ts';
import { wrapDetail } from '../../render/layout.ts';
import type { Style, StyleColour } from '../../render/style.ts';
import { formatCost, formatDuration, NODE_COLUMN } from '../render.ts';
import type { SessionState } from './state.ts';

/**
 * AC7's *stated fraction*: a third of the window, and no more.
 *
 * The frame is a footer, not a window. Two thirds of the terminal has to stay
 * the transcript, because the transcript is what an operator reads in order to
 * decide whether to intervene — a status region that grew to fill the screen
 * would have replaced the thing it exists to annotate.
 */
export const FRAME_ROW_FRACTION = 1 / 3;

/** Below this the frame is not a summary, it is a header. KAR-21.5 owns the
 * window too short to hold even this. */
export const MIN_FRAME_ROWS = 4;

/** How many rows the frame may occupy in a terminal of `rows` rows. */
export function frameRowBudget(rows: number): number {
  return Math.max(MIN_FRAME_ROWS, Math.floor(rows * FRAME_ROW_FRACTION));
}

/**
 * Which glyph each node status wears.
 *
 * A total record over `NodeStatus` rather than a `switch` with a default: a
 * status added to `NODE_STATUSES` without an entry here is a compile error,
 * where a default arm would have rendered it as whatever the fallback was.
 */
const NODE_GLYPHS: Readonly<Record<NodeStatus, TranscriptGlyph>> = {
  scheduled: 'pending',
  running: 'active',
  'awaiting-retry': 'pending',
  suspended: 'paused',
  blocked: 'paused',
  completed: 'done',
  failed: 'gone',
  cancelled: 'gone',
};

/** The colour each status reinforces — never the thing that carries it. */
const NODE_COLOURS: Readonly<Record<NodeStatus, StyleColour | null>> = {
  scheduled: 'dim',
  running: null,
  'awaiting-retry': 'yellow',
  suspended: 'yellow',
  blocked: 'yellow',
  completed: 'green',
  failed: 'red',
  cancelled: 'red',
};

/**
 * Which nodes keep their row when there are more than fit.
 *
 * Running first because that is what the operator is watching, then the ones
 * that are waiting to run, then the ones that went wrong, and completed last —
 * a finished node is the one fact the transcript above already carries in full.
 */
const ROW_PRIORITY: Readonly<Record<NodeStatus, number>> = {
  running: 0,
  'awaiting-retry': 1,
  blocked: 1,
  suspended: 1,
  scheduled: 2,
  failed: 3,
  cancelled: 4,
  completed: 5,
};

/** The narrowest detail column worth having; below it, prose is a stack of
 * syllables and the detail goes onto its own lines instead. */
const MIN_INLINE_DETAIL = 12;

/**
 * The indent a wrap may actually use at this width.
 *
 * `wrapDetail` will not lay prose out in less than 20 columns, so an indent
 * that left less than that would push every continuation line past the edge —
 * the failure EPIC-21-S02 is about, arriving through the padding rather than
 * through the text. At 20 columns the answer is no indent at all, which is the
 * right answer: a split pane has no width to spend on alignment.
 */
function indentAt(style: Style, wanted: number): number {
  return Math.min(wanted, Math.max(0, style.width - 20));
}

/** `text` as lines that fit `style.width`, continuations indented under it. */
function wrapped(text: string, style: Style, indent: number): string[] {
  return wrapDetail(text, { width: style.width, indent: indentAt(style, indent) });
}

/** One labelled line — the header, the gate, the cost — wrapped under itself. */
function block(text: string, style: Style, colour: StyleColour | null): string[] {
  return wrapped(text, style, 2).map((line) => style.paint(line, colour));
}

/** A detail that did not fit beside its row, on lines of its own. */
function detailLines(detail: string, style: Style, indent: number): string[] {
  const padding = ' '.repeat(indentAt(style, indent));
  return wrapped(detail, style, indent).map((line, index) =>
    style.paint(index === 0 ? `${padding}${line}` : line, 'dim'),
  );
}

/**
 * One node's row, and its continuation lines.
 *
 * Laid out exactly the way `run/render.ts` lays an event line out — the id
 * padded to `NODE_COLUMN`, the status at that column, the detail two columns
 * further and wrapped under itself — because the frame sits directly beneath
 * that transcript, and two column schemes on one screen read as two screens.
 *
 * Both fallbacks are the same decision `wrapDetail` already makes: the padding
 * is dropped when the terminal is too narrow to carry it, and the detail moves
 * onto its own lines when what is left beside the status would not hold a word.
 * Nothing is ever truncated — an operator who copies a worktree path out of the
 * frame needs the whole path, at exactly the moment they most need it.
 */
function nodeRow(id: string, node: NodeState, session: SessionState, style: Style): string[] {
  const glyphs = TRANSCRIPT_GLYPHS[style.charset];
  const status = node.status;
  const colour = NODE_COLOURS[status];
  const marker = `${glyphs[NODE_GLYPHS[status]]} ${id}`;
  const head =
    style.width >= NODE_COLUMN + status.length
      ? `${marker.padEnd(NODE_COLUMN)}${status}`
      : `${marker} ${status}`;

  const parts: string[] = [];
  // AC4 — the running node's elapsed time, from the instant the caller
  // measured through its own Clock. A node that never started has nothing to
  // be elapsed from, and a zero there would read as "instant".
  if (status === 'running' && node.startedTs > 0) {
    parts.push(formatDuration(Math.max(0, session.nowMs - node.startedTs)));
  }
  if (node.worktree !== null && node.worktree !== '') parts.push(node.worktree);
  const detail = parts.join(PART_SEPARATORS[style.charset]);

  if (head.length > style.width) {
    return [
      ...wrapped(head, style, 2).map((line) => style.paint(line, colour)),
      ...(detail === '' ? [] : detailLines(detail, style, 4)),
    ];
  }

  const painted = style.paint(head, colour);
  if (detail === '') return [painted];

  const column = head.length + 2;
  if (column + MIN_INLINE_DETAIL > style.width) return [painted, ...detailLines(detail, style, 4)];

  const lines = wrapped(detail, style, column);
  return [
    `${painted}  ${style.paint(lines[0] ?? '', 'dim')}`,
    ...lines.slice(1).map((line) => style.paint(line, 'dim')),
  ];
}

/**
 * The frame: what the operator sees pinned below the transcript.
 *
 * Assembled as *fixed* lines and *fillable* ones, because AC7's row budget has
 * to be spent in priority order rather than in reading order. The gate sentence
 * is fixed — it is the one line the operator is waiting for, and a plan large
 * enough to push it off the region is exactly the failure EPIC-21-S06 names.
 */
export function renderFrame(run: RunState, session: SessionState, style: Style): readonly string[] {
  const header = block(
    `run ${run.runId ?? '(not created yet)'} — ${RUN_STATUS_LABELS[run.status]}`,
    style,
    'bold',
  );

  const gate = pendingGate(run);
  const gateLines = gate === null ? [] : block(pendingGateSummary(gate), style, 'yellow');

  const inputLines =
    session.input === null
      ? []
      : block(`${session.input.prompt}: ${session.input.text}`, style, 'bold');

  const costLines = block(formatCost(run.budget.run.costUsd), style, 'dim');

  const fixed = header.length + gateLines.length + inputLines.length + costLines.length;
  const budget = frameRowBudget(session.rows);

  const ids = Object.keys(run.nodes).toSorted((left, right) => {
    const nodes = run.nodes;
    const byPriority =
      ROW_PRIORITY[nodes[left]?.status ?? 'completed'] -
      ROW_PRIORITY[nodes[right]?.status ?? 'completed'];
    return byPriority === 0 ? left.localeCompare(right) : byPriority;
  });

  const rows: string[] = [];
  let shown = 0;
  for (const id of ids) {
    const node = run.nodes[id];
    if (node === undefined) continue;
    const row = nodeRow(id, node, session, style);
    // One row is reserved for the `+N more` count while anything is left over,
    // so the count itself can never be the line that did not fit.
    const remaining = ids.length - shown - 1;
    const reserve = remaining > 0 ? 1 : 0;
    if (fixed + rows.length + row.length + reserve > budget) break;
    rows.push(...row);
    shown += 1;
  }

  const more = ids.length - shown;
  const moreLines = more > 0 ? block(`+${String(more)} more`, style, 'dim') : [];

  return [...header, ...rows, ...moreLines, ...gateLines, ...inputLines, ...costLines];
}
