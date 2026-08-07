/**
 * KAR-10.3 — the F1.3 approval gate's pure half
 * (docs/06-planning-and-replanning.md §1.3).
 *
 * *"The `TaskSpec` is presented for human edit and explicit approval before any
 * execution."* Four operator actions are supported — **approve**,
 * **edit-then-approve**, **reject-and-reframe** and **abandon** — and this file
 * owns everything about them that is a function of values: what the operator is
 * shown, what an edit produces, what history a UI can read back, and what a
 * mid-run edit has to be revalidated against. The durable half — the blocking
 * `human` node, its one `node_wake` row, the transaction the approval and the
 * pin share — is `@DeFlow/daemon`'s `spec/gate.ts`, because it is about a
 * database rather than about a document.
 *
 * Three decisions here are worth stating, because each had a tempting
 * alternative:
 *
 * **The operator edits the framed document, not the sealed `TaskSpec`.**
 * EPIC-10-S14's third scenario is an edit that *removes a criterion's
 * `verifiedBy` without marking it unverifiable* — and `verifiedBy` is
 * `DeFlow.taskspecdraft.v1`'s vocabulary, not v1's. So an edit is a replacement
 * framed document, run through `validateTaskSpecDraft` and re-sealed by
 * `sealTaskSpec`. The refusal text is therefore *the same function's* text as
 * the framing node's, not a second copy of it that agrees on the cases somebody
 * thought of. The alternative — editing the sealed spec — cannot express the
 * scenario at all, and would silently launder a criterion that names two gates
 * into one that names none, because v1's `check` has no way to hold two.
 *
 * **The patch is over the sealed specs.** `specHash` is what a verdict cites and
 * what a pin is minted from, so "what changed" has to be a diff of the document
 * the hash is over — excluding `specHash` and `approvedBy` for exactly the
 * reason the hash excludes them (docs/04-domain-model.md §2). A patch whose
 * first operation replaced the digest of the document it is a patch for would be
 * unreadable in a diff panel and meaningless in an audit.
 *
 * **Nothing here is reversible by overwriting.** `specHistory` walks the ledger
 * forward and returns every version with its own hash; the pre-edit spec is
 * still `run.created.spec`, addressable at the hash every verdict against it
 * cited. That is AC5's "nothing is overwritten" as a readable value rather than
 * as a promise.
 *
 * Verifies: EPIC-10-S13, EPIC-10-S14, EPIC-10-S15, EPIC-10-S17, EPIC-10-S29 ·
 * AC1, AC5, AC6, AC7, AC8
 */
import type { Event } from './events.ts';
import {
  type DraftIssue,
  sealTaskSpec,
  type TaskSpecDraft,
  TaskSpecDraftInvalid,
  validateTaskSpecDraft,
} from './framing.ts';
import { SPEC_HASH_OMIT_KEYS } from './hash.ts';
import { type CriterionId, type NodeId, NodeIdSchema } from './ids.ts';
import type { JsonPatchOperation } from './json-patch.ts';
import type { PlanGraph } from './plan-graph.ts';
import type { TaskSpec } from './task-spec.ts';

/**
 * The `NodeId` of the run's approval gate.
 *
 * One per run and well-known, so the projection can answer *"is the spec still
 * waiting?"* from a node id rather than by scanning the log for an option set —
 * see the `human.requested` case in ./reduce.ts. It is not a plan node: the plan
 * does not exist yet, and cannot, because the planner's first input is the
 * approved spec.
 */
export const SPEC_GATE_NODE: NodeId = NodeIdSchema.parse('spec-approval');

/** What the operator can do with a draft `TaskSpec` (§1.3). */
export const SPEC_DECISIONS = ['approve', 'edit', 'reject', 'abandon'] as const;

export type SpecDecision = (typeof SPEC_DECISIONS)[number];

/**
 * The four options a gate's `human.requested` carries, in §1.3's order.
 *
 * `abandon` rides on `effect: 'reject'` and is told apart by its **id**, which
 * is the field `human.responded` carries and the one this module's resolver
 * branches on. The `effect` vocabulary lives in `DeFlow.plangraph.v1`
 * (`HumanNodeSchema`), and that document is append-only — a fifth member would
 * have to publish `plangraph.v2` to record a distinction the option id already
 * carries losslessly. Both options are refusals of the draft; what differs is
 * what DeFlow does next, and that is a decision, not a node-level effect.
 */
export const SPEC_APPROVAL_OPTIONS = [
  { id: 'approve', label: 'Approve this spec and start planning', effect: 'approve' },
  { id: 'edit', label: 'Edit the spec before approving', effect: 'edit' },
  { id: 'reject', label: 'Reject and re-run the framing interview', effect: 'reject' },
  { id: 'abandon', label: 'Abandon this run', effect: 'reject' },
] as const satisfies readonly {
  readonly id: SpecDecision;
  readonly label: string;
  readonly effect: 'approve' | 'reject' | 'edit' | 'inject';
}[];

// ── what the operator reads ──────────────────────────────────────────────────

const bullets = (lines: readonly string[]): string =>
  lines.length === 0 ? '- (none)' : lines.map((line) => `- ${line}`).join('\n');

/** How a criterion says who checks it, in the framed document's vocabulary. */
function criterionCheck(criterion: TaskSpecDraft['acceptanceCriteria'][number]): string {
  if ('unverifiable' in criterion) {
    const gates = criterion.verifiedBy ?? [];
    const reviewed = gates.length === 0 ? '' : ` reviewed by ${gates.join(', ')};`;
    return `unverifiable —${reviewed} ${criterion.reason}`;
  }
  return `verified by ${criterion.verifiedBy.join(', ')}`;
}

/**
 * The rendered spec that travels in `human.requested.prompt` (AC1).
 *
 * Plain text and composed here line by line, for the same reason
 * `buildPinnedSegments` is: *"what exactly is pinned"* — and here, *what exactly
 * was approved* — should be answerable by reading one function. It is the
 * operator's copy, not the agent's: the bytes an agent later sees are the pinned
 * segments compiled from the sealed spec, which is why this is allowed to be
 * readable and they are required to be verbatim.
 */
export function renderSpecForReview(document: TaskSpecDraft): string {
  return [
    'Goal',
    document.goal,
    '',
    'In scope',
    bullets(document.scope.included),
    ...(document.scope.paths === undefined
      ? []
      : ['', 'Declared paths', bullets(document.scope.paths)]),
    '',
    'Non-goals',
    bullets(document.nonGoals),
    '',
    'Constraints',
    bullets(document.constraints),
    '',
    'Acceptance criteria',
    bullets(
      document.acceptanceCriteria.map(
        (criterion) => `${criterion.id}: ${criterion.statement} (${criterionCheck(criterion)})`,
      ),
    ),
    '',
    'Known failure modes',
    bullets(
      document.knownFailureModes.map(
        (mode) => `${mode.id}: ${mode.description} — detected by: ${mode.detection}`,
      ),
    ),
    '',
    'Prior decisions',
    bullets(document.priorDecisions.map((decision) => `${decision.decision} (${decision.source})`)),
  ].join('\n');
}

// ── editing ──────────────────────────────────────────────────────────────────

export interface SpecAmendment {
  /** The `specHash` before the edit. */
  readonly from: string;
  /** The `specHash` after it — `spec.specHash`, restated so the pair reads together. */
  readonly to: string;
  readonly patch: readonly JsonPatchOperation[];
  /** The amended framed document, which is what a later edit starts from. */
  readonly document: TaskSpecDraft;
  /** The sealed spec the amendment produced. */
  readonly spec: TaskSpec;
}

/** An edit the gate refused. Carries the framed document's own issues, so a
 * caller answers the operator with the *same* text EPIC-10-S9 asserts. */
export class SpecEditRefused extends Error {
  readonly issues: readonly DraftIssue[];

  constructor(issues: readonly DraftIssue[]) {
    super(
      `the edited spec does not satisfy the criteria contract: ${issues
        .map((issue) => `${issue.pointer || '/'} ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'SpecEditRefused';
    this.issues = issues;
  }
}

/**
 * The hashable form of a spec: what `specHash` is over, and therefore what a
 * patch between two versions of it is over.
 *
 * Exported because the differ lives in `@DeFlow/daemon` (R1 — see
 * ./json-patch.ts) and *what is diffed* is a domain decision this module owns.
 * A patch whose first operation replaced the digest of the document it is a
 * patch for would be unreadable in a diff panel and meaningless in an audit.
 */
export function hashableSpec(spec: TaskSpec): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...spec };
  for (const key of SPEC_HASH_OMIT_KEYS) delete copy[key];
  return copy;
}

/**
 * AC5, first half — everything about an edit that is not the diff itself.
 *
 * Refuses before it seals: an edit that breaks the criteria contract leaves the
 * gate open and the run unfailed (EPIC-10-S14's third scenario), which is only
 * possible because this throws rather than sealing something partial.
 * `TaskSpecDraftInvalid` from `sealTaskSpec` is re-thrown as `SpecEditRefused`
 * so a caller has one class to catch and the operator sees one kind of message.
 */
export async function sealEditedSpec(edited: unknown): Promise<TaskSpec> {
  const issues = validateTaskSpecDraft(edited);
  if (issues.length > 0) throw new SpecEditRefused(issues);
  try {
    return await sealTaskSpec(edited);
  } catch (thrown) {
    if (thrown instanceof TaskSpecDraftInvalid) throw new SpecEditRefused(thrown.issues);
    throw thrown;
  }
}

/** The refusal a no-op edit gets. An amendment with an empty patch is a
 * `spec.amended` row that says nothing happened, and the honest answer to "the
 * operator pressed save without changing anything" is to approve what is
 * already there. */
export const emptyEditRefusal = (): SpecEditRefused =>
  new SpecEditRefused([
    {
      pointer: '',
      message:
        'this edit changes nothing: the amended spec hashes to the one already on the gate. ' +
        'Approve the spec as it stands, or change something first.',
    },
  ]);

// ── reading the history back ─────────────────────────────────────────────────

export interface SpecVersion {
  readonly specHash: string;
  readonly spec: TaskSpec;
  /** The patch that produced this version, or `null` for the framed original. */
  readonly patch: readonly JsonPatchOperation[] | null;
}

/**
 * Every version of the spec this run has had, oldest first (EPIC-10-S14's
 * fourth scenario).
 *
 * Reads the ledger and nothing else — the same signature discipline
 * `gateSpecFromLedger` is written to: a history assembled from a table the
 * daemon maintains would be a second source, and two sources of "what did the
 * spec say" is how a verdict comes to cite a hash nobody can resolve.
 */
export async function specHistory(events: readonly Event[]): Promise<readonly SpecVersion[]> {
  const versions: SpecVersion[] = [];
  for (const event of events) {
    if (event.kind === 'run.created') {
      versions.push({
        specHash: event.payload.spec.specHash,
        spec: event.payload.spec,
        patch: null,
      });
    }
    if (event.kind === 'spec.amended') {
      versions.push({
        specHash: event.payload.to,
        spec: await sealTaskSpec(event.payload.document),
        patch: event.payload.patch,
      });
    }
  }
  return versions;
}

/**
 * The spec the run is currently judged against: the framed original, moved by
 * every amendment (AC8).
 *
 * Returns `null` for a ledger with no `run.created` — a run whose framing has
 * not landed has no spec, and answering with a fabricated one is worse than
 * answering with nothing.
 */
export async function currentSpec(events: readonly Event[]): Promise<TaskSpec | null> {
  const versions = await specHistory(events);
  return versions.at(-1)?.spec ?? null;
}

// ── revalidation ─────────────────────────────────────────────────────────────

export interface SpecCoverageIssue {
  readonly criterion: CriterionId;
  readonly message: string;
}

/**
 * AC8 — the mandatory revalidation a spec edit forces
 * (docs/06-planning-and-replanning.md §1.3, EPIC-10-S29).
 *
 * One question, asked of the plan the run is actually executing: **does every
 * acceptance criterion still reach a gate?** A criterion the framing document
 * marked unverifiable is answered by a human and needs no gate node — that is
 * what `check.kind === 'manual'` means once the spec is sealed, and it is the
 * one exemption. Everything else must be named by some `gate` node's `criteria`,
 * or the plan no longer satisfies the spec and F7.4's acceptance board would be
 * showing a criterion nothing can ever tick.
 *
 * Pure, and deliberately not "plan validation" in full — KAR-11.2 owns that.
 * What this owns is the half §1.3 makes mandatory at an edit, and it is stated
 * as a list of criteria rather than a boolean because the diagnostic has to
 * *name AC-8*.
 */
export function revalidateSpecAgainstPlan(
  spec: TaskSpec,
  plan: PlanGraph,
): readonly SpecCoverageIssue[] {
  const covered = new Set<string>();
  for (const node of plan.nodes) {
    if (node.type !== 'gate') continue;
    for (const criterion of node.criteria) covered.add(criterion);
  }

  const issues: SpecCoverageIssue[] = [];
  for (const criterion of spec.acceptanceCriteria) {
    if (criterion.check?.kind === 'manual') continue;
    if (covered.has(criterion.id)) continue;
    issues.push({
      criterion: criterion.id,
      message:
        `acceptance criterion ${criterion.id} is covered by no gate node in plan version ` +
        `${plan.version} and is not marked unverifiable: "${criterion.statement}". The run ` +
        'stops scheduling new work rather than continuing against a spec it no longer ' +
        'satisfies (docs/06-planning-and-replanning.md §1.3).',
    });
  }
  return issues;
}
