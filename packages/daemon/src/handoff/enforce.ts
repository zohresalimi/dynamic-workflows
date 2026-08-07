/**
 * KAR-09.9 — the bounded repair loop, as the one place a handoff is enforced
 * (docs/08-context-and-memory.md §9.2).
 *
 * `@DeFlow/core`'s `judgeHandoff` decides; this decides nothing. What it owns
 * is the three things a decision cannot do for itself: append the
 * `handoff.oversize` event, send the repair prompt to the live session, and
 * refuse to go round a second time.
 *
 * **The loop is `while` nothing.** It is two calls to `judgeHandoff`, written
 * out, because that is what "exactly one repair" looks like when the bound is
 * structural rather than a counter somebody can raise. A loop with a limit is a
 * loop whose limit becomes configurable in six months; two calls cannot become
 * three without a reviewer noticing the third.
 *
 * **Nothing here shortens anything.** The result carries `returned` — whatever
 * came back, whole — and the caller writes a fact only when `outcome` is
 * `accepted`. That is the entirety of "nothing invalid reaches the blackboard":
 * there is no partial acceptance, no best-effort parse, and no prefix.
 * `packages/core/test/no-handoff-truncation.test.ts` scans this file for the
 * call that would undo it.
 *
 * **`vendorRepairExhausted` short-circuits before anything is measured** (AC7).
 * Claude Code runs its own bounded schema-repair loop and reports exhaustion as
 * `error_max_structured_output_retries`; stacking DeFlow's repair on top of it
 * multiplies cost and latency for no additional chance of success. The flag
 * arrives from `@DeFlow/adapters`, which is where the vendor's subtype is read.
 *
 * Verifies: EPIC-09-S46, EPIC-09-S47, EPIC-09-S48, EPIC-09-S49 · AC4, AC5,
 * AC6, AC7, AC8
 */
import type {
  Db,
  HandoffOversize,
  HandoffSample,
  NodeFailureError,
  NodeId,
  NodeReturns,
  NodeType,
  RunId,
  SchemaIssue,
  StructuredOutput,
  TokenCount,
  Tokenizer,
} from '@DeFlow/core';
import { HANDOFF_REPAIR_LIMIT, judgeHandoff, judgeVendorFailure } from '@DeFlow/core';
import { appendEvents } from '@DeFlow/ledger';

/**
 * The live session a repair is delivered to.
 *
 * A port, and deliberately the *same* session rather than a fresh one: the
 * session already holds the context needed to compress accurately, and a new
 * one would have to be re-fed the packet to say anything useful — which is
 * paying twice for a compression.
 */
export interface HandoffSession {
  /** Sends one further turn and returns whatever `structured_output` held. */
  repair(prompt: string): Promise<StructuredOutput>;
}

/** Just enough of `SchemaDirectory` to validate one return, so a caller can
 * pass a store, a stub or a single compiled validator. */
export interface HandoffValidator {
  validate(schemaId: string, value: unknown): readonly SchemaIssue[];
}

export interface EnforceHandoffOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly node: NodeId;
  /** For the AC9 oversize-rate sample the caller records alongside this. */
  readonly nodeType: NodeType;
  readonly attempt: number;
  readonly epoch: number;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly contract: NodeReturns;
  readonly structuredOutput: StructuredOutput;
  /**
   * AC7 — the provider already gave up on its own schema-repair loop. When
   * true, nothing below runs: no measurement, no event, no repair.
   */
  readonly vendorRepairExhausted?: boolean;
  readonly schemas: HandoffValidator;
  readonly tokenizer: Tokenizer;
  readonly session: HandoffSession;
}

export interface HandoffResult {
  readonly outcome: 'accepted' | 'failed';
  /** The return exactly as it arrived, or `undefined` when none did. Never a
   * prefix — see the module note. */
  readonly returned: unknown;
  readonly tokens: TokenCount;
  readonly failure: NodeFailureError | null;
  readonly issues: readonly SchemaIssue[];
  /** 0 or 1. There is no third value. */
  readonly repairs: number;
  /** The events this call appended, in order, for a caller that wants them
   * without re-reading the ledger. */
  readonly oversize: readonly HandoffOversize[];
  /**
   * AC9 — this handoff, as one row of the oversize-rate measurement.
   *
   * Returned rather than left to the caller to reconstruct, because the
   * denominator is the part that goes wrong: `handoff.oversize` events alone
   * give the numerator, and a rate computed from them would be 100% for every
   * node type that ever went over. One sample per handoff — oversize or not —
   * is what makes `handoffOversizeRates` a rate rather than a count.
   */
  readonly sample: HandoffSample;
}

function appendOversize(options: EnforceHandoffOptions, payload: HandoffOversize): void {
  appendEvents(options.db, [
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'handoff.oversize',
      v: 1,
      epoch: options.epoch,
      nodeId: options.node,
      attempt: options.attempt,
      payload,
    },
  ]);
}

/**
 * AC4–AC8 — measure, repair once, or fail.
 *
 * Returns rather than throws, on every arm. Whether a node retries is the
 * scheduler's decision and it needs the failure as a value to make it
 * (docs/04-domain-model.md §8).
 */
export async function enforceHandoff(options: EnforceHandoffOptions): Promise<HandoffResult> {
  if (options.vendorRepairExhausted === true) {
    const judgement = judgeVendorFailure(options.node, options.attempt);
    return {
      outcome: 'failed',
      returned: undefined,
      tokens: judgement.tokens,
      failure: judgement.failure,
      issues: [],
      repairs: 0,
      oversize: [],
      sample: { nodeType: options.nodeType, oversize: false },
    };
  }

  const judge = (structuredOutput: StructuredOutput, repairAttempted: boolean) =>
    judgeHandoff({
      node: options.node,
      attempt: options.attempt,
      contract: options.contract,
      structuredOutput,
      repairAttempted,
      validate: (value) => options.schemas.validate(String(options.contract.schemaId), value),
      tokenizer: options.tokenizer,
    });

  const first = judge(options.structuredOutput, false);
  const appended: HandoffOversize[] = [];
  if (first.oversize !== null) {
    appendOversize(options, first.oversize);
    appended.push(first.oversize);
  }

  if (first.outcome !== 'repair') {
    return {
      outcome: first.outcome === 'accepted' ? 'accepted' : 'failed',
      returned: first.returned,
      tokens: first.tokens,
      failure: first.failure,
      issues: first.issues,
      repairs: 0,
      oversize: appended,
      sample: { nodeType: options.nodeType, oversize: appended.length > 0 },
    };
  }

  // The one repair. `repairPrompt` is non-null exactly when `outcome` is
  // `repair`, which is why there is no branch here for a missing prompt.
  const repaired = await options.session.repair(first.repairPrompt as string);
  const second = judge(repaired, true);
  if (second.oversize !== null) {
    appendOversize(options, second.oversize);
    appended.push(second.oversize);
  }

  return {
    outcome: second.outcome === 'accepted' ? 'accepted' : 'failed',
    returned: second.returned,
    tokens: second.tokens,
    failure: second.failure,
    issues: second.issues,
    repairs: HANDOFF_REPAIR_LIMIT,
    oversize: appended,
    sample: { nodeType: options.nodeType, oversize: appended.length > 0 },
  };
}
