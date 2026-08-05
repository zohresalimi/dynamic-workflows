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

import { NodeFailureError, type NodeFailureReason, type TokenUsage } from '@DeFlow/core';
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
 * The `result` envelope's `usage`, as a domain `TokenUsage`.
 *
 * `source: 'vendor-reported'` is not a decoration: it is what keeps this
 * figure addable to other vendor figures and un-addable to an estimate. The
 * three optional counters are omitted when the envelope did not report them —
 * "not reported" and "zero" are different claims, and only one of them is
 * true.
 */
export function shimResultUsage(line: ShimLine): TokenUsage {
  const usage = asRecord(line.raw.usage) ?? {};
  const cacheRead = asCount(usage.cache_read_input_tokens);
  const cacheCreation = asCount(usage.cache_creation_input_tokens);
  const reasoning = asCount(usage.reasoning_output_tokens);

  return {
    inputTokens: asCount(usage.input_tokens) ?? 0,
    outputTokens: asCount(usage.output_tokens) ?? 0,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheCreation === undefined ? {} : { cacheCreationInputTokens: cacheCreation }),
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    source: 'vendor-reported',
  };
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
 */
export const RESULT_SUBTYPE_REASONS: Readonly<
  Record<string, { readonly reason: NodeFailureReason; readonly class: 'transient' | 'permanent' }>
> = {
  error_max_structured_output_retries: {
    reason: 'agent.schema-repair-exhausted',
    class: 'permanent',
  },
  error_max_turns: { reason: 'agent.max-turns', class: 'permanent' },
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
