/**
 * KAR-16.3 — `gates.ts`: verdicts, findings by file and line, and criterion
 * satisfaction (F7.3, F7.4, F10.8).
 *
 * Verifies: EPIC-16-S19, EPIC-16-S23 · AC7, AC10, AC11
 *
 * ## Two collapses this file refuses to make
 *
 * **`unverifiable` is a third criterion state, not a flavour of
 * `unsatisfied`.** It is how a gate says *"I could not tell"*, and it is where
 * a shallow specification becomes visible — the SDD literature's primary
 * failure mode, surfaced as data rather than as a feeling. A board that painted
 * it red would tell an operator to go and fix something that is not broken.
 *
 * **`needs-human` is an outcome, not a failure.** A deterministic gate whose
 * own tooling failed — a missing binary — did not judge the work; it failed to
 * run. Counting it as a failure *"sends work into the repair loop that no
 * amount of repair will fix"* (docs/04 §7), so `failureCount` counts `fail`
 * and nothing else.
 *
 * ## Why `run.created` is folded here
 *
 * F7.4 requires every acceptance criterion to map to at least one gate, and the
 * criterion that maps to none is the one worth seeing. It cannot be seen at all
 * unless the board starts from the *spec's* criteria rather than from the
 * criteria some gate happened to mention — so the run's own spec seeds the
 * board, every row starts `unverifiable` and `unmapped`, and a gate speaking to
 * a row is what moves it.
 */
import type { Event } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

export type VerdictOutcome = 'pass' | 'fail' | 'needs-human';
export type CriterionStatus = 'satisfied' | 'unsatisfied' | 'unverifiable';

export interface FindingLocationVM {
  readonly file: string;
  readonly line: number;
  readonly endLine: number | null;
  /** The blob the line was read from. Without it a margin annotation drifts. */
  readonly blobSha: string | null;
}

export interface FindingVM {
  readonly id: string;
  readonly severity: 'blocker' | 'major' | 'minor' | 'info';
  readonly criterion: string | null;
  readonly location: FindingLocationVM | null;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly gate: string;
  readonly seq: number;
}

export interface VerdictVM {
  readonly seq: number;
  readonly gate: string;
  /** Whose work was judged — not the gate's own node. */
  readonly evaluatedNode: string;
  readonly attempt: number;
  readonly outcome: VerdictOutcome;
  readonly summary: string;
  readonly specHash: string | null;
  readonly criteria: readonly { readonly id: string; readonly status: CriterionStatus }[];
  readonly findings: readonly FindingVM[];
}

export interface CriterionVM {
  readonly id: string;
  statement: string | null;
  status: CriterionStatus;
  /** Every gate that has spoken to it, in first-mention order. */
  gates: string[];
  /** No gate has ever spoken to it — an F7.4 defect, rendered as one. */
  unmapped: boolean;
  /** The `seq` of the verdict that last decided it. */
  decidedAtSeq: number | null;
}

export interface GateAttemptVM {
  readonly gate: string;
  readonly attempt: number;
  readonly outcome: VerdictOutcome;
  readonly seq: number;
}

export interface EscalationVM {
  readonly seq: number;
  readonly node: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  answeredWith: string | null;
  answeredBy: string | null;
  answeredAtSeq: number | null;
}

export interface GatesProjection {
  appliedSeq: number;
  verdicts: VerdictVM[];
  criteria: Map<string, CriterionVM>;
  /** `file` → its findings, ascending by line. The diff surface's index. */
  findingsByFile: Map<string, FindingVM[]>;
  /** `evaluatedNode` → the verdicts it earned, in order. */
  attemptsByNode: Map<string, GateAttemptVM[]>;
  escalations: EscalationVM[];
  /** The gate definitions this run was pinned to, by id. */
  definitions: Map<string, { readonly path: string; readonly sha256: string }>;
  failureCount: number;
  needsHumanCount: number;
  passCount: number;
}

export function emptyGates(): GatesProjection {
  return {
    appliedSeq: 0,
    verdicts: [],
    criteria: new Map(),
    findingsByFile: new Map(),
    attemptsByNode: new Map(),
    escalations: [],
    definitions: new Map(),
    failureCount: 0,
    needsHumanCount: 0,
    passCount: 0,
  };
}

export function applyGates(state: GatesProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'run.created': {
      for (const criterion of event.payload.spec.acceptanceCriteria) {
        state.criteria.set(criterion.id, {
          id: criterion.id,
          statement: criterion.statement,
          // Nothing has judged it yet, and "not yet judged" and "cannot be
          // judged" are the same cell until a gate says otherwise. The
          // distinction the board needs is `unmapped`, beside it.
          status: 'unverifiable',
          gates: [],
          unmapped: true,
          decidedAtSeq: null,
        });
      }
      return;
    }

    case 'gates.loaded': {
      for (const gate of event.payload.gates) {
        state.definitions.set(gate.id, { path: gate.path, sha256: gate.sha256 });
      }
      return;
    }

    case 'gate.evaluated': {
      const raw = event.payload.verdict;
      const findings: FindingVM[] = raw.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        criterion: finding.criterion ?? null,
        location:
          finding.location === undefined
            ? null
            : {
                file: finding.location.file,
                line: finding.location.line,
                endLine: finding.location.endLine ?? null,
                // `DeFlow.finding.v1` has no `blobSha` at all and `.v2` makes
                // it required beside a location, so the `in` check is what
                // reads both shapes without asserting either.
                blobSha: 'blobSha' in finding.location ? finding.location.blobSha : null,
              },
        message: finding.message,
        evidence: [...finding.evidence],
        gate: raw.gate,
        seq: event.seq,
      }));

      const verdict: VerdictVM = {
        seq: event.seq,
        gate: raw.gate,
        evaluatedNode: raw.evaluatedNode,
        attempt: event.attempt ?? 0,
        outcome: raw.outcome,
        summary: raw.summary,
        specHash: raw.specHash ?? null,
        criteria: raw.criteria.map((one) => ({ id: one.id, status: one.status })),
        findings,
      };
      state.verdicts.push(verdict);

      if (raw.outcome === 'fail') state.failureCount += 1;
      else if (raw.outcome === 'needs-human') state.needsHumanCount += 1;
      else state.passCount += 1;

      for (const finding of findings) {
        if (finding.location === null) continue;
        const held = state.findingsByFile.get(finding.location.file) ?? [];
        held.push(finding);
        // Ordered by line rather than by arrival: the diff surface attaches
        // them to a gutter, and a gutter is read top to bottom.
        held.sort((left, right) => (left.location?.line ?? 0) - (right.location?.line ?? 0));
        state.findingsByFile.set(finding.location.file, held);
      }

      const attempts = state.attemptsByNode.get(raw.evaluatedNode) ?? [];
      attempts.push({
        gate: raw.gate,
        attempt: verdict.attempt,
        outcome: raw.outcome,
        seq: event.seq,
      });
      state.attemptsByNode.set(raw.evaluatedNode, attempts);

      for (const judged of raw.criteria) {
        const held = state.criteria.get(judged.id) ?? {
          id: judged.id,
          statement: null,
          status: 'unverifiable' as CriterionStatus,
          gates: [],
          unmapped: true,
          decidedAtSeq: null,
        };
        // Last writer wins, and that is the repair loop: attempt 1 says
        // `unsatisfied`, the fix lands, attempt 2 says `satisfied`, and the
        // board has to move. Ordering is by `seq`, which is why the guard at
        // the top of this function is the only thing that has to be right.
        held.status = judged.status;
        held.decidedAtSeq = event.seq;
        held.unmapped = false;
        if (!held.gates.includes(raw.gate)) held.gates.push(raw.gate);
        state.criteria.set(judged.id, held);
      }
      return;
    }

    case 'human.requested': {
      state.escalations.push({
        seq: event.seq,
        node: event.payload.node,
        prompt: event.payload.prompt,
        options: event.payload.options.map((one) => ({ id: one.id, label: one.label })),
        answeredWith: null,
        answeredBy: null,
        answeredAtSeq: null,
      });
      return;
    }

    case 'human.responded': {
      // The newest unanswered escalation for that node: a node can be asked
      // twice in a run, and answering the first one twice would leave the
      // second waiting forever on a decision that was already made.
      const open = state.escalations
        .toReversed()
        .find((one) => one.node === event.payload.node && one.answeredWith === null);
      if (open === undefined) return;
      open.answeredWith = event.payload.optionId;
      open.answeredBy = event.payload.by ?? 'operator';
      open.answeredAtSeq = event.seq;
      return;
    }

    default:
      ignored<'gates'>(event as Ignorable<'gates'>);
      return;
  }
}
