/**
 * KAR-17.7 — the criterion → gate join, and the vocabulary the acceptance-
 * criteria board renders in (F10.8, F7.4, F7.3).
 *
 * Verifies: EPIC-17-S28, EPIC-17-S29 · AC1, AC2, AC3, AC4, AC5, AC7, AC8
 *
 * Pure. It takes `../ledger/projections/gates.ts`'s projection and returns
 * what the board draws; it touches no DOM and mounts nothing, exactly the same
 * split `./review-index.ts` makes for the diff surface next door — and for the
 * same reason: the join is legible without a browser, and everything a browser
 * is needed for lives in `../views/AcceptanceCriteriaView.vue`.
 *
 * ## The one collapse this file refuses to make
 *
 * **A criterion with no gate mapped to it is `unverifiable`, and it says so.**
 * `GatesProjection.criteria` already seeds every criterion from `run.created`
 * as `unverifiable` / `unmapped: true` and only a `gate.evaluated` speaking to
 * it moves it — this module adds nothing to that decision. What it adds is the
 * **explicit message** F7.4 asks for (AC4), held as one constant so the board
 * and the copy-as-markdown export cannot say two different things about the
 * same defect.
 *
 * ## Conflict, and why it is not "the status changed"
 *
 * `GatesProjection.criteria.get(id).status` is already *"the most recent
 * verdict wins"* — that is the correct headline (AC5) and this module does not
 * recompute it. A **conflict** is a narrower, additional fact: two different
 * *gates* currently disagree about the same criterion, as opposed to one gate
 * correcting itself over a repair loop (`gate-failure-repair`'s `ac-1` goes
 * `unsatisfied` → `satisfied` from `typecheck` alone, twice — not a conflict).
 * So this module keeps each gate's own **latest** judgement of a criterion and
 * flags a conflict when those disagree, which is exactly what tells a repair
 * loop apart from a spec that two reviewers read differently.
 */
import type {
  CriterionStatus,
  FindingVM,
  GatesProjection,
  VerdictOutcome,
} from '../ledger/projections/gates.ts';
import { type DisplayState, stateVar } from './state-palette.ts';

export type { CriterionStatus } from '../ledger/projections/gates.ts';

/** AC4's exact wording — read by the board and by the markdown export alike. */
export const NO_GATE_MESSAGE = 'no gate maps to this criterion — spec defect (F7.4)';

export interface CriterionStatusStyleVM {
  readonly status: CriterionStatus;
  readonly glyph: string;
  readonly label: string;
  /** The seven-state palette this status borrows its colour from (AC2). */
  readonly tone: DisplayState;
}

/**
 * Three states, three glyphs, three colours — and `unverifiable` borrows
 * `awaiting-human`'s hue rather than `failed`'s, on purpose: it is a judgement
 * the board could not make, not a broken result, and `../lib/review-index.ts`
 * makes the identical choice for a `needs-human` verdict.
 */
export const CRITERION_STATUS_STYLE: Readonly<Record<CriterionStatus, CriterionStatusStyleVM>> = {
  satisfied: { status: 'satisfied', glyph: '✓', label: 'satisfied', tone: 'passed' },
  unsatisfied: { status: 'unsatisfied', glyph: '✕', label: 'unsatisfied', tone: 'failed' },
  unverifiable: {
    status: 'unverifiable',
    glyph: '∅',
    label: 'unverifiable',
    tone: 'awaiting-human',
  },
};

/** The CSS custom property a criterion row should paint with (AC2). */
export function criterionStatusVar(status: CriterionStatus): string {
  return stateVar(CRITERION_STATUS_STYLE[status].tone);
}

/** One verdict's judgement of one criterion, with its own findings joined on. */
export interface CriterionVerdictVM {
  readonly seq: number;
  readonly gate: string;
  readonly evaluatedNode: string;
  readonly attempt: number;
  readonly outcome: VerdictOutcome;
  readonly summary: string;
  /** What *this* verdict said about *this* criterion — not the headline. */
  readonly status: CriterionStatus;
  /** This verdict's findings that named this criterion, in the order they arrived. */
  readonly findings: readonly FindingVM[];
}

export interface CriterionRowVM {
  readonly id: string;
  readonly statement: string | null;
  /** The headline: the most recent verdict across every gate (AC5). */
  readonly status: CriterionStatus;
  readonly unmapped: boolean;
  /** Two gates' latest judgements of this criterion disagree (AC5). */
  readonly conflict: boolean;
  /** Every gate that has spoken to it, first-mention order. */
  readonly gates: readonly string[];
  /** Every verdict that judged it, oldest first — the evidence AC3 asks for. */
  readonly evidence: readonly CriterionVerdictVM[];
}

export interface CriteriaBoardVM {
  /** Spec order (AC1) — `GatesProjection.criteria`'s own insertion order. */
  readonly rows: readonly CriterionRowVM[];
  readonly counts: Readonly<Record<CriterionStatus, number>>;
  readonly total: number;
  /**
   * The run's overall answer (AC7).
   *
   * Never the word "done" while `counts.unverifiable > 0`, and never a
   * percentage — "80% satisfied with 20% unverifiable" is exactly the
   * misreading a percentage invites, and this board exists to prevent it.
   */
  readonly headline: string;
}

/**
 * The join AC1–AC5 describe.
 *
 * Built from `state.verdicts` rather than only from `state.criteria`, for the
 * same reason `reviewIndex` reads `gates.verdicts` rather than
 * `gates.findingsByFile` alone: the headline status is one cell, and AC3's
 * "every gate that speaks to it" needs the history the headline throws away.
 */
export function criteriaBoard(state: GatesProjection): CriteriaBoardVM {
  const evidenceByCriterion = new Map<string, CriterionVerdictVM[]>();
  // criterionId → gate → that gate's latest status for it. A `Map` preserves
  // nothing about order that matters here; what matters is that a later
  // verdict from the same gate overwrites its own earlier entry rather than
  // appending one, so two attempts from one gate can never look like two
  // gates disagreeing.
  const latestPerGate = new Map<string, Map<string, CriterionStatus>>();

  // `state.verdicts` is pushed in `seq` order by `applyGates`, so a `Map.set`
  // below is always "this gate's most recent word" by construction.
  for (const verdict of state.verdicts) {
    for (const judged of verdict.criteria) {
      const evidence = evidenceByCriterion.get(judged.id) ?? [];
      evidence.push({
        seq: verdict.seq,
        gate: verdict.gate,
        evaluatedNode: verdict.evaluatedNode,
        attempt: verdict.attempt,
        outcome: verdict.outcome,
        summary: verdict.summary,
        status: judged.status,
        findings: verdict.findings.filter((finding) => finding.criterion === judged.id),
      });
      evidenceByCriterion.set(judged.id, evidence);

      const byGate = latestPerGate.get(judged.id) ?? new Map<string, CriterionStatus>();
      byGate.set(verdict.gate, judged.status);
      latestPerGate.set(judged.id, byGate);
    }
  }

  const rows: CriterionRowVM[] = [...state.criteria.values()].map((criterion) => {
    const byGate = latestPerGate.get(criterion.id);
    const distinctStatuses = byGate === undefined ? 0 : new Set(byGate.values()).size;
    return {
      id: criterion.id,
      statement: criterion.statement,
      status: criterion.status,
      unmapped: criterion.unmapped,
      conflict: distinctStatuses > 1,
      gates: criterion.gates,
      evidence: evidenceByCriterion.get(criterion.id) ?? [],
    };
  });

  const counts: Record<CriterionStatus, number> = {
    satisfied: 0,
    unsatisfied: 0,
    unverifiable: 0,
  };
  for (const row of rows) counts[row.status] += 1;

  const headline = ((): string => {
    if (rows.length === 0) return 'no acceptance criteria recorded';
    if (counts.unverifiable > 0) {
      return (
        `${String(counts.satisfied)} of ${String(rows.length)} criteria satisfied — ` +
        `${String(counts.unverifiable)} unverifiable`
      );
    }
    if (counts.unsatisfied > 0) {
      return (
        `${String(counts.satisfied)} of ${String(rows.length)} criteria satisfied — ` +
        `${String(counts.unsatisfied)} unsatisfied`
      );
    }
    return `all ${String(rows.length)} criteria satisfied`;
  })();

  return { rows, counts, total: rows.length, headline };
}

/**
 * The copy-as-markdown export (AC8) — a checklist suitable for a PR
 * description, built from the same `CriteriaBoardVM` the table renders so the
 * two cannot drift apart (test plan row 6's red: *"the export drifts from the
 * table"*).
 */
export function criteriaMarkdown(board: CriteriaBoardVM): string {
  const lines = board.rows.map((row) => {
    const box = row.status === 'satisfied' ? 'x' : ' ';
    const suffix = ((): string => {
      if (row.status === 'unverifiable') {
        return row.unmapped ? ` — unverifiable (${NO_GATE_MESSAGE})` : ' — unverifiable';
      }
      if (row.status === 'unsatisfied') return ' — unsatisfied';
      return '';
    })();
    const conflict = row.conflict ? ' — ⚠ conflicting verdicts' : '';
    const statement = row.statement ?? '(no statement recorded)';
    return `- [${box}] **${row.id}** — ${statement}${suffix}${conflict}`;
  });
  return [`_${board.headline}_`, '', ...lines].join('\n');
}
