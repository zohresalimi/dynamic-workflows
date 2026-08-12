/**
 * KAR-18.9 AC1-AC5 — the one presentation layer every command prints through.
 *
 * The information the CLI produced was already right; the presentation was
 * not. Five commands each formatted their own output, which is why they did
 * not look like one tool: a long detail ran off the edge, statuses did not line
 * up into a column the eye could scan, and the one line an operator needs —
 * *here is what to do next* — was somewhere in the middle.
 *
 * So this module owns glyph, colour, section heading, column alignment,
 * wrapping and the summary block, and `doctor`, `init`, `status`, `run` and
 * `ledger snapshot` map their own model onto `Report` rather than formatting
 * anything. `test/render-guard.test.ts` is what keeps that true next month.
 *
 * The summary's shape is AC5's settlement of an apparent contradiction — the
 * owner asked for the summary *"at the end, ahead of the detail"*. It is **last
 * in the report and first within the block**: the next action is the first line
 * of the last block, which is where a terminal leaves the cursor after a long
 * report and what the vendor CLIs do.
 *
 * Verifies: EPIC-18-S57, EPIC-18-S58, EPIC-18-S61 · AC1-AC5
 */

import { REPORT_STATES, type ReportState, STATE_LABELS } from './glyphs.ts';
import { columnWidth, wrapDetail } from './layout.ts';
import { STATE_COLOURS, type Style } from './style.ts';

export type { ReportState };
export { REPORT_STATES, STATE_LABELS };

export interface ReportRow {
  /** Stable, machine-readable and short — what the eye scans down. */
  readonly id: string;
  readonly state: ReportState;
  /** Why it is that state. Wrapped, and never truncated. */
  readonly detail: string;
  /**
   * One command to run when *this* row is the worst thing in the report.
   *
   * Every row that can be worst needs one worth printing: a summary whose next
   * action is "see above" has restated the problem rather than answered it.
   */
  readonly action?: string;
}

export interface ReportSection {
  readonly title: string;
  readonly rows: readonly ReportRow[];
}

export interface Report {
  readonly title: string;
  readonly sections: readonly ReportSection[];
  /** The overall verdict, when the command computed one of its own. Otherwise
   * the worst row wins, which is the same rule spelled by the renderer. */
  readonly state?: ReportState;
  /** Printed beside the overall status when the command has a code to name. */
  readonly exitCode?: number;
  /** Used when the worst row carries no action of its own (AC5). */
  readonly fallbackAction?: string;
}

/** `skipped` sits above `ok` and below `warn`: it is not a pass, and it is not
 * a complaint about the machine either. */
const SEVERITY: Readonly<Record<ReportState, number>> = { ok: 0, skipped: 1, warn: 2, fail: 3 };

export function worstState(states: readonly ReportState[]): ReportState {
  return states.reduce<ReportState>(
    (worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst),
    'ok',
  );
}

export function stateCounts(rows: readonly ReportRow[]): Record<ReportState, number> {
  const counts: Record<ReportState, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

const allRows = (report: Report): readonly ReportRow[] =>
  report.sections.flatMap((section) => section.rows);

/**
 * The action to print, chosen from the **worst** row that has one.
 *
 * Not "the worst row", which would print nothing whenever the single worst
 * check happens to be one nothing can be run about — a report whose next action
 * silently disappears the moment something goes more wrong is worse than one
 * that never had it. Ties go to the earliest such row, so the answer is stable
 * across a change to collection order: a next action that moves between runs on
 * an unchanged machine is one nobody trusts.
 */
export function nextAction(report: Report): string | null {
  const rows = allRows(report);
  if ((report.state ?? worstState(rows.map((row) => row.state))) === 'ok') return null;

  const owner = rows
    .filter((row) => row.state !== 'ok' && row.action !== undefined)
    .reduce<ReportRow | null>(
      (worst, row) => (worst === null || SEVERITY[row.state] > SEVERITY[worst.state] ? row : worst),
      null,
    );
  return owner?.action ?? report.fallbackAction ?? null;
}

/** Two spaces of indent under a heading, and two between columns. */
const INDENT = 2;
const GAP = 2;

/**
 * `head` with `text` laid out beside it, wrapped and indented to `column`.
 *
 * The one interesting case is an unbreakable token — an absolute path, a URL —
 * that is wider than the space left beside the head. AC4 says such a token is
 * emitted whole rather than broken, and putting it *after* the head would make
 * the line long **and** full of spaces, which is neither readable nor
 * copyable. So the head keeps its line and the token gets one of its own,
 * still at the detail column, where it is a single selectable word.
 *
 * `column` rather than `head.length`: the head may already carry an escape
 * sequence, and `.length` counts those.
 */
function attach(head: string, column: number, text: string, style: Style): string[] {
  const wrapped = wrapDetail(text, { width: style.width, indent: column });
  const first = wrapped[0] ?? '';
  if (first !== '' && column + first.length > style.width) {
    return [head.trimEnd(), `${' '.repeat(column)}${first}`, ...wrapped.slice(1)];
  }
  return [`${head}${first}`.trimEnd(), ...wrapped.slice(1)];
}

function renderSection(section: ReportSection, style: Style): string[] {
  const idWidth = columnWidth(section.rows.map((row) => row.id));
  const labelWidth = columnWidth(section.rows.map((row) => STATE_LABELS[row.state]));
  // `<indent><id><gap><glyph> <label><gap>` — where every detail in this
  // section begins, and where its continuation lines line up.
  const detailColumn = INDENT + idWidth + GAP + 2 + labelWidth + GAP;

  const lines = ['', style.paint(section.title, style.colour ? 'bold' : null)];

  for (const row of section.rows) {
    const status = `${style.glyphs[row.state]} ${STATE_LABELS[row.state].padEnd(labelWidth)}`;
    const head =
      ' '.repeat(INDENT) +
      row.id.padEnd(idWidth) +
      ' '.repeat(GAP) +
      style.paint(status, STATE_COLOURS[row.state]) +
      ' '.repeat(GAP);

    lines.push(...attach(head, detailColumn, row.detail, style));
  }

  return lines;
}

/**
 * The summary block (AC5): last in the report, and the next action first
 * within it.
 *
 * Every state is counted, including the ones at zero — `0 fail` is the fact an
 * operator is looking for, and a census that omits its empty rows makes them
 * count the report instead.
 */
function renderSummary(report: Report, style: Style): string[] {
  const rows = allRows(report);
  const state = report.state ?? worstState(rows.map((row) => row.state));
  const counts = stateCounts(rows);
  const action = nextAction(report);

  const lines = [''];
  if (action !== null) {
    lines.push(...attach(`${style.paint('next:', 'bold')} `, 'next: '.length, action, style));
  }

  const census = REPORT_STATES.map((entry) => `${counts[entry]} ${entry}`).join(', ');
  const verdict = `${style.glyphs[state]} ${STATE_LABELS[state]}`;
  const exit = report.exitCode === undefined ? '' : ` — exit ${report.exitCode}`;
  lines.push(`overall: ${style.paint(verdict, STATE_COLOURS[state])} — ${census}${exit}`);
  return lines;
}

/**
 * One report, as the bytes a terminal receives. Always ends in a newline.
 *
 * The title wraps like everything else: `DeFlow init: workspace ready at
 * <an absolute path>` is routinely wider than a terminal, and a first line that
 * runs off the edge is the first thing an operator sees.
 */
export function renderReport(report: Report, style: Style): string {
  const lines = [
    ...wrapDetail(report.title, { width: style.width, indent: 0 }).map((line) =>
      style.paint(line, style.colour ? 'bold' : null),
    ),
    ...report.sections.flatMap((section) => renderSection(section, style)),
    ...renderSummary(report, style),
  ];
  return `${lines.join('\n')}\n`;
}
