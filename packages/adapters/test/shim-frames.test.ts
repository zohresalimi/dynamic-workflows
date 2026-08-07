/**
 * KAR-05.8 — the `stream-json` envelope, parsed into DeFlow's own vocabulary.
 *
 * The envelope asserted here is the one recorded in
 * `fixtures/cli-shapes/claude-code@2.1.220.json` and reproduced by the fake
 * exec-shim agent (KAR-04.6). Two of its fields carry weight beyond looking
 * right:
 *
 * - **`modelUsage` is the billing truth**, so it becomes a `TokenUsage` with
 *   `source: 'vendor-reported'`. An estimate mixed into the same total is not
 *   a slightly-wrong number, it is a number with no meaning
 *   (docs/04-domain-model.md §8), and the estimator on the ACP path already
 *   labels itself. The sibling `usage` object is a trap and is never read —
 *   KAR-09.7 owns that rule, and `test/tier1-model-usage.test.ts` defends it.
 * - **`resetsAt` is epoch _seconds_.** Reading it as milliseconds schedules
 *   the retry in 1970, which is indistinguishable from "retry immediately" —
 *   the exact behaviour AC6 exists to prevent.
 *
 * Verifies: EPIC-05-S29 · KAR-05.8 AC5, AC6 · test plan #5, #6
 */
import { TokenUsageSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  parseShimLine,
  shimRateLimit,
  shimResultFailure,
  shimResultUsage,
  shimText,
} from '../src/index.ts';

/** The verified `result` envelope, field for field. */
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'end_turn',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 1024,
    output_tokens: 37,
    cache_creation_input_tokens: 12,
    cache_read_input_tokens: 900,
  },
  modelUsage: {
    'claude-sonnet-4-5-20260514': {
      inputTokens: 1024,
      outputTokens: 37,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 12,
      costUSD: 0.0123,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  },
  permission_denials: [],
  terminal_reason: 'complete',
  result: 'ok',
  session_id: 'sess-1',
  uuid: 'a5cf5c3e-0000-4000-8000-000000000001',
};

const line = (value: unknown): NonNullable<ReturnType<typeof parseShimLine>> => {
  const parsed = parseShimLine(JSON.stringify(value));
  if (parsed === null) throw new Error('expected a parsed line');
  return parsed;
};

suite('every line carries the two ids the shim path needs', () => {
  it('reads the uuid and the session id off any line type', () => {
    const parsed = line(RESULT);
    expect(parsed.uuid).toBe('a5cf5c3e-0000-4000-8000-000000000001');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.type).toBe('result');
  });

  it('answers null for a blank line rather than inventing a frame', () => {
    expect(parseShimLine('')).toBeNull();
    expect(parseShimLine('   \n')).toBeNull();
  });

  it('refuses a line that is not JSON with adapter.malformed-output', () => {
    // The SDK's reader drops what it cannot parse and carries on. Right for a
    // transport library, wrong for DeFlow: the dropped frame is a hole in a
    // transcript the ledger keeps for ever, under a node that reported success.
    expect(() => parseShimLine('{"type":')).toThrow();
    try {
      parseShimLine('{"type":');
      expect.unreachable('a malformed line must throw');
    } catch (error) {
      expect(error).toMatchObject({ deflowFailure: { reason: 'adapter.malformed-output' } });
    }
  });

  it('concatenates assistant text, and says nothing for other line types', () => {
    const assistant = line({
      type: 'assistant',
      uuid: 'u1',
      session_id: 'sess-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello ' }] },
    });
    expect(shimText(assistant)).toBe('hello ');
    expect(shimText(line({ type: 'system', subtype: 'init', uuid: 'u0' }))).toBe('');
  });
});

suite('the result envelope becomes a vendor-reported TokenUsage (AC5)', () => {
  it('maps every field of the verified envelope, and labels the source', () => {
    const usage = shimResultUsage(line(RESULT));
    expect(usage).toEqual({
      inputTokens: 1024,
      outputTokens: 37,
      cacheCreationInputTokens: 12,
      cacheReadInputTokens: 900,
      source: 'vendor-reported',
    });
    // Not merely shaped like one: the domain schema is what the ledger will
    // validate it against.
    expect(TokenUsageSchema.parse(usage)).toEqual(usage);
  });

  it('never labels a vendor figure as an estimate', () => {
    expect(shimResultUsage(line(RESULT)).source).toBe('vendor-reported');
  });

  it('omits the optional counters the envelope did not report', () => {
    const sparse = line({
      ...RESULT,
      modelUsage: { 'claude-sonnet-4-5-20260514': { inputTokens: 10, outputTokens: 2 } },
    });
    expect(shimResultUsage(sparse)).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      source: 'vendor-reported',
    });
  });

  it('a successful result is not a failure', () => {
    expect(shimResultFailure(line(RESULT))).toBeNull();
  });
});

suite('the result subtype maps to a closed taxonomy reason (AC5)', () => {
  it('error_max_structured_output_retries is agent.schema-repair-exhausted, permanently', () => {
    const failure = shimResultFailure(
      line({
        ...RESULT,
        subtype: 'error_max_structured_output_retries',
        is_error: true,
        stop_reason: 'refusal',
        result: '',
      }),
    );
    expect(failure).not.toBeNull();
    expect(failure).toMatchObject({
      deflowFailure: { reason: 'agent.schema-repair-exhausted', class: 'permanent' },
    });
  });

  it('error_max_turns is agent.max-turns, not a generic failure', () => {
    const failure = shimResultFailure(
      line({ ...RESULT, subtype: 'error_max_turns', is_error: true }),
    );
    expect(failure).toMatchObject({ deflowFailure: { reason: 'agent.max-turns' } });
  });

  it('an error subtype carrying permission denials is agent.refused', () => {
    const failure = shimResultFailure(
      line({
        ...RESULT,
        subtype: 'error_during_execution',
        is_error: true,
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {} }],
      }),
    );
    expect(failure).toMatchObject({ deflowFailure: { reason: 'agent.refused' } });
  });

  it('an unrecognised error subtype is still a typed failure, never swallowed', () => {
    const failure = shimResultFailure(
      line({ ...RESULT, subtype: 'error_something_new', is_error: true }),
    );
    expect(failure).not.toBeNull();
    expect(failure?.deflowFailure.reason).toBe('agent.nonzero-exit');
  });
});

suite('rate_limit_event carries a schedulable instant (AC6)', () => {
  const RATE_LIMIT = {
    type: 'rate_limit_event',
    uuid: 'u9',
    session_id: 'sess-1',
    rate_limit_info: { status: 'allowed_warning', resetsAt: 1_800_000_000 },
  };

  it('converts the vendor’s epoch seconds into the ms epoch DeFlow schedules on', () => {
    expect(shimRateLimit(line(RATE_LIMIT))).toEqual({
      status: 'allowed_warning',
      resetsAt: 1_800_000_000_000,
    });
  });

  it('is null for any other line type, so nothing else schedules a wake', () => {
    expect(shimRateLimit(line(RESULT))).toBeNull();
  });

  it('reports the status without a resetsAt when the vendor omitted one', () => {
    const partial = line({ ...RATE_LIMIT, rate_limit_info: { status: 'allowed' } });
    expect(shimRateLimit(partial)).toEqual({ status: 'allowed', resetsAt: null });
  });
});
