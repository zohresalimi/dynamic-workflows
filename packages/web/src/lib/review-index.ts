/**
 * KAR-17.6 — the findings-to-line index, and the vocabulary a verdict is
 * rendered in (F7.7, F7.3, F7.5).
 *
 * Verifies: EPIC-17-S24, EPIC-17-S25, EPIC-17-S27 · AC2, AC3, AC4, AC5, AC6, AC10
 *
 * Pure. It takes `../ledger/projections/gates.ts`'s projection and returns what
 * the diff surface draws; it fetches nothing, touches no DOM, and knows nothing
 * about `@git-diff-view`. Everything a browser is needed for lives in
 * `../components/review/` and `../views/DiffReviewView.vue`, and everything
 * here is asserted next door without one.
 *
 * ## The three collapses this file refuses to make
 *
 * **A finding with no `location` is not a finding on line 1.** The naive index
 * is keyed on `finding.location?.line ?? 1`: it type-checks, it renders, and
 * it pins *"no test covers the new branch"* — a judgement about the change as a
 * whole — to whatever happens to occupy the first line of a file it was never
 * about. Those findings get a bucket of their own (`unlocated`), rendered at
 * file level, and they are counted in the total so a header that says *"4
 * findings"* is not quietly saying three.
 *
 * **`needs-human` is not `fail`.** A gate that returned `needs-human` because
 * its own binary is missing, or because the question is a judgement call, has
 * not said the work is wrong — it has said nobody has judged it. Colouring that
 * file red *"sends work into the repair loop that no amount of repair will
 * fix"* (docs/04-domain-model.md §7), so the tone for it is `judgement`, which
 * is neither `failing` nor `clean`.
 *
 * **Severity is three signals, not a colour.** Every severity carries a glyph
 * and a label as well as a tone (WCAG 1.4.1), because a red dot and an amber
 * dot are the same dot to about one man in twelve.
 */
import { DEFAULT_NO_PROGRESS_POLICY } from '@DeFlow/core';
import type { FindingVM, GatesProjection, VerdictOutcome } from '../ledger/projections/gates.ts';

export type FindingSeverity = FindingVM['severity'];

/** Worst first. The order the file list badges and the header count read in. */
export const FINDING_SEVERITY_ORDER = ['blocker', 'major', 'minor', 'info'] as const;

export interface SeverityStyleVM {
  readonly severity: FindingSeverity;
  /** The non-colour half of the encoding. One per severity, all distinct. */
  readonly glyph: string;
  readonly label: string;
  /** Lower is worse, so `Math.min` picks the badge. */
  readonly rank: number;
  /** Whether it is surfaced by default or behind a disclosure (EPIC-17-S25). */
  readonly surfacedByDefault: boolean;
}

export const SEVERITY_STYLE: Readonly<Record<FindingSeverity, SeverityStyleVM>> = {
  blocker: { severity: 'blocker', glyph: '⛔', label: 'blocker', rank: 0, surfacedByDefault: true },
  major: { severity: 'major', glyph: '▲', label: 'major', rank: 1, surfacedByDefault: true },
  minor: { severity: 'minor', glyph: '◆', label: 'minor', rank: 2, surfacedByDefault: false },
  info: { severity: 'info', glyph: 'ℹ', label: 'info', rank: 3, surfacedByDefault: false },
};

/**
 * How a file reads at a glance.
 *
 * Three values rather than two, and that is AC5: `judgement` is what a
 * `needs-human` verdict leaves behind, and it is not a shade of `failing`.
 */
export type ReviewTone = 'clean' | 'failing' | 'judgement';

export interface OutcomeStyleVM {
  readonly outcome: VerdictOutcome;
  readonly glyph: string;
  readonly label: string;
  readonly tone: ReviewTone;
}

/** Worst first, so a file's headline outcome is `outcomes[0]`. */
export const OUTCOME_ORDER = ['fail', 'needs-human', 'pass'] as const;

export const OUTCOME_STYLE: Readonly<Record<VerdictOutcome, OutcomeStyleVM>> = {
  fail: { outcome: 'fail', glyph: '✕', label: 'failed', tone: 'failing' },
  'needs-human': {
    outcome: 'needs-human',
    glyph: '?',
    label: 'judgement required',
    tone: 'judgement',
  },
  pass: { outcome: 'pass', glyph: '✓', label: 'passed', tone: 'clean' },
};

/** A finding with the verdict that produced it already joined on. */
export interface ReviewFindingVM extends FindingVM {
  /** The outcome of the verdict this finding came from — AC5's input. */
  readonly outcome: VerdictOutcome;
  /** Whose work was judged. Not the gate's own node. */
  readonly evaluatedNode: string;
}

export interface LineFindingsVM {
  readonly line: number;
  readonly findings: readonly ReviewFindingVM[];
}

export interface FileReviewVM {
  readonly file: string;
  /** Ascending by line — a gutter is read top to bottom. */
  readonly lines: readonly LineFindingsVM[];
  /** The same thing keyed, because a per-line slot asks by line number. */
  readonly byLine: ReadonlyMap<number, readonly ReviewFindingVM[]>;
  readonly worst: FindingSeverity | null;
  /** Every outcome that spoke to this file, worst first. */
  readonly outcomes: readonly VerdictOutcome[];
  readonly tone: ReviewTone;
  readonly count: number;
}

export interface ReviewIndexVM {
  /** By path, so the file list is stable across reloads. */
  readonly files: readonly FileReviewVM[];
  /** AC3 — findings about the change as a whole. Never on line 1. */
  readonly unlocated: readonly ReviewFindingVM[];
  /** Located and unlocated together. */
  readonly total: number;
  readonly bySeverity: Readonly<Record<FindingSeverity, number>>;
}

/** The worst of `severities`, or `null` when there are none. */
export function worstSeverity(severities: Iterable<FindingSeverity>): FindingSeverity | null {
  let worst: FindingSeverity | null = null;
  for (const severity of severities) {
    if (worst === null || SEVERITY_STYLE[severity].rank < SEVERITY_STYLE[worst].rank) {
      worst = severity;
    }
  }
  return worst;
}

/** The tone of a set of outcomes: any failure wins, then any judgement call. */
export function toneOf(outcomes: Iterable<VerdictOutcome>): ReviewTone {
  let tone: ReviewTone = 'clean';
  for (const outcome of outcomes) {
    const candidate = OUTCOME_STYLE[outcome].tone;
    if (candidate === 'failing') return 'failing';
    if (candidate === 'judgement') tone = 'judgement';
  }
  return tone;
}

/**
 * The index the diff surface draws from.
 *
 * Built from the *verdicts* rather than from the projection's own
 * `findingsByFile`, because that index drops the location-less findings — it
 * is keyed by file and they have no file — and because a finding on its own
 * says nothing about whether the gate that reported it failed or only asked for
 * a human, which is what AC5 needs.
 */
export function reviewIndex(gates: GatesProjection): ReviewIndexVM {
  const perFile = new Map<string, ReviewFindingVM[]>();
  const outcomesPerFile = new Map<string, Set<VerdictOutcome>>();
  const unlocated: ReviewFindingVM[] = [];
  const bySeverity: Record<FindingSeverity, number> = { blocker: 0, major: 0, minor: 0, info: 0 };

  for (const verdict of gates.verdicts) {
    for (const finding of verdict.findings) {
      const joined: ReviewFindingVM = {
        ...finding,
        outcome: verdict.outcome,
        evaluatedNode: verdict.evaluatedNode,
      };
      bySeverity[joined.severity] += 1;

      if (joined.location === null) {
        unlocated.push(joined);
        continue;
      }

      const file = joined.location.file;
      const held = perFile.get(file) ?? [];
      held.push(joined);
      perFile.set(file, held);
      const outcomes = outcomesPerFile.get(file) ?? new Set<VerdictOutcome>();
      outcomes.add(verdict.outcome);
      outcomesPerFile.set(file, outcomes);
    }
  }

  const files = [...perFile.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([file, findings]) => {
      const byLine = new Map<number, ReviewFindingVM[]>();
      for (const finding of findings) {
        // Non-null by construction: the location-less ones left above.
        const line = finding.location?.line ?? 0;
        const held = byLine.get(line) ?? [];
        held.push(finding);
        byLine.set(line, held);
      }
      for (const held of byLine.values()) {
        held.sort(
          (left, right) =>
            SEVERITY_STYLE[left.severity].rank - SEVERITY_STYLE[right.severity].rank ||
            left.seq - right.seq ||
            left.id.localeCompare(right.id),
        );
      }

      const seen = outcomesPerFile.get(file) ?? new Set<VerdictOutcome>();
      const outcomes = OUTCOME_ORDER.filter((outcome) => seen.has(outcome));

      return {
        file,
        lines: [...byLine.entries()]
          .toSorted(([left], [right]) => left - right)
          .map(([line, held]) => ({ line, findings: held as readonly ReviewFindingVM[] })),
        byLine: byLine as ReadonlyMap<number, readonly ReviewFindingVM[]>,
        worst: worstSeverity(findings.map((one) => one.severity)),
        outcomes,
        tone: toneOf(outcomes),
        count: findings.length,
      } satisfies FileReviewVM;
    });

  return {
    files,
    unlocated,
    total: files.reduce((sum, file) => sum + file.count, 0) + unlocated.length,
    bySeverity,
  };
}

/**
 * Where a node's verdict points into the diff.
 *
 * The other end of AC2. The findings index answers *"what does this line say"*
 * once the operator is on the file; this answers the question they ask first,
 * from the plan graph, which is *"where do I go"* — and the honest answer is a
 * file **and a line**, because a link that carries only the file lands them at
 * the top of a diff and leaves them to find the verdict themselves. That is the
 * two-windows workflow this whole surface exists to replace, rebuilt inside one
 * window.
 */
export interface DiffPointerVM {
  /** Whose work was judged. The `?node=` scope the diff opens in. */
  readonly node: string;
  readonly file: string;
  readonly line: number;
}

/**
 * `evaluatedNode` → the line its **latest** verdict points at, where there is
 * one.
 *
 * Three refusals, each of which would otherwise produce a link that lies:
 *
 * - **The latest verdict, not the worst one.** A node whose failure has since
 *   been repaired must stop pointing at the bug that is no longer there.
 * - **The worst finding, not the first.** Ordered by line, a `minor` at line 12
 *   precedes a `major` at line 31, and the first thing a reader should be shown
 *   is the one that matters most.
 * - **A located finding, or nothing at all.** A verdict whose findings are all
 *   about the change as a whole has no line to offer, and `?line=1` would be a
 *   guess dressed as a fact (AC3). The chip still links to the node's diff —
 *   it simply says nothing about where to look.
 */
export function diffPointers(gates: GatesProjection): ReadonlyMap<string, DiffPointerVM> {
  const latest = new Map<string, { readonly seq: number; readonly findings: readonly FindingVM[] }>(
    [],
  );

  for (const verdict of gates.verdicts) {
    const held = latest.get(verdict.evaluatedNode);
    if (held !== undefined && held.seq > verdict.seq) continue;
    latest.set(verdict.evaluatedNode, { seq: verdict.seq, findings: verdict.findings });
  }

  const pointers = new Map<string, DiffPointerVM>();
  for (const [node, verdict] of latest) {
    const located = verdict.findings.filter((one) => one.location !== null);
    const worst = worstSeverity(located.map((one) => one.severity));
    const finding = located.find((one) => one.severity === worst);
    if (finding?.location == null) continue;
    pointers.set(node, { node, file: finding.location.file, line: finding.location.line });
  }
  return pointers;
}

/**
 * AC6 — the surgical repair loop as a pair of states plus its cap.
 *
 * The join is on the **gate**, not on the node, and that is not a shortcut: the
 * failing verdict judged `impl-1` and the re-run judged `fix-65207341fbd9`, so
 * a per-node index — which is what `attemptsByNode` is — cannot see that the
 * two are one loop. What ties them together is that the same gate answered
 * twice, which is exactly what *"one issue, one fix"* means.
 */
export interface RepairLoopVM {
  readonly gate: string;
  /** Whose work failed. */
  readonly failedNode: string;
  /** Whose work the re-run judged, when the fix ran as a node of its own. */
  readonly fixNode: string | null;
  readonly failing: { readonly seq: number; readonly summary: string };
  /** `null` while the loop is still open, or when it spent its cap. */
  readonly repaired: {
    readonly seq: number;
    readonly outcome: VerdictOutcome;
    readonly summary: string;
  } | null;
  /** The worst located finding of the failing verdict — pinned beside the move. */
  readonly finding: ReviewFindingVM | null;
  readonly file: string | null;
  /** How many times this gate answered, counting the failure itself. */
  readonly attempts: number;
  /** F7.5's default, read from the policy rather than written as a 3. */
  readonly cap: number;
  /** Spent the cap without passing — escalated to a human, not a fix failure. */
  readonly escalated: boolean;
}

export function repairLoops(gates: GatesProjection): readonly RepairLoopVM[] {
  const cap = DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode;
  const ordered = [...gates.verdicts].toSorted((left, right) => left.seq - right.seq);
  const consumed = new Set<number>();
  const loops: RepairLoopVM[] = [];

  for (const verdict of ordered) {
    if (verdict.outcome !== 'fail' || consumed.has(verdict.seq)) continue;

    const chain = ordered.filter((one) => one.gate === verdict.gate && one.seq >= verdict.seq);
    const attempts: typeof chain = [];
    for (const attempt of chain) {
      attempts.push(attempt);
      if (attempt.outcome !== 'fail') break;
    }
    for (const attempt of attempts) consumed.add(attempt.seq);

    const last = attempts.at(-1);
    const repaired = last !== undefined && last.outcome !== 'fail' ? last : null;
    const located = verdict.findings.filter((one) => one.location !== null);
    const worst = worstSeverity(located.map((one) => one.severity));
    const finding = located.find((one) => one.severity === worst) ?? null;
    const fixNode =
      last !== undefined && last.evaluatedNode !== verdict.evaluatedNode
        ? last.evaluatedNode
        : null;

    loops.push({
      gate: verdict.gate,
      failedNode: verdict.evaluatedNode,
      fixNode,
      failing: { seq: verdict.seq, summary: verdict.summary },
      repaired:
        repaired === null
          ? null
          : { seq: repaired.seq, outcome: repaired.outcome, summary: repaired.summary },
      finding:
        finding === null
          ? null
          : { ...finding, outcome: verdict.outcome, evaluatedNode: verdict.evaluatedNode },
      file: finding?.location?.file ?? null,
      attempts: attempts.length,
      cap,
      escalated: repaired === null && attempts.length >= cap,
    });
  }

  return loops;
}
