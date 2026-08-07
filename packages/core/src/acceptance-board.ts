/**
 * KAR-10.4 AC5 — a verdict is scoped to the spec it judged, and the board says
 * so out loud.
 *
 * This is mechanism 1 of [docs/10-verification-gates.md §5.2]'s four: *"the
 * verdict carries `specHash`. If it does not equal the run's current pinned
 * `specHash`, the verdict is void and the gate is re-run."* The other three live
 * elsewhere — the pinned block is ./compile-pinned.ts, the post-render check is
 * ./pin-integrity.ts, the restatement is ./constraint.ts — and this file is the
 * one that decides what a *reader* is told.
 *
 * Three decisions are load-bearing, and each had a cheaper alternative that
 * would have quietly broken the mechanism:
 *
 * **The third state is not optional.** A void verdict could be dropped, leaving
 * the row blank, or kept, leaving it green. Both are wrong in the way the epic's
 * notes warn about: *"voiding verdicts on a spec edit means a mid-run edit can
 * invalidate an hour of gate work. That is correct and it should be visible."* A
 * blank row reads as work nobody has started; a green one is a lie. So
 * `revalidating` exists, and its note names both hashes — which is also NF10, in
 * that the state traces to the `spec.amended` row that caused it.
 *
 * **The whole verdict dies, not the changed criteria.** A verdict speaks to
 * several criteria at once and was formed as one judgement against one contract.
 * Voiding only the criteria whose text changed would keep the parts of that
 * judgement that happen to still look right, which is exactly the reasoning the
 * reviewer was not asked to do. There is no partial validity.
 *
 * **Absence is void.** See `VerdictV2Schema` — a verdict that names no contract
 * is not evidence about this one.
 *
 * **A constraint is a row, not a footnote** (EPIC-10-S21's third scenario). The
 * spec's prohibitions are part of the contract and no acceptance criterion
 * speaks to them, so a board built from `acceptanceCriteria` alone is a board on
 * which a violated prohibition is *absent* while every gate reads green — which
 * is [docs/08-context-and-memory.md §4.3]'s Security-Recall Divergence rendered
 * as a UI: *"invisible to standard monitoring, because the commission-type audit
 * signals stay healthy while the prohibitions rot"*. So `constraints` is a
 * required input, every constraint gets a criterion of its own, and that row is
 * decided by a verdict entry naming it or by nothing at all.
 *
 * Verifies: EPIC-10-S21 (third scenario), EPIC-10-S22, EPIC-10-S29 (third
 * scenario) · AC4, AC5
 */
import { type CriterionId, CriterionIdSchema, type NodeId, SchemaIdSchema } from './ids.ts';
import { type CriterionStatus, VERDICT_V2_SCHEMA_ID, type VerdictV2 } from './verdict.ts';

/** The criterion fields a board row needs. An `AcceptanceCriterion` has both. */
export interface BoardCriterion {
  readonly id: CriterionId;
  readonly statement: string;
}

/**
 * What a row can say.
 *
 * The first three are a gate's own vocabulary (`CriterionStatus`), carried
 * through unchanged so the board never re-interprets a verdict it is only
 * displaying. The last two are the board's own: `pending` is *nothing has
 * spoken to this yet*, and `revalidating` is *something did, against a contract
 * that no longer applies*. Collapsing those two is how a mid-run edit becomes
 * invisible.
 */
export type BoardStatus = CriterionStatus | 'pending' | 'revalidating';

export interface BoardRow {
  readonly criterion: CriterionId;
  readonly statement: string;
  readonly status: BoardStatus;
  /** The gate node whose verdict decided — or invalidated — this row. */
  readonly decidedBy: NodeId | null;
  /** Why the row reads the way it does, when that needs saying: for
   * `revalidating`, naming the old and the new hash; and for a constraint no
   * verdict has spoken to, saying why the green rows beside it are not evidence
   * about it. Null everywhere else. */
  readonly note: string | null;
}

/**
 * The one place a gate stamps the contract it judged (AC5's first sentence).
 *
 * A function rather than a convention, so *"every verdict carries the specHash
 * it was judged against"* is something a gate cannot forget to do halfway
 * through EPIC-12. The hash comes from the caller because the caller is the
 * gate runner, which resolved it from the ledger through `gateSpecFromLedger` —
 * never from the node's context and never from the worktree (AC4).
 */
export function verdictAgainst(verdict: VerdictV2, specHash: string): VerdictV2 {
  return { ...verdict, schemaId: SchemaIdSchema.parse(VERDICT_V2_SCHEMA_ID), specHash };
}

/**
 * Whether this verdict has stopped being evidence.
 *
 * One comparison, deliberately: equal or void. There is no "close enough"
 * branch and there must not be one — see the header on partial validity.
 */
export function isVerdictVoid(
  verdict: { readonly specHash?: string | undefined },
  currentSpecHash: string,
): boolean {
  return verdict.specHash !== currentSpecHash;
}

/**
 * The prefix of a criterion minted for a constraint. Reserved: a hand-authored
 * criterion may not use it (see `acceptanceBoard`), because two rows under one
 * id is precisely how a prohibition comes to inherit somebody else's verdict.
 */
export const CONSTRAINT_CRITERION_PREFIX = 'constraint-';

/**
 * The criterion a constraint is checked under: `constraint-1`, `constraint-2`,
 * … in the spec's own order.
 *
 * Positional rather than derived from the constraint's text, and that is safe
 * for one reason only: a spec edit that reorders or rewords the constraints
 * changes `specHash`, and every verdict formed against the old one is void
 * (AC5). The id is therefore never reused across contracts — within one
 * contract it is stable, and between contracts nothing survives to be confused.
 *
 * The statement is the constraint **verbatim**. A board row is what a human
 * reads before deciding whether the run honoured its contract, and a paraphrase
 * there is the same drift F1.5 pins the prompt against.
 */
export function constraintCriteria(constraints: readonly string[]): readonly BoardCriterion[] {
  return constraints.map((statement, index) => ({
    id: CriterionIdSchema.parse(`${CONSTRAINT_CRITERION_PREFIX}${index + 1}`),
    statement,
  }));
}

export interface AcceptanceBoardInput {
  /** The criteria of the spec at `specHash` — the contract now in force. */
  readonly criteria: readonly BoardCriterion[];
  /**
   * The constraints of that same spec, verbatim. Required rather than optional:
   * a caller who omits them gets a board that is silent about every prohibition
   * in the contract, and silence beside a column of green rows reads as
   * approval.
   */
  readonly constraints: readonly string[];
  /** Every verdict the run has produced, oldest first. */
  readonly verdicts: readonly VerdictV2[];
  /** The run's current `specHash`, as `run.spec.approved` last recorded it. */
  readonly specHash: string;
}

/**
 * F7.4's acceptance-criteria board: one row per criterion of the spec that is
 * currently in force.
 *
 * Driven by the spec's criteria rather than by the verdicts, which is what makes
 * a criterion nothing has judged appear as `pending` rather than not appear at
 * all — and what makes a criterion an amendment *added* (EPIC-10-S29's AC-8)
 * show up the moment the amendment lands.
 *
 * Later verdicts win, so a re-run at the current hash retires the stale row it
 * replaced. Nothing is mutated and no event is written: this is a projection,
 * and the ledger it reads keeps every voided verdict exactly where it was.
 */
export function acceptanceBoard(input: AcceptanceBoardInput): readonly BoardRow[] {
  const constraints = constraintCriteria(input.constraints);
  const collision = input.criteria.find((criterion) =>
    constraints.some((entry) => entry.id === criterion.id),
  );
  if (collision !== undefined) {
    throw new Error(
      `the spec authors an acceptance criterion named '${collision.id}', which collides with the ` +
        `criterion this board mints for constraint ${collision.id.slice(
          CONSTRAINT_CRITERION_PREFIX.length,
        )}. Ids beginning '${CONSTRAINT_CRITERION_PREFIX}' are reserved: two rows under one id ` +
        'means a verdict entry decides both, and a prohibition would inherit a verdict formed ' +
        'about something else. Rename the acceptance criterion.',
    );
  }
  return [
    ...input.criteria.map((criterion) => row(criterion, input)),
    ...constraints.map((criterion) => row(criterion, input, true)),
  ];
}

function row(criterion: BoardCriterion, input: AcceptanceBoardInput, constraint = false): BoardRow {
  const spoken = input.verdicts.filter((verdict) =>
    verdict.criteria.some((entry) => entry.id === criterion.id),
  );

  // Last write wins, and only among verdicts that still cite the contract in
  // force: a re-run at the current hash is the answer to the stale one before
  // it, and a stale verdict appended *after* a live one is not a later opinion
  // about this contract at all.
  const live = spoken.findLast((verdict) => !isVerdictVoid(verdict, input.specHash));
  if (live !== undefined) {
    const entry = live.criteria.find((candidate) => candidate.id === criterion.id);
    return {
      criterion: criterion.id,
      statement: criterion.statement,
      status: entry?.status ?? 'unverifiable',
      decidedBy: live.by.node,
      note: null,
    };
  }

  const stale = spoken.at(-1);
  if (stale === undefined) {
    return {
      criterion: criterion.id,
      statement: criterion.statement,
      status: 'pending',
      decidedBy: null,
      // An unjudged criterion is work nobody has reached yet, and the blank row
      // says so on its own. An unjudged *constraint* beside a column of green
      // rows says something else to a reader — it looks covered — so this one
      // row states the §4.3 rule rather than leaving it to be inferred.
      note: constraint ? unjudgedConstraintNote(criterion.id) : null,
    };
  }

  return {
    criterion: criterion.id,
    statement: criterion.statement,
    status: 'revalidating',
    decidedBy: stale.by.node,
    note:
      `re-running against the amended spec: this criterion was judged at specHash ` +
      `${stale.specHash ?? '(none recorded)'} and the run is now at ${input.specHash}, so that ` +
      'verdict is void. The reviewer formed its judgement against a different contract.',
  };
}

/**
 * Why a constraint's row is blank, said out loud.
 *
 * The sentence is the whole point of the row existing: *"passing gates are not
 * evidence that prohibitions were honoured"* (EPIC-10-S21), because
 * Security-Recall Divergence is invisible to exactly the monitoring a green
 * board provides.
 */
function unjudgedConstraintNote(criterion: CriterionId): string {
  return (
    'no gate has spoken to this constraint. A gate that passed on some other criterion is not ' +
    'evidence that a prohibition was honoured (docs/08-context-and-memory.md §4.3), so this row ' +
    `stays pending until a verdict entry names ${criterion} and says what it found.`
  );
}

/**
 * The gate nodes whose latest word on some criterion went stale — the set the
 * scheduler must re-run (AC5's second sentence, EPIC-10-S22).
 *
 * Derived from the same walk the board does rather than from a flag somebody
 * sets, so *"the gate is re-scheduled"* and *"the row says re-running"* cannot
 * disagree. Deduplicated and in first-seen order: one gate that spoke to four
 * voided criteria is re-run once.
 */
export function staleGateNodes(
  verdicts: readonly VerdictV2[],
  currentSpecHash: string,
): readonly NodeId[] {
  const live = new Set<NodeId>();
  const stale: NodeId[] = [];
  for (const verdict of verdicts) {
    if (isVerdictVoid(verdict, currentSpecHash)) {
      if (!stale.includes(verdict.by.node)) stale.push(verdict.by.node);
    } else {
      live.add(verdict.by.node);
    }
  }
  return stale.filter((node) => !live.has(node));
}
