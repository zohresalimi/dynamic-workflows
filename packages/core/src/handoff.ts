/**
 * KAR-09.9 — the handoff contract: an enforced return budget, one bounded
 * repair, and no truncation anywhere (docs/08-context-and-memory.md §9).
 *
 * F6.4's *"default return budget: 500–2,000 tokens, enforced"* needs a
 * mechanism or it is a comment. This module is the mechanism, and it is a pure
 * decision: given what came back, what the contract asked for, a validator and
 * a tokenizer, it answers **accept / repair once / fail** and nothing else.
 *
 * Four decisions here are load-bearing.
 *
 *   1. **There is no truncating arm, and there is no place to add one.** A
 *      `HandoffJudgement` carries `returned` — the payload exactly as it
 *      arrived — and an `outcome`. It never carries a shortened payload,
 *      because truncating a JSON document produces invalid JSON downstream,
 *      which is precisely the silent propagation of garbage F6.9 exists to
 *      forbid. Storing the *whole* oversized return is deliberate: it is the
 *      evidence needed to fix the prompt or the budget.
 *      `packages/core/test/no-handoff-truncation.test.ts` greps for the
 *      shortening call that would undo this.
 *   2. **Validate, then measure.** A return that does not satisfy its schema
 *      is not also reported as oversize: "the model could not produce valid
 *      JSON" and "the model produced valid JSON that was too long" have
 *      different fixes, and reporting both makes the node inspector argue with
 *      itself. The size is still counted — it is cheap and it is evidence —
 *      but `handoff.oversize` is appended only for the second case.
 *   3. **The repair is bounded at one, structurally.** `judgeHandoff` takes
 *      `repairAttempted` and has no counter of its own: a caller cannot ask
 *      for a second repair, because the only input that could authorise one is
 *      a boolean that is already `true`. `HANDOFF_REPAIR_LIMIT` exists so the
 *      number is greppable, not so it can be raised.
 *   4. **`agent` recon and `agent` implementation are told apart by
 *      `permission`, not by a new plan field.** §9.3's table wants 4,000 for a
 *      survey and 1,500 for an implementation, and `DeFlow.plangraph.v1` is
 *      already published — schema ids are append-only, so a `role` field would
 *      have to ship a v2 of the whole plan document to express something the
 *      plan already states. A node that cannot write is surveying; a node that
 *      can is implementing.
 *
 * The numbers themselves are honest about their provenance: 500–2,000 is
 * *practitioner consensus, not a controlled study* (§9.3). That is exactly why
 * `handoffOversizeRates` exists — AC9 records the oversize rate per node type
 * so the defaults can later be tuned from DeFlow's own data rather than from
 * somebody else's blog post.
 *
 * Verifies: EPIC-09-S46, EPIC-09-S47, EPIC-09-S48, EPIC-09-S49, EPIC-09-S50
 * (the validation half) · AC1, AC4, AC5, AC6, AC7, AC8, AC9
 */
import type { SchemaIssue } from './accept-fact.ts';
import { canonicalJson } from './canonical-json.ts';
import type { TokenCount } from './context-packet.ts';
import type { NodeId } from './ids.ts';
import { NodeFailureError } from './node-failure.ts';
import {
  DEFAULT_RETURNS_MAX_TOKENS,
  type NodeReturns,
  type NodeType,
  type PermissionLevel,
} from './plan-graph.ts';
import type { Tokenizer } from './tokenizer.ts';

/** The global default, re-exported under the name this module talks about it
 * by. One constant, defined beside the plan schema that falls back to it. */
export const DEFAULT_RETURN_BUDGET = DEFAULT_RETURNS_MAX_TOKENS;

/**
 * Which kind of work an `agent` node is doing, for budget purposes only.
 *
 * Two values because §9.3 draws exactly two, and `agentRoleOf` derives it from
 * the node's permission rather than from a field an author would have to
 * remember to set (see decision 4 in the module note).
 */
export type AgentRole = 'implementation' | 'recon';

/**
 * docs/08-context-and-memory.md §9.3's table, transcribed once.
 *
 * `tool` is absent from the document's table — its output is deterministic and
 * travels as handles — so it falls to `default` like every other node type
 * with nothing specific to say.
 */
export const RETURN_BUDGET_DEFAULTS = {
  gate: 300,
  human: 500,
  'agent.implementation': 1500,
  'agent.recon': 4000,
  default: DEFAULT_RETURN_BUDGET,
} as const;

/**
 * AC1 — the budget a node of this type gets when its author set none.
 *
 * An `agent` with no stated role is treated as an implementation: 1,500 is the
 * conservative half of the pair, and a survey that wanted 4,000 and silently
 * got it would be a budget nobody chose.
 */
export function defaultReturnBudget(type: NodeType, role?: AgentRole): number {
  if (type === 'gate') return RETURN_BUDGET_DEFAULTS.gate;
  if (type === 'human') return RETURN_BUDGET_DEFAULTS.human;
  if (type === 'agent') {
    return role === 'recon'
      ? RETURN_BUDGET_DEFAULTS['agent.recon']
      : RETURN_BUDGET_DEFAULTS['agent.implementation'];
  }
  return RETURN_BUDGET_DEFAULTS.default;
}

/** A node that cannot write is surveying; one that can is implementing. */
export function agentRoleOf(permission: PermissionLevel): AgentRole {
  return permission === 'read' ? 'recon' : 'implementation';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * AC1 — fills each node's `returns.maxTokens` from the per-node-type table,
 * where the author left it out.
 *
 * It runs on the **raw document, before `parsePlanGraph`**, and that ordering
 * is the whole reason it exists as a separate step: `NodeReturnsSchema` gives
 * `maxTokens` the global 1,500 default, so by the time a plan has parsed, a
 * `gate` that omitted the field is indistinguishable from one that asked for
 * 1,500 — and 300 is what §9.3 says it should have got. The schema's default
 * stays as the last-resort backstop for a document that reaches the parser
 * un-normalised.
 *
 * A node with no `returns` at all is left exactly as it is. The *budget*
 * defaults; the `schemaId` does not and must not, because a return nobody
 * named a shape for cannot be validated against anything — which is why the
 * plan parser rejects it (test plan #1).
 */
export function withReturnBudgetDefaults(document: unknown): unknown {
  if (!isRecord(document) || !Array.isArray(document.nodes)) return document;

  const nodes = (document.nodes as unknown[]).map((node) => {
    if (!isRecord(node) || !isRecord(node.returns)) return node;
    if (node.returns.maxTokens !== undefined) return node;

    const type = node.type;
    if (typeof type !== 'string') return node;
    const permission = node.permission;
    const role =
      type === 'agent' && typeof permission === 'string'
        ? agentRoleOf(permission as PermissionLevel)
        : undefined;

    return {
      ...node,
      returns: { ...node.returns, maxTokens: defaultReturnBudget(type as NodeType, role) },
    };
  });

  return { ...document, nodes };
}

/**
 * One, and the number is not a knob.
 *
 * Claude Code already runs its own bounded internal schema-repair loop; a
 * second unbounded one on top of it multiplies cost and latency for no
 * additional chance of success (§9.1). The constant is exported so the bound is
 * greppable from the scheduler, which is where somebody would otherwise be
 * tempted to loop.
 */
export const HANDOFF_REPAIR_LIMIT = 1;

/**
 * What the result envelope's `structured_output` field held.
 *
 * A tagged pair rather than `unknown | undefined`, because **absent is a
 * contract failure and `{}` is a value** — §9.1 records that whether Claude
 * Code populates `structured_output` in every success case is Unverified, and
 * the one thing the parser must not do is turn the absence into an empty
 * object that then validates against a permissive schema.
 */
export type StructuredOutput =
  | { readonly present: true; readonly value: unknown }
  | { readonly present: false };

/** `handoff.oversize`'s payload, exactly as §9 of the domain model spells it. */
export interface HandoffOversize {
  readonly node: NodeId;
  readonly attempt: number;
  readonly budget: number;
  readonly actual: number;
  /** Whether the one repair had already been spent when this was measured.
   * `false` on the first event, `true` on the second — which is what tells a
   * reader that the repair happened and did not help (AC5). */
  readonly repairAttempted: boolean;
}

export type HandoffOutcome = 'accepted' | 'repair' | 'failed';

/**
 * Why the outcome is what it is. Distinct values rather than a boolean,
 * because EPIC-09-S49's second scenario asks the node inspector to show *which
 * layer gave up*.
 */
export type HandoffCause =
  | 'in-budget'
  | 'schema-invalid'
  | 'absent-structured-output'
  | 'oversize'
  | 'vendor-repair-exhausted';

export interface HandoffJudgement {
  readonly outcome: HandoffOutcome;
  readonly cause: HandoffCause;
  /**
   * The return exactly as it arrived, or `undefined` when nothing did.
   *
   * Never shortened, on any arm. A failed handoff's full payload is the
   * evidence needed to fix the prompt or the budget (EPIC-09-S48).
   */
  readonly returned: unknown;
  /** The Tier-2 count of the canonically-serialised return. */
  readonly tokens: TokenCount;
  /** The event to append, or `null` when the return was not over budget. */
  readonly oversize: HandoffOversize | null;
  /** The failure to record, or `null` on any arm but `failed`. */
  readonly failure: NodeFailureError | null;
  /** The re-prompt to send. Non-null if and only if `outcome` is `repair`. */
  readonly repairPrompt: string | null;
  /** Every Ajv violation, in the order Ajv reported them (`allErrors: true`). */
  readonly issues: readonly SchemaIssue[];
}

export interface HandoffInput {
  readonly node: NodeId;
  readonly attempt: number;
  readonly contract: NodeReturns;
  readonly structuredOutput: StructuredOutput;
  /** Whether the single repair has already been spent on this attempt. */
  readonly repairAttempted: boolean;
  /**
   * Ajv's verdict, as a port. `@DeFlow/core` reads no directory (R1), and the
   * validator is compiled from `.DeFlow/schemas/` by `@DeFlow/daemon`'s schema
   * store against `AJV_2020_OPTIONS` — `strict: true`, `allErrors: true`.
   */
  readonly validate: (value: unknown) => readonly SchemaIssue[];
  /** KAR-09.7's Tier-2 counter. The figure carries its own method label. */
  readonly tokenizer: Tokenizer;
}

const issueLine = (issue: SchemaIssue): string => `${issue.pointer || '/'} ${issue.message}`;

/**
 * The re-prompt sent to the **same session**, because that session already
 * holds the context needed to compress accurately or to repair the shape.
 *
 * It is a string rather than a template object so the whole instruction is
 * visible in one place and in one test; the caller delivers it as a further
 * turn on the live session, and it is explicitly **not** counted as a node
 * retry attempt (EPIC-09-S47) — counting it would interact badly with the
 * retry policy and with F4.7's no-progress detection.
 */
export function repairPromptFor(input: {
  readonly cause: Exclude<HandoffCause, 'in-budget' | 'vendor-repair-exhausted'>;
  readonly contract: NodeReturns;
  readonly actual: number;
  readonly issues: readonly SchemaIssue[];
}): string {
  if (input.cause === 'oversize') {
    return (
      `Your structured return measured ${input.actual} tokens against a budget of ` +
      `${input.contract.maxTokens}. Send the same information again, compressed to fit within ` +
      `${input.contract.maxTokens} tokens, still valid against ${input.contract.schemaId}. ` +
      'Drop detail, do not drop required fields, and do not truncate the JSON.'
    );
  }
  if (input.cause === 'absent-structured-output') {
    return (
      `The turn ended without a structured_output for ${input.contract.schemaId}. Send the ` +
      `return again as a single JSON object valid against ${input.contract.schemaId}, within ` +
      `${input.contract.maxTokens} tokens.`
    );
  }
  return (
    `Your structured return did not satisfy ${input.contract.schemaId}: ` +
    `${input.issues.map(issueLine).join('; ')}. Send it again, fixing every one of those, ` +
    `within ${input.contract.maxTokens} tokens.`
  );
}

function failure(reason: 'contract.schema-invalid' | 'contract.handoff-oversize', message: string) {
  // `permanent` as a *failure*: whether to repair is a scheduling decision made
  // above this boundary, and it has already been made by the time a `failed`
  // judgement exists at all.
  return new NodeFailureError(message, { reason, class: 'permanent' });
}

/**
 * AC4, AC5, AC6, AC8 — the whole decision, as one pure function.
 *
 * Order: shape, then size. See decision 2 in the module note.
 */
export function judgeHandoff(input: HandoffInput): HandoffJudgement {
  const { contract, node, attempt, repairAttempted } = input;

  if (!input.structuredOutput.present) {
    const tokens = input.tokenizer.count('');
    const message =
      `node ${node} returned no structured_output for ${contract.schemaId}: the turn reported ` +
      'success and carried no parsed object, which is a contract failure rather than an empty ' +
      'result (docs/08-context-and-memory.md §9.1)';
    return {
      outcome: repairAttempted ? 'failed' : 'repair',
      cause: 'absent-structured-output',
      returned: undefined,
      tokens,
      oversize: null,
      failure: repairAttempted ? failure('contract.schema-invalid', message) : null,
      repairPrompt: repairAttempted
        ? null
        : repairPromptFor({ cause: 'absent-structured-output', contract, actual: 0, issues: [] }),
      issues: [],
    };
  }

  const returned = input.structuredOutput.value;
  // Canonical, not `JSON.stringify`: the figure a budget is compared against
  // must not depend on the order the vendor happened to emit the keys in.
  const tokens = input.tokenizer.count(canonicalJson(returned));
  const issues = input.validate(returned);

  if (issues.length > 0) {
    const message =
      `node ${node} returned a value that does not satisfy ${contract.schemaId}: ` +
      issues.map(issueLine).join('; ');
    return {
      outcome: repairAttempted ? 'failed' : 'repair',
      cause: 'schema-invalid',
      returned,
      tokens,
      oversize: null,
      failure: repairAttempted ? failure('contract.schema-invalid', message) : null,
      repairPrompt: repairAttempted
        ? null
        : repairPromptFor({
            cause: 'schema-invalid',
            contract,
            actual: tokens.estimated,
            issues,
          }),
      issues,
    };
  }

  if (tokens.estimated > contract.maxTokens) {
    const oversize: HandoffOversize = {
      node,
      attempt,
      budget: contract.maxTokens,
      actual: tokens.estimated,
      repairAttempted,
    };
    const message =
      `node ${node} returned ${tokens.estimated} tokens against a budget of ` +
      `${contract.maxTokens} and was still over after its one repair`;
    return {
      outcome: repairAttempted ? 'failed' : 'repair',
      cause: 'oversize',
      returned,
      tokens,
      oversize,
      failure: repairAttempted ? failure('contract.handoff-oversize', message) : null,
      repairPrompt: repairAttempted
        ? null
        : repairPromptFor({
            cause: 'oversize',
            contract,
            actual: tokens.estimated,
            issues: [],
          }),
      issues: [],
    };
  }

  return {
    outcome: 'accepted',
    cause: 'in-budget',
    returned,
    tokens,
    oversize: null,
    failure: null,
    repairPrompt: null,
    issues: [],
  };
}

/**
 * AC7 — the vendor's own repair loop, already exhausted.
 *
 * Claude Code surfaces it as `error_max_structured_output_retries`, which
 * `@DeFlow/adapters` maps to `agent.schema-repair-exhausted`. This function is
 * how that arrives at the handoff path, and its whole content is a `null`
 * `repairPrompt`: *do not retry on top of a retry.* Stacking DeFlow's repair on
 * top of the CLI's multiplies cost and latency for no additional chance of
 * success, and the reason stays distinct from `contract.handoff-oversize` so
 * the inspector can say which layer gave up.
 */
export function judgeVendorFailure(node: NodeId, attempt: number): HandoffJudgement {
  return {
    outcome: 'failed',
    cause: 'vendor-repair-exhausted',
    returned: undefined,
    tokens: { estimated: 0, method: 'gpt-tokenizer/o200k_base' },
    oversize: null,
    failure: new NodeFailureError(
      `node ${node} exhausted the provider's own bounded schema-repair loop on attempt ` +
        `${attempt}; DeFlow attempts no further repair on top of it`,
      { reason: 'agent.schema-repair-exhausted', class: 'permanent', detail: { attempt } },
    ),
    repairPrompt: null,
    issues: [],
  };
}

/** One node's handoff, reduced to the two things the rate is computed from. */
export interface HandoffSample {
  readonly nodeType: NodeType;
  /** Whether this handoff went over budget at all — not how many events it
   * produced. A handoff that was oversize twice is one oversize handoff. */
  readonly oversize: boolean;
}

export interface HandoffOversizeRate {
  readonly nodeType: NodeType;
  readonly handoffs: number;
  readonly oversize: number;
  /** `oversize / handoffs`, in [0, 1]. */
  readonly rate: number;
}

/**
 * AC9 — the oversize rate per node type, in the shape F10.11's cross-run
 * dashboard reads.
 *
 * *"Record oversize rate per node type and feed it into F10.11's cross-run
 * dashboard, then tune from your own data. That measurement is a genuine
 * differentiator; nobody else in the category has it."* Sorted by node type so
 * two runs of the same data produce the same rows in the same order.
 */
export function handoffOversizeRates(
  samples: readonly HandoffSample[],
): readonly HandoffOversizeRate[] {
  const counts = new Map<NodeType, { handoffs: number; oversize: number }>();
  for (const sample of samples) {
    const entry = counts.get(sample.nodeType) ?? { handoffs: 0, oversize: 0 };
    entry.handoffs += 1;
    if (sample.oversize) entry.oversize += 1;
    counts.set(sample.nodeType, entry);
  }

  return [...counts.entries()]
    .sort(([one], [other]) => one.localeCompare(other))
    .map(([nodeType, entry]) => ({
      nodeType,
      handoffs: entry.handoffs,
      oversize: entry.oversize,
      rate: entry.oversize / entry.handoffs,
    }));
}
