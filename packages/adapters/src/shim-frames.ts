/**
 * KAR-05.8 — the exec shim's line parser: vendor output in, DeFlow's own
 * vocabulary out.
 *
 * This module is the reason §8.5 calls the shim the highest-churn code in the
 * project. It reads a wire format nobody promised to keep stable, and the
 * envelope it reads was captured by execution on 2026-08-02 and is recorded in
 * `fixtures/cli-shapes/`. Everything here is a pure function over one already
 * complete line, so the churn is testable without a subprocess and the
 * subprocess specs can be about the process.
 *
 * Three properties carry weight beyond looking right.
 *
 * **The `uuid` is the dedup key on this path.** It is the shim-side equivalent
 * of the ACP notification id, and what makes replay-after-crash idempotent
 * (F4.3). A parser that keyed on line index instead would look identical until
 * the day an agent emitted its lines in a different order after a resume, and
 * then it would duplicate a transcript the ledger keeps for ever.
 *
 * **`usage` is the billing truth, so it is labelled `vendor-reported`.** The
 * ACP path estimates and says so; mixing the two into one total produces a
 * number with no meaning, and a budget ceiling computed from it fires at the
 * wrong time in both directions (docs/04-domain-model.md §8).
 *
 * **`resetsAt` is epoch _seconds_.** Reading it as milliseconds schedules the
 * wake in 1970, which is indistinguishable from "retry immediately" — the
 * exact behaviour the frame exists to prevent.
 *
 * No vendor is named in this file's code, and that is the rule the package
 * keeps (KAR-05.2 AC5, `test/no-capability-table.test.ts`): which dialect a
 * provider speaks is a fact about *invocation* and lives in the registry.
 *
 * Verifies: EPIC-05-S29 · KAR-05.8 AC4, AC5, AC6
 */

import {
  NodeFailureError,
  type NodeFailureReason,
  type StructuredOutput,
  type TokenUsage,
} from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { malformedOutput } from './failures.ts';

/** One parsed line of a `stream-json` / JSONL stream. */
export interface ShimLine {
  /** The line's own id, and the event-log dedup key. `null` when absent. */
  readonly uuid: string | null;
  readonly sessionId: string | null;
  /** The vendor's `type` discriminator, or `''` when it sent none. */
  readonly type: string;
  /** The whole line, verbatim. Never normalised — the shape is not ours. */
  readonly raw: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Parses one line, or answers `null` for a blank one.
 *
 * A line that is not JSON **throws** rather than being skipped. The SDK's own
 * reader drops what it cannot parse and carries on, which is right for a
 * transport library and wrong for DeFlow: the dropped frame becomes a hole in
 * a transcript the ledger keeps for ever, under a node that reported success.
 * The first 4 KiB are kept as the failure's evidence, exactly as the ACP
 * transport keeps them.
 */
export function parseShimLine(text: string): ShimLine | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const bytes = Buffer.from(text, 'utf8');
    throw malformedOutput(bytes.subarray(0, 4096), bytes.byteLength);
  }

  const raw = asRecord(value);
  if (raw === null) {
    const bytes = Buffer.from(text, 'utf8');
    throw malformedOutput(bytes.subarray(0, 4096), bytes.byteLength);
  }

  return {
    uuid: asString(raw.uuid),
    sessionId: asString(raw.session_id),
    type: asString(raw.type) ?? '',
    raw,
  };
}

/**
 * The assistant text this line contributes, or `''`.
 *
 * Concatenated by the caller across the turn, which is what makes the node's
 * output the same thing on this path as on the ACP one.
 */
export function shimText(line: ShimLine): string {
  if (line.type !== 'assistant') return '';
  const message = asRecord(line.raw.message);
  if (message === null) return '';

  const content = message.content;
  if (!Array.isArray(content)) return asString(message.text) ?? '';

  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === 'text' ? (asString(record.text) ?? '') : '';
    })
    .join('');
}

/**
 * KAR-09.7 Tier 1 — one turn's authoritative figures, normalised.
 *
 * The same shape whichever dialect produced it (`./turn-frames.ts` builds one
 * from the jsonl dialect's `turn.completed`), so a consumer computing a fill
 * percentage or folding a calibration sample never branches on vendor.
 *
 * `contextWindow` and `maxOutputTokens` are `null` rather than a default,
 * because a default here is a window-size table with one entry: the whole
 * reason this field is carried at all is that DeFlow reads the window off the
 * turn instead of knowing it.
 */
export interface VendorUsageReport {
  /** The model the turn mostly ran on, when the dialect names one. */
  readonly model: string | null;
  readonly usage: TokenUsage;
  /** `null` when the dialect reports no cost — never 0, which is a claim. */
  readonly costUsd: number | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
}

/** Builds a `TokenUsage` from already-extracted counts, omitting the optional
 * counters nobody reported — "not reported" and "zero" are different claims,
 * and only one of them is true. */
function vendorUsage(counts: {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  cacheCreation?: number | undefined;
  reasoning?: number | undefined;
}): TokenUsage {
  return {
    inputTokens: counts.input,
    outputTokens: counts.output,
    ...(counts.cacheRead === undefined ? {} : { cacheReadInputTokens: counts.cacheRead }),
    ...(counts.cacheCreation === undefined
      ? {}
      : { cacheCreationInputTokens: counts.cacheCreation }),
    ...(counts.reasoning === undefined ? {} : { reasoningOutputTokens: counts.reasoning }),
    source: 'vendor-reported',
  };
}

/** Sums one optional counter across every model entry, staying `undefined`
 * when not a single entry reported it. */
function sumOptional(entries: readonly Record<string, unknown>[], key: string): number | undefined {
  const reported = entries
    .map((entry) => asCount(entry[key]))
    .filter((value) => value !== undefined);
  return reported.length === 0 ? undefined : reported.reduce((sum, value) => sum + value, 0);
}

/**
 * The `result` envelope's Tier-1 report, read from **`modelUsage` only**, or
 * `null` when the envelope carried no `modelUsage` at all.
 *
 * The envelope also carries a `usage` object and it is a trap: the CLI's own
 * zod schema types it `z.unknown()` — a raw passthrough of Anthropic's API
 * object whose shape the CLI does not guarantee — and it carries no window.
 * `modelUsage` is typed, and `modelUsage[m].contextWindow` is what makes a
 * per-model window table unnecessary. `test/no-result-envelope-usage.test.ts`
 * is the mechanical half of that rule; the differential specs in
 * `test/tier1-model-usage.test.ts` are the half a grep cannot be routed around.
 *
 * A turn may bill against more than one model — a sub-agent on a cheaper one,
 * for instance. The counts are **summed**, because the turn cost what it cost;
 * the window is taken from the entry with the most input tokens, because that
 * is the model the packet actually had to fit inside, and `null` when that
 * entry did not report one.
 */
export function shimResultReport(line: ShimLine): VendorUsageReport | null {
  const modelUsage = asRecord(line.raw.modelUsage);
  if (modelUsage === null) return null;

  const entries = Object.entries(modelUsage)
    .map(([model, value]) => ({ model, entry: asRecord(value) }))
    .filter((row): row is { model: string; entry: Record<string, unknown> } => row.entry !== null);
  if (entries.length === 0) return null;

  const records = entries.map((row) => row.entry);
  const dominant = entries.reduce((best, row) =>
    (asCount(row.entry.inputTokens) ?? 0) > (asCount(best.entry.inputTokens) ?? 0) ? row : best,
  );

  const costs = records
    .map((entry) => entry.costUSD)
    .filter((cost): cost is number => typeof cost === 'number' && Number.isFinite(cost));

  return {
    model: dominant.model,
    usage: vendorUsage({
      input: sumOptional(records, 'inputTokens') ?? 0,
      output: sumOptional(records, 'outputTokens') ?? 0,
      cacheRead: sumOptional(records, 'cacheReadInputTokens'),
      cacheCreation: sumOptional(records, 'cacheCreationInputTokens'),
      reasoning: sumOptional(records, 'reasoningOutputTokens'),
    }),
    costUsd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
    contextWindow: asCount(dominant.entry.contextWindow) ?? null,
    maxOutputTokens: asCount(dominant.entry.maxOutputTokens) ?? null,
  };
}

/**
 * KAR-09.6 AC2 — the vendor's own compaction, as much of it as exists.
 *
 * `{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger,
 * pre_tokens } }`, and `compact_metadata` carries **`pre_tokens` only** — no
 * post count, no dropped list, no handle to what was summarised away. So this
 * returns those two fields and stops; the caller turns them into a
 * `vendor.session` compaction, whose type has nowhere to put the rest.
 *
 * A frame with no usable `pre_tokens` is `null` rather than `{ preTokens: 0 }`.
 * "The vendor reported nothing" and "the vendor reported no tokens" are
 * different claims and only one of them draws a bar.
 *
 * The sibling `{ subtype: 'status', status: 'compacting' }` frame is
 * deliberately not matched here: it is a live indicator, and treating it as a
 * boundary would append a second compaction event for one compaction
 * (EPIC-09-S31, second scenario).
 */
export interface ShimCompactBoundary {
  /** The vendor's own word: `'auto'` (its threshold) or `'manual'` (a human). */
  readonly trigger: 'auto' | 'manual';
  /** `compact_metadata.pre_tokens` — the only number the frame carries. */
  readonly preTokens: number;
}

export const COMPACT_BOUNDARY_SUBTYPE = 'compact_boundary';

export function shimCompactBoundary(line: ShimLine): ShimCompactBoundary | null {
  if (line.type !== 'system' || line.raw.subtype !== COMPACT_BOUNDARY_SUBTYPE) return null;

  const metadata = asRecord(line.raw.compact_metadata);
  if (metadata === null) return null;

  const preTokens = asCount(metadata.pre_tokens);
  if (preTokens === undefined) return null;

  // An unrecognised trigger reads as the vendor's own threshold rather than as
  // a human's request: `manual` is a claim that somebody asked for this, and
  // inventing that claim would put a compaction in the operator's lap.
  return { trigger: metadata.trigger === 'manual' ? 'manual' : 'auto', preTokens };
}

/**
 * The `result` envelope as a domain `TokenUsage`.
 *
 * `source: 'vendor-reported'` is not a decoration: it is what keeps this figure
 * addable to other vendor figures and un-addable to an estimate. An envelope
 * with no `modelUsage` degrades to labelled zeros rather than to the `usage`
 * trap's figures — the node completed and DeFlow has nothing to report about
 * it, which is a different statement from "the vendor reported these numbers".
 */
export function shimResultUsage(line: ShimLine): TokenUsage {
  return shimResultReport(line)?.usage ?? vendorUsage({ input: 0, output: 0 });
}

/**
 * KAR-09.9 AC2 — the parsed object the vendor produced against the schema this
 * invocation passed, as a tagged presence rather than a nullable value.
 *
 * `{ present: false }` and `{ present: true, value: {} }` are different
 * answers and the difference is the story: docs/08-context-and-memory.md §9.1
 * records that whether `structured_output` is populated in *every* Claude Code
 * success case is **Unverified**, and rules that an absent field on an
 * otherwise-successful result is a contract failure with a clear message — not
 * an empty object. `?? {}` here would erase exactly that, and would do it
 * silently: an empty object validates against any schema with no required
 * properties.
 *
 * `null` is read as present-and-null rather than absent, because a schema
 * whose root is nullable can legitimately produce one, and the handoff's own
 * validator is what should reject it if it cannot.
 */
export function shimStructuredOutput(line: ShimLine): StructuredOutput {
  if (!Object.hasOwn(line.raw, 'structured_output')) return { present: false };
  return { present: true, value: line.raw.structured_output };
}

/** What the envelope says the turn cost, in USD, or 0 when it said nothing. */
export function shimResultCostUsd(line: ShimLine): number {
  const cost = line.raw.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

/**
 * The `result.subtype` values with a mapping of their own, and what they mean
 * in the closed taxonomy (docs/04-domain-model.md §8).
 *
 * `error_max_structured_output_retries` is the entry that matters: it is the
 * only honest source for `agent.schema-repair-exhausted`, and a taxonomy entry
 * whose stimulus cannot be produced is a branch nobody has ever run. Mapping
 * it to a generic failure would also make it *retryable*, and re-running an
 * agent that already exhausted its repair budget spends the retry budget
 * proving the same thing again.
 *
 * `error_max_budget_usd` is `gate`, and the class is not a choice this table
 * makes: `budget.cost-exceeded` is one of the three reasons `NodeFailureSchema`
 * refuses to classify as anything else (KAR-06.5). A ceiling the operator set
 * has been hit, and the only correct next action is a human's.
 *
 * `error_during_execution` is deliberately **absent**. It is the vendor's
 * "something went wrong" subtype and says nothing specific, so it falls to the
 * default arm below — where the permission denials get their vote and decide
 * between `agent.refused` and `agent.nonzero-exit`. Naming it here would take
 * that vote away, which is the one case where the generic arm is more precise
 * than a table row.
 */
export const RESULT_SUBTYPE_REASONS: Readonly<
  Record<
    string,
    { readonly reason: NodeFailureReason; readonly class: 'transient' | 'permanent' | 'gate' }
  >
> = {
  error_max_structured_output_retries: {
    reason: 'agent.schema-repair-exhausted',
    class: 'permanent',
  },
  error_max_turns: { reason: 'agent.max-turns', class: 'permanent' },
  error_max_budget_usd: { reason: 'budget.cost-exceeded', class: 'gate' },
};

/**
 * The failure a `result` envelope reports, or `null` when the turn succeeded.
 *
 * The subtype decides first, because it is the field the vendor uses to say
 * *why*. Only when it says nothing specific do the permission denials get a
 * vote: an error subtype carrying denials is the agent having been stopped
 * rather than having broken, which is `agent.refused` and permanent — the same
 * argv would be denied the same way next time.
 */
export function shimResultFailure(line: ShimLine): NodeFailureError | null {
  const subtype = asString(line.raw.subtype) ?? '';
  const isError = line.raw.is_error === true;
  if (!isError && !subtype.startsWith('error')) return null;

  const denials = Array.isArray(line.raw.permission_denials) ? line.raw.permission_denials : [];
  const mapped = RESULT_SUBTYPE_REASONS[subtype] ?? {
    reason: denials.length > 0 ? ('agent.refused' as const) : ('agent.nonzero-exit' as const),
    class: 'transient' as const,
  };

  const stopReason = asString(line.raw.stop_reason) ?? '';
  return new NodeFailureError(
    `the agent ended the turn with result subtype ${subtype === '' ? '(none)' : subtype}` +
      `${stopReason === '' ? '' : ` (stop_reason ${stopReason})`}`,
    {
      reason: mapped.reason,
      class: mapped.class,
      detail: {
        subtype,
        stopReason,
        permissionDenials: denials.length,
        ...(line.uuid === null ? {} : { uuid: line.uuid }),
      },
    },
  );
}

/** A parsed rate-limit frame: the status, and the instant to schedule against. */
export interface ShimRateLimit {
  readonly status: string;
  /** ms epoch, converted from the vendor's epoch **seconds**. `null` when the
   * vendor reported a limit without saying when it lifts. */
  readonly resetsAt: number | null;
}

/**
 * The rate-limit frame, or `null` for every other line type.
 *
 * The unit conversion is the whole function. `resetsAt` arrives as epoch
 * seconds; DeFlow's durable timers are ms epoch, and a scheduler handed
 * 1_800_000_000 as milliseconds wakes in 1970 — which is a wake that fires
 * immediately, i.e. the blind retry AC6 forbids, wearing a scheduler's
 * clothes.
 */
export function shimRateLimit(line: ShimLine): ShimRateLimit | null {
  if (line.type !== 'rate_limit_event') return null;
  const info = asRecord(line.raw.rate_limit_info) ?? {};
  const seconds = info.resetsAt;
  return {
    status: asString(info.status) ?? 'unknown',
    resetsAt:
      typeof seconds === 'number' && Number.isFinite(seconds) ? Math.floor(seconds) * 1000 : null,
  };
}
