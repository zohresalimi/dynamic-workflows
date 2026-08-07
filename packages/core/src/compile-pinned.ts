/**
 * KAR-10.4 — the byte-preserving compiler behind the pinned set (AC2, AC6).
 *
 * `buildPinnedSegments` (./pinned-set.ts) owns *what is pinned* and is the one
 * producer of `pinned: true`. This module owns the half that has to be provable
 * rather than merely intended: **the bytes**. It is pure, total and
 * synchronous — no clock, no filesystem, no digest — and it carries, beside
 * every segment it composes, the exact runs of the approved spec that segment
 * quotes.
 *
 * That last part is the whole point. *"Verbatim means identical bytes — the
 * summariser is never allowed near them"* (docs/04-domain-model.md §2), and a
 * comment cannot enforce it. `quoted` makes byte-preservation a checkable
 * property: every run is a slice of `canonicalSpecText(spec)` **and** a slice of
 * the segment's own `text`, so a reflow, a re-wrap or a "tidied" bullet is a red
 * test rather than a difference nobody diffs. `compile-pinned.test.ts` asserts
 * exactly that over a spec written the way people actually write prose — hard
 * wraps, a tab, a trailing double space, a numbered list, an em dash.
 *
 * **Why synchronous.** AC2 says pure and total, and the test that proves it
 * deep-freezes the spec and calls twice. Hashing is asynchronous here
 * (`contentHash` goes through Web Crypto), so keeping the composition free of it
 * is what lets the purity claim be about a function rather than about a promise
 * chain. ./pinned-set.ts adds the digests.
 *
 * **Restatement runs here, before the digest** (AC6). A `forbid` whose subject
 * has a closed positive form and whose positive set the *node* declares is
 * restated into that positive form on the way in — the prohibition never reaches
 * the prompt at all. What survives as `forbid` is the genuine residue ("do not
 * exfiltrate credentials"), it renders last, and it is counted, because a rising
 * forbid ratio is the leading indicator of the decay §4.2 measured.
 *
 * Verifies: EPIC-10-S19 (third scenario) · AC2, AC6
 */
import {
  type Constraint,
  orderPinnedConstraints,
  restateAsRequirement,
  restateForbidAsAllowOnly,
} from './constraint.ts';
import type { SegmentKind } from './context-packet.ts';
import { type PinnedField, type PinnedNodeContext, type TaskSpec } from './task-spec.ts';

/** The three kinds a pinned segment may have. Derived from `SegmentKind` so
 * that a tenth kind added to the vocabulary cannot quietly become pinnable. */
export type PinnedSegmentKind = Extract<SegmentKind, `pinned.${string}`>;

/** Everything else — the only kinds `contextSegment` will build. */
export type UnpinnedSegmentKind = Exclude<SegmentKind, PinnedSegmentKind>;

export interface PinnedContentType {
  /** Stable identifier, and the `SegmentId` the built segment carries. */
  readonly id: string;
  readonly kind: PinnedSegmentKind;
  /** Where the bytes come from, quoting §4.1's third column. */
  readonly source: string;
}

/**
 * docs/08-context-and-memory.md §4.1's table, in its order — which is also the
 * render order of the pinned block. Exactly five rows, and the count is
 * asserted rather than assumed.
 */
export const PINNED_CONTENT_TYPES = [
  { id: 'pinned-spec-goal', kind: 'pinned.spec', source: 'F1.2, approved at F1.3' },
  { id: 'pinned-spec-criteria', kind: 'pinned.spec', source: 'F1.2 / F7.4' },
  {
    id: 'pinned-constraints-safety',
    kind: 'pinned.constraints',
    source: 'run config + F5.6 execution-boundary rules',
  },
  { id: 'pinned-pathscope', kind: 'pinned.pathscope', source: 'F5.3' },
  { id: 'pinned-constraints-permission', kind: 'pinned.constraints', source: 'F5.4' },
] as const satisfies readonly PinnedContentType[];

/**
 * One run of the approved spec that a segment reproduces byte for byte.
 *
 * `field` is which of F1.5's six the bytes came from, so a failure names the
 * part of the document that got reformatted rather than just the segment.
 */
export interface PinnedQuote {
  readonly field: PinnedField;
  readonly text: string;
}

export interface CompiledPinnedSegment {
  /** The `PINNED_CONTENT_TYPES` id, which is also the built `SegmentId`. */
  readonly id: string;
  readonly kind: PinnedSegmentKind;
  /** The composed segment text — headings included; those are DeFlow's words. */
  readonly text: string;
  /** The author's own bytes inside it. Empty for a segment DeFlow composes
   * entirely, such as the permission line. */
  readonly quoted: readonly PinnedQuote[];
}

const bullets = (lines: readonly string[]): string => lines.map((line) => `- ${line}`).join('\n');

/**
 * The `pinned-constraints-safety` row's bytes, given the constraints that
 * survived `pinnedConstraintsOf`.
 *
 * Exported because the framing packet pins this row before any `TaskSpec`
 * exists (KAR-10.2) and must render it the same way an agent packet does. One
 * composer, so a framing node and an agent node cannot be told the safety rules
 * in two different renderings of the same list.
 */
export function safetyConstraintsText(constraints: readonly Constraint[]): string {
  return `Safety constraints (pinned):\n${
    constraints.length === 0 ? '- (none declared)' : bullets(constraints.map(restateAsRequirement))
  }`;
}

/**
 * The approved spec's canonical form: the pinned fields, in
 * `PINNED_SPEC_FIELDS` order, with the author's bytes untouched.
 *
 * This is the document AC2's *"byte-identical to the corresponding slice of the
 * approved spec"* is measured against. It is deliberately not JSON: a JSON
 * encoding escapes a newline and a tab, and *"the bytes survived"* would then be
 * a claim about an escaping function rather than about the prose an agent will
 * read.
 */
export function canonicalSpecText(spec: TaskSpec): string {
  return [
    'goal',
    spec.goal,
    'nonGoals',
    ...spec.nonGoals,
    'constraints',
    ...spec.constraints,
    'acceptanceCriteria',
    ...spec.acceptanceCriteria.map((criterion) => criterionLine(criterion)),
  ].join('\n');
}

/** One acceptance criterion, as both the canonical form and the pinned segment
 * render it. One composer, so the two cannot drift into disagreeing about what
 * "the spec's own bytes" are. */
function criterionLine(criterion: TaskSpec['acceptanceCriteria'][number]): string {
  return `${criterion.id}: ${criterion.statement}`;
}

/**
 * Every constraint that reaches the pinned block, in render order, after the
 * KAR-09.4 restatement pass (AC6).
 *
 * Three things happen here and the order matters:
 *
 *   1. The spec's own prose constraints are folded in as `require` statements —
 *      the honest reading of a hand-written line: it is a commission-type
 *      constraint until somebody restates it, and §4.2 measured that commission
 *      compliance is the half that does not decay.
 *   2. A `forbid` whose subject has a closed positive form is restated into it
 *      using what the **node** declared — its path scopes. "Do not write outside
 *      `src/shared/**`" carries no information about what *is* allowed, so the
 *      positive form can only come from the declaration, and where there is none
 *      the prohibition honestly stays one.
 *   3. Positives first, prohibitions last, stable within each form.
 *
 * Exported because `buildPacket` counts these (KAR-09.4 AC4) and must count the
 * same list this renders. Two implementations of "which constraints are pinned"
 * is how the doctor's forbid ratio and the prompt come to disagree.
 */
export function pinnedConstraintsOf(
  spec: TaskSpec,
  constraints: readonly Constraint[] = [],
  node?: PinnedNodeContext,
): readonly Constraint[] {
  const declared = node?.pathScopes ?? [];
  const restated = constraints.map((constraint) => {
    if (constraint.form !== 'forbid') return constraint;
    if (constraint.subject !== 'write-path') return constraint;
    return restateForbidAsAllowOnly(constraint, declared) ?? constraint;
  });
  return orderPinnedConstraints([
    ...spec.constraints.map((statement): Constraint => ({ form: 'require', statement })),
    ...restated,
  ]);
}

/**
 * The five pinned segments' bytes, in §4.1's order, as a pure function of the
 * spec, the node and the run's safety constraints.
 *
 * Deliberately not a template anyone can extend: every line is composed here, so
 * *"what exactly is pinned"* is answerable by reading one function rather than
 * by tracing a formatter.
 */
export function compilePinnedSegments(
  spec: TaskSpec,
  node: PinnedNodeContext,
  constraints: readonly Constraint[] = [],
): readonly CompiledPinnedSegment[] {
  const pinnedConstraints = pinnedConstraintsOf(spec, constraints, node);

  const nonGoals = spec.nonGoals.length === 0 ? '- (none declared)' : bullets(spec.nonGoals);
  const criteriaLines = spec.acceptanceCriteria.map(criterionLine);

  const composed: readonly { text: string; quoted: readonly PinnedQuote[] }[] = [
    {
      text: `Goal (pinned, verbatim from the approved spec):\n${spec.goal}\n\nNon-goals:\n${nonGoals}`,
      quoted: [
        { field: 'goal', text: spec.goal },
        ...spec.nonGoals.map((text): PinnedQuote => ({ field: 'nonGoals', text })),
      ],
    },
    {
      text: `Acceptance criteria (pinned, verbatim from the approved spec):\n${bullets(
        criteriaLines,
      )}`,
      quoted: criteriaLines.map((text): PinnedQuote => ({ field: 'acceptanceCriteria', text })),
    },
    {
      text: safetyConstraintsText(pinnedConstraints),
      // The spec's own constraint lines survive verbatim as `require`
      // statements; a restated `allow-only` deliberately does not, which is
      // what AC6 asks for.
      quoted: spec.constraints.map((text): PinnedQuote => ({ field: 'constraints', text })),
    },
    {
      text: `Declared path scopes (pinned):\n${
        node.pathScopes.length === 0
          ? '- this node declares no write scope and must not write'
          : bullets(node.pathScopes.map((glob) => `write: ${glob}`))
      }`,
      quoted: node.pathScopes.map((text): PinnedQuote => ({ field: 'pathScopes', text })),
    },
    {
      text: `Permission level (pinned): ${node.permission}`,
      quoted: [{ field: 'permission', text: node.permission }],
    },
  ];

  return PINNED_CONTENT_TYPES.map((type, index) => {
    const entry = composed[index] as { text: string; quoted: readonly PinnedQuote[] };
    return { id: type.id, kind: type.kind, text: entry.text, quoted: entry.quoted };
  });
}
